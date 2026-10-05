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
const { shortestWitnessChain } = require('../src/route');

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
    DELETE FROM route_segments;
    DELETE FROM route_anchors;
    DELETE FROM routes;
    DELETE FROM source_redactions;
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

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title } });
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

async function publish(selection, baseVersionNo, note = '') {
  const r = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo, editor: '测试员', note },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.versionNo;
}

// 建 5 事件：A B C D E，关系 A→B, A→C, C→D, B→D, D→E（按此顺序，关系 id 1..5）
// A→D 有两条等长路径：[1,4]（A→B→D）与 [2,3]（A→C→D），字典序 [1,4] 小。
async function makeGraphDraft() {
  const A = await makeEvent('事件A');
  const B = await makeEvent('事件B');
  const C = await makeEvent('事件C');
  const D = await makeEvent('事件D');
  const E = await makeEvent('事件E');
  const claims = {};
  for (const [k, id] of Object.entries({ A, B, C, D, E })) {
    claims[k] = await makeClaim(id, { precision: 'year', year: 1958, source: `出处${k}` });
  }
  const r1 = await makeRel(A, B, '关系一');
  const r2 = await makeRel(A, C, '关系二');
  const r3 = await makeRel(C, D, '关系三');
  const r4 = await makeRel(B, D, '关系四');
  const r5 = await makeRel(D, E, '关系五');
  return { A, B, C, D, E, claims, rels: { r1, r2, r3, r4, r5 } };
}

test('见证链求解：关系数最少，同长度按关系 ID 序列择小', () => {
  const rels = [
    { relationId: 1, earlierEventId: 1, laterEventId: 2 }, // A→B
    { relationId: 2, earlierEventId: 1, laterEventId: 3 }, // A→C
    { relationId: 3, earlierEventId: 3, laterEventId: 4 }, // C→D
    { relationId: 4, earlierEventId: 2, laterEventId: 4 }, // B→D
    { relationId: 5, earlierEventId: 4, laterEventId: 5 }, // D→E
  ];
  // 两条等长路径 [1,4] 与 [2,3]：首元素 1 < 2，选 [1,4]（尽管 4 > 3）
  const chain = shortestWitnessChain(rels, 1, 4);
  assert.deepStrictEqual(chain.eventIds, [1, 2, 4]);
  assert.deepStrictEqual(chain.relationIds, [1, 4]);
  // 直达优先于绕路
  const direct = shortestWitnessChain(rels, 4, 5);
  assert.deepStrictEqual(direct.relationIds, [5]);
  // 不可达返回 null（反向不算连通）
  assert.strictEqual(shortestWitnessChain(rels, 5, 1), null);
  assert.strictEqual(shortestWitnessChain(rels, 2, 3), null);
});

