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
    DELETE FROM import_batches;
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

async function getState() {
  const r = await call('GET', '/api/editor/state');
  assert.strictEqual(r.status, 200);
  return r.json;
}

// 一个合法的采访整理包：2 事件（3 条主张，含矛盾主张）+ 1 条先于关系
function sampleBundle() {
  return {
    batchId: '2026-09-fangtan-01',
    events: [
      {
        key: 'dongyuan-hui',
        title: '修水渠动员会',
        description: '大队在晒谷场召开修建东干渠动员会。',
        claims: [
          { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述，2021-07-05 访谈', note: '中秋节后第三天' },
          { precision: 'year', year: 1958, source: '《县水利志》1994 年版，第 87 页' },
        ],
      },
      {
        key: 'tongshui',
        title: '东干渠通水',
        claims: [
          { precision: 'month', year: 1959, month: 5, source: '王秀兰口述，2021-08-02 访谈' },
        ],
      },
    ],
    relations: [
      { earlierKey: 'dongyuan-hui', laterKey: 'tongshui', source: '二人口述一致' },
    ],
  };
}

async function preview(bundle) {
  return call('POST', '/api/editor/import-preview', { body: bundle });
}

async function confirm(bundle, fingerprint, draftRevisionNo) {
  return call('POST', '/api/editor/import', { body: { bundle, fingerprint, draftRevisionNo } });
}

test('导入接口需要编辑者口令', async () => {
  const r1 = await call('POST', '/api/editor/import-preview', { token: null, body: sampleBundle() });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('POST', '/api/editor/import', { token: null, body: {} });
  assert.strictEqual(r2.status, 401);
});

test('预览只读：返回待写入内容、数量、指纹与修订号，不写任何数据', async () => {
  const keep = await makeEvent('既有事件'); // 既有草稿，导入不应影响
  const before = await getState();

  const pv = await preview(sampleBundle());
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.json));
  assert.strictEqual(pv.json.ok, true);
  assert.strictEqual(pv.json.batchId, '2026-09-fangtan-01');
  assert.match(pv.json.fingerprint, /^[0-9a-f]{64}$/);
  assert.strictEqual(pv.json.draftRevisionNo, before.draftRevisionNo);
  assert.strictEqual(pv.json.alreadyImported, null);
  assert.deepStrictEqual(pv.json.counts, { eventCount: 2, claimCount: 3, relationCount: 1 });

  // 待写入内容：事件、主张（含区间与出处）、关系（含解析出的标题）
  const [e1, e2] = pv.json.events;
  assert.strictEqual(e1.key, 'dongyuan-hui');
  assert.strictEqual(e1.claims.length, 2);
  assert.strictEqual(e1.claims[0].dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(e1.claims[0].intervalStart, '1958-09-12');
  assert.strictEqual(e1.claims[0].source, '李宝山口述，2021-07-05 访谈');
  assert.strictEqual(e1.claims[1].intervalEnd, '1958-12-31');
  assert.strictEqual(e2.claims[0].intervalStart, '1959-05-01');
  assert.strictEqual(e2.claims[0].intervalEnd, '1959-05-31');
  assert.strictEqual(pv.json.relations[0].earlierTitle, '修水渠动员会');
  assert.strictEqual(pv.json.relations[0].laterTitle, '东干渠通水');

  // 预览不写数据：草稿与修订号不变
  const after = await getState();
  assert.strictEqual(after.draftRevisionNo, before.draftRevisionNo);
  assert.strictEqual(after.events.length, 1);
  assert.strictEqual(after.events[0].id, keep);
});

