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
const { runDueSchedules } = require('../src/schedule');

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

// 建两个事件（动员会 → 通水会）并连续发布两版；返回草稿 id 与选择
async function setupTwoVersions() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');
  const selection = [
    { eventId: e1, claimId: c1 },
    { eventId: e2, claimId: c2 },
  ];
  const v1 = await publish(selection, 0, '首版');
  const v2 = await publish(selection, v1, '第二版');
  return { e1, e2, c1, c2, selection, v1, v2 };
}

function secondsFromNow(deltaSec) {
  return new Date(Date.now() + deltaSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

test('撤回接口需要编辑口令', async () => {
  const r1 = await call('POST', '/api/editor/versions/1/retract', { token: null, body: { reason: 'x' } });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('GET', '/api/editor/retractions', { token: null });
  assert.strictEqual(r2.status, 401);
});

test('撤回成功：只追加审计记录，历史快照与版本号不变；编辑者可见原因', async () => {
  const { v2 } = await setupTwoVersions();
  const before = await call('GET', `/api/editor/versions/${v2}/raw`);

  const r = await call('POST', `/api/editor/versions/${v2}/retract`, {
    body: { reason: '  动员会日期考证有误，需撤回修订  ', editor: '志愿者小王' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.alreadyRetracted, false);
  assert.strictEqual(r.json.retraction.versionNo, v2);
  assert.strictEqual(r.json.retraction.reason, '动员会日期考证有误，需撤回修订'); // trim 后保存
  assert.strictEqual(r.json.retraction.editor, '志愿者小王');
  assert.ok(r.json.retraction.retractedAt);
  assert.strictEqual(r.json.currentVersionNo, v2); // 发布基准不变（含撤回版）
  assert.strictEqual(r.json.latestVisibleVersionNo, v2 - 1);

  // 审计记录只追加一条
  const n = mem.prepare('SELECT COUNT(*) AS n FROM version_retractions WHERE version_no = ?').get(v2).n;
  assert.strictEqual(n, 1);

  // 快照原文未被改写
  const after = await call('GET', `/api/editor/versions/${v2}/raw`);
  assert.deepStrictEqual(after.json.version, before.json.version);
  assert.strictEqual(after.json.retraction.reason, '动员会日期考证有误，需撤回修订');

  // 撤回清单（编辑者视角）
  const list = await call('GET', '/api/editor/retractions');
  assert.strictEqual(list.json.retractions.length, 1);
  assert.strictEqual(list.json.retractions[0].versionNo, v2);
  assert.strictEqual(list.json.currentVersionNo, v2);
  assert.strictEqual(list.json.latestVisibleVersionNo, v2 - 1);

  // 编辑者版本清单标记撤回状态
  const versions = await call('GET', '/api/editor/versions');
  assert.strictEqual(versions.json.currentVersionNo, v2);
  const row2 = versions.json.versions.find((v) => v.versionNo === v2);
  assert.strictEqual(row2.retracted, true);
  assert.strictEqual(row2.retraction.reason, '动员会日期考证有误，需撤回修订');
  const row1 = versions.json.versions.find((v) => v.versionNo === v2 - 1);
  assert.strictEqual(row1.retracted, false);
  assert.strictEqual(row1.retraction, null);
});

test('重复撤回幂等：返回首次记录，不覆盖原因', async () => {
  const { v2 } = await setupTwoVersions();
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '首次原因', editor: '甲' } });

  const again = await call('POST', `/api/editor/versions/${v2}/retract`, {
    body: { reason: '试图改写的第二条原因', editor: '乙' },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyRetracted, true);
  assert.strictEqual(again.json.retraction.reason, '首次原因');
  assert.strictEqual(again.json.retraction.editor, '甲');

  const n = mem.prepare('SELECT COUNT(*) AS n FROM version_retractions WHERE version_no = ?').get(v2).n;
  assert.strictEqual(n, 1);
});

test('版本不存在 → 404；原因非法 → 400；均不改状态', async () => {
  const { v2 } = await setupTwoVersions();

  // 不存在的版本
  const nf = await call('POST', '/api/editor/versions/9999/retract', { body: { reason: 'x' } });
  assert.strictEqual(nf.status, 404);

  // 版本号非法
  const badNo = await call('POST', '/api/editor/versions/abc/retract', { body: { reason: 'x' } });
  assert.strictEqual(badNo.status, 400);

  // 原因非法：空 / 纯空白 / 非字符串 / 超长 / 缺失
  for (const reason of ['', '   ', '\t\n', 123, null, undefined, 'x'.repeat(1001)]) {
    const r = await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason } });
    assert.strictEqual(r.status, 400, `reason=${JSON.stringify(reason)} 应 400，实际 ${r.status}`);
  }

  // 均不改状态：无审计记录，访客视图不变
  const n = mem.prepare('SELECT COUNT(*) AS n FROM version_retractions').get().n;
  assert.strictEqual(n, 0);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, v2);
});

