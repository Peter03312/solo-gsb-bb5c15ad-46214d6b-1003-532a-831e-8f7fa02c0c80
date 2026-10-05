'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

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
    UPDATE draft_meta SET revision = 0;
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

async function getState() {
  const r = await call('GET', '/api/editor/state');
  assert.strictEqual(r.status, 200);
  return r.json;
}

// 搭好草稿：动员会(两条矛盾主张) 先于 通水(一条主张)，发布第 1 版
async function seedV1() {
  const e1 = await makeEvent('动员会', '晒谷场开会');
  const e2 = await makeEvent('通水会', '东干渠通水');
  const c1a = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  await makeClaim(e1, { precision: 'year', year: 1958, source: '县水利志第87页' }); // 未选的矛盾主张
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  const rid = await makeRel(e1, e2, '二人口述一致');
  const pub = await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2 }],
      baseVersionNo: 0,
      editor: '甲',
      note: '首版',
    },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  return { e1, e2, c1a, c2, rid };
}

test('恢复接口需要编辑者口令', async () => {
  const r = await call('GET', '/api/editor/restore-preview/1', { token: null });
  assert.strictEqual(r.status, 401);
  const r2 = await call('POST', '/api/editor/restore', {
    token: null,
    body: { versionNo: 1, draftRevisionNo: 0, currentVersionNo: 0 },
  });
  assert.strictEqual(r2.status, 401);
});

test('草稿增删改都推进修订号；state 返回修订号', async () => {
  const r0 = (await getState()).draftRevisionNo;
  const e1 = await makeEvent('事件一');
  assert.strictEqual((await getState()).draftRevisionNo, r0 + 1);

  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '事件一改', description: '' } });
  assert.strictEqual((await getState()).draftRevisionNo, r0 + 2);

  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  assert.strictEqual((await getState()).draftRevisionNo, r0 + 3);

  const e2 = await makeEvent('事件二');
  const rid = await makeRel(e1, e2);
  assert.strictEqual((await getState()).draftRevisionNo, r0 + 5);

  await call('DELETE', `/api/editor/relations/${rid}`);
  assert.strictEqual((await getState()).draftRevisionNo, r0 + 6);

  await call('DELETE', `/api/editor/claims/${c1}`);
  assert.strictEqual((await getState()).draftRevisionNo, r0 + 7);

  await call('DELETE', `/api/editor/events/${e2}`);
  assert.strictEqual((await getState()).draftRevisionNo, r0 + 8);
});

test('预览只读：列出该版被选主张/关系与将被替换的草稿，不改任何数据', async () => {
  const ids = await seedV1();
  // 草稿继续漂移：新增一个事件与主张（发布后改的）
  const extra = await makeEvent('后来加的事件');
  await makeClaim(extra, { precision: 'year', year: 1970, source: '新材料' });
  const before = await getState();
  assert.strictEqual(before.events.length, 3);

  const pv = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.json));
  assert.strictEqual(pv.json.versionNo, 1);
  assert.strictEqual(pv.json.draftRevisionNo, before.draftRevisionNo);
  assert.strictEqual(pv.json.currentVersionNo, 1);

  // 该版侧：事件按 sort_order、含被选主张内容
  const v = pv.json.version;
  assert.strictEqual(v.events.length, 2);
  const hui = v.events.find((e) => e.title === '动员会');
  assert.strictEqual(hui.claimId, ids.c1a);
  assert.strictEqual(hui.dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(hui.source, '李宝山口述');
  assert.strictEqual(v.relations.length, 1);
  assert.strictEqual(v.relations[0].source, '二人口述一致');
  assert.strictEqual(v.relations[0].relationId, ids.rid);

  // 当前草稿侧：包含未发布的新事件与未选矛盾主张，只用于展示将被替换的内容
  const d = pv.json.currentDraft;
  assert.strictEqual(d.counts.eventCount, 3);
  assert.strictEqual(d.events.find((e) => e.title === '动员会').claims.length, 2);
  assert.ok(d.events.some((e) => e.title === '后来加的事件'));
  assert.strictEqual(d.counts.relationCount, 1);

  // 预览不改数据
  const after = await getState();
  assert.deepStrictEqual(after.events.map((e) => e.id), before.events.map((e) => e.id));
  assert.strictEqual(after.draftRevisionNo, before.draftRevisionNo);
});

test('版本不存在：预览与确认均 404', async () => {
  const pv = await call('GET', '/api/editor/restore-preview/99');
  assert.strictEqual(pv.status, 404);
  const r = await call('POST', '/api/editor/restore', {
    body: { versionNo: 99, draftRevisionNo: 0, currentVersionNo: 0 },
  });
  assert.strictEqual(r.status, 404);
});