test('键重复、引用缺失、日期或出处非法等问题一次性列出并整包拒绝', async () => {
  const bad = {
    batchId: 'bad-01',
    events: [
      { key: 'a', title: '事件甲', claims: [{ precision: 'day', year: 1959, month: 2, day: 30, source: 's' }] }, // 日期非法
      { key: 'a', title: '重复键', claims: [{ precision: 'year', year: 1960, source: 's' }] }, // 键重复
      { key: 'b', title: '事件乙', claims: [{ precision: 'month', year: 1958, month: 13, source: 's' }] }, // 月份非法
      { key: 'c', title: '事件丙', claims: [{ precision: 'year', year: 1961, source: '  ' }] }, // 出处非法
      { key: 'd', title: '事件丁', claims: [{ precision: 'week', year: 1961, source: 's' }] }, // 精度非法
    ],
    relations: [
      { earlierKey: 'a', laterKey: 'ghost' }, // 引用缺失
      { earlierKey: 'b', laterKey: 'b' }, // 自环
    ],
  };
  const r = await preview(bad);
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.ok, undefined);
  assert.strictEqual(r.json.code, 'BUNDLE_INVALID');
  const types = r.json.problems.map((p) => p.type);
  assert.ok(types.includes('duplicate_key'), JSON.stringify(r.json.problems));
  assert.ok(types.includes('missing_reference'));
  assert.ok(types.includes('self_relation'));
  assert.strictEqual(types.filter((t) => t === 'invalid_date').length, 3); // 2月30日、13月、week 精度
  assert.ok(types.includes('invalid_source'));
  // 问题带定位信息
  const dup = r.json.problems.find((p) => p.type === 'duplicate_key');
  assert.strictEqual(dup.key, 'a');
  const miss = r.json.problems.find((p) => p.type === 'missing_reference');
  assert.strictEqual(miss.key, 'ghost');

  // 整包拒绝：草稿完全没变
  const st = await getState();
  assert.strictEqual(st.events.length, 0);
  assert.strictEqual(st.draftRevisionNo, 0);
});

test('结构非法（缺 batchId / 空 events / 无主张）也被整包拒绝', async () => {
  const r1 = await preview({ events: [{ key: 'a', title: 't', claims: [{ precision: 'year', year: 1, source: 's' }] }] });
  assert.strictEqual(r1.status, 422);
  assert.ok(r1.json.problems.some((p) => /batchId/.test(p.message)));

  const r2 = await preview({ batchId: 'x', events: [] });
  assert.strictEqual(r2.status, 422);

  const r3 = await preview({ batchId: 'x', events: [{ key: 'a', title: 't', claims: [] }] });
  assert.strictEqual(r3.status, 422);
  assert.ok(r3.json.problems.some((p) => /时间主张/.test(p.message)));

  // 顶层不是对象：JSON 字符串被解析器以 400 拒绝；数组到达校验，以 422 整包拒绝
  const r4 = await preview('not-an-object');
  assert.strictEqual(r4.status, 400);
  const r5 = await preview([1, 2, 3]);
  assert.strictEqual(r5.status, 422);
});

test('确认参数非法返回 400', async () => {
  const pv = await preview(sampleBundle());
  assert.strictEqual(pv.status, 200);
  const bad = async (body) => (await call('POST', '/api/editor/import', { body })).status;
  assert.strictEqual(await bad({}), 400);
  assert.strictEqual(await bad({ bundle: sampleBundle() }), 400);
  assert.strictEqual(await bad({ bundle: sampleBundle(), fingerprint: pv.json.fingerprint }), 400);
  assert.strictEqual(await bad({ bundle: sampleBundle(), fingerprint: pv.json.fingerprint, draftRevisionNo: -1 }), 400);
  assert.strictEqual(await bad({ bundle: 'x', fingerprint: pv.json.fingerprint, draftRevisionNo: 0 }), 400);
});

test('内容被替换（指纹不符）→ 409 且不写入', async () => {
  const bundle = sampleBundle();
  const pv = await preview(bundle);
  assert.strictEqual(pv.status, 200);

  const tampered = sampleBundle();
  tampered.events[0].title = '被替换的标题';
  const r = await confirm(tampered, pv.json.fingerprint, pv.json.draftRevisionNo);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'BUNDLE_CONTENT_MISMATCH');

  const st = await getState();
  assert.strictEqual(st.events.length, 0);
  assert.strictEqual(st.draftRevisionNo, 0);
});

test('草稿已变化（修订号过期）→ 409 且不写入；重新预览后可成功', async () => {
  const bundle = sampleBundle();
  const pv = await preview(bundle);
  assert.strictEqual(pv.status, 200);

  // 另一位编辑者在确认前改了草稿
  await makeEvent('并发加入的事件');
  const revNow = (await getState()).draftRevisionNo;

  const r = await confirm(bundle, pv.json.fingerprint, pv.json.draftRevisionNo);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'DRAFT_REVISION_CONFLICT');
  assert.strictEqual(r.json.currentRevisionNo, revNow);

  // 未写入，且失败的确认不会记录批次（可重试）
  const st = await getState();
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.draftRevisionNo, revNow);

  // 重新预览后确认成功
  const pv2 = await preview(bundle);
  assert.strictEqual(pv2.json.draftRevisionNo, revNow);
  const ok = await confirm(bundle, pv2.json.fingerprint, pv2.json.draftRevisionNo);
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
});

