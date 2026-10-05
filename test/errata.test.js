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
    DELETE FROM errata;
    DELETE FROM version_retractions;
    DELETE FROM publish_schedules;
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

// 建两个事件（动员会 → 通水会）+ 一条先于关系并发布一版
async function setupOneVersion() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  const r1 = await makeRel(e1, e2, '二人口述一致');
  const selection = [
    { eventId: e1, claimId: c1 },
    { eventId: e2, claimId: c2 },
  ];
  const v1 = await publish(selection, 0, '首版');
  return { e1, e2, c1, c2, r1, selection, v1 };
}

async function registerErrata(body) {
  return call('POST', '/api/editor/errata', { body });
}

function errataCount() {
  return mem.prepare('SELECT COUNT(*) AS n FROM errata').get().n;
}

test('勘误接口需要编辑口令', async () => {
  const r1 = await call('POST', '/api/editor/errata', {
    token: null,
    body: { versionNo: 1, targetType: 'event', targetId: 1, note: 'x', source: 'y' },
  });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('GET', '/api/editor/versions/1/errata', { token: null });
  assert.strictEqual(r2.status, 401);
  const r3 = await call('GET', '/api/editor/errata/1', { token: null });
  assert.strictEqual(r3.status, 401);
});

test('登记成功：事件与关系附记进入公开视图；快照、求解日期与草稿不变', async () => {
  const { e1, r1, v1 } = await setupOneVersion();
  const rawBefore = await call('GET', `/api/editor/versions/${v1}/raw`);
  const revBefore = (await call('GET', '/api/editor/state')).json.draftRevisionNo;

  // 对事件登记
  const rEvent = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1,
    note: '动员会日期应为 1958-09-13，口述记忆有误', source: '《县水利志》1994 年版，第 87 页',
    editor: '志愿者小王',
  });
  assert.strictEqual(rEvent.status, 201, JSON.stringify(rEvent.json));
  assert.strictEqual(rEvent.json.ok, true);
  assert.strictEqual(rEvent.json.errata.errataId, 1);
  assert.strictEqual(rEvent.json.errata.versionNo, v1);
  assert.strictEqual(rEvent.json.errata.targetType, 'event');
  assert.strictEqual(rEvent.json.errata.targetId, e1);
  assert.strictEqual(rEvent.json.errata.replacesErrataId, null);
  assert.strictEqual(rEvent.json.replaced, null);

  // 对「先于」关系登记
  const rRel = await registerErrata({
    versionNo: v1, targetType: 'relation', targetId: r1,
    note: '该先后关系另有反证待核', source: '张德福口述，2022-03-11 访谈',
  });
  assert.strictEqual(rRel.status, 201, JSON.stringify(rRel.json));
  assert.strictEqual(rRel.json.errata.errataId, 2);

  // 访客最新年表可见两条生效附记（含目标展示信息）
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.errata.length, 2);
  const evErrata = pub.json.version.errata.find((x) => x.targetType === 'event');
  assert.strictEqual(evErrata.note, '动员会日期应为 1958-09-13，口述记忆有误');
  assert.strictEqual(evErrata.source, '《县水利志》1994 年版，第 87 页');
  assert.strictEqual(evErrata.target.title, '动员会');
  const relErrata = pub.json.version.errata.find((x) => x.targetType === 'relation');
  assert.strictEqual(relErrata.target.earlierTitle, '动员会');
  assert.strictEqual(relErrata.target.laterTitle, '通水会');

  // 访客读取指定历史版本同样可见
  const pubV = await call('GET', `/api/public/versions/${v1}`, { token: null });
  assert.strictEqual(pubV.json.version.errata.length, 2);

  // 原快照、求解日期与草稿未改（raw 的 version 仅新增 errata 字段）
  const rawAfter = await call('GET', `/api/editor/versions/${v1}/raw`);
  const { errata: _dropAfter, ...coreAfter } = rawAfter.json.version;
  const { errata: _dropBefore, ...coreBefore } = rawBefore.json.version;
  assert.deepStrictEqual(coreAfter, coreBefore);
  assert.strictEqual(rawAfter.json.version.errata.length, 2); // 编辑者原文视图也带生效附记
  assert.strictEqual(rawAfter.json.version.errata[0].source, '《县水利志》1994 年版，第 87 页');
  const revAfter = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  assert.strictEqual(revAfter, revBefore); // 不推进草稿修订号
});

