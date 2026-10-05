'use strict';

// 并行编辑会话：两名编辑者同时整理年表草稿时的三方合并工作区。
//
// 开启会话（openSession）：把当时的草稿修订号与全部事件 / 主张 / 「先于」关系
// 快照存入会话（基线，只读、不再变化）。草稿本身不加锁，其他人可继续编辑。
//
// 暂存操作（appendSessionOps）：会话内的修改先记录为操作（增 / 删 / 改事件、
// 主张、「先于」关系），整批校验（沿用现有主张日期 / 出处 / 关系校验），有任何
// 问题整批拒绝（422），不落半截。新建对象用会话内临时编号（tempId）互相引用。
//
// 提交（commitSession）：把「基线」「当前草稿」「会话工作稿（基线 + 暂存操作）」
// 做三方合并——
//   · 只有一方触及的对象 / 字段：自动合并（对方的改动原样保留，绝不覆盖）；
//   · 同一字段被双方改成不同值、编辑与删除相撞（含删除会级联丢弃对方新增内容）、
//     关系端点已被对方删除：整次拒绝（409 SESSION_MERGE_CONFLICT），逐项列出
//     基线 / 当前值 / 拟提交值供人工重编，草稿一字未动；
//   · 会话开启后草稿被「从历史版本恢复」整体替换过（恢复会重排对象编号，基线中的
//     对象与当前草稿的同编号对象已不再是同一对象）：同样整次拒绝
//     （409 SESSION_MERGE_CONFLICT，冲突类型 restore_rebased），草稿一字未动——
//     否则按编号对齐的三方合并会把旧对象的改动写进占用同一编号的新对象；
//   · 无冲突：在一个事务内应用全部变更（草稿修订号只推进一次），返回新修订号
//     与临时编号 → 正式编号映射。
// 提交幂等：会话一旦 committed / conflicted 即关闭，重复提交返回首次结果，
// 绝不重复写入；冲突后须基于最新草稿重开会话。
// 会话内容只在 /api/editor 下暴露（持编辑口令），访客不可见。

const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { draftRevisionNo, draftRestoreNo } = require('./restore');

const EVENT_FIELDS = ['title', 'description'];
const CLAIM_FIELDS = ['precision', 'year', 'month', 'day', 'source', 'note'];
const RELATION_FIELDS = ['source', 'note'];

const OBJECT_LABEL = { event: '事件', claim: '主张', relation: '「先于」关系' };
const MAX_OPS_PER_BATCH = 500;

const keyOfId = (id) => `id:${id}`;
const keyOfTemp = (t) => `tmp:${t}`;
const keyToId = (key) => (key.startsWith('id:') ? Number(key.slice(3)) : null);
const keyToTemp = (key) => (key.startsWith('tmp:') ? key.slice(4) : null);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function valuesEqual(a, b) {
  return (a === undefined || a === null ? null : a) === (b === undefined || b === null ? null : b);
}

function diffFields(b, p, fields) {
  return fields.filter((f) => !valuesEqual(b[f], p[f]));
}

function pickFields(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f] === undefined ? null : obj[f];
  return out;
}

// ---------- 读取草稿（基线 / 当前共用同一形状） ----------
function readDraftState() {
  const db = getDb();
  const events = db.prepare('SELECT id, title, description FROM events ORDER BY id').all();
  const claims = db
    .prepare('SELECT id, event_id AS eventId, precision, year, month, day, source, note FROM claims ORDER BY id')
    .all();
  const relations = db
    .prepare('SELECT id, earlier_id AS earlierId, later_id AS laterId, source, note FROM relations ORDER BY id')
    .all();
  return { events, claims, relations };
}

// ---------- 会话工作稿：基线 + 暂存操作 ----------
// 以键索引：既有对象为 "id:<正式id>"，会话内新建对象为 "tmp:<临时编号>"。
function workingFromState(state) {
  const events = new Map();
  for (const e of state.events) {
    events.set(keyOfId(e.id), { key: keyOfId(e.id), id: e.id, tempId: null, title: e.title, description: e.description });
  }
  const claims = new Map();
  for (const c of state.claims) {
    claims.set(keyOfId(c.id), {
      key: keyOfId(c.id),
      id: c.id,
      tempId: null,
      eventKey: keyOfId(c.eventId),
      precision: c.precision,
      year: c.year,
      month: c.month,
      day: c.day,
      source: c.source,
      note: c.note,
    });
  }
  const relations = new Map();
  for (const r of state.relations) {
    relations.set(keyOfId(r.id), {
      key: keyOfId(r.id),
      id: r.id,
      tempId: null,
      earlierKey: keyOfId(r.earlierId),
      laterKey: keyOfId(r.laterId),
      source: r.source,
      note: r.note,
    });
  }
  return { events, claims, relations };
}

function refKeyOf(op, idField, refField) {
  return op[idField] !== undefined ? keyOfId(op[idField]) : keyOfTemp(op[refField]);
}

