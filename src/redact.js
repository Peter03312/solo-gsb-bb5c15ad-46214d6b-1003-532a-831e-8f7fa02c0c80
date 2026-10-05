'use strict';

// 编辑者按「出处原文」撤回其公开展示：只读预览 + 确认登记。
//
// 数据层只在 source_redactions 追加登记精确出处文本，**不改写任何历史快照
// （versions / version_events / version_relations）或草稿（events / claims /
// relations）**。遮盖在读出层动态生效：
//
//   - 公开访客接口（最新年表、历史版本、版本清单以外的快照详情、专题路线、
//     勘误附记）读出时，凡事件主张 source、「先于」关系 source、附记 source
//     与任一已登记文本**首尾空白折叠后相等**，一律显示为统一的
//     REDACTED_SOURCE（「出处已遮盖」），其余字段与版本号不变；
//   - 以后发布含同一文本（含仅首尾空白不同的写法）的新版本，因读出时动态比对，
//     自动遮盖，无需额外处理；
//   - 持编辑口令的接口（草稿状态、恢复预览、版本原文、发布返回）始终返回原文；
//   - 从历史版本恢复草稿复制的是快照原文，草稿区不受遮盖影响。
//
// 本轮匹配规则（修复首尾空白漏匹配）：
//   手工录入、整理包导入、并行会话提交保存的出处都可能带首尾空白
//   （录入 / 导入 / 会话路径均原样保留 source 的首尾空白字符），而编辑者
//   粘贴预览时通常没有这些空白。因此比较前对**两侧文本各自做首尾空白折叠**
//   （String.prototype.trim()：去除两端全部空白字符，含空格 / 制表 / 换行 /
//   全角空格等 JS 认定的空白）：
//     · 折叠后**严格相等**即命中——「  受访人李某  」与「受访人李某」视为同一出处；
//     · **内部空白与其他文字仍逐字精确区分**：trim 不触碰字符串内部，
//       「受访人 李某」≠「受访人  李某」（中间两个空格）、「李某」≠「李某 续」、
//       部分包含不命中；
//     · 空 / 纯空白文本不能登记（400），故快照中的空出处永远不会被遮盖。
//   登记文本以折叠后的规范文本存入 source_redactions（UNIQUE 不变）；
//   快照与草稿中的出处原文一律原样保留（编辑者原文视图、快照、恢复均不变）。
//
// 两阶段与恢复草稿 / 导入整包一致：
//   预览（previewSourceRedaction）只读：给出该文本在**全部已发布版本**
//     的事件主张与「先于」关系中命中的位置与数量（命中含仅首尾空白不同的写法），
//     以及当前最新版本号；每条命中附快照中实际保存的出处原文 source，
//     便于编辑者核对命中的空白变体；
//   确认（confirmSourceRedaction）须提交预览时的最新版本号 currentVersionNo：
//     - 空 / 纯空白文本 → 400；
//     - 预览后又发布了新版本（最新版本号变化）→ 409 VERSION_CONFLICT，不落库；
//     - 文本已登记过（首尾空白折叠后同一文本）→ 幂等返回已遮盖状态
//       （200，alreadyRedacted: true）。

const { getDb } = require('./db');
const { latestVersionNo } = require('./publish');

const REDACTED_SOURCE = '出处已遮盖';
const MAX_SOURCE_LEN = 1000; // 与出处录入长度上限一致

// 出处比较的唯一规范形式：去除两端全部空白字符（trim），内部一律不动。
// 登记文本、快照出处、草稿出处在比较前都过这一道；两侧 trim 后严格相等才视为同一出处。
function canonicalSourceText(source) {
  return String(source).trim();
}

// 判断一条库存出处（可能带首尾空白）是否命中已登记遮盖文本。
function sourceMatchesRedaction(storedSource, redactedSet) {
  if (storedSource == null) return false;
  return redactedSet.has(canonicalSourceText(storedSource));
}

// 空 / 非字符串 / 超长拒绝；返回 trim 后的规范文本（登记与命中比较都用它）。
function normalizeSourceText(source) {
  if (typeof source !== 'string') {
    throw { status: 400, message: 'source（出处原文）必须是非空字符串' };
  }
  const text = canonicalSourceText(source);
  if (text === '') {
    throw { status: 400, message: '出处原文不能为空：请输入要撤回公开展示的出处文本（首尾空白会自动折叠，内部空白须逐字一致）' };
  }
  if (text.length > MAX_SOURCE_LEN) {
    throw { status: 400, message: `出处原文长度不能超过 ${MAX_SOURCE_LEN}` };
  }
  return text;
}

