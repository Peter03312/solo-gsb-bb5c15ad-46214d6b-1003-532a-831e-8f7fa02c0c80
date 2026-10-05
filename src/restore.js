'use strict';

// 从任一已发布版本预览并恢复草稿。
//
// 预览（buildRestorePreview）只读：目标版本的事件、被选时间主张、
// 「先于」关系，当前草稿中将被替换的内容（全部事件 / 主张 / 关系），
// 草稿修订号与最新版本号，全部在同一个只读事务（同一 WAL 快照，
// 即同一数据库状态）内读出。两个服务进程共用同一库时，另一进程无论在
// 预览读取的哪一步提交事件 / 主张 / 关系写入或发布新版本，预览都不会
// 返回「旧草稿内容配新修订号」之类从未同时存在过的混合结果；
// 预览本身不执行任何写操作（事务内只有 SELECT，不产生写入）。
//
// 确认（restoreDraftFromVersion）在一个 BEGIN IMMEDIATE 写事务内原子地：
//   1. 校验版本仍存在、最新版本号与预览时一致、草稿修订号与预览时一致；
//   2. 清空整个草稿区（按依赖顺序显式删除 relations / claims / events）；
//   3. 按版本快照重建事件、关系；每事件只复制当版被选的那一条主张；
//   4. 重置自增序号，使新草稿 id 从 1 开始；
//   5. 在 draft_restores 追加一行恢复登记（草稿代 +1），开启中的并行编辑会话
//      据此识别基线对象身份已被恢复更替。
// 取得写锁后再做校验，期间草稿或最新版本被另一进程改动都沿用既有
// 409（DRAFT_REVISION_CONFLICT / VERSION_CONFLICT）结果，整次不改库；
// 等不到写锁同样按草稿冲突处理。成功返回的草稿状态在同一事务内读出。
// 历史版本快照（versions / version_events / version_relations）不动，
// 访客年表因此保持不变。

const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');

function draftRevisionNo() {
  return getDb().prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
}

// 当前「草稿代」：已确认恢复的次数（draft_restores 最大行号）。
// 恢复会整体替换草稿并重排对象编号；并行编辑会话以此识别基线对象身份是否已更替。
function draftRestoreNo() {
  return getDb().prepare('SELECT COALESCE(MAX(id), 0) AS n FROM draft_restores').get().n;
}

function draftEventApi(row, claims) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    claims: claims.map((c) => ({
      id: c.id,
      eventId: c.event_id,
      precision: c.precision,
      year: c.year,
      month: c.month,
      day: c.day,
      dateLabel: c.date_label,
      intervalStart: c.interval_start,
      intervalEnd: c.interval_end,
      source: c.source,
      note: c.note,
    })),
  };
}

// 在调用方事务（同一 WAL 快照）内读取当前草稿全貌。
// 事件、全部主张、关系、修订号必须来自同一数据库状态，故全部查询都在
// buildRestorePreview / restoreDraftFromVersion 给定的事务里发出。
function currentDraftSnapshotIn(db) {
  const eventRows = db.prepare('SELECT * FROM events ORDER BY id').all();
  const claimRows = db.prepare('SELECT * FROM claims ORDER BY id').all();
  const claimsByEvent = new Map();
  for (const c of claimRows) {
    if (!claimsByEvent.has(c.event_id)) claimsByEvent.set(c.event_id, []);
    claimsByEvent.get(c.event_id).push(c);
  }
  const events = eventRows.map((row) =>
    draftEventApi(row, (claimsByEvent.get(row.id) || []).slice())
  );
  const relations = db
    .prepare('SELECT * FROM relations ORDER BY id')
    .all()
    .map((r) => ({
      id: r.id,
      earlierId: r.earlier_id,
      laterId: r.later_id,
      source: r.source,
      note: r.note,
    }));
  const eventCount = events.length;
  const claimCount = events.reduce((n, e) => n + e.claims.length, 0);
  return { events, relations, counts: { eventCount, claimCount, relationCount: relations.length } };
}