// 把一条（已校验的）操作应用到工作稿。暂存与提交折叠共用，保证语义一致。
function applyOp(working, op, tempIds) {
  switch (op.op) {
    case 'create_event': {
      const key = keyOfTemp(op.tempId);
      working.events.set(key, { key, id: null, tempId: op.tempId, title: op.title, description: op.description });
      tempIds.add(op.tempId);
      break;
    }
    case 'update_event':
      Object.assign(working.events.get(refKeyOf(op, 'eventId', 'eventRef')), op.set);
      break;
    case 'delete_event': {
      const key = refKeyOf(op, 'eventId', 'eventRef');
      working.events.delete(key);
      // 与草稿区一致：删除事件级联删除其主张与相关关系
      for (const [k, c] of working.claims) if (c.eventKey === key) working.claims.delete(k);
      for (const [k, r] of working.relations) {
        if (r.earlierKey === key || r.laterKey === key) working.relations.delete(k);
      }
      break;
    }
    case 'create_claim': {
      const key = keyOfTemp(op.tempId);
      working.claims.set(key, {
        key,
        id: null,
        tempId: op.tempId,
        eventKey: refKeyOf(op, 'eventId', 'eventRef'),
        precision: op.precision,
        year: op.year,
        month: op.month,
        day: op.day,
        source: op.source,
        note: op.note,
      });
      tempIds.add(op.tempId);
      break;
    }
    case 'update_claim':
      Object.assign(working.claims.get(refKeyOf(op, 'claimId', 'claimRef')), op.set);
      break;
    case 'delete_claim':
      working.claims.delete(refKeyOf(op, 'claimId', 'claimRef'));
      break;
    case 'create_relation': {
      const key = keyOfTemp(op.tempId);
      working.relations.set(key, {
        key,
        id: null,
        tempId: op.tempId,
        earlierKey: refKeyOf(op, 'earlierId', 'earlierRef'),
        laterKey: refKeyOf(op, 'laterId', 'laterRef'),
        source: op.source,
        note: op.note,
      });
      tempIds.add(op.tempId);
      break;
    }
    case 'update_relation':
      Object.assign(working.relations.get(refKeyOf(op, 'relationId', 'relationRef')), op.set);
      break;
    case 'delete_relation':
      working.relations.delete(refKeyOf(op, 'relationId', 'relationRef'));
      break;
    default:
      break;
  }
}

function foldWorking(baseline, ops) {
  const working = workingFromState(baseline);
  const tempIds = new Set();
  for (const op of ops) applyOp(working, op, tempIds);
  return working;
}

// ---------- 暂存操作的校验（沿用现有主张日期 / 出处 / 关系校验） ----------
function fail(message) {
  throw { opProblem: message };
}

function reqTempId(v, tempIds) {
  if (typeof v !== 'string' || v.trim() === '') fail('tempId（临时编号）必须是非空字符串');
  const t = v.trim();
  if (t.length > 100) fail('tempId 长度不能超过 100 字符');
  if (tempIds.has(t)) fail(`临时编号「${t}」在本会话中已被使用`);
  return t;
}

function reqTitle(v) {
  if (typeof v !== 'string' || v.trim() === '') fail('title 必须是非空字符串');
  if (v.length > 200) fail('title 长度不能超过 200 字符');
  return v.trim();
}

function optText(v, max, name) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail(`${name} 必须是字符串`);
  if (v.length > max) fail(`${name} 长度不能超过 ${max} 字符`);
  return v;
}

function reqSource(v) {
  if (typeof v !== 'string' || v.trim() === '') fail('source（出处）必须是非空字符串');
  if (v.length > 1000) fail('source 长度不能超过 1000 字符');
  return v;
}

// 解析对象引用：既有对象给整数 id，会话内新建对象给临时编号；二者只能其一。
function resolveRef(raw, working, mapName, idField, refField, label) {
  const hasId = raw[idField] !== undefined && raw[idField] !== null;
  const hasRef = raw[refField] !== undefined && raw[refField] !== null;
  if (hasId && hasRef) fail(`${idField} 与 ${refField} 只能提供一个`);
  if (hasId) {
    const id = Number(raw[idField]);
    if (!Number.isInteger(id) || id < 1) fail(`${idField} 必须是正整数`);
    const key = keyOfId(id);
    if (!working[mapName].has(key)) {
      fail(`${label} ${id} 不在会话工作稿中（不存在、已在会话内删除，或晚于会话基线加入草稿——如需引用请重开会话）`);
    }
    return { key, ref: { [idField]: id } };
  }
  if (hasRef) {
    if (typeof raw[refField] !== 'string' || raw[refField].trim() === '') {
      fail(`${refField} 必须是非空临时编号字符串`);
    }
    const t = raw[refField].trim();
    const key = keyOfTemp(t);
    if (!working[mapName].has(key)) fail(`临时编号「${t}」不是本会话创建的${label}`);
    return { key, ref: { [refField]: t } };
  }
  fail(`必须提供 ${idField}（既有${label} id）或 ${refField}（会话内临时编号）`);
  return null; // 不可达
}

function parseClaimOrFail(input, prefix) {
  try {
    return parseClaimDate(input);
  } catch (e) {
    fail(`${prefix}：${e.message}`);
    return null; // 不可达
  }
}