function isRedacted(sourceText) {
  return getDb()
    .prepare('SELECT 1 FROM source_redactions WHERE source_text = ?')
    .get(sourceText) !== undefined;
}

// 全部已登记遮盖文本的**规范文本**集合（读出层动态遮盖用，数量级为出处条数）。
// 比较时库存出处同样先 canonicalSourceText 折叠首尾空白，再查集合。
function redactedSourceSet() {
  return new Set(
    getDb().prepare('SELECT source_text AS t FROM source_redactions').all().map((r) => r.t)
  );
}

// 公开读出层：把版本详情中命中的 source 统一替换为「出处已遮盖」，其余字段不动。
// 命中判定对库存出处做首尾空白折叠（内部空白仍须与登记文本逐字一致）。
function applyRedactionToVersion(version, redactedSet = redactedSourceSet()) {
  if (!version || redactedSet.size === 0) return version;
  const mask = (s) => (sourceMatchesRedaction(s, redactedSet) ? REDACTED_SOURCE : s);
  return {
    ...version,
    events: version.events.map((ev) => ({
      ...ev,
      source: mask(ev.source),
    })),
    relations: version.relations.map((rel) => ({
      ...rel,
      source: mask(rel.source),
    })),
  };
}

// 扫描单个版本快照中的命中位置（库存出处 trim 后与目标规范文本严格相等），只读。
// 命中行附库存原文 source（可能与目标差在首尾空白），供编辑者核对实际命中的写法。
function hitsInVersion(versionNo, sourceText) {
  const db = getDb();
  const versionIdRow = db.prepare('SELECT id FROM versions WHERE version_no = ?').get(versionNo);
  if (!versionIdRow) return null;
  const versionId = versionIdRow.id;

  const allEvents = db
    .prepare(
      `SELECT sort_order AS sortOrder, event_id AS eventId, title, source
         FROM version_events WHERE version_id = ? ORDER BY sort_order`
    )
    .all(versionId);
  const allRelations = db
    .prepare(
      `SELECT sort_order AS sortOrder, relation_id AS relationId,
              earlier_event_id AS earlierEventId, later_event_id AS laterEventId, source
         FROM version_relations WHERE version_id = ? ORDER BY sort_order`
    )
    .all(versionId);

  // 首尾空白折叠后相等即命中；内部空白 / 其他字符仍须逐字一致（trim 不改内部）
  const eventHits = allEvents
    .filter((row) => canonicalSourceText(row.source) === sourceText)
    .map((row) => ({
      sortOrder: row.sortOrder,
      eventId: row.eventId,
      title: row.title,
      source: row.source,
    }));
  const relationHits = allRelations
    .filter((row) => canonicalSourceText(row.source) === sourceText)
    .map((row) => ({
      sortOrder: row.sortOrder,
      relationId: row.relationId,
      earlierEventId: row.earlierEventId,
      laterEventId: row.laterEventId,
      source: row.source,
    }));

  return {
    versionNo,
    eventHitCount: eventHits.length,
    relationHitCount: relationHits.length,
    totalHitCount: eventHits.length + relationHits.length,
    eventHits,
    relationHits,
  };
}

// 草稿区（未发布）中的命中：仅供编辑参考——确认后这些内容发布时会自动遮盖。
// 命中规则与已发布版本一致（首尾空白折叠相等；内部逐字精确）。
// 预览主体仍只统计「全部已发布版本」（需求：在已发布版本的事件主张与先于关系中命中）。
function draftHits(sourceText) {
  const db = getDb();
  const allClaims = db
    .prepare(
      `SELECT c.id AS claimId, c.event_id AS eventId, e.title, c.source
         FROM claims c JOIN events e ON e.id = c.event_id
        ORDER BY c.id`
    )
    .all();
  const allRelations = db
    .prepare(
      `SELECT id AS relationId, earlier_id AS earlierEventId, later_id AS laterEventId, source
         FROM relations ORDER BY id`
    )
    .all();
  const claimHits = allClaims
    .filter((row) => canonicalSourceText(row.source) === sourceText)
    .map((row) => ({
      claimId: row.claimId,
      eventId: row.eventId,
      title: row.title,
      source: row.source,
    }));
  const relationHits = allRelations
    .filter((row) => canonicalSourceText(row.source) === sourceText)
    .map((row) => ({
      relationId: row.relationId,
      earlierEventId: row.earlierEventId,
      laterEventId: row.laterEventId,
      source: row.source,
    }));
  return {
    claimHitCount: claimHits.length,
    relationHitCount: relationHits.length,
    totalHitCount: claimHits.length + relationHits.length,
    claimHits,
    relationHits,
  };
}