test('附记只属于目标版：以后发布的版本不继承，恢复草稿不带回附记', async () => {
  const { e1, selection, v1 } = await setupOneVersion();
  await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '首版附记', source: '档案甲',
  });

  // 同内容发布第二版：新版没有附记
  const v2 = await publish(selection, v1, '第二版');
  const pubV2 = await call('GET', `/api/public/versions/${v2}`, { token: null });
  assert.deepStrictEqual(pubV2.json.version.errata, []);
  // 旧版附记仍在
  const pubV1 = await call('GET', `/api/public/versions/${v1}`, { token: null });
  assert.strictEqual(pubV1.json.version.errata.length, 1);

  // 从第一版恢复草稿：草稿区本无附记概念，恢复不携带附记
  const rp = await call('GET', `/api/editor/restore-preview/${v1}`);
  const restored = await call('POST', '/api/editor/restore', {
    body: { versionNo: v1, draftRevisionNo: rp.json.draftRevisionNo, currentVersionNo: rp.json.currentVersionNo },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  // 恢复后发布第三版：同样不继承第一版的附记
  const v3 = await publish(restored.json.pendingSelection, v2, '恢复后发布');
  const pubV3 = await call('GET', `/api/public/versions/${v3}`, { token: null });
  assert.deepStrictEqual(pubV3.json.version.errata, []);
  // 第一版附记依然只属于第一版
  const list = await call('GET', `/api/editor/versions/${v1}/errata`);
  assert.strictEqual(list.json.totalCount, 1);
});

test('替代须提交所见附记号：缺失或过期 → 409 取得当前附记且不落库', async () => {
  const { e1, v1 } = await setupOneVersion();
  const first = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '第一条附记', source: '档案甲',
  });
  const id1 = first.json.errata.errataId;

  // 未提交所见附记号 → 409，返回当前生效附记
  const noToken = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '想悄悄替代', source: '档案乙',
  });
  assert.strictEqual(noToken.status, 409);
  assert.strictEqual(noToken.json.code, 'ERRATA_CONFLICT');
  assert.strictEqual(noToken.json.current.errataId, id1);
  assert.strictEqual(noToken.json.current.note, '第一条附记');

  // 提交了过期的附记号 → 409
  const stale = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '基于不存在的附记', source: '档案乙',
    replacesErrataId: id1 + 100,
  });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.current.errataId, id1);

  // 均未落库
  assert.strictEqual(errataCount(), 1);

  // 提交正确附记号 → 替代成功，旧附记保留在替代链中
  const second = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1,
    note: '更正：应为 1958-09-14', source: '档案乙，第 12 页', replacesErrataId: id1,
  });
  assert.strictEqual(second.status, 201, JSON.stringify(second.json));
  assert.strictEqual(second.json.errata.replacesErrataId, id1);
  assert.strictEqual(second.json.replaced.errataId, id1);
  assert.strictEqual(second.json.replaced.note, '第一条附记');
  assert.strictEqual(errataCount(), 2);

  // 同一目标只展示最新生效附记
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.errata.length, 1);
  assert.strictEqual(pub.json.version.errata[0].note, '更正：应为 1958-09-14');

  // 编辑者可查完整替代链（旧 → 新）
  const chain = await call('GET', `/api/editor/errata/${id1}`);
  assert.strictEqual(chain.status, 200);
  assert.deepStrictEqual(chain.json.chain.map((c) => c.errataId), [id1, second.json.errata.errataId]);
  assert.strictEqual(chain.json.effective.errataId, second.json.errata.errataId);
  assert.strictEqual(chain.json.errata.note, '第一条附记'); // 旧附记原文保留供追溯
});