test('确认参数非法返回 400', async () => {
  await seedV1();
  const st = await getState();
  const bad = async (body) => (await call('POST', '/api/editor/restore', { body })).status;
  assert.strictEqual(await bad({ versionNo: 0, draftRevisionNo: st.draftRevisionNo, currentVersionNo: 1 }), 400);
  assert.strictEqual(await bad({ versionNo: 1, draftRevisionNo: -1, currentVersionNo: 1 }), 400);
  assert.strictEqual(await bad({ versionNo: 1, draftRevisionNo: st.draftRevisionNo, currentVersionNo: -1 }), 400);
});

test('草稿修订号过期 → 409 冲突且数据不变', async () => {
  await seedV1();
  const pv = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(pv.status, 200);
  // 另一位编辑者在确认前改了草稿
  const sneaky = await makeEvent('并发加入的事件');
  const revBefore = (await getState()).draftRevisionNo;

  const r = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: pv.json.draftRevisionNo,
      currentVersionNo: pv.json.currentVersionNo,
    },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'DRAFT_REVISION_CONFLICT');
  assert.strictEqual(r.json.currentRevisionNo, revBefore);

  // 数据未动
  const st = await getState();
  assert.ok(st.events.some((e) => e.id === sneaky));
  assert.strictEqual(st.draftRevisionNo, revBefore);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
});

test('最新版本过期（期间有人发布）→ 409 冲突且数据不变', async () => {
  const ids = await seedV1(); // 第 1 版
  // 第三位事件补入并发布第 2 版（latest 变为 2）
  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: '张德福口述' });
  await makeRel(ids.e2, e3, '先有水渠后有抽水机');
  const pub2 = await call('POST', '/api/editor/publish', {
    body: {
      selection: [
        { eventId: ids.e1, claimId: ids.c1a },
        { eventId: ids.e2, claimId: ids.c2 },
        { eventId: e3, claimId: c3 },
      ],
      baseVersionNo: 1,
      editor: '乙',
    },
  });
  assert.strictEqual(pub2.status, 201);

  // 预览时记录的最新版本号仍是 1（模拟预览发生在 v2 发布之前）
  const r = await call('POST', '/api/editor/restore', {
    body: { versionNo: 1, draftRevisionNo: (await getState()).draftRevisionNo, currentVersionNo: 1 },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(r.json.currentVersionNo, 2);

  // 草稿与版本均未被恢复操作改动
  const st = await getState();
  assert.ok(st.events.some((e) => e.title === '抽水机到站'));
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 2);
  assert.strictEqual(view.json.version.eventCount, 3);
});

test('确认成功：原子替换草稿、只恢复被选主张、返回 id 映射与待选主张；快照与访客不变', async () => {
  const ids = await seedV1(); // 第 1 版：动员会/通水会
  // 发布第 2 版（草稿多一个事件），让当前最新与恢复目标不同
  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: '张德福口述' });
  await makeRel(ids.e2, e3, '先有水渠后有抽水机');
  const pub2 = await call('POST', '/api/editor/publish', {
    body: {
      selection: [
        { eventId: ids.e1, claimId: ids.c1a },
        { eventId: ids.e2, claimId: ids.c2 },
        { eventId: e3, claimId: c3 },
      ],
      baseVersionNo: 1,
    },
  });
  assert.strictEqual(pub2.status, 201);

  const pv = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(pv.status, 200);
  const revAtPreview = pv.json.draftRevisionNo;

  const r = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: revAtPreview,
      currentVersionNo: pv.json.currentVersionNo,
    },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  // 修订号只推进一次
  assert.strictEqual(r.json.revisionNo, revAtPreview + 1);
  // 最新版本号不变（访客年表仍是第 2 版）
  assert.strictEqual(r.json.currentVersionNo, 2);
  assert.strictEqual(r.json.restoredFromVersionNo, 1);

  // 草稿被整体替换：只剩第 1 版的两个事件，且每事件只有被选的一条主张
  const st = await getState();
  assert.strictEqual(st.events.length, 2);
  assert.deepStrictEqual(st.events.map((e) => e.title), ['动员会', '通水会']);
  const hui = st.events.find((e) => e.title === '动员会');
  assert.strictEqual(hui.description, '晒谷场开会');
  assert.strictEqual(hui.claims.length, 1);
  assert.strictEqual(hui.claims[0].dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(hui.claims[0].source, '李宝山口述');
  assert.strictEqual(hui.claims[0].intervalStart, '1958-09-12');
  assert.strictEqual(hui.claims[0].intervalEnd, '1958-09-12');
  const tong = st.events.find((e) => e.title === '通水会');
  assert.strictEqual(tong.claims.length, 1);
  assert.strictEqual(tong.claims[0].dateLabel, '1959 年 05 月');
  assert.strictEqual(tong.claims[0].intervalStart, '1959-05-01');
  assert.strictEqual(tong.claims[0].intervalEnd, '1959-05-31');
  assert.strictEqual(st.relations.length, 1);
  assert.strictEqual(st.relations[0].source, '二人口述一致');
  assert.strictEqual(st.relations[0].earlierId, hui.id);
  assert.strictEqual(st.relations[0].laterId, tong.id);

  // 新草稿 id 从 1 开始重建，关联正确
  assert.strictEqual(hui.id, 1);
  assert.strictEqual(tong.id, 2);
  assert.strictEqual(hui.claims[0].id, 1);
  assert.strictEqual(tong.claims[0].id, 2);
  assert.strictEqual(st.relations[0].id, 1);

  // 返回旧快照 id → 新草稿 id 映射
  const em = r.json.idMap.events;
  assert.strictEqual(em.length, 2);
  const emHui = em.find((m) => m.oldEventId === ids.e1);
  assert.deepStrictEqual(emHui, { oldEventId: ids.e1, newEventId: 1, oldClaimId: ids.c1a, newClaimId: 1 });
  const rm = r.json.idMap.relations;
  assert.deepStrictEqual(rm[0], {
    oldRelationId: ids.rid,
    newRelationId: 1,
    oldEarlierEventId: ids.e1,
    newEarlierEventId: 1,
    oldLaterEventId: ids.e2,
    newLaterEventId: 2,
  });

  // 待选主张：每事件一条
  assert.deepStrictEqual(r.json.pendingSelection, [
    { eventId: 1, claimId: 1 },
    { eventId: 2, claimId: 2 },
  ]);

  // 历史快照不变，访客年表仍是第 2 版
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 2);
  assert.strictEqual(view.json.version.eventCount, 3);
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.eventCount, 2);
  const v2 = await call('GET', '/api/public/versions/2', { token: null });
  assert.strictEqual(v2.json.version.eventCount, 3);
});

