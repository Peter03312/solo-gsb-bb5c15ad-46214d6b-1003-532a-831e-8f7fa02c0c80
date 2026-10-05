'use strict';

const express = require('express');
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { evaluateDraft, publishVersion, latestVersionNo, getVersionDetail, getVersionSummary } = require('./publish');
const { buildRestorePreview, restoreDraftFromVersion, draftRevisionNo } = require('./restore');
const { buildImportPreview, confirmImport } = require('./bundle');
const {
  previewSourceRedaction,
  confirmSourceRedaction,
  applyRedactionToVersion,
  listRedactions,
} = require('./redact');
const {
  createSchedule,
  getSchedule,
  listSchedules,
  cancelSchedule,
} = require('./schedule');
const {
  createRoute,
  getRouteDetail,
  applyRedactionToRoute,
  listRoutes,
} = require('./route');
const {
  retractVersion,
  getRetraction,
  isRetracted,
  retractedVersionNoSet,
  latestVisibleVersionNo,
  listRetractions,
} = require('./retract');
const {
  registerErrata,
  listErrataForVersion,
  getErrataWithChain,
  effectiveErrataForVersion,
  applyRedactionToErrata,
} = require('./errata');
const {
  openSession,
  getSession,
  listSessions,
  appendSessionOps,
  commitSession,
} = require('./session');
const scheduler = require('./scheduler');

const router = express.Router();

// ---------- 辅助 ----------
function badRequest(message) {
  return { status: 400, message };
}

function requireString(body, field, { max = 500, allowEmpty = false } = {}) {
  const v = body[field];
  if (typeof v !== 'string') throw badRequest(`字段 ${field} 必须是字符串`);
  if (!allowEmpty && v.trim() === '') throw badRequest(`字段 ${field} 不能为空`);
  if (v.length > max) throw badRequest(`字段 ${field} 长度不能超过 ${max}`);
  return v;
}

function optionalString(body, field, max = 2000) {
  const v = body[field];
  if (v == null) return '';
  if (typeof v !== 'string') throw badRequest(`字段 ${field} 必须是字符串`);
  if (v.length > max) throw badRequest(`字段 ${field} 长度不能超过 ${max}`);
  return v;
}

// 事件不存在 → 404
function getEventOr404(id) {
  const ev = getDb().prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) throw { status: 404, message: `事件 ${id} 不存在` };
  return ev;
}

function claimRowToApi(c) {
  return {
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
  };
}

function eventRowToApi(e) {
  const claims = getDb()
    .prepare('SELECT * FROM claims WHERE event_id = ? ORDER BY id')
    .all(e.id)
    .map(claimRowToApi);
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    claims,
  };
}

function readClaimPayload(body) {
  const { precision, year, month, day } = parseClaimDate(body || {});
  const source = requireString(body, 'source', { max: 1000 });
  const note = optionalString(body, 'note', 2000);
  const { start, end } = claimInterval(precision, year, month, day);
  return {
    precision,
    year,
    month,
    day,
    dateLabel: formatClaimDate(precision, year, month, day),
    intervalStart: start,
    intervalEnd: end,
    source,
    note,
  };
}

// ================= 公开接口（访客，无需口令） =================
// 只暴露未撤回的已发布版本快照，不触碰草稿；撤回版一律按不存在处理。

router.get('/api/public/chronicle', (req, res) => {
  // 访客最新年表指向编号最大的未撤回版
  const no = latestVisibleVersionNo();
  if (no === 0) {
    const anyPublished = latestVersionNo() > 0;
    return res.json({
      published: false,
      ...(anyPublished ? { allRetracted: true } : {}),
      message: anyPublished ? '尚无可读版本：已发布版本均已撤回' : '年表尚未发布任何版本',
    });
  }
  // 访客视图：命中已登记出处的位置统一显示「出处已遮盖」，其余字段与版本号不变
  const version = applyRedactionToVersion(getVersionDetail(no));
  // 勘误附记：仅该版各目标的生效附记；附记出处同样按遮盖规则显示
  version.errata = applyRedactionToErrata(effectiveErrataForVersion(no, version));
  res.json({ published: true, currentVersionNo: no, version });
});

