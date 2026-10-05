'use strict';

// 长链路线（两万事件顺链的首尾为锚点）端到端测试。
//
// 见证链求解已改为「正 / 反向 BFS 定层 + 逐层最小关系 ID 贪心 + 父指针回溯」的
// 线性实现，不再逐层复制整条路径（旧实现链长 L 时单段即复制 O(L²) 个元素，
// 两万事件顺链首尾一段需数秒，创建请求难以及时完成）。本文件验证：
//   1) 求解结果与旧实现逐案一致（每段关系数最少、同长度按关系 ID 序列字典序择小）；
//   2) 两万事件顺链的路线创建及时完成；
//   3) 断点拒绝（指出段号与两端事件、不保存）、冻结落库（改草稿 / 发新版不影响旧路线）、
//      出处遮盖与撤回版隐藏等读取规则在长链下保持不变。

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

// 每个测试文件独立内存库
const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app, scheduler } = require('../src/server');
const { shortestWitnessChain } = require('../src/route');
const { ordinalFromIso, isoFromOrdinal } = require('../src/dates');

const TOKEN = 'test-token';
const CHAIN_LEN = 20000;
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  scheduler.stop();
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM route_segments;
    DELETE FROM route_anchors;
    DELETE FROM routes;
    DELETE FROM source_redactions;
    DELETE FROM version_retractions;
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

// 旧实现（逐层为每个节点保留并复制整条路径的分层 BFS），作为结果一致性参照。
function referenceWitnessChain(relations, fromId, toId) {
  const adj = new Map();
  for (const r of relations) {
    if (!adj.has(r.earlierEventId)) adj.set(r.earlierEventId, []);
    adj.get(r.earlierEventId).push({ to: r.laterEventId, relationId: r.relationId });
  }
  for (const edges of adj.values()) edges.sort((a, b) => a.relationId - b.relationId);
  const seqLess = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };
  const depth = new Map([[fromId, 0]]);
  let frontier = new Map([[fromId, { eventIds: [fromId], relationIds: [] }]]);
  let d = 0;
  while (frontier.size) {
    const next = new Map();
    for (const [u, chainU] of frontier) {
      for (const { to, relationId } of adj.get(u) || []) {
        if (depth.has(to)) continue;
        const candidate = {
          eventIds: [...chainU.eventIds, to],
          relationIds: [...chainU.relationIds, relationId],
        };
        const cur = next.get(to);
        if (!cur || seqLess(candidate.relationIds, cur.relationIds)) next.set(to, candidate);
      }
    }
    d += 1;
    for (const id of next.keys()) depth.set(id, d);
    if (next.has(toId)) return next.get(toId);
    frontier = next;
  }
  return null;
}

// 直接在库中铺一条 n 个事件的逐日相接长链（事件 i 先于事件 i+1），
// 另加一个无任何关系的孤立事件；每个事件一条日精度主张，
// 区间统一为 1950-01-01 ~ 2030-12-31（容纳两万天，可解）。
// 关系 id 即 1..n-1（按建链顺序）；第 100 条关系（事件 100 → 101）用独立出处。
// 返回 { selection, firstId, midId, lastId, isolatedId }。
function seedChainWithIsolated(n) {
  const insE = mem.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  const insC = mem.prepare(
    `INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
     VALUES (?, 'day', 1958, 1, 1, '1958 年 01 月 01 日', '1950-01-01', '2030-12-31', ?, '')`
  );
  const insR = mem.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');
  const selection = [];
  let isolatedId = null;
  mem.transaction(() => {
    for (let i = 1; i <= n; i++) {
      const eventId = Number(insE.run(`长链事件${i}`, '').lastInsertRowid);
      const claimId = Number(insC.run(eventId, `口述记录第${i}册`).lastInsertRowid);
      selection.push({ eventId, claimId });
      if (i > 1) insR.run(i - 1, i, i === 101 ? '衔接档案第100号' : '逐日衔接', '');
    }
    isolatedId = Number(insE.run('孤立事件', '').lastInsertRowid);
    selection.push({ eventId: isolatedId, claimId: Number(insC.run(isolatedId, '孤立事件出处').lastInsertRowid) });
  })();
  return { selection, firstId: 1, midId: n / 2, lastId: n, isolatedId };
}

test('见证链求解：两万事件顺链线性时间完成（不逐层复制路径）', () => {
  const rels = [];
  for (let i = 1; i < CHAIN_LEN; i++) {
    rels.push({ relationId: i, earlierEventId: i, laterEventId: i + 1 });
  }
  const t0 = Date.now();
  const chain = shortestWitnessChain(rels, 1, CHAIN_LEN);
  const elapsed = Date.now() - t0;
  assert.ok(chain, '顺链首尾应可达');
  assert.strictEqual(chain.eventIds.length, CHAIN_LEN);
  assert.strictEqual(chain.relationIds.length, CHAIN_LEN - 1);
  assert.strictEqual(chain.eventIds[0], 1);
  assert.strictEqual(chain.eventIds[CHAIN_LEN - 1], CHAIN_LEN);
  assert.deepStrictEqual(chain.relationIds, Array.from({ length: CHAIN_LEN - 1 }, (_, i) => i + 1));
  // 旧实现（逐层复制路径）在本机上约需 8 秒；线性实现即使全套测试并发争抢也应远在 6 秒以内
  assert.ok(elapsed < 6000, `两万事件顺链求解应在线性时间完成，实际 ${elapsed}ms`);
});