// 在调用方事务（同一 WAL 快照）内读取目标版本详情；版本快照不可变，
// 但仍在预览事务内读出，使「目标版本 / 当前草稿 / 修订号 / 最新版本号」
// 四个值严格对应同一数据库状态（版本在快照存在性上也前后一致）。
function versionDetailIn(db, no) {
  const summary = db
    .prepare(
      `SELECT v.version_no AS versionNo, v.parent_no AS parentNo, v.editor, v.note, v.published_at AS publishedAt,
              (SELECT COUNT(*) FROM version_events WHERE version_id = v.id) AS eventCount,
              (SELECT COUNT(*) FROM version_relations WHERE version_id = v.id) AS relationCount
         FROM versions v WHERE v.version_no = ?`
    )
    .get(no);
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

function latestVersionNoIn(db) {
  const row = db.prepare('SELECT MAX(version_no) AS no FROM versions').get();
  return row.no || 0;
}

// 只读预览，不改任何数据。返回 null 表示版本不存在。
// 目标版本、当前草稿（全部事件 / 主张 / 关系）、草稿修订号、最新版本号
// 在同一个只读事务（同一 WAL 快照）内读出，保证它们对应同一数据库状态：
// 另一进程在预览读取期间写入事件 / 主张 / 关系或发布新版本，只会让整份
// 预览整体落在写入前或写入后的快照上，绝不返回新旧混合的结果。
function buildRestorePreview(versionNo) {
  const db = getDb();
  const read = db.transaction(() => {
    const version = versionDetailIn(db, versionNo);
    if (!version) return null;
    const current = currentDraftSnapshotIn(db);
    return {
      versionNo,
      draftRevisionNo: draftRevisionNo(),
      currentVersionNo: latestVersionNoIn(db),
      version,
      currentDraft: current,
    };
  });
  return read();
}

// 由快照区间起点与精度还原 year/month/day，再用 dates 工具重算区间，
// 保证重建出的主张与现有录入路径完全一致。
function claimPartsFromSnapshot(ev) {
  const [y, m, d] = ev.intervalStart.split('-').map(Number);
  const input = {
    precision: ev.precision,
    year: y,
    month: ev.precision === 'year' ? undefined : m,
    day: ev.precision === 'day' ? d : undefined,
  };
  const parsed = parseClaimDate(input);
  const iv = claimInterval(parsed.precision, parsed.year, parsed.month, parsed.day);
  return {
    precision: parsed.precision,
    year: parsed.year,
    month: parsed.month,
    day: parsed.day,
    dateLabel: formatClaimDate(parsed.precision, parsed.year, parsed.month, parsed.day),
    intervalStart: iv.start,
    intervalEnd: iv.end,
  };
}

// 确认恢复。expectedRevision: 预览时草稿修订号；expectedLatestVersionNo: 预览时最新版本号。
// 抛 { status, ...body } 表示 HTTP 错误；成功返回新草稿状态与旧→新 id 映射。
//
// 全部校验与重建在一个 BEGIN IMMEDIATE 写事务内进行：先取写锁再核对最新版本号、
// 草稿修订号与目标版本，因此另一进程在「预览 → 确认」之间写入草稿或发布新版本，
// 都会在这里被发现并沿用既有 409（VERSION_CONFLICT / DRAFT_REVISION_CONFLICT）
// 语义拒绝，整次不改库；写锁等待超时（另一进程长时间写）同样按草稿冲突处理，
// 不会把 SQLITE_BUSY 透传成 500。成功返回的草稿全貌、修订号、最新版本号
// 也在同一事务（提交前）读出，彼此对应同一数据库状态。
function restoreDraftFromVersion({ versionNo, expectedRevision, expectedLatestVersionNo }) {
  const db = getDb();

  const runTx = db.transaction(() => {
    // 事务内（持写锁）确认目标版本仍存在：版本快照不可变，正常必存在；
    // 库被外部整体替换等极端情况下返回 404，同样不写任何数据。
    const version = versionDetailIn(db, versionNo);
    if (!version) {
      throw { status: 404, message: `版本 ${versionNo} 不存在，无法恢复` };
    }

    // 事务内重新确认最新版本号与草稿修订号，避免并发下的静默覆盖
    const latest = latestVersionNoIn(db);
    if (Number(expectedLatestVersionNo) !== latest) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `版本冲突：你预览时最新是第 ${expectedLatestVersionNo} 版，现在已是第 ${latest} 版。请重新预览后再恢复。`,
        currentVersionNo: latest,
        expectedVersionNo: Number(expectedLatestVersionNo),
      };
    }
    const revision = draftRevisionNo();
    if (Number(expectedRevision) !== revision) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message: `草稿冲突：你预览恢复时草稿修订号为 ${expectedRevision}，现在已变为 ${revision}（期间草稿被修改过）。请重新预览后再恢复。`,
        currentRevisionNo: revision,
        expectedRevisionNo: Number(expectedRevision),
      };
    }

    const eventMap = []; // {oldId, newId, oldClaimId, newClaimId}
    const relationMap = [];

    // 清空整个草稿区；显式按依赖顺序删除（不依赖外键级联设置）
    db.prepare('DELETE FROM relations').run();
    db.prepare('DELETE FROM claims').run();
    db.prepare('DELETE FROM events').run();

    // 重置草稿表自增序号，新草稿 id 从 1 开始（不动 versions 区）
    db.prepare("UPDATE sqlite_sequence SET seq = 0 WHERE name IN ('events', 'claims', 'relations')").run();

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 快照事件按 sort_order 排列；只恢复当版被选的一条主张
    for (const ev of version.events) {
      const evInfo = insEvent.run(ev.title, ev.description || '');
      const newEventId = evInfo.lastInsertRowid;
      const parts = claimPartsFromSnapshot(ev);
      const claimInfo = insClaim.run(
        newEventId,
        parts.precision,
        parts.year,
        parts.month,
        parts.day,
        parts.dateLabel,
        parts.intervalStart,
        parts.intervalEnd,
        ev.source || '',
        ev.claimNote || ''
      );
      eventMap.push({
        oldEventId: ev.eventId,
        newEventId,
        oldClaimId: ev.claimId,
        newClaimId: claimInfo.lastInsertRowid,
      });
    }

    const newEventIdByOld = new Map(eventMap.map((m) => [m.oldEventId, m.newEventId]));
    const insRel = db.prepare(
      'INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)'
    );
    for (const rel of version.relations) {
      const newEarlier = newEventIdByOld.get(rel.earlierEventId);
      const newLater = newEventIdByOld.get(rel.laterEventId);
      const info = insRel.run(newEarlier, newLater, rel.source || '', rel.note || '');
      relationMap.push({
        oldRelationId: rel.relationId,
        newRelationId: info.lastInsertRowid,
        oldEarlierEventId: rel.earlierEventId,
        newEarlierEventId: newEarlier,
        oldLaterEventId: rel.laterEventId,
        newLaterEventId: newLater,
      });
    }

    // 上面的 DELETE/INSERT 每一条都触发了修订号自增；恢复作为一次原子操作，
    // 只应算一次草稿变更，最终把修订号校正为预览时的值 + 1。
    db.prepare('UPDATE draft_meta SET revision = ? WHERE id = 1').run(Number(expectedRevision) + 1);

    // 登记本次恢复（只追加）：恢复重排了对象编号，开启中的并行编辑会话据此
    // 识别基线对象身份已更替，提交时整次拒绝而不是把改动合并到同编号的新对象上。
    db.prepare('INSERT INTO draft_restores (version_no) VALUES (?)').run(versionNo);

    // 响应中的新草稿全貌、修订号、最新版本号也在本事务（提交前）读出，
    // 保证成功返回的各个值对应同一个恢复后的数据库状态。
    const draft = currentDraftSnapshotIn(db);
    return {
      eventMap,
      relationMap,
      draft,
      revisionNo: Number(expectedRevision) + 1,
      currentVersionNo: latest,
    };
  });

  let result;
  try {
    // BEGIN IMMEDIATE：先取写锁再校验，杜绝「读到快照后、升级写锁前另一进程
    // 已提交」导致的 SQLITE_BUSY_SNAPSHOT；等不到写锁归为既有草稿冲突。
    result = runTx.immediate();
  } catch (err) {
    if (err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED')) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message:
          '草稿冲突：确认恢复提交时另一进程正在修改草稿，未能取得一致草稿状态。' +
          '本次恢复已整体取消，未改动任何数据；请重新预览后再恢复。',
      };
    }
    throw err;
  }

  const { eventMap, relationMap, draft, revisionNo, currentVersionNo } = result;
  // 恢复后每事件只有一条（当版被选）主张，供编辑台直接填好单选、继续校验发布
  const pendingSelection = eventMap.map((m) => ({
    eventId: m.newEventId,
    claimId: m.newClaimId,
  }));

  return {
    restoredFromVersionNo: versionNo,
    currentVersionNo,
    revisionNo,
    idMap: { events: eventMap, relations: relationMap },
    pendingSelection,
    draft,
  };
}

module.exports = {
  buildRestorePreview,
  restoreDraftFromVersion,
  draftRevisionNo,
  draftRestoreNo,
};