test('访客最新年表指向编号最大的未撤回版；全部撤回显示尚无可读版本', async () => {
  const { v1, v2 } = await setupTwoVersions();

  // 撤回最新版 v2 → 访客回退到 v1
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '第二版编年有误' } });
  let view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, true);
  assert.strictEqual(view.json.currentVersionNo, v1);
  assert.strictEqual(view.json.version.versionNo, v1);

  // 再撤回 v1 → 全部撤回，尚无可读版本
  await call('POST', `/api/editor/versions/${v1}/retract`, { body: { reason: '首版也有误' } });
  view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
  assert.strictEqual(view.json.allRetracted, true);
  assert.match(view.json.message, /尚无可读版本/);

  // 编辑者视角：最高已发布版本号仍是 v2（发布基准不变）
  const state = await call('GET', '/api/editor/state');
  assert.strictEqual(state.json.currentVersionNo, v2);
  assert.strictEqual(state.json.latestVisibleVersionNo, 0);
});

test('访客版本清单隐藏撤回版；指定撤回版读取按不存在处理（404）', async () => {
  const { v1, v2 } = await setupTwoVersions();
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '撤回第二版' } });

  // 清单只含未撤回版
  const list = await call('GET', '/api/public/versions', { token: null });
  assert.strictEqual(list.json.currentVersionNo, v1);
  assert.deepStrictEqual(list.json.versions.map((v) => v.versionNo), [v1]);

  // 指定撤回版 → 404（按不存在处理）
  const detail = await call('GET', `/api/public/versions/${v2}`, { token: null });
  assert.strictEqual(detail.status, 404);
  assert.match(detail.json.message, /不存在/);

  // 未撤回版不受影响，结构兼容
  const ok = await call('GET', `/api/public/versions/${v1}`, { token: null });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.version.versionNo, v1);
  assert.ok(Array.isArray(ok.json.version.events));
  assert.ok(Array.isArray(ok.json.version.relations));

  // 编辑者仍可见撤回版原文
  const raw = await call('GET', `/api/editor/versions/${v2}/raw`);
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.json.version.events.length, 2);
  assert.strictEqual(raw.json.retraction.reason, '撤回第二版');
});

test('引用撤回版的专题路线：访客隐藏（清单与详情），编辑者仍可见', async () => {
  const { e1, e2, v1, v2 } = await setupTwoVersions();
  // 两个版本各建一条路线
  const mk = async (versionNo, title) => {
    const r = await call('POST', '/api/editor/routes', {
      body: { title, versionNo, anchorEventIds: [e1, e2], editor: '测试员' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    return r.json.route.routeNo;
  };
  const route1 = await mk(v1, '据首版的路线');
  const route2 = await mk(v2, '据第二版的路线');

  // 撤回 v2
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '编年依据错误' } });

  // 访客路线清单：只剩引用未撤回版的路线
  const pubList = await call('GET', '/api/public/routes', { token: null });
  assert.deepStrictEqual(pubList.json.routes.map((r) => r.routeNo), [route1]);

  // 访客直接访问引用撤回版的路线 → 404
  const pubDetail = await call('GET', `/api/public/routes/${route2}`, { token: null });
  assert.strictEqual(pubDetail.status, 404);

  // 引用未撤回版的路线不受影响
  const pubOk = await call('GET', `/api/public/routes/${route1}`, { token: null });
  assert.strictEqual(pubOk.status, 200);
  assert.strictEqual(pubOk.json.route.title, '据首版的路线');

  // 编辑者清单仍含全部路线，并标记所据版本已撤回
  const edList = await call('GET', '/api/editor/routes');
  assert.strictEqual(edList.json.routes.length, 2);
  const edRoute2 = edList.json.routes.find((r) => r.routeNo === route2);
  assert.strictEqual(edRoute2.versionRetracted, true);
  const edRoute1 = edList.json.routes.find((r) => r.routeNo === route1);
  assert.strictEqual(edRoute1.versionRetracted, false);

  // 编辑者仍可查看引用撤回版的路线原文
  const edDetail = await call('GET', `/api/editor/routes/${route2}/raw`);
  assert.strictEqual(edDetail.status, 200);
  assert.strictEqual(edDetail.json.route.title, '据第二版的路线');
  assert.strictEqual(edDetail.json.versionRetracted, true);
});