router.get('/api/public/versions', (req, res) => {
  const retracted = retractedVersionNoSet();
  const rows = getDb()
    .prepare(
      `SELECT version_no AS versionNo, parent_no AS parentNo, editor, note, published_at AS publishedAt
         FROM versions ORDER BY version_no DESC`
    )
    .all()
    .filter((v) => !retracted.has(v.versionNo));
  res.json({ currentVersionNo: latestVisibleVersionNo(), versions: rows });
});

router.get('/api/public/versions/:no', (req, res) => {
  const no = Number(req.params.no);
  const detail = getVersionDetail(no);
  // 撤回版对访客按不存在处理（其勘误附记随之不可见）
  if (!detail || isRetracted(no)) throw { status: 404, message: `版本 ${req.params.no} 不存在` };
  // 访客读取指定历史版本同样应用出处遮盖
  const version = applyRedactionToVersion(detail);
  version.errata = applyRedactionToErrata(effectiveErrataForVersion(no, version));
  res.json({ version });
});

// ---- 专题「先于」脉络路线（公开只读） ----
// 只展示路线涉及的事件与关系；出处命中遮盖登记的位置显示「出处已遮盖」。
// 引用撤回版的路线对访客隐藏。
router.get('/api/public/routes', (req, res) => {
  const retracted = retractedVersionNoSet();
  res.json({ routes: listRoutes().filter((r) => !retracted.has(r.versionNo)) });
});

router.get('/api/public/routes/:no', (req, res) => {
  const no = Number(req.params.no);
  if (!Number.isInteger(no) || no < 1) throw badRequest('路线号必须是正整数');
  const detail = getRouteDetail(no);
  // 引用撤回版的路线对访客按不存在处理
  if (!detail || isRetracted(detail.versionNo)) throw { status: 404, message: `路线 ${req.params.no} 不存在` };
  res.json({ route: applyRedactionToRoute(detail) });
});

// ================= 编辑者接口 =================

// 草稿全貌：事件、主张、关系 + 当前最新版本号
router.get('/api/editor/state', (req, res) => {
  const db = getDb();
  const events = db.prepare('SELECT * FROM events ORDER BY id').all().map(eventRowToApi);
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
  res.json({
    currentVersionNo: latestVersionNo(),
    latestVisibleVersionNo: latestVisibleVersionNo(),
    currentVersion: getVersionSummary(latestVersionNo()) || null,
    draftRevisionNo: draftRevisionNo(),
    events,
    relations,
  });
});

// ---- 事件 CRUD ----
router.post('/api/editor/events', (req, res) => {
  const title = requireString(req.body, 'title', { max: 200 });
  const description = optionalString(req.body, 'description', 5000);
  const info = getDb().prepare('INSERT INTO events (title, description) VALUES (?, ?)').run(title.trim(), description);
  res.status(201).json({ event: eventRowToApi(getEventOr404(info.lastInsertRowid)) });
});

