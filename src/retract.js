'use strict';

// 版本撤回：编辑者发现已发布年表的编年依据错误时，按版本号与非空原因撤回该版。
//
// 数据层只在 version_retractions 追加审计记录，**不改写任何历史快照
// （versions / version_events / version_relations）或草稿，版本号也不复用**。
// 撤回在读出层动态生效：
//
//   - 访客最新年表指向**编号最大的未撤回版**；若全部已发布版本都被撤回，
//     公开接口返回「尚无可读版本」；
//   - 访客版本清单不含撤回版；访客读取指定撤回版、以及引用撤回版的专题路线，
//     一律按不存在处理（404）；
//   - 持编辑口令的接口（版本清单、版本原文、路线详情、恢复草稿）仍可见撤回版
//     原文、撤回原因与相关路线，不受影响；
//   - 即时发布与预约发布仍以**最高已发布版本号**（含撤回版）为基准，编号继续递增；
//   - 以已撤回版为冻结基准的待执行预约，到期执行时转为冲突，不生成新版本
//     （撤回与到期发布竞争时按事务提交顺序裁决：撤回先提交则预约转冲突；
//     发布先提交则新版本保留，撤回仅作用于指定版）。
//
// 同一版本至多一条撤回记录（UNIQUE 约束）：重复撤回幂等返回首次记录，
// 不覆盖原因、不重复落库。版本不存在（404）、原因非法（400）拒绝且不改状态。

const { getDb } = require('./db');
const { latestVersionNo } = require('./publish');

const MAX_REASON_LEN = 1000; // 与出处文本长度上限一致

// 空 / 非字符串 / 超长拒绝；返回 trim 后的原因文本。
function normalizeReason(reason) {
  if (typeof reason !== 'string') {
    throw { status: 400, message: 'reason（撤回原因）必须是非空字符串' };
  }
  const text = reason.trim();
  if (text === '') {
    throw { status: 400, message: '撤回原因不能为空：请说明该版编年依据的错误' };
  }
  if (text.length > MAX_REASON_LEN) {
    throw { status: 400, message: `撤回原因长度不能超过 ${MAX_REASON_LEN}` };
  }
  return text;
}

function rowToApi(row) {
  if (!row) return null;
  return {
    versionNo: row.version_no,
    reason: row.reason,
    editor: row.editor,
    retractedAt: row.retracted_at,
  };
}

// 指定版本的撤回记录；未撤回返回 null。
function getRetraction(versionNo) {
  const row = getDb()
    .prepare('SELECT * FROM version_retractions WHERE version_no = ?')
    .get(Number(versionNo));
  return rowToApi(row);
}

function isRetracted(versionNo) {
  return (
    getDb()
      .prepare('SELECT 1 FROM version_retractions WHERE version_no = ?')
      .get(Number(versionNo)) !== undefined
  );
}

// 全部已撤回版本号集合（公开读出层过滤用，数量级为版本条数）。
function retractedVersionNoSet() {
  return new Set(
    getDb().prepare('SELECT version_no AS no FROM version_retractions').all().map((r) => r.no)
  );
}

// 编号最大的未撤回版（访客视角的「最新年表」）；全部撤回或尚无版本时为 0。
function latestVisibleVersionNo() {
  const row = getDb()
    .prepare(
      `SELECT MAX(version_no) AS no FROM versions
        WHERE version_no NOT IN (SELECT version_no FROM version_retractions)`
    )
    .get();
  return row.no || 0;
}

// ---------- 确认撤回：事务内追加审计记录（只追加，不改快照/草稿） ----------
// 抛 { status, ...body } 表示 HTTP 错误。
function retractVersion({ versionNo, reason, editor = '' }) {
  const no = Number(versionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw { status: 400, message: 'versionNo 必须是正整数（已发布版本号）' };
  }
  const reasonText = normalizeReason(reason);

  const db = getDb();
  const tx = db.transaction(() => {
    // 版本不存在 → 404，不落库（事务回滚，状态不变）
    const version = db.prepare('SELECT version_no FROM versions WHERE version_no = ?').get(no);
    if (!version) {
      throw { status: 404, message: `版本 ${no} 不存在，无法撤回` };
    }
    // 重复撤回幂等：返回首次记录，不覆盖原因、不重复登记
    const existing = db
      .prepare('SELECT * FROM version_retractions WHERE version_no = ?')
      .get(no);
    if (existing) {
      return { alreadyRetracted: true, row: existing };
    }
    const info = db
      .prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)')
      .run(no, reasonText, String(editor || ''));
    const row = db.prepare('SELECT * FROM version_retractions WHERE id = ?').get(info.lastInsertRowid);
    return { alreadyRetracted: false, row };
  });
  const { alreadyRetracted, row } = tx();

  return {
    ok: true,
    alreadyRetracted,
    retraction: rowToApi(row),
    // 发布基准（含撤回版的最高版本号）与访客可见的最新版号，供编辑者核对
    currentVersionNo: latestVersionNo(),
    latestVisibleVersionNo: latestVisibleVersionNo(),
  };
}

// 已撤回版本清单（编辑者查看，含原因原文）。
function listRetractions() {
  return getDb()
    .prepare('SELECT * FROM version_retractions ORDER BY version_no DESC')
    .all()
    .map(rowToApi);
}

module.exports = {
  MAX_REASON_LEN,
  retractVersion,
  getRetraction,
  isRetracted,
  retractedVersionNoSet,
  latestVisibleVersionNo,
  listRetractions,
};