test('确认成功：一个事务追加整包，返回键→草稿ID映射与新修订号；既有草稿/快照/访客不变', async () => {
  // 既有草稿 + 已发布第 1 版
  const keep = await makeEvent('既有事件', '不要动我');
  const keepClaim = await makeClaim(keep, { precision: 'year', year: 1950, source: '老档案' });
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: keep, claimId: keepClaim }], baseVersionNo: 0 },
  });
  assert.strictEqual(pub.status, 201);

  const bundle = sampleBundle();
  const pv = await preview(bundle);
  const revAtPreview = pv.json.draftRevisionNo;

  const r = await confirm(bundle, pv.json.fingerprint, revAtPreview);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.batchId, '2026-09-fangtan-01');
  // 整包只推进一次修订号
  assert.strictEqual(r.json.revisionNo, revAtPreview + 1);
  assert.deepStrictEqual(r.json.counts, { eventCount: 2, claimCount: 3, relationCount: 1 });

  // 键 → 草稿 ID 映射
  const em = r.json.idMap.events;
  assert.strictEqual(em.length, 2);
  const mA = em.find((m) => m.key === 'dongyuan-hui');
  const mB = em.find((m) => m.key === 'tongshui');
  assert.ok(mA.eventId > 0 && mB.eventId > 0);
  assert.strictEqual(mA.claimIds.length, 2);
  assert.strictEqual(mB.claimIds.length, 1);
  const rm = r.json.idMap.relations;
  assert.strictEqual(rm.length, 1);
  assert.strictEqual(rm[0].earlierKey, 'dongyuan-hui');
  assert.strictEqual(rm[0].laterKey, 'tongshui');

  // 草稿：既有内容保留，整包已追加，关系指向新事件
  const st = await getState();
  assert.strictEqual(st.draftRevisionNo, revAtPreview + 1);
  assert.strictEqual(st.events.length, 3);
  assert.ok(st.events.some((e) => e.id === keep && e.description === '不要动我'));
  const evA = st.events.find((e) => e.id === mA.eventId);
  assert.strictEqual(evA.title, '修水渠动员会');
  assert.deepStrictEqual(evA.claims.map((c) => c.id), mA.claimIds);
  assert.strictEqual(evA.claims[0].dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(evA.claims[0].source, '李宝山口述，2021-07-05 访谈');
  assert.strictEqual(evA.claims[1].intervalEnd, '1958-12-31');
  const rel = st.relations.find((x) => x.id === rm[0].relationId);
  assert.strictEqual(rel.earlierId, mA.eventId);
  assert.strictEqual(rel.laterId, mB.eventId);
  assert.strictEqual(rel.source, '二人口述一致');

  // 历史快照与访客视图不受影响（仍是第 1 版，只有既有事件）
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.eventCount, 1);
  assert.strictEqual(view.json.version.events[0].title, '既有事件');
});

test('批次标识曾成功导入 → 409 且不写入；预览会提示已导入', async () => {
  const bundle = sampleBundle();
  const pv1 = await preview(bundle);
  const ok = await confirm(bundle, pv1.json.fingerprint, pv1.json.draftRevisionNo);
  assert.strictEqual(ok.status, 201);
  const revAfterImport = ok.json.revisionNo;

  // 再次预览同一批次：仍 200，但标记已导入
  const pv2 = await preview(bundle);
  assert.strictEqual(pv2.status, 200);
  assert.ok(pv2.json.alreadyImported);
  assert.ok(pv2.json.alreadyImported.importedAt);

  // 再次确认（即便修订号是最新的）→ 批次冲突
  const dup = await confirm(bundle, pv2.json.fingerprint, pv2.json.draftRevisionNo);
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.json.code, 'BATCH_ALREADY_IMPORTED');
  assert.strictEqual(dup.json.batchId, '2026-09-fangtan-01');

  const st = await getState();
  assert.strictEqual(st.events.length, 2);
  assert.strictEqual(st.draftRevisionNo, revAfterImport);
});

