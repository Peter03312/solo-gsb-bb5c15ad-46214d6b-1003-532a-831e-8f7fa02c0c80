'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

// 每个测试文件独立内存库
const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title, description = '') {
  const r = await call('POST', '/api/editor/events', { body: { title, description } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

test('编辑者接口需要口令；访客接口公开', async () => {
  const r1 = await call('GET', '/api/editor/state', { token: null });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('GET', '/api/editor/state', { token: 'wrong' });
  assert.strictEqual(r2.status, 401);
  const r3 = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(r3.json.published, false);
});

test('完整发布流程：矛盾主张可共存，选其中一条发布快照', async () => {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1a = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c1b = await makeClaim(e1, { precision: 'year', year: 1958, source: '县水利志第87页' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');

  // 同事件两条矛盾主张并存
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.find((e) => e.id === e1).claims.length, 2);

  // 选 c1a（1958-09-12）与 c2（1959 年 5 月）
  const pub = await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2 }],
      baseVersionNo: 0,
      editor: '测试员甲',
      note: '首版',
    },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.strictEqual(pub.json.versionNo, 1);
  assert.strictEqual(pub.json.version.events[0].title, '动员会');
  assert.strictEqual(pub.json.version.events[0].resolvedDate, '1958-09-12');
  assert.strictEqual(pub.json.version.events[1].resolvedDate, '1959-05-01');
  assert.strictEqual(pub.json.version.relations[0].source, '二人口述一致');

  // 访客只能看到发布版与所选出处
  const pubView = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pubView.status, 200);
  assert.strictEqual(pubView.json.currentVersionNo, 1);
  assert.strictEqual(pubView.json.version.events.length, 2);
  const dongyuan = pubView.json.version.events.find((e) => e.title === '动员会');
  assert.strictEqual(dongyuan.claimId, c1a);
  assert.strictEqual(dongyuan.source, '李宝山口述');
});

test('缺主张无法发布并指明事件；无版本时访客看不到草稿', async () => {
  const e1 = await makeEvent('有主张');
  await makeEvent('无主张');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1960, source: '档案' });
  const st = await call('GET', '/api/editor/state');
  const e2 = st.json.events.find((e) => e.title === '无主张').id;

  const r = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: 0 }], baseVersionNo: 0 },
  });
  // claimId 0 不存在 -> bad_selection（而非缺主张，二者都阻止发布）
  assert.strictEqual(r.status, 422);
  assert.ok(['bad_selection', 'missing'].includes(r.json.errors[0].type));
  assert.ok(r.json.errors[0].eventIds.includes(e2));

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
});

test('成环发布被拒并报出涉事事件与关系；上一版本保留', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  const e3 = await makeEvent('C');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  const c2 = await makeClaim(e2, { precision: 'year', year: 1958, source: 's' });
  const c3 = await makeClaim(e3, { precision: 'year', year: 1958, source: 's' });
  await makeRel(e1, e2);
  await makeRel(e2, e3);

  // 先发一版好的（DAG）
  const ok = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], baseVersionNo: 0 },
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));

  // 草稿加回边 C->A 形成环，再发 -> 422 cycle，版本仍为 1
  const ringEdgeId = await makeRel(e3, e1, '环边出处');
  const bad = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], baseVersionNo: 1 },
  });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual(bad.json.errors[0].type, 'cycle');
  assert.deepStrictEqual(new Set(bad.json.errors[0].eventIds), new Set([e1, e2, e3]));
  assert.ok(bad.json.errors[0].relationIds.includes(ringEdgeId));
  assert.match(bad.json.errors[0].message, /成环/);
  assert.match(bad.json.errors[0].detail, /环边出处/);

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
});

test('时间无解被拒并给见证链；上一版本保留', async () => {
  const e1 = await makeEvent('冬月会议');
  const e2 = await makeEvent('春月会议');
  const c1 = await makeClaim(e1, { precision: 'month', year: 1958, month: 12, source: 's1' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1958, month: 1, source: 's2' });
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(r.json.errors[0].type, 'temporal');
  assert.deepStrictEqual(r.json.errors[0].eventIds, [e1, e2]);

  const r2 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  assert.strictEqual(r2.status, 422);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
});

test('版本冲突：两位编辑基于同一版本，后者发布得到 409，且未覆盖前者', async () => {
  const e1 = await makeEvent('事件甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });

  // 编辑甲基于 0 发布 -> 第 1 版
  const a = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0, editor: '甲' },
  });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(a.json.versionNo, 1);

  // 草稿新增事件；编辑乙仍基于 0 提交
  const e2 = await makeEvent('事件乙');
  const c2 = await makeClaim(e2, { precision: 'year', year: 1960, source: 's2' });
  const b = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0, editor: '乙' },
  });
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(b.json.currentVersionNo, 1);
  assert.strictEqual(b.json.baseVersionNo, 0);

  // 最新仍为第 1 版（未被乙静默覆盖）
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.eventCount, 1);

  // 乙重新基于 1 确认后发布 -> 第 2 版
  const b2 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 1, editor: '乙' },
  });
  assert.strictEqual(b2.status, 201);
  assert.strictEqual(b2.json.versionNo, 2);
  assert.strictEqual(b2.json.version.parentNo, 1);

  // 旧版快照不可变且仍可取
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.status, 200);
  assert.strictEqual(v1.json.version.eventCount, 1);
});

test('发布后继续改草稿不影响已发布快照', async () => {
  const e1 = await makeEvent('老标题');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 3, day: 1, source: 's' });
  await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0 },
  });

  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '新标题', description: '改了' } });
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.events[0].title, '老标题');

  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].title, '老标题');
});

test('自环关系在录入时即被拒绝', async () => {
  const e1 = await makeEvent('X');
  const r = await call('POST', '/api/editor/relations', { body: { earlierId: e1, laterId: e1 } });
  assert.strictEqual(r.status, 400);
});