test('见证链求解：随机图上与旧实现结果逐案一致（含成环 / 平行边 / 自环 / 不可达）', () => {
  let seed = 20261004;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let iter = 0; iter < 500; iter++) {
    const n = 1 + rnd(12);
    const m = rnd(30);
    const rels = [];
    for (let j = 0; j < m; j++) {
      rels.push({ relationId: 1000 + j, earlierEventId: 1 + rnd(n), laterEventId: 1 + rnd(n) });
    }
    const from = 1 + rnd(n);
    const to = 1 + rnd(n);
    assert.deepStrictEqual(
      shortestWitnessChain(rels, from, to),
      referenceWitnessChain(rels, from, to),
      `随机图第 ${iter} 例结果不一致：${JSON.stringify({ rels, from, to })}`
    );
  }
});

test('长链路线端到端：首尾锚点及时建立，断点拒绝，冻结 / 遮盖 / 撤回规则不变', async () => {
  const { selection, firstId, midId, lastId, isolatedId } = seedChainWithIsolated(CHAIN_LEN);

  // 发布第 1 版（两万事件长链 + 1 个孤立事件）
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 0, editor: '长链路线测试', note: '长链路线首版' },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json).slice(0, 300));
  assert.strictEqual(pub.json.versionNo, 1);
  const lastDate = isoFromOrdinal(ordinalFromIso('1950-01-01') + CHAIN_LEN - 1);
  assert.strictEqual(
    pub.json.version.events.find((e) => e.eventId === lastId).resolvedDate,
    lastDate,
    '链尾求解日期应为首日 +（链长-1）天'
  );

  // ---- 1) 首尾为锚建立路线：及时完成；唯一段即贯穿全链的最少关系见证链 ----
  const t0 = Date.now();
  const created = await call('POST', '/api/editor/routes', {
    body: { title: '长链脉络', versionNo: 1, anchorEventIds: [firstId, lastId], editor: '路线编辑', note: '长链专题' },
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(created.status, 201, JSON.stringify(created.json).slice(0, 300));
  // 旧实现仅求解即需约 8 秒；此处为端到端预算（含版本读取与两万个事件的详情组装），留足并发余量
  assert.ok(elapsed < 10000, `两万事件顺链的路线创建应及时完成，实际 ${elapsed}ms`);
  const route = created.json.route;
  assert.strictEqual(route.routeNo, 1);
  assert.strictEqual(route.versionNo, 1);
  assert.deepStrictEqual(route.anchors.map((a) => a.eventId), [firstId, lastId]);
  assert.strictEqual(route.segments.length, 1);
  assert.strictEqual(route.segments[0].eventIds.length, CHAIN_LEN);
  assert.strictEqual(route.segments[0].relationIds.length, CHAIN_LEN - 1);
  assert.strictEqual(route.segments[0].eventIds[0], firstId);
  assert.strictEqual(route.segments[0].eventIds[CHAIN_LEN - 1], lastId);
  // 顺链上最短路唯一：关系 id 序列即 1..CHAIN_LEN-1
  assert.deepStrictEqual(
    route.segments[0].relationIds,
    Array.from({ length: CHAIN_LEN - 1 }, (_, i) => i + 1)
  );
  // 路线只含链上事件与关系（孤立事件不出现）；首尾为锚点，其余为中间事件
  assert.strictEqual(route.events.length, CHAIN_LEN);
  assert.strictEqual(route.relations.length, CHAIN_LEN - 1);
  assert.ok(!route.events.some((e) => e.eventId === isolatedId));
  const roleOf = new Map(route.events.map((e) => [e.eventId, e.role]));
  assert.strictEqual(roleOf.get(firstId), 'anchor');
  assert.strictEqual(roleOf.get(lastId), 'anchor');
  assert.strictEqual(roleOf.get(midId), 'intermediate');

  // ---- 2) 多锚点：两段各自取最少关系链 ----
  const created2 = await call('POST', '/api/editor/routes', {
    body: { title: '长链脉络（含中途锚点）', versionNo: 1, anchorEventIds: [firstId, midId, lastId] },
  });
  assert.strictEqual(created2.status, 201, JSON.stringify(created2.json).slice(0, 300));
  assert.strictEqual(created2.json.route.segments.length, 2);
  assert.strictEqual(created2.json.route.segments[0].eventIds.length, CHAIN_LEN / 2);
  assert.strictEqual(created2.json.route.segments[1].eventIds.length, CHAIN_LEN - CHAIN_LEN / 2 + 1);
  assert.strictEqual(created2.json.route.segments[0].relationIds.length, CHAIN_LEN / 2 - 1);

  // ---- 3) 断点：孤立事件不可达 → 422 指出全部断点（段号与两端事件），整条不保存 ----
  const bad = await call('POST', '/api/editor/routes', {
    body: { title: '断点路线', versionNo: 1, anchorEventIds: [firstId, isolatedId, lastId] },
  });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual(bad.json.code, 'ROUTE_INVALID');
  const discs = bad.json.errors.filter((e) => e.type === 'disconnected');
  assert.strictEqual(discs.length, 2);
  assert.strictEqual(discs[0].segmentIndex, 0);
  assert.deepStrictEqual(discs[0].eventIds, [firstId, isolatedId]);
  assert.match(discs[0].message, /第 1 段断点/);
  assert.strictEqual(discs[1].segmentIndex, 1);
  assert.deepStrictEqual(discs[1].eventIds, [isolatedId, lastId]);
  assert.match(discs[1].message, /第 2 段断点/);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM routes').get().n, 2, '断点路线不得落库');

  // ---- 4) 冻结：改草稿（删关系、改标题）并发布第 2 版，旧路线逐字节不变 ----
  const before1 = await call('GET', '/api/editor/routes/1/raw');
  assert.strictEqual(before1.status, 200);
  const del = await call('DELETE', '/api/editor/relations/1');
  assert.strictEqual(del.status, 200);
  const ren = await call('PUT', `/api/editor/events/${firstId}`, {
    body: { title: '长链事件1（草稿改名）', description: '' },
  });
  assert.strictEqual(ren.status, 200);
  const pub2 = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 1, editor: '长链路线测试', note: '第二版' },
  });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json).slice(0, 300));
  assert.strictEqual(pub2.json.versionNo, 2);
  const after1 = await call('GET', '/api/editor/routes/1/raw');
  assert.deepStrictEqual(after1.json.route, before1.json.route, '改草稿、发新版不得改变旧路线');

  // ---- 5) 出处遮盖：遮盖链上事件 100 的主张出处与关系 100 的出处 ----
  for (const src of ['口述记录第100册', '衔接档案第100号']) {
    const prev = await call('POST', '/api/editor/redaction-preview', { body: { source: src } });
    assert.strictEqual(prev.status, 200);
    const conf = await call('POST', '/api/editor/redaction', {
      body: { source: src, currentVersionNo: prev.json.currentVersionNo },
    });
    assert.strictEqual(conf.status, 200, JSON.stringify(conf.json).slice(0, 300));
  }
  // 访客视图：命中处显示「出处已遮盖」，其余不变
  const pubRoute = await call('GET', '/api/public/routes/1', { token: null });
  assert.strictEqual(pubRoute.status, 200);
  const ev100 = pubRoute.json.route.events.find((e) => e.eventId === 100);
  const ev101 = pubRoute.json.route.events.find((e) => e.eventId === 101);
  assert.strictEqual(ev100.source, '出处已遮盖');
  assert.strictEqual(ev101.source, '口述记录第101册');
  const rel100 = pubRoute.json.route.relations.find((r) => r.relationId === 100);
  const rel101 = pubRoute.json.route.relations.find((r) => r.relationId === 101);
  assert.strictEqual(rel100.source, '出处已遮盖');
  assert.strictEqual(rel101.source, '逐日衔接');
  // 编辑者持口令看原文
  const raw1 = await call('GET', '/api/editor/routes/1/raw');
  assert.strictEqual(raw1.json.route.events.find((e) => e.eventId === 100).source, '口述记录第100册');
  assert.strictEqual(raw1.json.route.relations.find((r) => r.relationId === 100).source, '衔接档案第100号');

  // ---- 6) 撤回所据版本：访客路线隐藏（404 / 清单不含），编辑者仍可见原文 ----
  const ret = await call('POST', '/api/editor/versions/1/retract', {
    body: { reason: '编年依据待核', editor: '长链路线测试' },
  });
  assert.strictEqual(ret.status, 200);
  const pubGone = await call('GET', '/api/public/routes/1', { token: null });
  assert.strictEqual(pubGone.status, 404, '引用撤回版的路线对访客按不存在处理');
  const pubList = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(pubList.json.routes.length, 0, '访客路线清单不含引用撤回版的路线');
  const rawAfter = await call('GET', '/api/editor/routes/1/raw');
  assert.strictEqual(rawAfter.status, 200);
  assert.strictEqual(rawAfter.json.versionRetracted, true);
  assert.strictEqual(rawAfter.json.route.events.length, CHAIN_LEN);
  const edList = await call('GET', '/api/editor/routes');
  assert.strictEqual(edList.json.routes.length, 2);
  assert.strictEqual(edList.json.routes.find((r) => r.routeNo === 1).versionRetracted, true);
});