// 校验并归一化一条操作；校验问题经 fail() 抛出，由 normalizeOps 收集。
function normalizeOp(raw, working, tempIds) {
  if (!isPlainObject(raw)) fail('必须是操作对象');
  const kind = raw.op;
  if (typeof kind !== 'string' || kind.trim() === '') fail('缺少 op 字段（操作类型）');

  switch (kind) {
    case 'create_event': {
      const tempId = reqTempId(raw.tempId, tempIds);
      const title = reqTitle(raw.title);
      const description = optText(raw.description, 5000, 'description');
      return { op: kind, tempId, title, description };
    }
    case 'update_event': {
      const { ref } = resolveRef(raw, working, 'events', 'eventId', 'eventRef', '事件');
      const set = {};
      if (raw.title !== undefined) set.title = reqTitle(raw.title);
      if (raw.description !== undefined) set.description = optText(raw.description, 5000, 'description');
      if (!Object.keys(set).length) fail('update_event 至少要提供 title 或 description 之一');
      return { op: kind, ...ref, set };
    }
    case 'delete_event': {
      const { ref } = resolveRef(raw, working, 'events', 'eventId', 'eventRef', '事件');
      return { op: kind, ...ref };
    }
    case 'create_claim': {
      const tempId = reqTempId(raw.tempId, tempIds);
      const { ref } = resolveRef(raw, working, 'events', 'eventId', 'eventRef', '事件');
      const parsed = parseClaimOrFail(raw, '主张日期非法');
      const source = reqSource(raw.source);
      const note = optText(raw.note, 2000, 'note');
      return { op: kind, tempId, ...ref, ...parsed, source, note };
    }
    case 'update_claim': {
      const { key, ref } = resolveRef(raw, working, 'claims', 'claimId', 'claimRef', '主张');
      const cur = working.claims.get(key);
      const set = {};
      const dateTouched = ['precision', 'year', 'month', 'day'].some((f) => raw[f] !== undefined);
      if (dateTouched) {
        // 日期各分量与现有值合并后整体校验（与直接录入同一校验）
        const merged = { precision: cur.precision, year: cur.year, month: cur.month, day: cur.day };
        for (const f of ['precision', 'year', 'month', 'day']) {
          if (raw[f] !== undefined) merged[f] = raw[f];
        }
        Object.assign(set, parseClaimOrFail(merged, '修改后的主张日期非法'));
      }
      if (raw.source !== undefined) set.source = reqSource(raw.source);
      if (raw.note !== undefined) set.note = optText(raw.note, 2000, 'note');
      if (!Object.keys(set).length) fail('update_claim 至少要提供一个可修改字段（precision/year/month/day/source/note）');
      return { op: kind, ...ref, set };
    }
    case 'delete_claim': {
      const { ref } = resolveRef(raw, working, 'claims', 'claimId', 'claimRef', '主张');
      return { op: kind, ...ref };
    }
    case 'create_relation': {
      const tempId = reqTempId(raw.tempId, tempIds);
      const earlier = resolveRef(raw, working, 'events', 'earlierId', 'earlierRef', '事件');
      const later = resolveRef(raw, working, 'events', 'laterId', 'laterRef', '事件');
      if (earlier.key === later.key) fail('一个事件不能先于自身');
      const source = optText(raw.source, 1000, 'source');
      const note = optText(raw.note, 2000, 'note');
      return { op: kind, tempId, ...earlier.ref, ...later.ref, source, note };
    }
    case 'update_relation': {
      const { ref } = resolveRef(raw, working, 'relations', 'relationId', 'relationRef', '「先于」关系');
      const set = {};
      if (raw.source !== undefined) set.source = optText(raw.source, 1000, 'source');
      if (raw.note !== undefined) set.note = optText(raw.note, 2000, 'note');
      if (!Object.keys(set).length) fail('update_relation 至少要提供 source 或 note 之一');
      return { op: kind, ...ref, set };
    }
    case 'delete_relation': {
      const { ref } = resolveRef(raw, working, 'relations', 'relationId', 'relationRef', '「先于」关系');
      return { op: kind, ...ref };
    }
    default:
      fail(
        `未知操作类型「${kind}」（支持 create_event / update_event / delete_event / ` +
          `create_claim / update_claim / delete_claim / create_relation / update_relation / delete_relation）`
      );
      return null; // 不可达
  }
}

// 整批校验：任何一条有问题即整批拒绝（不落半截）；合法操作顺次应用到工作稿，
// 使同批后续操作可以引用本批新建的对象。
function normalizeOps(rawOps, working, tempIds) {
  const ops = [];
  const problems = [];
  rawOps.forEach((raw, index) => {
    try {
      const op = normalizeOp(raw, working, tempIds);
      ops.push(op);
      applyOp(working, op, tempIds);
    } catch (e) {
      if (e && e.opProblem) {
        problems.push({ opIndex: index, op: isPlainObject(raw) ? raw.op : undefined, message: `ops[${index}]：${e.opProblem}` });
      } else {
        throw e;
      }
    }
  });
  return { ops, problems };
}

