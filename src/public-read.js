'use strict';

// 访客公开读出的**统一流程**：可见性判定 + 内容投影。
//
// 五个公开端点（最新年表、历史版本清单 / 详情、专题路线清单 / 详情）都经由本模块：
// 整次读取包在**同一个延迟只读事务（deferred read transaction）**里完成。
// 在 WAL 模式下，该事务首次执行 SELECT 时取得一个已提交快照，事务内随后的全部
// 语句都读这同一个快照——因此一次响应取自**同一个已提交的数据库状态**：
//
//   - 读取期间另一服务进程发布新版本、撤回版本、登记出处遮盖或替代勘误附记，
//     本进程要么在其提交**之前**（整份响应按变更前）、要么在其提交**之后**
//     （下一次请求整份按变更后）完成，绝不会把变更前后的版本可见性、出处遮盖
//     与勘误附记混在同一份响应里；
//   - 撤回版及引用它的路线仍不可见（可见性判定与清单 / 详情过滤在同一快照内）；
//   - 命中出处仍按原规则遮盖：遮盖登记表在该快照内**只装载一次**，版本快照
//     投影与勘误附记投影共用同一个规范文本集合——不会出现「快照出处未遮盖、
//     附记出处已遮盖」之类的混合结果；长路线 / 大版本读取也只做一次登记表
//     全表扫描，之后每条出处 O(1) 哈希命中，不逐条重复扫描；
//   - 编辑者原文视图与不可变快照完全不变：本模块只做读出投影，不写任何表，
//     持编辑口令的接口（版本原文、路线原文、附记链、恢复草稿）走各自原路径。
//
// 不阻塞其他进程写入：这里用的是**延迟事务**（BEGIN，而非 BEGIN IMMEDIATE），
// 只读不升级为写事务；在 WAL 模式下读持共享快照，与另一进程的写事务互不阻塞——
// 其他进程可随时正常发布 / 撤回 / 登记，读取也不会因为等写锁而失败。

const { getDb } = require('./db');
const { latestVersionNo, getVersionDetail } = require('./publish');
const { isRetracted, retractedVersionNoSet, latestVisibleVersionNo } = require('./retract');
const {
  redactedSourceSet,
  applyRedactionToVersion,
} = require('./redact');
const {
  effectiveErrataForVersion,
  applyRedactionToErrata,
} = require('./errata');
const { getRouteDetail, applyRedactionToRoute, listRoutes } = require('./route');

// 在同一已提交快照内执行一次公开读取：db.transaction 默认是延迟事务，
// 调用 fn 时事务已开启，fn 内所有 SELECT 共享同一 WAL 读快照。
// fn 只做只读操作；抛出的 { status, ... } 由路由层转成对应 HTTP 响应，
// 只读事务回滚不改变任何数据。
function inReadSnapshot(fn) {
  const db = getDb();
  return db.transaction(fn)();
}

// 把版本快照投影为访客视图：可见性已由调用方在同一快照内判定，
// 这里只做一次遮盖集合装载，并复用于版本内容与勘误附记两处投影。
function projectPublicVersion(no, redactedSet) {
  const version = applyRedactionToVersion(getVersionDetail(no), redactedSet);
  // 生效附记的目标展示信息取自同一快照的版本内容；附记出处共用同一遮盖集合
  version.errata = applyRedactionToErrata(effectiveErrataForVersion(no, version), redactedSet);
  return version;
}

// ---------- GET /api/public/chronicle：访客最新年表 ----------
// 返回：
//   { published:false, message }                       —— 从未发布
//   { published:false, allRetracted:true, message }   —— 已发布但全部撤回
//   { published:true, currentVersionNo, version }      —— 编号最大的未撤回版
// 「是否有版本」「最新可见版号」「版本内容」「生效附记」全部取自同一快照。
function publicChronicle() {
  return inReadSnapshot(() => {
    const no = latestVisibleVersionNo();
    if (no === 0) {
      const anyPublished = latestVersionNo() > 0;
      return {
        published: false,
        ...(anyPublished ? { allRetracted: true } : {}),
        message: anyPublished ? '尚无可读版本：已发布版本均已撤回' : '年表尚未发布任何版本',
      };
    }
    const redactedSet = redactedSourceSet();
    const version = projectPublicVersion(no, redactedSet);
    return { published: true, currentVersionNo: no, version };
  });
}

// ---------- GET /api/public/versions：访客版本清单 ----------
// 撤回集合、清单行与最新可见版号在同一快照内读出，
// 保证 currentVersionNo 与清单内容同源（不会清单含撤回版而版号已回退）。
function publicVersionList() {
  return inReadSnapshot(() => {
    const db = getDb();
    // 先读最新可见版号再取清单行：二者同快照同源（快照由读事务统一保证，
    // 这里显式固定顺序，避免版号与清单行取自相邻语句的不同时点）。
    const currentVersionNo = latestVisibleVersionNo();
    const retracted = retractedVersionNoSet();
    const rows = db
      .prepare(
        `SELECT version_no AS versionNo, parent_no AS parentNo, editor, note, published_at AS publishedAt
           FROM versions ORDER BY version_no DESC`
      )
      .all()
      .filter((v) => !retracted.has(v.versionNo));
    return { currentVersionNo, versions: rows };
  });
}

// ---------- GET /api/public/versions/:no：访客历史版本详情 ----------
// 版本不存在或在同一快照判定为已撤回 → 返回 null（路由层按 404 输出）。
// 撤回版的勘误附记随之不可见；未撤回版的内容与附记按同一遮盖集合投影。
function publicVersionDetail(no) {
  return inReadSnapshot(() => {
    const detail = getVersionDetail(no);
    if (!detail || isRetracted(no)) return null;
    return projectPublicVersion(no, redactedSourceSet());
  });
}

// ---------- GET /api/public/routes：访客路线清单 ----------
// 撤回集合与路线清单在同一快照内读出，引用撤回版的路线整体过滤掉。
function publicRouteList() {
  return inReadSnapshot(() => {
    const retracted = retractedVersionNoSet();
    return { routes: listRoutes().filter((r) => !retracted.has(r.versionNo)) };
  });
}

// ---------- GET /api/public/routes/:no：访客路线详情 ----------
// 路线不存在、或其所据版本在同一快照判定为已撤回 → 返回 null（404）。
// 路线骨架、所据版本快照展示字段与遮盖集合均取自同一快照。
function publicRouteDetail(no) {
  return inReadSnapshot(() => {
    const detail = getRouteDetail(no);
    if (!detail || isRetracted(detail.versionNo)) return null;
    return applyRedactionToRoute(detail, redactedSourceSet());
  });
}

module.exports = {
  inReadSnapshot,
  publicChronicle,
  publicVersionList,
  publicVersionDetail,
  publicRouteList,
  publicRouteDetail,
};