test('恢复后的草稿可校验、可按现有 baseVersionNo 约定发布为新版本', async () => {
  const ids = await seedV1();
  // 第 2 版：仅用于制造 latest=2 的局面，内容与恢复目标不同
  await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: ids.e1, claimId: ids.c1a }, { eventId: ids.e2, claimId: ids.c2 }],
      baseVersionNo: 1,
      note: '再发一版',
    },
  });

  const pv = await call('GET', '/api/editor/restore-preview/1');
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: pv.json.draftRevisionNo,
      currentVersionNo: pv.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200);

  // 用返回的待选主张校验：通过
  const val = await call('POST', '/api/editor/validate', { body: { selection: restored.json.pendingSelection } });
  assert.strictEqual(val.status, 200);
  assert.strictEqual(val.json.ok, true);

  // 旧基准（1）发布 → 409，遵守现有 baseVersionNo 冲突约定
  const stale = await call('POST', '/api/editor/publish', {
    body: { selection: restored.json.pendingSelection, baseVersionNo: 1 },
  });
  assert.strictEqual(stale.status, 409);

  // 以最新 2 为基准发布 → 第 3 版，parent 2
  const ok = await call('POST', '/api/editor/publish', {
    body: { selection: restored.json.pendingSelection, baseVersionNo: 2, editor: '恢复者' },
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.versionNo, 3);
  assert.strictEqual(ok.json.version.parentNo, 2);
  assert.deepStrictEqual(
    ok.json.version.events.map((e) => ({ title: e.title, claimId: e.claimId })),
    [
      { title: '动员会', claimId: 1 },
      { title: '通水会', claimId: 2 },
    ]
  );
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 3);
});

test('空草稿也能从旧版恢复；冲突回滚不留半截数据', async () => {
  const ids = await seedV1();
  // 清空草稿（模拟删光）
  const st0 = await getState();
  await call('DELETE', `/api/editor/events/${ids.e1}`);
  await call('DELETE', `/api/editor/events/${ids.e2}`);
  assert.strictEqual((await getState()).events.length, 0);

  // 用过期修订号确认 → 409，草稿仍为空（没有插入半截事件）
  const bad = await call('POST', '/api/editor/restore', {
    body: { versionNo: 1, draftRevisionNo: st0.draftRevisionNo, currentVersionNo: 1 },
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual((await getState()).events.length, 0);

  // 用最新预览恢复成功
  const pv = await call('GET', '/api/editor/restore-preview/1');
  const ok = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: pv.json.draftRevisionNo,
      currentVersionNo: 1,
    },
  });
  assert.strictEqual(ok.status, 200);
  const st = await getState();
  assert.strictEqual(st.events.length, 2);
  assert.strictEqual(st.relations.length, 1);
});
