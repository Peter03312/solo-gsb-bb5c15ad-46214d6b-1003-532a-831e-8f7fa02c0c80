'use strict';

const { getDb } = require('./db');
const { solve, claimToInterval } = require('./solver');
const { isoFromOrdinal } = require('./dates');

// 当前草稿修订号（events/claims/relations 任一增删改都由触发器推进）。
// 与 restore.js 的 draftRevisionNo 同表同列；这里就地查询以避免顶层循环依赖。
function readDraftRevision() {
  return getDb().prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
}

// 409 草稿冲突：发布 / 预约组装快照所依据的草稿状态在读取与写入之间已被另一进程改写。
// 明确返回冲突，调用方整次不生成版本或预约；编辑者刷新草稿、重新确认选择后重试。
function draftConflictError({ kind, expected, current }) {
  return {
    status: 409,
    code: 'DRAFT_REVISION_CONFLICT',
    message:
      `草稿冲突：${kind}读取草稿（事件 / 主张 / 关系 / 求解日期 / 修订号）后，草稿已被另一操作改动` +
      `（修订号 ${expected} → ${current}）。本次${kind}已整体取消，未生成任何版本或预约；请重新查看最新草稿并确认选择后再试。`,
    currentRevisionNo: current,
    expectedRevisionNo: expected,
  };
}

// 以 BEGIN IMMEDIATE 运行写入事务，返回其返回值。
// 写锁等待超时（另一进程长时间持有写事务）也按「无法取得一致草稿状态」处理：
// 抛 DRAFT_REVISION_CONFLICT，语义与修订号过期相同——刷新后重试，绝不冻结混合内容。
function commitImmediateWithConflict(db, fn, { kind }) {
  const tx = db.transaction(fn);
  try {
    return tx.immediate();
  } catch (err) {
    if (err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED')) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message:
          `草稿冲突：${kind}提交时另一进程正在修改草稿，未能取得一致草稿状态。` +
          '本次操作已整体取消，未生成任何版本或预约；请重新查看最新草稿并确认选择后再试。',
      };
    }
    throw err;
  }
}

// 组装草稿现状并求解；不写库。
// 事件、全部主张、「先于」关系与草稿修订号在同一个只读事务（同一快照）内读出，
// 保证一次操作使用同一草稿状态：即便另一进程在读取期间改写事件与主张，
// 这里也不会读到从未同时存在过的混合内容。
function evaluateDraft(selectionList) {
  const db = getDb();

  const read = db.transaction(() => {
    const revisionNo = readDraftRevision();
    const events = db.prepare('SELECT id, title, description FROM events ORDER BY id').all();
    const claims = db.prepare('SELECT * FROM claims').all();
    const relations = db
      .prepare('SELECT id, earlier_id AS earlierId, later_id AS laterId, source, note FROM relations ORDER BY id')
      .all();
    return { revisionNo, events, claims, relations };
  });

  const { revisionNo, events, claims, relations } = read();

  const claimsById = new Map(claims.map((c) => [c.id, c]));
  const selected = new Map();
  const badSelection = [];

  for (const item of selectionList) {
    const claim = claimsById.get(item.claimId);
    if (!claim || claim.event_id !== item.eventId) {
      badSelection.push(item.eventId);
      continue;
    }
    selected.set(item.eventId, claimToInterval(claim));
  }

  if (badSelection.length) {
    const titles = new Map(events.map((e) => [e.id, e.title]));
    return {
      ok: false,
      errors: badSelection.map((eid) => ({
        type: 'bad_selection',
        eventIds: [eid],
        relationIds: [],
        message: `事件「${titles.get(eid) || eid}」选定的主张不存在或不属于该事件`,
      })),
      revisionNo,
      events,
      claims,
      relations,
    };
  }

  const result = solve(events, selected, relations);
  return { ...result, revisionNo, events, claims, relations, selected };
}

