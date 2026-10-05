'use strict';

// 预约发布：编辑者为通过现有发布校验的草稿选定每事件主张，并指定未来 UTC 时刻。
//
// 建立预约（createSchedule）时即冻结：
//   - 事件、每事件所选主张（精度/区间/出处/考异）、全部「先于」关系；
//   - 求解器确定的具体日期（resolvedDate）；
//   - 当前最新版本号 baseVersionNo（冻结的基准版本号）；
//   - 草稿修订号 draftRevisionNo：与上面的事件 / 主张 / 关系 / 求解日期同属一个
//     草稿快照（同一只读事务读出），不会再把旧快照配上新修订号。
// 此后草稿的任何增删改、从历史版本恢复都不影响预约内容。
//
// 两进程共用同一库时的并发窗口由乐观并发控制关闭：先在同一快照内读出草稿状态并
// 求解，随后在 BEGIN IMMEDIATE 写事务内再次核对草稿修订号——快照之后草稿若被另一
// 进程改动过（含事件与主张在读取之间被一次性改动），返回 409 DRAFT_REVISION_CONFLICT
// 草稿冲突，整次不建立预约（同样不生成版本）。冻结进预约的内容必定来自某个真实
// 同时存在过的草稿状态。时间非法（非 UTC/解析失败）或不是未来时刻 → 400；
// 选择为空 → 400；草稿不能通过现有发布校验（缺主张/成环/时间无解）→ 422；
// 基准版本过期 → 409；写锁等待超时 → 409 草稿冲突；以上均不建立预约。
//
// 到期执行（runDueSchedules，由 scheduler 周期触发，启动时立即补跑一次）：
//   按 (scheduled_at, 预约号) 顺序逐条在各自事务内处理：
//   - 仅当冻结基准版本号仍等于当前最新版本号、且该基准版未被撤回时，
//     用冻结内容写出一个不可变新版本，
//     状态置 published（写版本与翻状态在同一事务，失败整体回滚，不留半版）；
//   - 否则置 conflict 并保留冻结内容供编辑者查看，不自动改基准、不发布。
//   - 撤回与到期发布竞争时按事务提交顺序裁决：撤回先提交则本预约到期转冲突；
//     发布先提交则新版本保留，撤回仅作用于指定版。
// 重启 / 重复触发只处理 pending 行；published/conflict/cancelled 永不重复发布。
//
// 取消（cancelSchedule）：只有 pending（尚未执行）可取消；已执行（published/conflict）
// 不可取消（409）；重复取消已取消的预约幂等成功。

const { getDb } = require('./db');
const {
  evaluateDraft,
  buildFrozenSnapshot,
  insertVersionFromSnapshot,
  latestVersionNo,
  getVersionSummary,
  readDraftRevision,
  draftConflictError,
  commitImmediateWithConflict,
} = require('./publish');
const { isRetracted } = require('./retract');

const STATUSES = ['pending', 'published', 'conflict', 'cancelled'];