// ---------- 三方合并 ----------
// baseline / current：readDraftState 形状；proposed：会话工作稿（Map 结构）。
// 返回 { plan, conflicts, autoMerged }；conflicts 非空时整次拒绝。
function mergeExisting({ objectType, fields, baselineRows, currentById, proposedMap, plan, conflicts, autoMerged, validateMerged }) {
  const updates = [];
  const deletes = [];
  for (const b of baselineRows) {
    const id = b.id;
    const c = currentById.get(id); // undefined = 对方已删除
    const p = proposedMap.get(keyOfId(id)); // undefined = 会话内已删除
    const sessionDeleted = p === undefined;
    const otherDeleted = c === undefined;
    const sessionFields = sessionDeleted ? [] : diffFields(b, p, fields);
    const otherFields = otherDeleted ? [] : diffFields(b, c, fields);
    const sessionChanged = sessionDeleted || sessionFields.length > 0;
    const otherChanged = otherDeleted || otherFields.length > 0;

    if (!sessionChanged) continue; // 会话未触及：对方的改动 / 删除原样保留
    if (!otherChanged) {
      // 仅会话触及：直接采用会话版本
      if (sessionDeleted) deletes.push(id);
      else updates.push({ id, values: pickFields(p, fields) });
      continue;
    }
    if (sessionDeleted && otherDeleted) continue; // 双方都删除：已不存在，无需动作
    if (sessionDeleted) {
      conflicts.push({
        type: 'edit_delete',
        objectType,
        id,
        message: `${OBJECT_LABEL[objectType]} #${id}：会话内删除，但对方在此期间修改了它——编辑与删除相撞`,
        sessionAction: 'delete',
        baseline: pickFields(b, fields),
        current: pickFields(c, fields),
        proposed: null,
      });
      continue;
    }
    if (otherDeleted) {
      conflicts.push({
        type: 'edit_delete',
        objectType,
        id,
        message: `${OBJECT_LABEL[objectType]} #${id}：会话内修改，但对方已将其删除——编辑与删除相撞`,
        sessionAction: 'update',
        baseline: pickFields(b, fields),
        current: null,
        proposed: pickFields(p, fields),
      });
      continue;
    }
    // 双方都修改：逐字段比对
    const overlap = sessionFields.filter((f) => otherFields.includes(f) && !valuesEqual(p[f], c[f]));
    if (overlap.length) {
      conflicts.push({
        type: 'field_conflict',
        objectType,
        id,
        message: `${OBJECT_LABEL[objectType]} #${id} 的 ${overlap.length} 个字段被双方改成不同值：${overlap.join('、')}`,
        fields: overlap.map((f) => ({ field: f, baseline: b[f] ?? null, current: c[f] ?? null, proposed: p[f] ?? null })),
        baseline: pickFields(b, fields),
        current: pickFields(c, fields),
        proposed: pickFields(p, fields),
      });
      continue;
    }
    // 双方改了不同字段（或同字段改成同值）：自动合并——以当前草稿为基础，覆盖会话改过的字段
    const merged = { ...pickFields(c, fields) };
    for (const f of sessionFields) merged[f] = p[f];
    if (validateMerged) {
      const problem = validateMerged(merged);
      if (problem) {
        conflicts.push({
          type: 'field_conflict',
          objectType,
          id,
          message: `${OBJECT_LABEL[objectType]} #${id}：双方分别修改的字段合并后非法（${problem}），请人工重编`,
          fields: [...new Set([...sessionFields, ...otherFields])].map((f) => ({
            field: f,
            baseline: b[f] ?? null,
            current: c[f] ?? null,
            proposed: p[f] ?? null,
          })),
          baseline: pickFields(b, fields),
          current: pickFields(c, fields),
          proposed: pickFields(p, fields),
        });
        continue;
      }
    }
    updates.push({ id, values: merged });
    if (otherFields.length > 0) {
      autoMerged.push({ objectType, id, sessionFields, otherFields });
    }
  }
  return { updates, deletes };
}

function validateMergedClaim(merged) {
  try {
    parseClaimDate(merged);
    return null;
  } catch (e) {
    return e.message;
  }
}