test('两名编辑者同时替代同一附记：仅一个成功，冲突方取得当前附记且不落库', async () => {
  const { e1, v1 } = await setupOneVersion();
  const first = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '原始附记', source: '档案甲',
  });
  const id1 = first.json.errata.errataId;

  // 甲、乙都基于所见附记 #id1 提交替代
  const jia = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '甲的更正', source: '甲的出处',
    editor: '甲', replacesErrataId: id1,
  });
  assert.strictEqual(jia.status, 201);

  const yi = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '乙的更正', source: '乙的出处',
    editor: '乙', replacesErrataId: id1,
  });
  assert.strictEqual(yi.status, 409);
  assert.strictEqual(yi.json.code, 'ERRATA_CONFLICT');
  // 冲突方取得当前生效附记（甲的那条），且未落库
  assert.strictEqual(yi.json.current.errataId, jia.json.errata.errataId);
  assert.strictEqual(yi.json.current.note, '甲的更正');
  assert.strictEqual(errataCount(), 2);

  // 公开只见甲的生效附记；乙可基于当前附记号重新替代
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.errata[0].note, '甲的更正');
  const retry = await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '乙重新替代', source: '乙的出处',
    replacesErrataId: yi.json.current.errataId,
  });
  assert.strictEqual(retry.status, 201);
  assert.strictEqual(errataCount(), 3);
});

test('拒绝登记：版本不存在 404；对象不属该版 422；目标版已撤回 409；均不落库', async () => {
  const { e1, e2, selection, v1 } = await setupOneVersion();

  // 版本不存在
  const nf = await registerErrata({ versionNo: 9999, targetType: 'event', targetId: e1, note: 'x', source: 'y' });
  assert.strictEqual(nf.status, 404);

  // 对象不属于该版：e2 的主张在发布后被删除并新建事件 e3（不在快照中）
  const e3 = await makeEvent('会后新事件');
  const notIn = await registerErrata({ versionNo: v1, targetType: 'event', targetId: e3, note: 'x', source: 'y' });
  assert.strictEqual(notIn.status, 422);
  assert.strictEqual(notIn.json.code, 'ERRATA_TARGET_NOT_IN_VERSION');
  const notInRel = await registerErrata({ versionNo: v1, targetType: 'relation', targetId: 999, note: 'x', source: 'y' });
  assert.strictEqual(notInRel.status, 422);

  // 目标版已撤回 → 409 VERSION_RETRACTED
  await call('POST', `/api/editor/versions/${v1}/retract`, { body: { reason: '编年依据错误' } });
  const retracted = await registerErrata({ versionNo: v1, targetType: 'event', targetId: e1, note: 'x', source: 'y' });
  assert.strictEqual(retracted.status, 409);
  assert.strictEqual(retracted.json.code, 'VERSION_RETRACTED');

  assert.strictEqual(errataCount(), 0);

  // 清掉草稿中未发布的新事件，撤回后发布修正版，可对新版登记（附记不继承，重新登记）
  await call('DELETE', `/api/editor/events/${e3}`);
  const v2 = await publish(selection, v1, '修正版');
  const ok = await registerErrata({ versionNo: v2, targetType: 'event', targetId: e2, note: '新版的附记', source: '档案' });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
});

test('字段非法 → 400 且不落库', async () => {
  const { e1, v1 } = await setupOneVersion();
  const base1 = { versionNo: v1, targetType: 'event', targetId: e1, note: '说明', source: '出处' };

  const cases = [
    { ...base1, versionNo: 0 },
    { ...base1, versionNo: 'abc' },
    { ...base1, targetType: 'claim' },
    { ...base1, targetType: '' },
    { ...base1, targetId: 0 },
    { ...base1, targetId: 'x' },
    { ...base1, note: '' },
    { ...base1, note: '   ' },
    { ...base1, note: 123 },
    { ...base1, note: 'x'.repeat(2001) },
    { ...base1, source: '' },
    { ...base1, source: '  ' },
    { ...base1, source: null },
    { ...base1, source: 'y'.repeat(1001) },
    { ...base1, replacesErrataId: -1 },
    { ...base1, replacesErrataId: 'abc' },
  ];
  for (const body of cases) {
    const r = await registerErrata(body);
    assert.strictEqual(r.status, 400, `应 400：${JSON.stringify(body)}，实际 ${r.status}`);
  }
  assert.strictEqual(errataCount(), 0);
});