// 由求解结果构造可直接入库 / 冻结的快照数据（不写库）。
// 立即发布与预约发布共用本函数，保证两条路径写出的快照语义完全一致。
// 返回 { eventRows, relationRows }，eventRows 已按求解日期升序（sort_order 即数组下标）。
function buildFrozenSnapshot(evalResult) {
  const { dates, events, selected, relations, claims } = evalResult;

  const sorted = [...events].sort((a, b) => {
    const da = dates.get(a.id);
    const db2 = dates.get(b.id);
    if (da !== db2) return da - db2;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  // 主张按 id 索引，避免长链草稿下逐事件线性查找（O(n²)）
  const claimsById = new Map(claims.map((c) => [c.id, c]));
  const eventRows = sorted.map((ev, i) => {
    const sel = selected.get(ev.id);
    const claimRow = claimsById.get(sel.claimId);
    return {
      eventId: ev.id,
      title: ev.title,
      description: ev.description || '',
      claimId: claimRow.id,
      precision: claimRow.precision,
      dateLabel: claimRow.date_label,
      intervalStart: claimRow.interval_start,
      intervalEnd: claimRow.interval_end,
      resolvedDate: isoFromOrdinal(dates.get(ev.id)),
      source: claimRow.source,
      claimNote: claimRow.note || '',
      sortOrder: i,
    };
  });

  const eventOrder = new Map(sorted.map((ev, i) => [ev.id, i]));
  const sortedRels = [...relations].sort(
    (a, b) =>
      eventOrder.get(a.earlierId) - eventOrder.get(b.earlierId) ||
      eventOrder.get(a.laterId) - eventOrder.get(b.laterId)
  );
  const relationRows = sortedRels.map((r, i) => ({
    relationId: r.id,
    earlierEventId: r.earlierId,
    laterEventId: r.laterId,
    source: r.source || '',
    note: r.note || '',
    sortOrder: i,
  }));

  return { eventRows, relationRows };
}

// 在调用方事务内，把冻结快照写成版本号 newNo 的不可变版本。
// 调用方须自行做基准版本号冲突检查并预先确定 newNo。
function insertVersionFromSnapshot({ db, newNo, parentNo, editor, note, snapshot }) {
  const verInfo = db
    .prepare('INSERT INTO versions (version_no, parent_no, editor, note) VALUES (?, ?, ?, ?)')
    .run(newNo, parentNo, String(editor || ''), String(note || ''));
  const versionId = verInfo.lastInsertRowid;

  const insEvent = db.prepare(`
    INSERT INTO version_events
      (version_id, event_id, title, description, claim_id, precision, date_label,
       interval_start, interval_end, resolved_date, source, claim_note, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const e of snapshot.eventRows) {
    insEvent.run(
      versionId,
      e.eventId,
      e.title,
      e.description,
      e.claimId,
      e.precision,
      e.dateLabel,
      e.intervalStart,
      e.intervalEnd,
      e.resolvedDate,
      e.source,
      e.claimNote,
      e.sortOrder
    );
  }

  const insRel = db.prepare(`
    INSERT INTO version_relations
      (version_id, relation_id, earlier_event_id, later_event_id, source, note, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of snapshot.relationRows) {
    insRel.run(versionId, r.relationId, r.earlierEventId, r.laterEventId, r.source, r.note, r.sortOrder);
  }
  return versionId;
}

// 发布一个新版本。selectionList: [{eventId, claimId}]
// baseVersionNo: 编辑者发起修改时所基于的版本号；null/0 表示尚无版本。
// 抛 { status, ...body } 表示 HTTP 错误。
//
// 并发正确性（两进程共用同一库）：
//   事件 / 所选主张 / 关系 / 求解日期 / 草稿修订号先在同一快照内读出（evaluateDraft），
//   随后在 BEGIN IMMEDIATE 写事务内再次核对草稿修订号——快照之后草稿若被另一进程
//   改动过（含事件与主张在两次读取之间被一次性改动的情形），返回 409 草稿冲突，
//   整次不生成版本；冻结进版本的内容必定来自某个真实同时存在过的草稿状态。
//   基准版本号冲突仍按既有 409 VERSION_CONFLICT 语义处理（先草稿后版本）。
function publishVersion({ selectionList, baseVersionNo, editor, note }) {
  const db = getDb();

  if (!Array.isArray(selectionList) || selectionList.length === 0) {
    throw { status: 400, message: '请为每个事件选择一条主张后再发布' };
  }

  const base = Number(baseVersionNo || 0);

  const evalResult = evaluateDraft(selectionList);
  if (!evalResult.ok) {
    throw {
      status: 422,
      message: '年表无法发布，请先修正下列问题（上一已发布版本保持不变）',
      errors: evalResult.errors,
    };
  }
  const snapshot = buildFrozenSnapshot(evalResult);
  const expectedRevision = evalResult.revisionNo;

  // BEGIN IMMEDIATE + 事务内再确认草稿修订号与基准版本，避免并发下冻结混合内容或静默覆盖
  const newNo = commitImmediateWithConflict(db, () => {
    const revision = readDraftRevision();
    if (expectedRevision !== revision) {
      throw draftConflictError({ kind: '发布', expected: expectedRevision, current: revision });
    }

    const row = db.prepare('SELECT MAX(version_no) AS no FROM versions').get();
    const latest = row.no || 0;
    if (base !== latest) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `版本冲突：你基于第 ${base} 版修改，但当前最新已是第 ${latest} 版。请重新查看最新版本并确认你的选择后再发布。`,
        currentVersionNo: latest,
        baseVersionNo: base,
        currentVersion: getVersionSummary(latest),
      };
    }

    const nextNo = latest + 1;
    insertVersionFromSnapshot({ db, newNo: nextNo, parentNo: base, editor, note, snapshot });
    return nextNo;
  }, { kind: '发布' });

  return { versionNo: newNo, version: getVersionDetail(newNo) };
}

function latestVersionNo() {
  const row = getDb().prepare('SELECT MAX(version_no) AS no FROM versions').get();
  return row.no || 0;
}

function getVersionSummary(no) {
  const db = getDb();
  const v = db
    .prepare(
      `SELECT v.version_no AS versionNo, v.parent_no AS parentNo, v.editor, v.note, v.published_at AS publishedAt,
              (SELECT COUNT(*) FROM version_events WHERE version_id = v.id) AS eventCount,
              (SELECT COUNT(*) FROM version_relations WHERE version_id = v.id) AS relationCount
         FROM versions v WHERE v.version_no = ?`
    )
    .get(no);
  return v || null;
}

function getVersionDetail(no) {
  const db = getDb();
  const summary = getVersionSummary(no);
  if (!summary) return null;
  const listEvents = db
    .prepare(
      `SELECT event_id AS eventId, title, description, claim_id AS claimId, precision,
              date_label AS dateLabel, interval_start AS intervalStart,
              interval_end AS intervalEnd, resolved_date AS resolvedDate,
              source, claim_note AS claimNote
         FROM version_events WHERE version_id = (SELECT id FROM versions WHERE version_no = ?)
        ORDER BY sort_order`
    )
    .all(no);
  const listRels = db
    .prepare(
      `SELECT relation_id AS relationId, earlier_event_id AS earlierEventId,
              later_event_id AS laterEventId, source, note
         FROM version_relations WHERE version_id = (SELECT id FROM versions WHERE version_no = ?)
        ORDER BY sort_order`
    )
    .all(no);
  return { ...summary, events: listEvents, relations: listRels };
}

module.exports = {
  publishVersion,
  evaluateDraft,
  buildFrozenSnapshot,
  insertVersionFromSnapshot,
  latestVersionNo,
  getVersionDetail,
  getVersionSummary,
  readDraftRevision,
  draftConflictError,
  commitImmediateWithConflict,
};