function mergeThreeWay(baseline, current, proposed) {
  const conflicts = [];
  const autoMerged = [];
  const plan = {
    eventCreates: [],
    eventUpdates: [],
    eventDeletes: [],
    claimCreates: [],
    claimUpdates: [],
    claimDeletes: [],
    relationCreates: [],
    relationUpdates: [],
    relationDeletes: [],
  };

  const currentEvents = new Map(current.events.map((e) => [e.id, e]));
  const currentClaims = new Map(current.claims.map((c) => [c.id, c]));
  const currentRelations = new Map(current.relations.map((r) => [r.id, r]));

  // ---- 既有对象：基线 vs 当前草稿 vs 会话工作稿 ----
  const ev = mergeExisting({
    objectType: 'event',
    fields: EVENT_FIELDS,
    baselineRows: baseline.events,
    currentById: currentEvents,
    proposedMap: proposed.events,
    conflicts,
    autoMerged,
  });
  plan.eventUpdates = ev.updates;
  plan.eventDeletes = ev.deletes;

  const cl = mergeExisting({
    objectType: 'claim',
    fields: CLAIM_FIELDS,
    baselineRows: baseline.claims,
    currentById: currentClaims,
    proposedMap: proposed.claims,
    conflicts,
    autoMerged,
    validateMerged: validateMergedClaim,
  });
  plan.claimUpdates = cl.updates;
  plan.claimDeletes = cl.deletes;

  const rl = mergeExisting({
    objectType: 'relation',
    fields: RELATION_FIELDS,
    baselineRows: baseline.relations,
    currentById: currentRelations,
    proposedMap: proposed.relations,
    conflicts,
    autoMerged,
  });
  plan.relationUpdates = rl.updates;
  plan.relationDeletes = rl.deletes;

  // ---- 会话删除事件 vs 对方在其上新增内容（删除会级联丢弃对方改动 → 编辑与删除相撞） ----
  const baselineClaimIds = new Set(baseline.claims.map((c) => c.id));
  const baselineRelationIds = new Set(baseline.relations.map((r) => r.id));
  for (const eventId of plan.eventDeletes) {
    const blockers = [];
    for (const c of current.claims) {
      if (c.eventId === eventId && !baselineClaimIds.has(c.id)) {
        blockers.push({ objectType: 'claim', claimId: c.id, source: c.source });
      }
    }
    for (const r of current.relations) {
      if ((r.earlierId === eventId || r.laterId === eventId) && !baselineRelationIds.has(r.id)) {
        blockers.push({ objectType: 'relation', relationId: r.id, earlierId: r.earlierId, laterId: r.laterId });
      }
    }
    if (blockers.length) {
      const b = baseline.events.find((e) => e.id === eventId);
      conflicts.push({
        type: 'edit_delete',
        objectType: 'event',
        id: eventId,
        message:
          `事件 #${eventId}「${b ? b.title : ''}」：会话内删除，但对方在此期间为其新增了 ${blockers.length} 条内容，` +
          `删除会丢弃对方的改动——编辑与删除相撞`,
        sessionAction: 'delete',
        blockers,
        baseline: b ? pickFields(b, EVENT_FIELDS) : null,
        current: currentEvents.get(eventId) ? pickFields(currentEvents.get(eventId), EVENT_FIELDS) : null,
        proposed: null,
      });
    }
  }

  // ---- 会话新建对象：检查端点 / 所属事件是否已被对方删除 ----
  for (const e of proposed.events.values()) {
    if (e.id === null) plan.eventCreates.push({ tempId: e.tempId, title: e.title, description: e.description });
  }
  for (const c of proposed.claims.values()) {
    if (c.id !== null) continue;
    const eventId = keyToId(c.eventKey);
    if (eventId !== null && !currentEvents.has(eventId)) {
      conflicts.push({
        type: 'endpoint_deleted',
        objectType: 'claim',
        tempId: c.tempId,
        missingEventId: eventId,
        message: `会话新增主张（临时编号「${c.tempId}」）所属的事件 #${eventId} 已被对方删除`,
        baseline: null,
        current: null,
        proposed: pickFields(c, CLAIM_FIELDS),
      });
      continue;
    }
    plan.claimCreates.push({
      tempId: c.tempId,
      eventKey: c.eventKey,
      precision: c.precision,
      year: c.year,
      month: c.month,
      day: c.day,
      source: c.source,
      note: c.note,
    });
  }
  for (const r of proposed.relations.values()) {
    if (r.id !== null) continue;
    const earlierId = keyToId(r.earlierKey);
    const laterId = keyToId(r.laterKey);
    const missing = [];
    if (earlierId !== null && !currentEvents.has(earlierId)) missing.push({ role: 'earlier', eventId: earlierId });
    if (laterId !== null && !currentEvents.has(laterId)) missing.push({ role: 'later', eventId: laterId });
    if (missing.length) {
      conflicts.push({
        type: 'endpoint_deleted',
        objectType: 'relation',
        tempId: r.tempId,
        missingEventId: missing[0].eventId,
        missing,
        message: `会话新增「先于」关系（临时编号「${r.tempId}」）的端点事件 #${missing[0].eventId} 已被对方删除`,
        baseline: null,
        current: null,
        proposed: {
          earlierId: earlierId,
          earlierTempId: keyToTemp(r.earlierKey),
          laterId: laterId,
          laterTempId: keyToTemp(r.laterKey),
          source: r.source,
          note: r.note,
        },
      });
      continue;
    }
    plan.relationCreates.push({
      tempId: r.tempId,
      earlierKey: r.earlierKey,
      laterKey: r.laterKey,
      source: r.source,
      note: r.note,
    });
  }

  return { plan, conflicts, autoMerged };
}