test('附记出处沿用精确文本遮盖规则；编辑者查原文', async () => {
  const { e1, v1 } = await setupOneVersion();
  await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1,
    note: '日期待核', source: '李宝山口述，2021-07-05 访谈',
  });

  // 遮盖前：访客可见原文
  let pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.errata[0].source, '李宝山口述，2021-07-05 访谈');

  // 按现有规则登记遮盖（精确文本）
  await call('POST', '/api/editor/redaction', {
    body: { source: '李宝山口述，2021-07-05 访谈', currentVersionNo: v1 },
  });

  // 访客最新年表与指定版：附记出处显示「出处已遮盖」，说明不变
  pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.errata[0].source, '出处已遮盖');
  assert.strictEqual(pub.json.version.errata[0].note, '日期待核');
  const pubV = await call('GET', `/api/public/versions/${v1}`, { token: null });
  assert.strictEqual(pubV.json.version.errata[0].source, '出处已遮盖');

  // 编辑者查原文（版本原文视图与附记链均不遮盖）
  const raw = await call('GET', `/api/editor/versions/${v1}/raw`);
  assert.strictEqual(raw.json.version.errata[0].source, '李宝山口述，2021-07-05 访谈');
  const list = await call('GET', `/api/editor/versions/${v1}/errata`);
  assert.strictEqual(list.json.targets[0].effective.source, '李宝山口述，2021-07-05 访谈');
});

test('撤回目标版：访客不再看到该版及其附记；编辑者仍可查原文与替代链', async () => {
  const { e1, selection, v1 } = await setupOneVersion();
  await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '首版附记', source: '档案甲',
  });
  const v2 = await publish(selection, v1, '第二版');

  // 撤回第一版
  await call('POST', `/api/editor/versions/${v1}/retract`, { body: { reason: '首版编年有误' } });

  // 访客最新年表指向第二版（无附记）；指定撤回版 404
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.currentVersionNo, v2);
  assert.deepStrictEqual(pub.json.version.errata, []);
  const gone = await call('GET', `/api/public/versions/${v1}`, { token: null });
  assert.strictEqual(gone.status, 404);

  // 编辑者仍可查撤回版的附记原文与替代链（响应附撤回信息）
  const list = await call('GET', `/api/editor/versions/${v1}/errata`);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.targets.length, 1);
  assert.strictEqual(list.json.targets[0].effective.note, '首版附记');
  assert.strictEqual(list.json.retraction.reason, '首版编年有误');
  const chain = await call('GET', `/api/editor/errata/1`);
  assert.strictEqual(chain.json.errata.note, '首版附记');
  assert.strictEqual(chain.json.retraction.reason, '首版编年有误');
});

test('版本附记清单：按目标分组，含目标信息、生效附记与替代链', async () => {
  const { e1, r1, v1 } = await setupOneVersion();
  const a = await registerErrata({ versionNo: v1, targetType: 'event', targetId: e1, note: '一', source: '甲' });
  await registerErrata({
    versionNo: v1, targetType: 'event', targetId: e1, note: '二', source: '乙',
    replacesErrataId: a.json.errata.errataId,
  });
  await registerErrata({ versionNo: v1, targetType: 'relation', targetId: r1, note: '关系附记', source: '丙' });

  const list = await call('GET', `/api/editor/versions/${v1}/errata`);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.versionNo, v1);
  assert.strictEqual(list.json.totalCount, 3);
  assert.strictEqual(list.json.targets.length, 2);
  const evTarget = list.json.targets.find((t) => t.targetType === 'event');
  assert.strictEqual(evTarget.target.title, '动员会');
  assert.strictEqual(evTarget.effective.note, '二');
  assert.deepStrictEqual(evTarget.chain.map((c) => c.note), ['一', '二']);
  const relTarget = list.json.targets.find((t) => t.targetType === 'relation');
  assert.strictEqual(relTarget.target.earlierTitle, '动员会');
  assert.strictEqual(relTarget.chain.length, 1);

  // 版本不存在 → 404；附记号不存在 → 404
  const nf = await call('GET', '/api/editor/versions/9999/errata');
  assert.strictEqual(nf.status, 404);
  const nfOne = await call('GET', '/api/editor/errata/9999');
  assert.strictEqual(nfOne.status, 404);
});