test('即时发布基准不变：撤回版仍计入最高版本号，编号继续递增', async () => {
  const { selection, v2 } = await setupTwoVersions();
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '撤回第二版' } });

  // 以撤回前的旧版为基准 → 409（基准仍是最高已发布版本号 v2）
  const stale = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: v2 - 1, editor: '修正者' },
  });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.currentVersionNo, v2);

  // 以最高已发布版本号（含撤回版）为基准 → 发布成功，编号递增为 v2+1
  const ok = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: v2, editor: '修正者', note: '修正版' },
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.versionNo, v2 + 1);
  assert.strictEqual(ok.json.version.parentNo, v2);

  // 访客最新年表指向新的未撤回版
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, v2 + 1);
});

test('以已撤回版为冻结基准的待执行预约：到期转冲突，不生成新版本', async () => {
  const { selection, v2 } = await setupTwoVersions();

  // 基于当前最新版 v2 建立预约
  const s = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: v2, editor: '预约员' },
  });
  assert.strictEqual(s.status, 201);
  const no = s.json.schedule.scheduleNo;

  // 到期前撤回基准版 v2
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '基准版编年有误' } });

  // 到期执行 → 冲突，不生成新版本
  const out = runDueSchedules(Date.now() + 120 * 1000);
  assert.strictEqual(out.published.length, 0);
  assert.strictEqual(out.conflicts.length, 1);
  assert.strictEqual(out.conflicts[0].scheduleNo, no);

  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.status, 'conflict');
  assert.strictEqual(detail.json.schedule.resultVersionNo, null);
  assert.match(detail.json.schedule.resultMessage, /撤回/);
  // 冻结内容保留可查看
  assert.strictEqual(detail.json.schedule.frozen.events.length, 2);

  // 没有生成新版本
  const state = await call('GET', '/api/editor/state');
  assert.strictEqual(state.json.currentVersionNo, v2);
});

test('撤回与到期发布竞争（一）：撤回先提交 → 预约转冲突', async () => {
  const { selection, v2 } = await setupTwoVersions();
  const s = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: v2 },
  });
  const no = s.json.schedule.scheduleNo;

  // 撤回先提交
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '先撤回' } });
  // 预约到期执行（在撤回之后）
  const out = runDueSchedules(Date.now() + 120 * 1000);
  assert.strictEqual(out.published.length, 0);
  assert.strictEqual(out.conflicts.length, 1);

  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.status, 'conflict');
  assert.match(detail.json.schedule.resultMessage, /撤回/);
});

