'use strict';

// 公开读取统一流程（访客：最新年表 / 历史版本 / 版本清单 / 专题路线）。
//
// 本轮修复的并发问题（两个服务进程共用同一 SQLite 文件时）：
//   修复前，一次公开读取把「最新可见版本号、撤回登记、版本快照、遮盖登记、
//   生效勘误附记、路线骨架」分多条 SELECT 各自读出——每条语句各取最新 WAL
//   快照。读取期间另一服务进程若**发布新版本、撤回版本、登记出处遮盖或
//   替代勘误附记**，响应就可能混合不同已提交状态：例如版本号取自撤回前、
//   遮盖判定取自遮盖登记后，或附记列表与版本内容不属于同一数据库状态。
//
// 修复后，每个公开读取请求只走一条统一流程：
//
//   1. **同一快照**：整份响应在同一只读事务（同一 WAL 快照）内组装——
//      可见性判定（撤回版及引用它的路线不可见）、版本 / 路线 / 附记内容、
//      遮盖登记全部对应**同一个已提交的数据库状态**。读取期间另一进程的
//      任何提交，只会让整份响应整体落在其提交前或提交后，绝不混合版本
//      可见性、出处遮盖与附记。
//   2. **登记只读一次**：撤回版本号集合与遮盖出处集合在事务开头各读入
//      一个 Set，此后版本事件 / 关系 / 附记 / 路线的每行命中判定都是
//      O(1) 集合查询——长路线与大版本不会逐条重复扫描全部遮盖登记。
//   3. **不阻塞写入**：只读事务（deferred）不取写锁，WAL 模式下读写互不
//      阻塞，另一进程可正常发布 / 撤回 / 登记遮盖 / 替代附记。
//
// 兼容性：五个公开接口的路径、状态码、响应字段与「未发布 / 全部撤回 /
// 对象不存在」的结果与修复前完全一致；撤回版及引用它的路线仍按不存在
// 处理（404），命中遮盖登记的出处仍显示「出处已遮盖」；持编辑口令的
// 原文视图与不可变快照不经过本模块，行为不变。

const { getDb } = require('./db');
const { latestVersionNo, getVersionDetail } = require('./publish');
const { retractedVersionNoSet, latestVisibleVersionNo } = require('./retract');
const { redactedSourceSet, applyRedactionToVersion } = require('./redact');
const { effectiveErrataForVersion, applyRedactionToErrata } = require('./errata');
const { getRouteDetail, applyRedactionToRoute, listRoutes } = require('./route');

// 一次公开读取的上下文：在同一只读事务内各读一次，之后该请求的全部
// 可见性判定与内容投影只使用这份上下文（不再触碰数据库）。
//   latestVersionNo        最高已发布版本号（含撤回版）
//   latestVisibleVersionNo 访客可见的最新版（编号最大的未撤回版，无则 0）
//   retracted              已撤回版本号集合（可见性判定）
//   redacted               已登记遮盖出处规范文本集合（内容投影）
function loadPublicContext() {
  return {
    latestVersionNo: latestVersionNo(),
    latestVisibleVersionNo: latestVisibleVersionNo(),
    retracted: retractedVersionNoSet(),
    redacted: redactedSourceSet(),
  };
}

// 统一入口：fn 在同一只读事务（deferred，同一 WAL 快照）内执行。
// 只发 SELECT、不取写锁，不阻塞其他进程写入；fn 抛错时事务回滚（本就只有读）。
function inSingleSnapshot(fn) {
  const db = getDb();
  return db.transaction(fn)();
}

// 版本投影：快照内容 + 该版各目标生效附记，统一应用出处遮盖。
// 遮盖判定使用上下文中的同一份登记集合（整请求只读一次登记）。
function projectVersion(ctx, version) {
  const projected = applyRedactionToVersion(version, ctx.redacted);
  // 附记目标信息只取标题（不参与遮盖），传投影后的版本与原文等价
  projected.errata = applyRedactionToErrata(
    effectiveErrataForVersion(version.versionNo, projected),
    ctx.redacted
  );
  return projected;
}

// GET /api/public/chronicle —— 最新年表：编号最大的未撤回版完整快照。
// 尚无版本 → { published:false }；全部撤回 → { published:false, allRetracted:true }。
function readPublicChronicle() {
  return inSingleSnapshot(() => {
    const ctx = loadPublicContext();
    const no = ctx.latestVisibleVersionNo;
    if (no === 0) {
      const anyPublished = ctx.latestVersionNo > 0;
      return {
        published: false,
        ...(anyPublished ? { allRetracted: true } : {}),
        message: anyPublished ? '尚无可读版本：已发布版本均已撤回' : '年表尚未发布任何版本',
      };
    }
    // 同一快照内该版本必存在（latestVisibleVersionNo 由同一事务算出）
    const version = projectVersion(ctx, getVersionDetail(no));
    return { published: true, currentVersionNo: no, version };
  });
}

// GET /api/public/versions —— 版本清单（不含撤回版），附访客可见的最新版号。
function readPublicVersionList() {
  return inSingleSnapshot(() => {
    const ctx = loadPublicContext();
    const rows = getDb()
      .prepare(
        `SELECT version_no AS versionNo, parent_no AS parentNo, editor, note, published_at AS publishedAt
           FROM versions ORDER BY version_no DESC`
      )
      .all()
      .filter((v) => !ctx.retracted.has(v.versionNo));
    return { currentVersionNo: ctx.latestVisibleVersionNo, versions: rows };
  });
}

// GET /api/public/versions/:no —— 指定历史版本；撤回版按不存在处理（返回 null → 404）。
function readPublicVersion(no) {
  return inSingleSnapshot(() => {
    const ctx = loadPublicContext();
    // 撤回版对访客按不存在处理（其勘误附记随之不可见）；先查集合避免读大快照
    if (ctx.retracted.has(no)) return null;
    const detail = getVersionDetail(no);
    if (!detail) return null;
    return { version: projectVersion(ctx, detail) };
  });
}

// GET /api/public/routes —— 路线清单（不含引用撤回版的路线）。
function readPublicRouteList() {
  return inSingleSnapshot(() => {
    const ctx = loadPublicContext();
    return { routes: listRoutes().filter((r) => !ctx.retracted.has(r.versionNo)) };
  });
}

// GET /api/public/routes/:no —— 路线详情；引用撤回版的路线按不存在处理（null → 404）。
function readPublicRoute(no) {
  return inSingleSnapshot(() => {
    const ctx = loadPublicContext();
    const detail = getRouteDetail(no);
    if (!detail || ctx.retracted.has(detail.versionNo)) return null;
    return { route: applyRedactionToRoute(detail, ctx.redacted) };
  });
}

module.exports = {
  readPublicChronicle,
  readPublicVersionList,
  readPublicVersion,
  readPublicRouteList,
  readPublicRoute,
};