// ---------- 时间 ----------
// 只接受显式以 Z 结尾的 UTC 时刻，精度到分或秒：
//   2026-10-02T12:34Z / 2026-10-02T12:34:56Z
// 规范化为等宽的 YYYY-MM-DDTHH:mm:ssZ（可直接按字典序比较先后）。
function parseScheduledAt(input) {
  if (typeof input !== 'string') {
    throw { status: 400, code: 'INVALID_SCHEDULED_TIME', message: 'scheduledAt 必须是 UTC 时间字符串（如 2026-10-02T12:34:00Z）' };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?Z$/.exec(input.trim());
  if (!m) {
    throw {
      status: 400,
      code: 'INVALID_SCHEDULED_TIME',
      message: 'scheduledAt 必须是未来 UTC 时刻，格式为 YYYY-MM-DDTHH:mm:ssZ（秒可省略；不接受其它时区）',
    };
  }
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const min = Number(m[5]);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  // Date.UTC 归一化会把 13 月等进位，用 round-trip 严格校验
  const ms = Date.UTC(year, mon - 1, day, hour, min, sec);
  if (!Number.isFinite(ms)) {
    throw { status: 400, code: 'INVALID_SCHEDULED_TIME', message: 'scheduledAt 不是合法时刻' };
  }
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== mon ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== min ||
    d.getUTCSeconds() !== sec
  ) {
    throw { status: 400, code: 'INVALID_SCHEDULED_TIME', message: `scheduledAt 日期不存在或字段越界：${input}` };
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const canonical = `${year}-${p2(mon)}-${p2(day)}T${p2(hour)}:${p2(min)}:${p2(sec)}Z`;
  return { canonical, ms };
}

function nowIsoUtc(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------- 建立预约：再校验 + 冻结快照，单事务落库 ----------
function createSchedule({ selectionList, scheduledAtRaw, baseVersionNo, editor = '', note = '' }) {
  const db = getDb();

  if (!Array.isArray(selectionList) || selectionList.length === 0) {
    throw { status: 400, message: '请为每个事件选择一条主张后再预约发布' };
  }
  const base = Number(baseVersionNo || 0);

  // 必须是未来 UTC 时刻（严格晚于当前）
  const { canonical: scheduledAt, ms } = parseScheduledAt(scheduledAtRaw);
  if (ms <= Date.now()) {
    throw {
      status: 400,
      code: 'INVALID_SCHEDULED_TIME',
      message: `预约时刻必须是未来的 UTC 时间：${scheduledAt} 已过期`,
    };
  }

  // 走与即时发布完全相同的现有校验与求解；事件 / 主张 / 关系 / 求解日期 / 修订号
  // 取自同一个草稿快照（evaluateDraft 在单一只读事务内读出）
  const evalResult = evaluateDraft(selectionList);
  if (!evalResult.ok) {
    throw {
      status: 422,
      message: '草稿未通过发布校验，不能建立预约（草稿可继续修改，未写入任何预约）',
      errors: evalResult.errors,
    };
  }
  const snapshot = buildFrozenSnapshot(evalResult);
  const expectedRevision = evalResult.revisionNo;
  const payload = { events: snapshot.eventRows, relations: snapshot.relationRows };
  const editorStr = String(editor || '');
  const noteStr = String(note || '');

  const id = commitImmediateWithConflict(db, () => {
    // 事务内先确认草稿修订号未变：快照之后草稿被另一进程改过则整次拒绝，
    // 不冻结混合内容，也不会把旧快照记成新修订号。
    const revision = readDraftRevision();
    if (expectedRevision !== revision) {
      throw draftConflictError({ kind: '预约', expected: expectedRevision, current: revision });
    }
    // 再确认基准版本号仍为当前最新版本号，与即时发布同一约定
    const latest = latestVersionNo();
    if (base !== latest) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `版本冲突：你基于第 ${base} 版建立预约，但当前最新已是第 ${latest} 版。请重新查看最新版本并确认选择后再预约。`,
        currentVersionNo: latest,
        baseVersionNo: base,
        currentVersion: getVersionSummary(latest),
      };
    }
    const info = db
      .prepare(
        `INSERT INTO publish_schedules
           (scheduled_at, status, base_version_no, draft_revision_no,
            selection_json, payload_json, event_count, relation_count, editor, note)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        scheduledAt,
        base,
        // 与冻结快照同源的修订号，保证「修订号」与「冻结内容」描述同一草稿状态
        expectedRevision,
        JSON.stringify(selectionList),
        JSON.stringify(payload),
        snapshot.eventRows.length,
        snapshot.relationRows.length,
        editorStr,
        noteStr
      );
    return info.lastInsertRowid;
  }, { kind: '预约' });

  return getSchedule(id);
}

// ---------- 到期执行：按时刻、预约号顺序逐条事务处理 ----------
let isRunning = false;

function runDueSchedules(nowMs = Date.now()) {
  const db = getDb();
  // 重复触发（上一轮尚未结束 / tick 重叠）直接跳过，杜绝并发重复发布
  if (isRunning) return { ran: false, published: [], conflicts: [] };
  isRunning = true;
  const published = [];
  const conflicts = [];
  const failed = [];
  try {
    const nowCanonical = nowIsoUtc(nowMs);
    // 到期的 pending（scheduled_at 等宽字符串，字典序比较即时间先后）
    const due = db
      .prepare(
        `SELECT * FROM publish_schedules
          WHERE status = 'pending' AND scheduled_at <= ?
          ORDER BY scheduled_at ASC, id ASC`
      )
      .all(nowCanonical);

    // 逐条独立事务：某条意外失败时该条回滚仍为 pending（下轮重试），
    // 不阻断排在其后的到期预约。
    for (const row of due) {
      try {
        processOne(row, published, conflicts);
      } catch (err) {
        failed.push(row.id);
        console.error(`预约 #${row.id} 到期执行失败，已回滚（预约仍为 pending，将在下次触发时重试）：`, err);
      }
    }
  } finally {
    isRunning = false;
  }
  return { ran: true, published, conflicts, failed, attemptedAt: nowIsoUtc(nowMs) };
}