test('撤回与到期发布竞争（二）：发布先提交 → 新版本保留，撤回仅作用指定版', async () => {
  const { selection, v2 } = await setupTwoVersions();
  const s = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: v2 },
  });
  const no = s.json.schedule.scheduleNo;

  // 预约到期先执行（发布先提交）→ 生成 v2+1
  const out = runDueSchedules(Date.now() + 120 * 1000);
  assert.strictEqual(out.published.length, 1);
  assert.strictEqual(out.published[0].versionNo, v2 + 1);

  // 撤回随后提交，只作用于指定版 v2；新版本 v2+1 保留且未撤回
  const ret = await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '旧版编年有误' } });
  assert.strictEqual(ret.status, 200);
  assert.strictEqual(ret.json.currentVersionNo, v2 + 1);
  assert.strictEqual(ret.json.latestVisibleVersionNo, v2 + 1);

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, v2 + 1);
  const old = await call('GET', `/api/public/versions/${v2}`, { token: null });
  assert.strictEqual(old.status, 404);

  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.status, 'published');
  assert.strictEqual(detail.json.schedule.resultVersionNo, v2 + 1);
});

test('未撤回版接口结构与出处遮盖保持兼容', async () => {
  const { v1, v2 } = await setupTwoVersions();

  // 遮盖 v1 中命中的出处，再撤回 v2
  await call('POST', '/api/editor/redaction', { body: { source: '李宝山口述', currentVersionNo: v2 } });
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '撤回第二版' } });

  // 未撤回版 v1：公开读取结构不变，遮盖仍生效
  const pub = await call('GET', `/api/public/versions/${v1}`, { token: null });
  assert.strictEqual(pub.status, 200);
  const v = pub.json.version;
  assert.deepStrictEqual(
    Object.keys(v).sort(),
    ['versionNo', 'parentNo', 'editor', 'note', 'publishedAt', 'eventCount', 'relationCount', 'events', 'relations', 'errata'].sort()
  );
  assert.strictEqual(v.events.find((e) => e.title === '动员会').source, '出处已遮盖');
  assert.strictEqual(v.events.find((e) => e.title === '通水会').source, '王秀兰口述');

  // 最新年表即 v1，同样遮盖
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, v1);
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '动员会').source, '出处已遮盖');

  // 编辑者原文视图仍是原文
  const raw = await call('GET', `/api/editor/versions/${v1}/raw`);
  assert.strictEqual(raw.json.version.events.find((e) => e.title === '动员会').source, '李宝山口述');
  assert.strictEqual(raw.json.retraction, null);
});

test('撤回不推进草稿修订号（不触碰草稿区）', async () => {
  const { v2 } = await setupTwoVersions();
  const before = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '撤回' } });
  const after = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  assert.strictEqual(before, after);
});

test('撤回版仍可被编辑者恢复草稿（用原文），恢复后发布编号继续递增', async () => {
  const { v2 } = await setupTwoVersions();
  await call('POST', `/api/editor/versions/${v2}/retract`, { body: { reason: '撤回待修' } });

  // 恢复预览可用，且附带撤回信息
  const rp = await call('GET', `/api/editor/restore-preview/${v2}`);
  assert.strictEqual(rp.status, 200);
  assert.strictEqual(rp.json.retraction.reason, '撤回待修');

  // 确认恢复
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: v2,
      draftRevisionNo: rp.json.draftRevisionNo,
      currentVersionNo: rp.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));

  // 恢复后以最高已发布版本号（含撤回版）为基准发布 → v2+1
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: restored.json.pendingSelection, baseVersionNo: v2, editor: '修正者' },
  });
  assert.strictEqual(pub.status, 201);
  assert.strictEqual(pub.json.versionNo, v2 + 1);

  // 访客最新年表指向修正版
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, v2 + 1);
});

test('尚无版本时撤回任何版本号 → 404；全部撤回后新版本立即可读', async () => {
  const nf = await call('POST', '/api/editor/versions/1/retract', { body: { reason: 'x' } });
  assert.strictEqual(nf.status, 404);

  // 发布一版再撤回 → 尚无可读版本
  const e1 = await makeEvent('事件甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: '档案' });
  const v1 = await publish([{ eventId: e1, claimId: c1 }], 0);
  await call('POST', `/api/editor/versions/${v1}/retract`, { body: { reason: '唯一一版也有误' } });
  let view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
  assert.strictEqual(view.json.allRetracted, true);

  // 修正后发布新版（基准仍是 v1）→ 访客立即可读新版
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: v1 },
  });
  assert.strictEqual(pub.status, 201);
  view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, true);
  assert.strictEqual(view.json.currentVersionNo, v1 + 1);
});