test('指纹与 JSON 键序无关：同一包重排键序仍可确认', async () => {
  const bundle = sampleBundle();
  const pv = await preview(bundle);
  assert.strictEqual(pv.status, 200);

  // 同一内容、不同键序（确认时重算指纹应一致）
  const reordered = {
    relations: [
      { source: '二人口述一致', laterKey: 'tongshui', earlierKey: 'dongyuan-hui' },
    ],
    events: bundle.events.map((e) => ({
      claims: e.claims.map((c) => ({ source: c.source, note: c.note, day: c.day, month: c.month, year: c.year, precision: c.precision })),
      description: e.description,
      title: e.title,
      key: e.key,
    })),
    batchId: bundle.batchId,
  };
  // 去掉 undefined 字段（JSON 往返等价）
  const cleaned = JSON.parse(JSON.stringify(reordered));
  const r = await confirm(cleaned, pv.json.fingerprint, pv.json.draftRevisionNo);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
});

test('导入内容仍须按现有选择与先后校验发布', async () => {
  // 时间上无解的包：冬月(1958-12) 先于 春月(1958-01)
  const bundle = {
    batchId: 'impossible-01',
    events: [
      { key: 'winter', title: '冬月会议', claims: [{ precision: 'month', year: 1958, month: 12, source: 's1' }] },
      { key: 'spring', title: '春月会议', claims: [{ precision: 'month', year: 1958, month: 1, source: 's2' }] },
    ],
    relations: [{ earlierKey: 'winter', laterKey: 'spring' }],
  };
  const pv = await preview(bundle);
  assert.strictEqual(pv.status, 200);
  const imp = await confirm(bundle, pv.json.fingerprint, pv.json.draftRevisionNo);
  assert.strictEqual(imp.status, 201);

  // 导入成功（草稿层不求解），但发布校验按现有规则拒绝
  const [w, s] = imp.json.idMap.events;
  const selection = [
    { eventId: w.eventId, claimId: w.claimIds[0] },
    { eventId: s.eventId, claimId: s.claimIds[0] },
  ];
  const val = await call('POST', '/api/editor/validate', { body: { selection } });
  assert.strictEqual(val.json.ok, false);
  assert.strictEqual(val.json.errors[0].type, 'temporal');

  const pub = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo: 0 } });
  assert.strictEqual(pub.status, 422);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
});

test('导入的合法内容可走完现有发布流程（选定主张 → 校验 → 发布）', async () => {
  const bundle = sampleBundle();
  const pv = await preview(bundle);
  const imp = await confirm(bundle, pv.json.fingerprint, pv.json.draftRevisionNo);
  assert.strictEqual(imp.status, 201);
  const [a, b] = imp.json.idMap.events;

  // 为每个导入事件选定一条主张（选矛盾主张中的年精度那条也行）
  const selection = [
    { eventId: a.eventId, claimId: a.claimIds[1] }, // 1958 年（年精度）
    { eventId: b.eventId, claimId: b.claimIds[0] }, // 1959 年 5 月
  ];
  const val = await call('POST', '/api/editor/validate', { body: { selection } });
  assert.strictEqual(val.json.ok, true, JSON.stringify(val.json));

  const pub = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 0, editor: '导入者', note: '整理包首版' },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.strictEqual(pub.json.versionNo, 1);
  assert.strictEqual(pub.json.version.events[0].resolvedDate, '1958-01-01');
  assert.strictEqual(pub.json.version.events[1].resolvedDate, '1959-05-01');

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.events.length, 2);
  assert.strictEqual(view.json.version.relations[0].source, '二人口述一致');
});

test('空 relations 可省略；确认后草稿修订号可被后续编辑继续推进', async () => {
  const bundle = {
    batchId: 'no-relations-01',
    events: [{ key: 'solo', title: '独立事件', claims: [{ precision: 'year', year: 1977, source: '档案' }] }],
  };
  const pv = await preview(bundle);
  assert.strictEqual(pv.json.counts.relationCount, 0);
  const imp = await confirm(bundle, pv.json.fingerprint, pv.json.draftRevisionNo);
  assert.strictEqual(imp.status, 201);
  assert.strictEqual(imp.json.idMap.relations.length, 0);

  // 后续普通编辑基于新修订号继续推进
  const eid = imp.json.idMap.events[0].eventId;
  await makeClaim(eid, { precision: 'day', year: 1977, month: 3, day: 5, source: '补充口述' });
  const st = await getState();
  assert.strictEqual(st.draftRevisionNo, imp.json.revisionNo + 1);
});