test('建立路线：多锚点、中间事件、最短见证链与关系 ID 择小', async () => {
  const g = await makeGraphDraft();
  const v1 = await publish(
    Object.entries(g.claims).map(([k, cid]) => ({ eventId: g[k], claimId: cid })),
    0
  );

  const r = await call('POST', '/api/editor/routes', {
    body: { title: '东干渠建设脉络', versionNo: v1, anchorEventIds: [g.A, g.D, g.E], editor: '路线编辑', note: '专题一' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const route = r.json.route;
  assert.strictEqual(route.routeNo, 1);
  assert.strictEqual(route.title, '东干渠建设脉络');
  assert.strictEqual(route.versionNo, v1);
  assert.deepStrictEqual(route.anchors.map((a) => a.eventId), [g.A, g.D, g.E]);
  assert.deepStrictEqual(route.anchors.map((a) => a.position), [0, 1, 2]);

  // 第 1 段 A→D：等长路径中按关系 ID 序列择小 → A→B→D（关系 1,4）
  assert.strictEqual(route.segments.length, 2);
  assert.deepStrictEqual(route.segments[0].eventIds, [g.A, g.B, g.D]);
  assert.deepStrictEqual(route.segments[0].relationIds, [g.rels.r1, g.rels.r4]);
  // 第 2 段 D→E：直达
  assert.deepStrictEqual(route.segments[1].eventIds, [g.D, g.E]);
  assert.deepStrictEqual(route.segments[1].relationIds, [g.rels.r5]);

  // 只含路线涉及的事件与关系：事件 C 与关系 r2、r3 不出现
  const evIds = route.events.map((e) => e.eventId);
  assert.deepStrictEqual(new Set(evIds), new Set([g.A, g.B, g.D, g.E]));
  assert.ok(!evIds.includes(g.C));
  const relIds = route.relations.map((x) => x.relationId);
  assert.deepStrictEqual(new Set(relIds), new Set([g.rels.r1, g.rels.r4, g.rels.r5]));

  // 锚点与中间事件区分
  const roleOf = Object.fromEntries(route.events.map((e) => [e.eventId, e.role]));
  assert.strictEqual(roleOf[g.A], 'anchor');
  assert.strictEqual(roleOf[g.D], 'anchor');
  assert.strictEqual(roleOf[g.E], 'anchor');
  assert.strictEqual(roleOf[g.B], 'intermediate');
  const anchorB = route.events.find((e) => e.eventId === g.B);
  assert.strictEqual(anchorB.anchorPosition, null);
  assert.strictEqual(route.events.find((e) => e.eventId === g.D).anchorPosition, 1);

  // 事件展示字段来自该版快照
  const evA = route.events.find((e) => e.eventId === g.A);
  assert.strictEqual(evA.title, '事件A');
  assert.strictEqual(evA.source, '出处A');
  assert.strictEqual(evA.resolvedDate, '1958-01-01');

  // 列表与详情
  const list = await call('GET', '/api/editor/routes');
  assert.strictEqual(list.json.routes.length, 1);
  assert.strictEqual(list.json.routes[0].anchorCount, 3);
  assert.strictEqual(list.json.routes[0].segmentCount, 2);
  const detail = await call('GET', '/api/editor/routes/1/raw');
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.route.events.find((e) => e.eventId === g.A).source, '出处A');
});

test('重复事件、锚点不足、空标题 → 400；未知版本 → 404；均不保存', async () => {
  const g = await makeGraphDraft();
  const v1 = await publish(
    Object.entries(g.claims).map(([k, cid]) => ({ eventId: g[k], claimId: cid })),
    0
  );

  // 重复事件
  let r = await call('POST', '/api/editor/routes', {
    body: { title: 'x', versionNo: v1, anchorEventIds: [g.A, g.B, g.A] },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.code, 'ROUTE_DUPLICATE_EVENTS');
  assert.deepStrictEqual(r.json.duplicateEventIds, [g.A]);

  // 锚点不足两个
  r = await call('POST', '/api/editor/routes', {
    body: { title: 'x', versionNo: v1, anchorEventIds: [g.A] },
  });
  assert.strictEqual(r.status, 400);

  // 空标题 / 非数组
  r = await call('POST', '/api/editor/routes', {
    body: { title: '  ', versionNo: v1, anchorEventIds: [g.A, g.B] },
  });
  assert.strictEqual(r.status, 400);
  r = await call('POST', '/api/editor/routes', {
    body: { title: 'x', versionNo: v1, anchorEventIds: 'not-array' },
  });
  assert.strictEqual(r.status, 400);

  // 未知版本
  r = await call('POST', '/api/editor/routes', {
    body: { title: 'x', versionNo: 99, anchorEventIds: [g.A, g.B] },
  });
  assert.strictEqual(r.status, 404);

  // 均未保存
  const list = await call('GET', '/api/editor/routes');
  assert.strictEqual(list.json.routes.length, 0);
});

test('未知事件 → 422；无法连通 → 422 指出断点；整条路线不保存', async () => {
  const g = await makeGraphDraft();
  const Z = await makeEvent('孤立事件Z'); // 无任何关系
  const cz = await makeClaim(Z, { precision: 'year', year: 1960, source: '出处Z' });
  const v1 = await publish(
    [...Object.entries(g.claims).map(([k, cid]) => ({ eventId: g[k], claimId: cid })), { eventId: Z, claimId: cz }],
    0
  );

  // 未知事件（不在该版快照中）
  let r = await call('POST', '/api/editor/routes', {
    body: { title: 'x', versionNo: v1, anchorEventIds: [g.A, 9999] },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'ROUTE_INVALID');
  assert.strictEqual(r.json.errors[0].type, 'unknown_event');
  assert.deepStrictEqual(r.json.errors[0].eventIds, [9999]);

  // 无法连通：A 与孤立事件 Z 之间没有有向路径
  r = await call('POST', '/api/editor/routes', {
    body: { title: 'x', versionNo: v1, anchorEventIds: [g.A, g.D, Z] },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'ROUTE_INVALID');
  const disc = r.json.errors.filter((e) => e.type === 'disconnected');
  assert.strictEqual(disc.length, 1);
  assert.strictEqual(disc[0].segmentIndex, 1); // 第 2 段（D→Z）是断点
  assert.deepStrictEqual(disc[0].eventIds, [g.D, Z]);
  assert.match(disc[0].message, /断点/);

  // 反向不算连通：E→A 方向无路径
  r = await call('POST', '/api/editor/routes', {
    body: { title: 'x', versionNo: v1, anchorEventIds: [g.E, g.A] },
  });
  assert.strictEqual(r.status, 422);

  // 整条路线未保存
  const list = await call('GET', '/api/editor/routes');
  assert.strictEqual(list.json.routes.length, 0);
  const pub = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(pub.json.routes.length, 0);
});

test('路线不可变：改草稿、恢复草稿、发布新版均不改旧路线', async () => {
  const g = await makeGraphDraft();
  const v1 = await publish(
    Object.entries(g.claims).map(([k, cid]) => ({ eventId: g[k], claimId: cid })),
    0
  );
  const created = await call('POST', '/api/editor/routes', {
    body: { title: '脉络一', versionNo: v1, anchorEventIds: [g.A, g.E] },
  });
  assert.strictEqual(created.status, 201);
  const before = created.json.route;
  // A→E 最短链：A→B→D→E（[1,4,5] 与 [2,3,5] 等长，择小）
  assert.deepStrictEqual(before.segments[0].eventIds, [g.A, g.B, g.D, g.E]);

  // 改草稿：删关系、改标题
  await call('DELETE', `/api/editor/relations/${g.rels.r1}`);
  await call('PUT', `/api/editor/events/${g.A}`, { body: { title: '事件A（改名）', description: '' } });
  // 从第 1 版恢复草稿（替换整个草稿）
  const st = await call('GET', '/api/editor/state');
  const prev = await call('GET', `/api/editor/restore-preview/${v1}`);
  await call('POST', '/api/editor/restore', {
    body: { versionNo: v1, draftRevisionNo: prev.json.draftRevisionNo, currentVersionNo: prev.json.currentVersionNo },
  });
  // 发布第 2 版（恢复后的草稿）
  const st2 = await call('GET', '/api/editor/state');
  const sel2 = st2.json.events.map((e) => ({ eventId: e.id, claimId: e.claims[0].id }));
  await publish(sel2, st2.json.currentVersionNo, '第二版');

  // 旧路线内容不变（仍据第 1 版快照：原标题、原链）
  const after1 = await call('GET', '/api/editor/routes/1/raw');
  assert.deepStrictEqual(after1.json.route, before);
  const pubView = await call('GET', '/api/public/routes/1', { token: null });
  assert.strictEqual(pubView.json.route.versionNo, v1);
  assert.strictEqual(pubView.json.route.events.find((e) => e.eventId === g.A).title, '事件A');
  assert.deepStrictEqual(pubView.json.route.segments[0].relationIds, before.segments[0].relationIds);
});

test('访客视图应用出处遮盖；编辑者持口令看原文；公开只含路线涉及内容', async () => {
  const g = await makeGraphDraft();
  const v1 = await publish(
    Object.entries(g.claims).map(([k, cid]) => ({ eventId: g[k], claimId: cid })),
    0
  );
  await call('POST', '/api/editor/routes', {
    body: { title: '脉络一', versionNo: v1, anchorEventIds: [g.A, g.D] },
  });

  // 遮盖链上事件 A 的主张出处与链上关系 r1 的出处
  for (const src of ['出处A', '关系一']) {
    const prev = await call('POST', '/api/editor/redaction-preview', { body: { source: src } });
    const conf = await call('POST', '/api/editor/redaction', {
      body: { source: src, currentVersionNo: prev.json.currentVersionNo },
    });
    assert.strictEqual(conf.status, 200);
  }

  // 访客：命中处显示「出处已遮盖」，其余不变
  const pub = await call('GET', '/api/public/routes/1', { token: null });
  assert.strictEqual(pub.status, 200);
  const evA = pub.json.route.events.find((e) => e.eventId === g.A);
  const evB = pub.json.route.events.find((e) => e.eventId === g.B);
  assert.strictEqual(evA.source, '出处已遮盖');
  assert.strictEqual(evB.source, '出处B');
  const rel1 = pub.json.route.relations.find((r) => r.relationId === g.rels.r1);
  assert.strictEqual(rel1.source, '出处已遮盖');
  // 公开视图不含路线之外的事件/关系
  assert.ok(!pub.json.route.events.some((e) => e.eventId === g.C));
  assert.ok(!pub.json.route.relations.some((r) => r.relationId === g.rels.r2));

  // 编辑者持口令看原文
  const raw = await call('GET', '/api/editor/routes/1/raw');
  assert.strictEqual(raw.json.route.events.find((e) => e.eventId === g.A).source, '出处A');
  assert.strictEqual(raw.json.route.relations.find((r) => r.relationId === g.rels.r1).source, '关系一');

  // 公开列表不含敏感字段也能看到路线
  const pubList = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(pubList.json.routes.length, 1);
  assert.strictEqual(pubList.json.routes[0].title, '脉络一');
});

test('路线接口的口令与参数校验', async () => {
  // 编辑者接口需口令
  let r = await call('POST', '/api/editor/routes', { token: null, body: {} });
  assert.strictEqual(r.status, 401);
  r = await call('GET', '/api/editor/routes/1/raw', { token: 'wrong' });
  assert.strictEqual(r.status, 401);

  // 公开接口无需口令
  r = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(r.status, 200);

  // 不存在的路线 404；非法路线号 400
  r = await call('GET', '/api/public/routes/42', { token: null });
  assert.strictEqual(r.status, 404);
  r = await call('GET', '/api/public/routes/abc', { token: null });
  assert.strictEqual(r.status, 400);
  r = await call('GET', '/api/editor/routes/42/raw');
  assert.strictEqual(r.status, 404);
});