// ---------- 应用合并计划（调用方事务内） ----------
function applyPlan(db, plan) {
  const idMap = { events: [], claims: [], relations: [] };
  const applied = {
    eventsCreated: 0,
    eventsUpdated: 0,
    eventsDeleted: 0,
    claimsCreated: 0,
    claimsUpdated: 0,
    claimsDeleted: 0,
    relationsCreated: 0,
    relationsUpdated: 0,
    relationsDeleted: 0,
  };

  // 删除：先关系、再主张、再事件（事件删除本身会级联，显式删除使意图明确）
  const delRel = db.prepare('DELETE FROM relations WHERE id = ?');
  for (const id of plan.relationDeletes) {
    delRel.run(id);
    applied.relationsDeleted += 1;
  }
  const delClaim = db.prepare('DELETE FROM claims WHERE id = ?');
  for (const id of plan.claimDeletes) {
    delClaim.run(id);
    applied.claimsDeleted += 1;
  }
  const delEvent = db.prepare('DELETE FROM events WHERE id = ?');
  for (const id of plan.eventDeletes) {
    delEvent.run(id);
    applied.eventsDeleted += 1;
  }

  // 更新：写入合并后的完整记录（未触及字段即当前草稿值，不覆盖对方改动）
  const updEvent = db.prepare("UPDATE events SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?");
  for (const u of plan.eventUpdates) {
    updEvent.run(u.values.title, u.values.description, u.id);
    applied.eventsUpdated += 1;
  }
  const updClaim = db.prepare(
    `UPDATE claims SET precision = ?, year = ?, month = ?, day = ?, date_label = ?,
       interval_start = ?, interval_end = ?, source = ?, note = ? WHERE id = ?`
  );
  for (const u of plan.claimUpdates) {
    const v = u.values;
    const iv = claimInterval(v.precision, v.year, v.month, v.day);
    updClaim.run(
      v.precision,
      v.year,
      v.month,
      v.day,
      formatClaimDate(v.precision, v.year, v.month, v.day),
      iv.start,
      iv.end,
      v.source,
      v.note,
      u.id
    );
    applied.claimsUpdated += 1;
  }
  const updRel = db.prepare('UPDATE relations SET source = ?, note = ? WHERE id = ?');
  for (const u of plan.relationUpdates) {
    updRel.run(u.values.source, u.values.note, u.id);
    applied.relationsUpdated += 1;
  }

  // 新建：先事件（取得正式编号），再主张，再关系
  const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  const eventIdByTemp = new Map();
  for (const c of plan.eventCreates) {
    const eventId = insEvent.run(c.title, c.description).lastInsertRowid;
    eventIdByTemp.set(c.tempId, eventId);
    idMap.events.push({ tempId: c.tempId, eventId });
    applied.eventsCreated += 1;
  }
  const resolveEventKey = (key) => {
    const temp = keyToTemp(key);
    return temp !== null ? eventIdByTemp.get(temp) : keyToId(key);
  };
  const insClaim = db.prepare(
    `INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const c of plan.claimCreates) {
    const iv = claimInterval(c.precision, c.year, c.month, c.day);
    const eventId = resolveEventKey(c.eventKey);
    const claimId = insClaim
      .run(
        eventId,
        c.precision,
        c.year,
        c.month,
        c.day,
        formatClaimDate(c.precision, c.year, c.month, c.day),
        iv.start,
        iv.end,
        c.source,
        c.note
      )
      .lastInsertRowid;
    idMap.claims.push({ tempId: c.tempId, claimId, eventId });
    applied.claimsCreated += 1;
  }
  const insRel = db.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');
  for (const r of plan.relationCreates) {
    const relationId = insRel.run(resolveEventKey(r.earlierKey), resolveEventKey(r.laterKey), r.source, r.note).lastInsertRowid;
    idMap.relations.push({ tempId: r.tempId, relationId });
    applied.relationsCreated += 1;
  }

  return { idMap, applied };
}

// ---------- 展示形状 ----------
function cmpObj(a, b) {
  const ai = a.id === null ? Number.MAX_SAFE_INTEGER : a.id;
  const bi = b.id === null ? Number.MAX_SAFE_INTEGER : b.id;
  if (ai !== bi) return ai - bi;
  return String(a.tempId || '').localeCompare(String(b.tempId || ''));
}

function shapeClaim(c) {
  const iv = claimInterval(c.precision, c.year, c.month, c.day);
  return {
    id: c.id,
    tempId: c.tempId,
    eventId: keyToId(c.eventKey),
    eventTempId: keyToTemp(c.eventKey),
    precision: c.precision,
    year: c.year,
    month: c.month,
    day: c.day,
    dateLabel: formatClaimDate(c.precision, c.year, c.month, c.day),
    intervalStart: iv.start,
    intervalEnd: iv.end,
    source: c.source,
    note: c.note,
  };
}

function shapeState(working) {
  const events = [...working.events.values()].sort(cmpObj).map((e) => ({
    id: e.id,
    tempId: e.tempId,
    title: e.title,
    description: e.description,
    claims: [...working.claims.values()]
      .filter((c) => c.eventKey === e.key)
      .sort(cmpObj)
      .map(shapeClaim),
  }));
  const relations = [...working.relations.values()].sort(cmpObj).map((r) => ({
    id: r.id,
    tempId: r.tempId,
    earlierId: keyToId(r.earlierKey),
    earlierTempId: keyToTemp(r.earlierKey),
    laterId: keyToId(r.laterKey),
    laterTempId: keyToTemp(r.laterKey),
    source: r.source,
    note: r.note,
  }));
  const claimCount = events.reduce((n, e) => n + e.claims.length, 0);
  return {
    events,
    relations,
    counts: { eventCount: events.length, claimCount, relationCount: relations.length },
  };
}

// ---------- 会话存取 ----------
function loadOps(sessionId) {
  return getDb()
    .prepare('SELECT op_json FROM edit_session_ops WHERE session_id = ? ORDER BY seq')
    .all(sessionId)
    .map((r) => JSON.parse(r.op_json));
}

function getSessionRow(sessionId) {
  return getDb().prepare('SELECT * FROM edit_sessions WHERE id = ?').get(sessionId);
}

// 开启会话：记录当前草稿修订号、恢复序号（草稿代）与完整草稿快照（基线，只读）。
function openSession({ editor, note }) {
  const db = getDb();
  const baseline = readDraftState();
  const baseRevisionNo = draftRevisionNo();
  const baseRestoreNo = draftRestoreNo();
  const info = db
    .prepare('INSERT INTO edit_sessions (editor, note, base_revision_no, base_restore_no, baseline_json) VALUES (?, ?, ?, ?, ?)')
    .run(String(editor || ''), String(note || ''), baseRevisionNo, baseRestoreNo, JSON.stringify(baseline));
  return getSession(info.lastInsertRowid);
}

function getSession(sessionId) {
  const row = getSessionRow(sessionId);
  if (!row) return null;
  const baseline = JSON.parse(row.baseline_json);
  const ops = loadOps(sessionId);
  const working = foldWorking(baseline, ops);
  return {
    sessionId: row.id,
    editor: row.editor,
    note: row.note,
    status: row.status,
    baseRevisionNo: row.base_revision_no,
    baseRestoreNo: row.base_restore_no,
    currentRevisionNo: draftRevisionNo(),
    // 开启后草稿被恢复过：基线对象身份已更替，本会话提交将被整次拒绝
    restoredAfterOpen: draftRestoreNo() !== row.base_restore_no,
    openedAt: row.created_at,
    closedAt: row.closed_at,
    baseline: shapeState(workingFromState(baseline)),
    ops,
    working: shapeState(working),
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

function listSessions() {
  const restoreNo = draftRestoreNo();
  return getDb()
    .prepare(
      `SELECT s.id AS sessionId, s.editor, s.note, s.status,
              s.base_revision_no AS baseRevisionNo, s.base_restore_no AS baseRestoreNo,
              s.created_at AS openedAt, s.closed_at AS closedAt,
              (SELECT COUNT(*) FROM edit_session_ops o WHERE o.session_id = s.id) AS opCount,
              s.result_json AS resultJson
         FROM edit_sessions s ORDER BY s.id DESC`
    )
    .all()
    .map((r) => {
      const result = r.resultJson ? JSON.parse(r.resultJson) : null;
      return {
        sessionId: r.sessionId,
        editor: r.editor,
        note: r.note,
        status: r.status,
        baseRevisionNo: r.baseRevisionNo,
        restoredAfterOpen: restoreNo !== r.baseRestoreNo,
        opCount: r.opCount,
        openedAt: r.openedAt,
        closedAt: r.closedAt,
        revisionNo: result && result.revisionNo !== undefined ? result.revisionNo : null,
        conflictCount: result && Array.isArray(result.conflicts) ? result.conflicts.length : null,
      };
    });
}

// 暂存一批操作：整批校验（沿用现有主张日期 / 出处 / 关系校验），有问题整批拒绝。
function appendSessionOps(sessionId, rawOps) {
  const db = getDb();
  const row = getSessionRow(sessionId);
  if (!row) throw { status: 404, message: `编辑会话 ${sessionId} 不存在` };
  if (row.status !== 'open') {
    throw {
      status: 409,
      code: 'SESSION_NOT_OPEN',
      message: `编辑会话 #${sessionId} 已关闭（${row.status === 'committed' ? '已提交' : '冲突已关闭'}），不能再暂存操作；请基于最新草稿重开会话`,
    };
  }
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    throw { status: 400, message: 'ops 必须是非空操作数组' };
  }
  if (rawOps.length > MAX_OPS_PER_BATCH) {
    throw { status: 400, message: `一批最多暂存 ${MAX_OPS_PER_BATCH} 个操作` };
  }

  const baseline = JSON.parse(row.baseline_json);
  const existingOps = loadOps(sessionId);
  const working = foldWorking(baseline, existingOps);
  // 临时编号在会话内全程唯一（即使对象后来在会话内被删除也不复用）
  const tempIds = new Set(existingOps.filter((op) => op.tempId).map((op) => op.tempId));

  const { ops, problems } = normalizeOps(rawOps, working, tempIds);
  if (problems.length) {
    throw {
      status: 422,
      code: 'SESSION_OPS_INVALID',
      message: `这批操作有 ${problems.length} 处问题，已整批拒绝，未暂存任何操作`,
      problems,
    };
  }

  const tx = db.transaction(() => {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM edit_session_ops WHERE session_id = ?').get(sessionId).m;
    const ins = db.prepare('INSERT INTO edit_session_ops (session_id, seq, op_json) VALUES (?, ?, ?)');
    ops.forEach((op, i) => ins.run(sessionId, maxSeq + 1 + i, JSON.stringify(op)));
  });
  tx();

  return {
    sessionId,
    staged: ops.length,
    opCount: existingOps.length + ops.length,
    working: shapeState(working),
  };
}