router.put('/api/editor/events/:id', (req, res) => {
  const id = Number(req.params.id);
  getEventOr404(id);
  const title = requireString(req.body, 'title', { max: 200 });
  const description = optionalString(req.body, 'description', 5000);
  getDb()
    .prepare('UPDATE events SET title = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(title.trim(), description, id);
  res.json({ event: eventRowToApi(getEventOr404(id)) });
});

router.delete('/api/editor/events/:id', (req, res) => {
  const id = Number(req.params.id);
  getEventOr404(id);
  getDb().prepare('DELETE FROM events WHERE id = ?').run(id);
  res.json({ deleted: id });
});

// ---- 主张 CRUD（同一事件允许矛盾主张并存） ----
router.post('/api/editor/events/:id/claims', (req, res) => {
  const eventId = Number(req.params.id);
  getEventOr404(eventId);
  const p = readClaimPayload(req.body);
  const info = getDb()
    .prepare(
      `INSERT INTO claims
         (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eventId, p.precision, p.year, p.month, p.day, p.dateLabel, p.intervalStart, p.intervalEnd, p.source, p.note);
  res.status(201).json({ claim: claimRowToApi(getDb().prepare('SELECT * FROM claims WHERE id = ?').get(info.lastInsertRowid)) });
});

router.put('/api/editor/claims/:claimId', (req, res) => {
  const claimId = Number(req.params.claimId);
  const existing = getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!existing) throw { status: 404, message: `主张 ${claimId} 不存在` };
  const p = readClaimPayload(req.body);
  getDb()
    .prepare(
      `UPDATE claims SET precision=?, year=?, month=?, day=?, date_label=?,
         interval_start=?, interval_end=?, source=?, note=? WHERE id=?`
    )
    .run(p.precision, p.year, p.month, p.day, p.dateLabel, p.intervalStart, p.intervalEnd, p.source, p.note, claimId);
  res.json({ claim: claimRowToApi(getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId)) });
});

router.delete('/api/editor/claims/:claimId', (req, res) => {
  const claimId = Number(req.params.claimId);
  const existing = getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!existing) throw { status: 404, message: `主张 ${claimId} 不存在` };
  getDb().prepare('DELETE FROM claims WHERE id = ?').run(claimId);
  res.json({ deleted: claimId });
});

// ---- 关系 CRUD ----
router.post('/api/editor/relations', (req, res) => {
  const earlierId = Number(req.body.earlierId);
  const laterId = Number(req.body.laterId);
  if (!Number.isInteger(earlierId) || !Number.isInteger(laterId)) {
    throw badRequest('earlierId 与 laterId 必须是事件 id 整数');
  }
  if (earlierId === laterId) throw badRequest('一个事件不能先于自身');
  getEventOr404(earlierId);
  getEventOr404(laterId);
  const source = optionalString(req.body, 'source', 1000);
  const note = optionalString(req.body, 'note', 2000);
  const info = getDb()
    .prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)')
    .run(earlierId, laterId, source, note);
  const row = getDb().prepare('SELECT * FROM relations WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({
    relation: { id: row.id, earlierId: row.earlier_id, laterId: row.later_id, source: row.source, note: row.note },
  });
});

router.delete('/api/editor/relations/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb().prepare('SELECT * FROM relations WHERE id = ?').get(id);
  if (!row) throw { status: 404, message: `关系 ${id} 不存在` };
  getDb().prepare('DELETE FROM relations WHERE id = ?').run(id);
  res.json({ deleted: id });
});

// ---- 发布前预检：不落库，返回求解错误或可行日期 ----
router.post('/api/editor/validate', (req, res) => {
  const selectionList = normalizeSelection(req.body);
  const result = evaluateDraft(selectionList);
  if (!result.ok) {
    return res.json({ ok: false, errors: result.errors });
  }
  const { dates, events, selected } = result;
  const preview = events
    .map((ev) => {
      const sel = selected.get(ev.id);
      return {
        eventId: ev.id,
        title: ev.title,
        claimId: sel.claimId,
        resolvedDate: iso(dates.get(ev.id)),
        intervalStart: iso(sel.startOrd),
        intervalEnd: iso(sel.endOrd),
      };
    })
    .sort((a, b) => a.resolvedDate.localeCompare(b.resolvedDate));
  res.json({ ok: true, preview });
});

function iso(ord) {
  // 延迟 require 避免循环
  return require('./dates').isoFromOrdinal(ord);
}

function normalizeSelection(body) {
  const raw = body && body.selection;
  if (!Array.isArray(raw)) throw badRequest('selection 必须是 [{eventId, claimId}] 数组');
  return raw.map((item) => {
    const eventId = Number(item && item.eventId);
    const claimId = Number(item && item.claimId);
    if (!Number.isInteger(eventId) || !Number.isInteger(claimId)) {
      throw badRequest('selection 中每项必须包含整数 eventId 与 claimId');
    }
    return { eventId, claimId };
  });
}

// ---- 正式发布：创建不可变版本 ----
router.post('/api/editor/publish', (req, res) => {
  const selectionList = normalizeSelection(req.body);
  const baseVersionNo = req.body.baseVersionNo === null || req.body.baseVersionNo === undefined
    ? null
    : Number(req.body.baseVersionNo);
  if (baseVersionNo !== null && !Number.isInteger(baseVersionNo)) {
    throw badRequest('baseVersionNo 必须是整数或 null');
  }
  const editor = optionalString(req.body, 'editor', 200) || '匿名编辑';
  const note = optionalString(req.body, 'note', 1000);
  const result = publishVersion({ selectionList, baseVersionNo, editor, note });
  res.status(201).json({ ok: true, ...result });
});

// 版本列表（编辑者视角）：在公开结构基础上附加撤回状态与原因；
// currentVersionNo 仍是最高已发布版本号（含撤回版，发布/预约基准不变）。
router.get('/api/editor/versions', (req, res) => {
  const no = latestVersionNo();
  const rows = getDb()
    .prepare(
      `SELECT version_no AS versionNo, parent_no AS parentNo, editor, note, published_at AS publishedAt
         FROM versions ORDER BY version_no DESC`
    )
    .all()
    .map((v) => {
      const retraction = getRetraction(v.versionNo);
      return { ...v, retracted: retraction !== null, retraction };
    });
  res.json({ currentVersionNo: no, latestVisibleVersionNo: latestVisibleVersionNo(), versions: rows });
});

// ---- 撤回已发布版本：按版本号与非空原因，只追加审计记录（快照与版本号不变） ----
// 体含 reason（非空撤回原因）、editor（可选）。版本不存在 404、原因非法 400，均不改状态；
// 重复撤回幂等返回首次记录（alreadyRetracted: true），不覆盖原因。
router.post('/api/editor/versions/:no/retract', (req, res) => {
  const no = Number(req.params.no);
  if (!Number.isInteger(no) || no < 1) throw badRequest('版本号必须是正整数');
  const result = retractVersion({
    versionNo: no,
    reason: req.body && req.body.reason,
    editor: optionalString(req.body || {}, 'editor', 200),
  });
  res.json(result);
});

// 已撤回版本清单（编辑者视角，含撤回原因与撤回时间）
router.get('/api/editor/retractions', (req, res) => {
  res.json({
    currentVersionNo: latestVersionNo(),
    latestVisibleVersionNo: latestVisibleVersionNo(),
    retractions: listRetractions(),
  });
});

// ---- 从已发布版本恢复草稿：只读预览，不改数据 ----
// 列出该版事件、被选时间主张、先于关系，以及当前草稿将被替换的内容。
router.get('/api/editor/restore-preview/:no', (req, res) => {
  const no = Number(req.params.no);
  if (!Number.isInteger(no) || no < 1) throw badRequest('版本号必须是正整数');
  const preview = buildRestorePreview(no);
  if (!preview) throw { status: 404, message: `版本 ${req.params.no} 不存在` };
  // 撤回版同样可恢复（编辑者功能）；附带撤回信息提示
  res.json({ ok: true, ...preview, retraction: getRetraction(no) });
});

// ---- 确认恢复：原子替换整个草稿 ----
// 必须提交预览时的草稿修订号 draftRevisionNo 与最新版本号 currentVersionNo。
router.post('/api/editor/restore', (req, res) => {
  const versionNo = Number(req.body && req.body.versionNo);
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw badRequest('versionNo 必须是正整数');
  }
  const expectedRevision = Number(req.body && req.body.draftRevisionNo);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw badRequest('draftRevisionNo 必须是非负整数（取预览时返回的值）');
  }
  const expectedLatestVersionNo = Number(req.body && req.body.currentVersionNo);
  if (!Number.isInteger(expectedLatestVersionNo) || expectedLatestVersionNo < 0) {
    throw badRequest('currentVersionNo 必须是非负整数（取预览时返回的值）');
  }
  const result = restoreDraftFromVersion({ versionNo, expectedRevision, expectedLatestVersionNo });
  res.status(200).json({ ok: true, ...result });
});

// ---- 导入采访整理包：只读预览，不改数据 ----
// 请求体即整理包 JSON。校验问题（键重复 / 引用缺失 / 日期或出处非法等）一次性列出，
// 有任何问题即 422 整包拒绝；通过时返回待写入内容、数量、内容指纹与草稿修订号。
router.post('/api/editor/import-preview', (req, res) => {
  const preview = buildImportPreview(req.body);
  res.json({ ok: true, ...preview });
});

// ---- 确认导入：一个事务追加整包 ----
// 必须提交原包 bundle、预览返回的内容指纹 fingerprint 与草稿修订号 draftRevisionNo。
router.post('/api/editor/import', (req, res) => {
  const body = req.body || {};
  if (!body.bundle || typeof body.bundle !== 'object' || Array.isArray(body.bundle)) {
    throw badRequest('bundle 必须是整理包对象（与预览时提交的完全一致）');
  }
  const fingerprint = body.fingerprint;
  if (typeof fingerprint !== 'string' || fingerprint.trim() === '') {
    throw badRequest('fingerprint 必须是预览返回的内容指纹字符串');
  }
  const expectedRevision = Number(body.draftRevisionNo);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw badRequest('draftRevisionNo 必须是非负整数（取预览时返回的值）');
  }
  const result = confirmImport({ bundle: body.bundle, fingerprint: fingerprint.trim(), expectedRevision });
  res.status(201).json({ ok: true, ...result });
});

// ---- 已发布版本原文（持编辑口令）：不应用出处遮盖 ----
// 访客公开接口中命中遮盖登记的 source 显示「出处已遮盖」；
// 编辑者持口令通过本接口仍可查看快照原文（恢复草稿亦使用原文，不受影响）。
// 撤回版同样可见原文；响应附带撤回信息（未撤回为 null）。
router.get('/api/editor/versions/:no/raw', (req, res) => {
  const no = Number(req.params.no);
  if (!Number.isInteger(no) || no < 1) throw badRequest('版本号必须是正整数');
  const detail = getVersionDetail(no);
  if (!detail) throw { status: 404, message: `版本 ${req.params.no} 不存在` };
  // 附该版各目标的生效勘误附记（原文，不遮盖；完整替代链见 /api/editor/versions/:no/errata）
  detail.errata = effectiveErrataForVersion(no, detail);
  res.json({ version: detail, retraction: getRetraction(no) });
});

// ================= 勘误附记（对指定已发布版本中的事件 / 「先于」关系） =================
// 附记只属于目标版：不随草稿恢复或以后发布的版本继承；原快照、求解日期与草稿均不改。
// 同一目标只展示最新生效附记；替代须提交所见附记号（replacesErrataId），事务内核对，
// 两人同时替代仅一个成功，冲突方 409 取得当前生效附记且不落库；旧附记保留供追溯。
// 版本不存在 404；对象不属该版 422；目标版已撤回 409；字段非法 400；均不落库。

// ---- 登记 / 替代附记 ----
// 体含 versionNo、targetType（event|relation）、targetId（该版快照对象编号）、
// note（勘误说明）、source（出处）、editor（可选）、replacesErrataId（替代时必填：
// 登记时所见的生效附记号；目标尚无附记时省略）。
router.post('/api/editor/errata', (req, res) => {
  const body = req.body || {};
  const result = registerErrata({
    versionNo: body.versionNo,
    targetType: body.targetType,
    targetId: body.targetId,
    note: body.note,
    source: body.source,
    editor: optionalString(body, 'editor', 200),
    replacesErrataId: body.replacesErrataId,
  });
  res.status(201).json(result);
});

// ---- 指定版本的全部附记（编辑者视角）：按目标分组，含生效附记与完整替代链，原文不遮盖 ----
router.get('/api/editor/versions/:no/errata', (req, res) => {
  const no = Number(req.params.no);
  if (!Number.isInteger(no) || no < 1) throw badRequest('版本号必须是正整数');
  const detail = getVersionDetail(no);
  if (!detail) throw { status: 404, message: `版本 ${req.params.no} 不存在` };
  res.json({ ok: true, ...listErrataForVersion(no, detail), retraction: getRetraction(no) });
});

// ---- 单条附记及其替代链（编辑者追溯用，原文不遮盖） ----
router.get('/api/editor/errata/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw badRequest('附记号必须是正整数');
  const found = getErrataWithChain(id);
  if (!found) throw { status: 404, message: `勘误附记 ${req.params.id} 不存在` };
  const detail = getVersionDetail(found.versionNo);
  res.json({ ok: true, ...getErrataWithChain(id, detail), retraction: getRetraction(found.versionNo) });
});

// ---- 按出处原文撤回公开展示：只读预览，不改数据 ----
// 体含 source（非空精确出处文本）。返回它在全部已发布版本的事件主张与
// 「先于」关系中命中的位置与数量、当前最新版本号；另附草稿区命中供编辑参考
// （草稿命中位置在以后发布时自动遮盖）。
router.post('/api/editor/redaction-preview', (req, res) => {
  const source = req.body && req.body.source;
  res.json(previewSourceRedaction(source));
});

// ---- 确认遮盖：登记精确出处文本（只追加，不改快照/草稿） ----
// 必须提交预览时返回的 currentVersionNo；预览后若有新版本 → 409 不落库；
// 文本已登记过 → 幂等返回已遮盖状态（alreadyRedacted: true）。
router.post('/api/editor/redaction', (req, res) => {
  const body = req.body || {};
  const result = confirmSourceRedaction({
    source: body.source,
    expectedLatestVersionNo: body.currentVersionNo,
    editor: optionalString(body, 'editor', 200),
  });
  res.json(result);
});

// 已登记的出处遮盖清单（编辑者视角，含原文）
router.get('/api/editor/redactions', (req, res) => {
  res.json({ currentVersionNo: latestVersionNo(), redactions: listRedactions() });
});

// ---- 预约发布：建立预约（冻结事件/所选主张/先于关系/求解日期/当前最新版本号） ----
// 体含 selection、scheduledAt（未来 UTC 时刻）、baseVersionNo、editor、note。
// 时间非法或非未来 → 400；选择为空 → 400；草稿未通过现有发布校验 → 422；
// baseVersionNo 不等于当前最新版本号 → 409；均不建立预约。
router.post('/api/editor/schedules', (req, res) => {
  const body = req.body || {};
  const selectionList = normalizeSelection(body);
  const baseVersionNo = body.baseVersionNo === null || body.baseVersionNo === undefined
    ? null
    : Number(body.baseVersionNo);
  if (baseVersionNo !== null && !Number.isInteger(baseVersionNo)) {
    throw badRequest('baseVersionNo 必须是整数或 null');
  }
  const editor = optionalString(body, 'editor', 200) || '匿名编辑';
  const note = optionalString(body, 'note', 1000);
  const schedule = createSchedule({
    selectionList,
    scheduledAtRaw: body.scheduledAt,
    baseVersionNo,
    editor,
    note,
  });
  // 新建后立即唤醒调度器（通常 1 秒内也会自然触发）
  scheduler.kick();
  res.status(201).json({ ok: true, schedule });
});

// 预约列表（工作台）：未执行的在前；列表项含冻结事件摘要
router.get('/api/editor/schedules', (req, res) => {
  res.json({ currentVersionNo: latestVersionNo(), schedules: listSchedules() });
});

// 预约详情：展开冻结的完整事件 / 主张 / 关系 / 求解日期（冲突后供编辑者查看内容）
router.get('/api/editor/schedules/:no', (req, res) => {
  const no = Number(req.params.no);
  if (!Number.isInteger(no) || no < 1) throw badRequest('预约号必须是正整数');
  const schedule = getSchedule(no);
  if (!schedule) throw { status: 404, message: `预约 ${req.params.no} 不存在` };
  res.json({ schedule });
});

// 取消尚未执行的预约；已生效（published/conflict）的预约不能取消（409）
router.delete('/api/editor/schedules/:no', (req, res) => {
  const no = Number(req.params.no);
  if (!Number.isInteger(no) || no < 1) throw badRequest('预约号必须是正整数');
  const result = cancelSchedule(no);
  res.json({ ok: true, ...result });
});

// ---- 专题「先于」脉络路线：建立（冻结版本号/锚点顺序/见证链，不可变） ----
// 体含 title（专题标题）、versionNo（所据已发布版本）、anchorEventIds（≥2 个互异事件，有序）、
// editor、note。相邻锚点在该版关系图中无有向路径 → 422 并指出断点，整条不保存；
// 未知版本 404；未知事件 422；重复事件 / 锚点不足两个等 400；均不保存。
router.post('/api/editor/routes', (req, res) => {
  const body = req.body || {};
  const route = createRoute({
    title: body.title,
    versionNo: body.versionNo,
    anchorEventIds: body.anchorEventIds,
    editor: optionalString(body, 'editor', 200) || '匿名编辑',
    note: optionalString(body, 'note', 1000),
  });
  res.status(201).json({ ok: true, route });
});

// 路线清单（编辑者视角）：在公开结构基础上附加所据版本是否已撤回的标记；
// 引用撤回版的路线编辑者仍可见（访客清单中隐藏）。
router.get('/api/editor/routes', (req, res) => {
  const retracted = retractedVersionNoSet();
  res.json({
    routes: listRoutes().map((r) => ({ ...r, versionRetracted: retracted.has(r.versionNo) })),
  });
});

// 路线详情原文（持编辑口令）：不应用出处遮盖，访客公开接口中命中处显示「出处已遮盖」
// 引用撤回版的路线编辑者仍可查看；响应附带 versionRetracted 标记。
router.get('/api/editor/routes/:no/raw', (req, res) => {
  const no = Number(req.params.no);
  if (!Number.isInteger(no) || no < 1) throw badRequest('路线号必须是正整数');
  const detail = getRouteDetail(no);
  if (!detail) throw { status: 404, message: `路线 ${req.params.no} 不存在` };
  res.json({ route: detail, versionRetracted: isRetracted(detail.versionNo) });
});

// ================= 并行编辑会话（暂存修改，提交时三方合并） =================
// 两名编辑者同时整理草稿：各自开启会话（记录当时草稿修订号与事件/主张/关系快照），
// 会话内修改先暂存为操作，提交时对照会话基线与当前草稿做三方合并。
// 全部端点仅持编辑口令可用（/api/editor 已有口令中间件），访客不可见。

// 开启会话：记录当前草稿修订号 + 事件/主张/「先于」关系快照（基线，只读）
router.post('/api/editor/sessions', (req, res) => {
  const body = req.body || {};
  const session = openSession({
    editor: optionalString(body, 'editor', 200) || '匿名编辑',
    note: optionalString(body, 'note', 1000),
  });
  res.status(201).json({ ok: true, session });
});

// 会话列表（状态 / 基线修订号 / 操作数 / 结果摘要）
router.get('/api/editor/sessions', (req, res) => {
  res.json({ draftRevisionNo: draftRevisionNo(), sessions: listSessions() });
});

// 会话详情：基线快照、暂存操作、会话工作稿（基线+操作折叠）、提交结果
router.get('/api/editor/sessions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw badRequest('会话号必须是正整数');
  const session = getSession(id);
  if (!session) throw { status: 404, message: `编辑会话 ${req.params.id} 不存在` };
  res.json({ session });
});

// 暂存一批操作：整批校验（沿用现有主张日期/出处/关系校验），有问题整批拒绝（422）
router.post('/api/editor/sessions/:id/ops', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw badRequest('会话号必须是正整数');
  const result = appendSessionOps(id, req.body && req.body.ops);
  res.status(201).json({ ok: true, ...result });
});

// 提交会话：三方合并。成功 200（新修订号 + 临时编号映射）；冲突 409 逐项列出
// 基线/当前值/拟提交值；重复提交返回首次结果（幂等，不重复写入）。
router.post('/api/editor/sessions/:id/commit', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw badRequest('会话号必须是正整数');
  const result = commitSession(id);
  res.json({ ok: true, ...result });
});

module.exports = router;