// 单条预约在一个事务内完成：检查基准 → 写不可变版本 + 翻状态（整体原子）。
function processOne(row, published, conflicts) {
  const db = getDb();
  const payload = JSON.parse(row.payload_json);
  const snapshot = { eventRows: payload.events, relationRows: payload.relations };
  const attemptedAt = nowIsoUtc();

  const tx = db.transaction(() => {
    // 事务内重新锁定行状态：只有 pending 才执行（取消 / 已执行永不重复）
    const fresh = db.prepare('SELECT status FROM publish_schedules WHERE id = ?').get(row.id);
    if (!fresh || fresh.status !== 'pending') return { skipped: true };

    const latest = latestVersionNo();
    const base = row.base_version_no;
    // 冻结基准版已被撤回（撤回事务先于本事务提交）→ 到期转冲突，不生成新版本
    const baseRetracted = base >= 1 && isRetracted(base);
    if (base !== latest || baseRetracted) {
      const message = baseRetracted
        ? `预约到期时，冻结的基准版本（第 ${base} 版）已被撤回（编年依据错误），` +
          '本预约转为冲突：未自动发布、未生成新版本；冻结内容完整保留如下，可核对后即时发布或另建预约。'
        : `预约到期时冻结的基准版本号（第 ${base} 版）已不等于当前最新版本号（第 ${latest} 版），` +
          '未自动发布、未改动基准；冻结内容保留如下，可重新核对后即时发布或另建预约。';
      db.prepare(
        `UPDATE publish_schedules
            SET status = 'conflict', result_message = ?, attempted_at = ?
          WHERE id = ? AND status = 'pending'`
      ).run(message, attemptedAt, row.id);
      return { conflict: true, message, latest };
    }

    const newNo = latest + 1;
    insertVersionFromSnapshot({
      db,
      newNo,
      parentNo: base,
      editor: row.editor,
      note: row.note,
      snapshot,
    });
    // 版本写入与状态翻转同事务：任一失败整体回滚（不留半版、不重复发布）
    db.prepare(
      `UPDATE publish_schedules
          SET status = 'published', result_version_no = ?, result_message = '', attempted_at = ?
        WHERE id = ? AND status = 'pending'`
    ).run(newNo, attemptedAt, row.id);
    return { published: true, newNo };
  });

  // 失败时事务整体回滚（该条仍为 pending，由 runDueSchedules 记录并在下轮重试），
  // 不影响同一轮中排在其后的其它预约。
  const out = tx();
  if (out && out.published) published.push({ scheduleNo: row.id, versionNo: out.newNo });
  if (out && out.conflict) conflicts.push({ scheduleNo: row.id, baseVersionNo: row.base_version_no, currentVersionNo: out.latest });
}

// ---------- 查看 / 列表 ----------
function parseRow(row) {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json);
  const selection = JSON.parse(row.selection_json);
  return {
    scheduleNo: row.id,
    scheduledAt: row.scheduled_at,
    status: row.status,
    baseVersionNo: row.base_version_no,
    draftRevisionNo: row.draft_revision_no,
    eventCount: row.event_count,
    relationCount: row.relation_count,
    editor: row.editor,
    note: row.note,
    selection,
    frozen: payload,
    resultVersionNo: row.result_version_no,
    resultMessage: row.result_message || '',
    createdAt: row.created_at,
    attemptedAt: row.attempted_at,
    cancelledAt: row.cancelled_at,
  };
}

function getSchedule(id) {
  return parseRow(getDb().prepare('SELECT * FROM publish_schedules WHERE id = ?').get(id));
}

// 列表项附带轻量事件摘要（标题/被选主张/求解日期/出处），不展开完整冻结关系
function listItem(row) {
  const full = parseRow(row);
  return {
    scheduleNo: full.scheduleNo,
    scheduledAt: full.scheduledAt,
    status: full.status,
    baseVersionNo: full.baseVersionNo,
    eventCount: full.eventCount,
    relationCount: full.relationCount,
    editor: full.editor,
    note: full.note,
    resultVersionNo: full.resultVersionNo,
    resultMessage: full.resultMessage,
    createdAt: full.createdAt,
    attemptedAt: full.attemptedAt,
    cancelledAt: full.cancelledAt,
    events: full.frozen.events.map((e) => ({
      eventId: e.eventId,
      title: e.title,
      claimId: e.claimId,
      dateLabel: e.dateLabel,
      resolvedDate: e.resolvedDate,
      source: e.source,
    })),
  };
}

function listSchedules() {
  const rows = getDb().prepare('SELECT * FROM publish_schedules').all();
  // 未执行（pending）优先、按到期时刻升序；其余按预约号倒序（最近处理的靠前）
  return rows
    .map(listItem)
    .sort((a, b) => {
      if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
      if (a.status === 'pending') {
        return a.scheduledAt.localeCompare(b.scheduledAt) || a.scheduleNo - b.scheduleNo;
      }
      return b.scheduleNo - a.scheduleNo;
    });
}

// ---------- 取消：仅 pending 可取消 ----------
function cancelSchedule(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM publish_schedules WHERE id = ?').get(id);
  if (!row) {
    throw { status: 404, message: `预约 ${id} 不存在` };
  }
  if (row.status === 'cancelled') {
    // 幂等：重复取消同一已取消预约，直接返回当前状态
    return { cancelled: true, alreadyCancelled: true, schedule: parseRow(row) };
  }
  if (row.status !== 'pending') {
    throw {
      status: 409,
      code: 'SCHEDULE_NOT_CANCELLABLE',
      message: `预约 ${id} 已执行（状态：${row.status}），不能取消。`,
      scheduleNo: id,
      statusNow: row.status,
      resultVersionNo: row.result_version_no,
    };
  }
  db.prepare(
    `UPDATE publish_schedules SET status = 'cancelled', cancelled_at = ?
      WHERE id = ? AND status = 'pending'`
  ).run(nowIsoUtc(), id);
  return { cancelled: true, alreadyCancelled: false, schedule: getSchedule(id) };
}

module.exports = {
  STATUSES,
  parseScheduledAt,
  createSchedule,
  runDueSchedules,
  getSchedule,
  listSchedules,
  cancelSchedule,
  nowIsoUtc,
};
