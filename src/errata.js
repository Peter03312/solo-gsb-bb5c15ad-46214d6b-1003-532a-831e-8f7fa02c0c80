'use strict';

// 勘误附记：编辑者对**指定已发布版本**中的事件或「先于」关系登记附记（说明 + 出处）。
//
// 数据层只在 errata 表追加记录，**不改写任何历史快照（versions / version_events /
// version_relations）、求解日期或草稿**：
//
//   - 附记只属于目标版：从该版恢复草稿、以后发布的新版本都不继承附记；
//   - 同一目标（版本号 + 对象类型 + 对象 id）只展示**最新生效附记**；
//   - 替代时须提交所见附记号（replacesErrataId）：事务内核对该目标当前生效附记号，
//     不一致即 409 ERRATA_CONFLICT 并返回当前生效附记，**不落库**——两名编辑者同时
//     替代时仅先提交者成功；旧附记全部保留（replaces_errata_id 形成替代链）供追溯；
//   - 访客读取目标版或最新年表时可见生效附记，附记出处沿用 source_redactions 的
//     出处遮盖规则（库存出处与登记文本各自 trim 后严格相等即命中，首尾空白折叠、
//     内部空白仍逐字区分；命中显示「出处已遮盖」，读出时动态比对）；
//   - 目标版已撤回时拒绝登记；撤回后访客不再看到该版及其附记（随版本读出层隐藏），
//     编辑者持口令仍可查原文与完整替代链。
//
// 抛 { status, ...body } 表示 HTTP 错误。

const { getDb } = require('./db');
const { redactedSourceSet, sourceMatchesRedaction, REDACTED_SOURCE } = require('./redact');

const MAX_NOTE_LEN = 2000; // 与考异备注长度上限一致
const MAX_SOURCE_LEN = 1000; // 与出处录入长度上限一致
const TARGET_TYPES = ['event', 'relation'];

// 空 / 非字符串 / 超长拒绝；返回 trim 后的文本。
function normalizeNote(note) {
  if (typeof note !== 'string') {
    throw { status: 400, message: 'note（勘误说明）必须是非空字符串' };
  }
  const text = note.trim();
  if (text === '') {
    throw { status: 400, message: '勘误说明不能为空：请填写对该版该对象的勘误内容' };
  }
  if (text.length > MAX_NOTE_LEN) {
    throw { status: 400, message: `勘误说明长度不能超过 ${MAX_NOTE_LEN}` };
  }
  return text;
}

function normalizeSource(source) {
  if (typeof source !== 'string') {
    throw { status: 400, message: 'source（勘误出处）必须是非空字符串' };
  }
  const text = source.trim();
  if (text === '') {
    throw { status: 400, message: '勘误出处不能为空：请注明勘误依据（受访人 / 档案 / 页码等）' };
  }
  if (text.length > MAX_SOURCE_LEN) {
    throw { status: 400, message: `勘误出处长度不能超过 ${MAX_SOURCE_LEN}` };
  }
  return text;
}

function rowToApi(row) {
  if (!row) return null;
  return {
    errataId: row.id,
    versionNo: row.version_no,
    targetType: row.target_type,
    targetId: row.target_id,
    note: row.note,
    source: row.source,
    editor: row.editor,
    replacesErrataId: row.replaces_errata_id,
    createdAt: row.created_at,
  };
}