function buildHitsResult(sourceText, { includeDraft = false } = {}) {
  const db = getDb();
  const versionNos = db
    .prepare('SELECT version_no AS no FROM versions ORDER BY version_no')
    .all()
    .map((r) => r.no);
  const versions = versionNos.map((no) => hitsInVersion(no, sourceText));
  const totalEventHits = versions.reduce((n, v) => n + v.eventHitCount, 0);
  const totalRelationHits = versions.reduce((n, v) => n + v.relationHitCount, 0);
  return {
    source: sourceText,
    currentVersionNo: latestVersionNo(),
    versionCount: versionNos.length,
    totalEventHitCount: totalEventHits,
    totalRelationHitCount: totalRelationHits,
    totalHitCount: totalEventHits + totalRelationHits,
    versions,
    ...(includeDraft ? { draft: draftHits(sourceText) } : {}),
  };
}

// ---------- 只读预览：不写任何数据 ----------
function previewSourceRedaction(source) {
  const sourceText = normalizeSourceText(source);
  return {
    ok: true,
    alreadyRedacted: isRedacted(sourceText),
    ...buildHitsResult(sourceText, { includeDraft: true }),
  };
}

// ---------- 确认：事务内登记遮盖文本（只追加） ----------
// expectedLatestVersionNo: 预览时返回的 currentVersionNo。
// 抛 { status, ...body } 表示 HTTP 错误。
function confirmSourceRedaction({ source, expectedLatestVersionNo, editor = '' }) {
  const sourceText = normalizeSourceText(source);
  const expected = Number(expectedLatestVersionNo);
  if (!Number.isInteger(expected) || expected < 0) {
    throw { status: 400, message: 'currentVersionNo 必须是非负整数（取预览时返回的值）' };
  }

  const db = getDb();
  let alreadyRedacted = false;
  let redactedAt = null;

  const tx = db.transaction(() => {
    const existing = db
      .prepare('SELECT created_at AS createdAt FROM source_redactions WHERE source_text = ?')
      .get(sourceText);
    if (existing) {
      // 重复确认幂等：不做任何写入，直接返回已遮盖状态（优先于版本冲突检查）。
      // 登记文本按 trim 后的规范文本存储，故「  X 」与「X」的重复确认在此归一。
      alreadyRedacted = true;
      redactedAt = existing.createdAt;
      return;
    }
    // 事务内重新确认最新版本号：预览后若有人发布了新版本，必须重新预览再确认
    const latest = latestVersionNo();
    if (expected !== latest) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `版本冲突：你预览遮盖时最新是第 ${expected} 版，现在已是第 ${latest} 版。请重新预览命中范围后再确认。`,
        currentVersionNo: latest,
        expectedVersionNo: expected,
      };
    }
    const info = db
      .prepare('INSERT INTO source_redactions (source_text, editor) VALUES (?, ?)')
      .run(sourceText, String(editor || ''));
    redactedAt = db.prepare('SELECT created_at AS t FROM source_redactions WHERE id = ?').get(info.lastInsertRowid).t;
  });
  tx();

  return {
    ok: true,
    alreadyRedacted,
    redactedAt,
    redactedLabel: REDACTED_SOURCE,
    ...buildHitsResult(sourceText, { includeDraft: false }),
  };
}

// 已登记遮盖清单（编辑者查看，原文仅在持口令接口返回）。
function listRedactions() {
  return getDb()
    .prepare(
      `SELECT id, source_text AS source, editor, created_at AS redactedAt
         FROM source_redactions ORDER BY id DESC`
    )
    .all()
    .map((r) => ({ id: r.id, source: r.source, editor: r.editor, redactedAt: r.redactedAt }));
}

module.exports = {
  REDACTED_SOURCE,
  MAX_SOURCE_LEN,
  canonicalSourceText,
  sourceMatchesRedaction,
  previewSourceRedaction,
  confirmSourceRedaction,
  applyRedactionToVersion,
  redactedSourceSet,
  listRedactions,
};