// 提交会话：三方合并 → 无冲突则一个事务应用全部变更；有冲突整次拒绝并逐项列出。
// 会话开启后若草稿被「从历史版本恢复」替换过（草稿代已变），基线对象身份已更替，
// 同样整次拒绝（冲突类型 restore_rebased）——不做按编号对齐的三方合并。
// 幂等：会话关闭后重复提交返回首次结果，绝不重复写入。
function commitSession(sessionId) {
  const db = getDb();
  const row = getSessionRow(sessionId);
  if (!row) throw { status: 404, message: `编辑会话 ${sessionId} 不存在` };

  if (row.status === 'committed') {
    const result = JSON.parse(row.result_json);
    return { sessionId, status: 'committed', alreadyCommitted: true, ...result };
  }
  if (row.status === 'conflicted') {
    const result = JSON.parse(row.result_json);
    throw {
      status: 409,
      code: 'SESSION_MERGE_CONFLICT',
      alreadyConflicted: true,
      sessionId,
      message: `编辑会话 #${sessionId} 此前的提交已因冲突被拒绝（会话已关闭，草稿未改动）。请基于最新草稿重开会话后重新暂存并提交。`,
      ...result,
    };
  }

  // 恢复识别：开启后草稿被「从历史版本恢复」整体替换过时，恢复会清空草稿并按
  // 版本快照重建、重排全部对象编号——基线中的对象与当前草稿的同编号对象已不再
  // 是同一对象，按编号对齐的三方合并会把旧对象的改动写进占用同一编号的新对象。
  // 因此整次拒绝（草稿一字未动），须基于最新草稿重开会话。
  const currentRestoreNo = draftRestoreNo();
  if (currentRestoreNo !== row.base_restore_no) {
    const restores = db
      .prepare(
        `SELECT id AS restoreNo, version_no AS versionNo, created_at AS restoredAt
           FROM draft_restores WHERE id > ? ORDER BY id`
      )
      .all(row.base_restore_no);
    const restoreList = restores.map((r) => `第 ${r.restoreNo} 次（恢复自第 ${r.versionNo} 版，${r.restoredAt} UTC）`).join('；');
    const conflicts = [
      {
        type: 'restore_rebased',
        message:
          `会话开启后草稿被「从历史版本恢复」整体替换过 ${restores.length} 次（${restoreList}）：` +
          `恢复清空草稿并按版本快照重建，事件 / 主张 / 关系的编号被重新占用，` +
          `基线中的对象与当前草稿中的同编号对象已不再是同一对象，无法安全三方合并`,
        restores,
        baseline: null,
        current: null,
        proposed: null,
      },
    ];
    const stored = {
      baseRevisionNo: row.base_revision_no,
      currentRevisionNo: draftRevisionNo(),
      conflicts,
    };
    db.prepare("UPDATE edit_sessions SET status = 'conflicted', result_json = ?, closed_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(stored),
      sessionId
    );
    throw {
      status: 409,
      code: 'SESSION_MERGE_CONFLICT',
      sessionId,
      message:
        `编辑会话 #${sessionId} 提交被拒绝：会话开启后草稿被「从历史版本恢复」整体替换过，` +
        `对象编号已重新占用，基线对象身份已更替（冲突类型 restore_rebased）。` +
        `草稿未做任何改动，请基于最新草稿重开会话后重新暂存并提交。`,
      ...stored,
    };
  }

  const baseline = JSON.parse(row.baseline_json);
  const ops = loadOps(sessionId);
  const proposed = foldWorking(baseline, ops);
  const current = readDraftState();
  const { plan, conflicts, autoMerged } = mergeThreeWay(baseline, current, proposed);

  if (conflicts.length) {
    // 只翻转会话状态并留存冲突明细；草稿一字未动
    const stored = {
      baseRevisionNo: row.base_revision_no,
      currentRevisionNo: draftRevisionNo(),
      conflicts,
    };
    db.prepare("UPDATE edit_sessions SET status = 'conflicted', result_json = ?, closed_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(stored),
      sessionId
    );
    throw {
      status: 409,
      code: 'SESSION_MERGE_CONFLICT',
      sessionId,
      message:
        `编辑会话 #${sessionId} 提交被拒绝：发现 ${conflicts.length} 处冲突` +
        `（同一字段被双方改成不同值 / 编辑与删除相撞 / 关系端点已删除）。` +
        `草稿未做任何改动，请逐项核对基线、当前值与拟提交值，基于最新草稿重开会话后人工重编。`,
      ...stored,
    };
  }

  const tx = db.transaction(() => {
    const revisionBefore = draftRevisionNo();
    const { idMap, applied } = applyPlan(db, plan);
    const totalChanges = Object.values(applied).reduce((n, x) => n + x, 0);
    // 触发器已逐行推进修订号；整次提交作为一次原子变更，校正为 +1（无变更则不推进）
    const revisionNo = totalChanges > 0 ? revisionBefore + 1 : revisionBefore;
    if (totalChanges > 0) {
      db.prepare('UPDATE draft_meta SET revision = ? WHERE id = 1').run(revisionNo);
    }
    const stored = { revisionNo, idMap, applied, autoMerged, baseRevisionNo: row.base_revision_no };
    db.prepare("UPDATE edit_sessions SET status = 'committed', result_json = ?, closed_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(stored),
      sessionId
    );
    return stored;
  });

  const stored = tx();
  return { sessionId, status: 'committed', alreadyCommitted: false, ...stored };
}

module.exports = {
  openSession,
  getSession,
  listSessions,
  appendSessionOps,
  commitSession,
};