// 该目标当前生效附记（替代链为线性：每条新附记替代上一条生效附记，故 id 最大者生效）。
function effectiveRow(db, versionNo, targetType, targetId) {
  return db
    .prepare(
      `SELECT * FROM errata
        WHERE version_no = ? AND target_type = ? AND target_id = ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(versionNo, targetType, targetId);
}

// 目标对象在该版快照中的展示信息（事件标题 / 关系两端事件标题），供查阅与公开读出。
function targetInfo(version, targetType, targetId) {
  if (targetType === 'event') {
    const ev = (version.events || []).find((e) => e.eventId === targetId);
    return ev ? { eventId: ev.eventId, title: ev.title } : null;
  }
  const rel = (version.relations || []).find((r) => r.relationId === targetId);
  if (!rel) return null;
  const titleById = new Map((version.events || []).map((e) => [e.eventId, e.title]));
  return {
    relationId: rel.relationId,
    earlierEventId: rel.earlierEventId,
    laterEventId: rel.laterEventId,
    earlierTitle: titleById.get(rel.earlierEventId) || '',
    laterTitle: titleById.get(rel.laterEventId) || '',
  };
}

// ---------- 登记附记：事务内校验 + 乐观并发（只追加，不改快照/草稿） ----------
// replacesErrataId：登记时所见的目标当前生效附记号；目标尚无附记时省略（或传 null）。
// 与事务内当前生效附记号不一致 → 409 ERRATA_CONFLICT（附当前生效附记），不落库。
function registerErrata({ versionNo, targetType, targetId, note, source, editor = '', replacesErrataId }) {
  const no = Number(versionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw { status: 400, message: 'versionNo 必须是正整数（已发布版本号）' };
  }
  if (!TARGET_TYPES.includes(targetType)) {
    throw { status: 400, message: `targetType 必须是 ${TARGET_TYPES.join(' 或 ')}（事件 / 「先于」关系）` };
  }
  const tid = Number(targetId);
  if (!Number.isInteger(tid) || tid < 1) {
    throw { status: 400, message: 'targetId 必须是正整数（该版快照中的事件 id / 关系 id）' };
  }
  const noteText = normalizeNote(note);
  const sourceText = normalizeSource(source);
  let expected = null;
  if (replacesErrataId !== null && replacesErrataId !== undefined) {
    expected = Number(replacesErrataId);
    if (!Number.isInteger(expected) || expected < 1) {
      throw { status: 400, message: 'replacesErrataId 必须是正整数（登记时所见的生效附记号）' };
    }
  }

  const db = getDb();
  const tx = db.transaction(() => {
    // 版本不存在 → 404，不落库
    const version = db
      .prepare('SELECT id, version_no FROM versions WHERE version_no = ?')
      .get(no);
    if (!version) {
      throw { status: 404, message: `版本 ${no} 不存在，无法登记勘误附记` };
    }
    // 目标版已撤回 → 拒绝登记（撤回版不再公开展示，附记无落点）
    const retracted = db
      .prepare('SELECT 1 FROM version_retractions WHERE version_no = ?')
      .get(no);
    if (retracted) {
      throw {
        status: 409,
        code: 'VERSION_RETRACTED',
        message: `第 ${no} 版已撤回公开展示，不能对其登记勘误附记。请修正后发布新版本，再对新版登记。`,
        versionNo: no,
      };
    }
    // 对象必须属于该版快照
    const inVersion =
      targetType === 'event'
        ? db
            .prepare('SELECT 1 FROM version_events WHERE version_id = ? AND event_id = ?')
            .get(version.id, tid)
        : db
            .prepare('SELECT 1 FROM version_relations WHERE version_id = ? AND relation_id = ?')
            .get(version.id, tid);
    if (!inVersion) {
      throw {
        status: 422,
        code: 'ERRATA_TARGET_NOT_IN_VERSION',
        message:
          targetType === 'event'
            ? `事件 ${tid} 不在第 ${no} 版快照中，无法登记勘误附记`
            : `「先于」关系 ${tid} 不在第 ${no} 版快照中，无法登记勘误附记`,
        versionNo: no,
        targetType,
        targetId: tid,
      };
    }
    // 乐观并发：事务内核对当前生效附记号与所见附记号
    const current = effectiveRow(db, no, targetType, tid);
    const currentId = current ? current.id : null;
    if (currentId !== expected) {
      throw {
        status: 409,
        code: 'ERRATA_CONFLICT',
        message: current
          ? `附记冲突：该目标当前生效附记是 #${current.id}（你提交时所见的是 ${expected === null ? '「尚无附记」' : `#${expected}`}）。请查看当前生效附记后再决定是否替代，本次未落库。`
          : `附记冲突：你提交时所见的附记 #${expected} 已不存在（该目标当前尚无生效附记）。请刷新后再登记，本次未落库。`,
        current: rowToApi(current),
      };
    }
    const info = db
      .prepare(
        `INSERT INTO errata (version_no, target_type, target_id, note, source, editor, replaces_errata_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(no, targetType, tid, noteText, sourceText, String(editor || ''), currentId);
    const row = db.prepare('SELECT * FROM errata WHERE id = ?').get(info.lastInsertRowid);
    return { row, replaced: current };
  });
  const { row, replaced } = tx();

  return {
    ok: true,
    errata: rowToApi(row),
    replaced: rowToApi(replaced), // 被替代的前一条生效附记（首条为 null），保留在库中供追溯
  };
}

// ---------- 读取 ----------
// 指定版本全部附记，按目标分组：每组含当前生效附记与完整替代链（旧 → 新），原文不遮盖。
// 版本不存在返回 null。
function listErrataForVersion(versionNo, versionDetail) {
  const db = getDb();
  const no = Number(versionNo);
  const rows = db
    .prepare('SELECT * FROM errata WHERE version_no = ? ORDER BY id')
    .all(no);

  const groups = new Map(); // key -> {targetType, targetId, chain}
  for (const row of rows) {
    const key = `${row.target_type}:${row.target_id}`;
    if (!groups.has(key)) {
      groups.set(key, { targetType: row.target_type, targetId: row.target_id, chain: [] });
    }
    groups.get(key).chain.push(rowToApi(row));
  }

  const targets = [...groups.values()].map((g) => ({
    targetType: g.targetType,
    targetId: g.targetId,
    target: versionDetail ? targetInfo(versionDetail, g.targetType, g.targetId) : null,
    effective: g.chain[g.chain.length - 1],
    chain: g.chain,
  }));

  return { versionNo: no, targets, totalCount: rows.length };
}

// 单条附记 + 其所在目标的完整替代链（编辑者追溯用，原文不遮盖）。不存在返回 null。
function getErrataWithChain(errataId, versionDetail) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM errata WHERE id = ?').get(Number(errataId));
  if (!row) return null;
  const chain = db
    .prepare(
      `SELECT * FROM errata
        WHERE version_no = ? AND target_type = ? AND target_id = ? ORDER BY id`
    )
    .all(row.version_no, row.target_type, row.target_id)
    .map(rowToApi);
  return {
    errata: rowToApi(row),
    versionNo: row.version_no,
    targetType: row.target_type,
    targetId: row.target_id,
    target: versionDetail ? targetInfo(versionDetail, row.target_type, row.target_id) : null,
    effective: chain[chain.length - 1],
    chain,
  };
}

// 指定版本各目标的**生效附记**（每目标至多一条），附目标展示信息；供公开读出层与
// 编辑者版本原文视图使用。source 在此不遮盖，由调用方按需应用遮盖规则。
function effectiveErrataForVersion(versionNo, versionDetail) {
  const db = getDb();
  const no = Number(versionNo);
  const rows = db
    .prepare(
      `SELECT e.* FROM errata e
        WHERE e.version_no = ?
          AND e.id = (
            SELECT MAX(id) FROM errata
            WHERE version_no = e.version_no AND target_type = e.target_type AND target_id = e.target_id
          )
        ORDER BY e.id`
    )
    .all(no);
  return rows.map((row) => ({
    ...rowToApi(row),
    target: versionDetail ? targetInfo(versionDetail, row.target_type, row.target_id) : null,
  }));
}

// 公开读出层：附记出处命中遮盖登记的统一显示「出处已遮盖」，其余字段不动。
// 命中规则与版本 / 路线读出一致：库存出处（可能带首尾空白）trim 后与登记文本严格相等。
function applyRedactionToErrata(items, redactedSet = redactedSourceSet()) {
  if (!items || redactedSet.size === 0) return items;
  return items.map((it) => ({
    ...it,
    source: sourceMatchesRedaction(it.source, redactedSet) ? REDACTED_SOURCE : it.source,
  }));
}

module.exports = {
  MAX_NOTE_LEN,
  MAX_SOURCE_LEN,
  TARGET_TYPES,
  registerErrata,
  listErrataForVersion,
  getErrataWithChain,
  effectiveErrataForVersion,
  applyRedactionToErrata,
};
