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

const { app, scheduler } = require('../src/server');
const { runDueSchedules, nowIsoUtc } = require('../src/schedule');
const { getDb } = require('../src/db');

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
  scheduler.stop();
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM publish_schedules;
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

// 构造一个已发布首版 + 2 个草稿事件（e1,e2 各 1 条主张，e1 先于 e2）的基础场景。
// 返回 { e1, e2, c1, c2, selection, latest }
async function setupDraftWithV1() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');
  const selection = [
    { eventId: e1, claimId: c1 },
    { eventId: e2, claimId: c2 },
  ];
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 0, editor: '甲' },
  });
  assert.strictEqual(pub.status, 201);
  const latest = pub.json.versionNo;
  return { e1, e2, c1, c2, selection, latest };
}

// secondsFromNow(120) -> 未来 120 秒的规范 UTC 串（秒精度）
function secondsFromNow(deltaSec) {
  const d = new Date(Date.now() + deltaSec * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function secondsAgo(deltaSec) {
  return secondsFromNow(-deltaSec);
}

test('预约接口需要编辑口令', async () => {
  const r = await call('GET', '/api/editor/schedules', { token: null });
  assert.strictEqual(r.status, 401);
  const r2 = await call('POST', '/api/editor/schedules', { token: null, body: {} });
  assert.strictEqual(r2.status, 401);
});

test('建立预约：校验通过后冻结内容，未到期访客只见旧版', async () => {
  const { e1, e2, c1, c2, selection, latest } = await setupDraftWithV1();

  const r = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(3600), baseVersionNo: latest, editor: '预约员', note: '定时发第二版' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const s = r.json.schedule;
  assert.strictEqual(s.status, 'pending');
  assert.strictEqual(s.baseVersionNo, latest);
  assert.strictEqual(s.eventCount, 2);
  assert.strictEqual(s.relationCount, 1);
  assert.strictEqual(s.frozen.events[0].resolvedDate, '1958-09-12');
  assert.strictEqual(s.frozen.events[1].resolvedDate, '1959-05-01');
  assert.strictEqual(s.scheduledAt.endsWith('Z'), true);

  // 到期前访客只见旧版
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, latest);
});

test('非法时间格式 / 过去时刻 / 非 UTC 时区 → 400，不建立预约', async () => {
  const { selection, latest } = await setupDraftWithV1();
  const bad = [
    'not-a-time',
    '2026-10-02T12:00',          // 缺 Z
    '2026-10-02T12:00:00+08:00', // 非 UTC
    '2026-13-40T99:99:99Z',      // 越界日期
    secondsAgo(60),              // 过去
  ];
  for (const scheduledAt of bad) {
    const r = await call('POST', '/api/editor/schedules', {
      body: { selection, scheduledAt, baseVersionNo: latest },
    });
    assert.strictEqual(r.status, 400, `时间 ${scheduledAt} 应 400，实际：${JSON.stringify(r.json)}`);
    assert.strictEqual(r.json.code, 'INVALID_SCHEDULED_TIME');
  }
  const list = await call('GET', '/api/editor/schedules');
  assert.strictEqual(list.json.schedules.length, 0);
});

test('草稿未通过发布校验（缺主张 / 无解）→ 422，不建立预约', async () => {
  const e1 = await makeEvent('冬月');
  const e2 = await makeEvent('春月');
  const c1 = await makeClaim(e1, { precision: 'month', year: 1958, month: 12, source: 's1' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1958, month: 1, source: 's2' });
  await makeRel(e1, e2);
  const r = await call('POST', '/api/editor/schedules', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      scheduledAt: secondsFromNow(60),
      baseVersionNo: 0,
    },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.errors[0].type, 'temporal');
  const list = await call('GET', '/api/editor/schedules');
  assert.strictEqual(list.json.schedules.length, 0);
});

test('baseVersionNo 过期 → 409，不建立预约', async () => {
  const { selection } = await setupDraftWithV1(); // 当前最新 = 1
  const r = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: 0 },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(r.json.currentVersionNo, 1);
  const list = await call('GET', '/api/editor/schedules');
  assert.strictEqual(list.json.schedules.length, 0);
});

test('预约后修改草稿不影响冻结内容；到期按冻结内容发布', async () => {
  const { e1, e2, c1, c2, selection, latest } = await setupDraftWithV1();
  const r = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: latest, editor: '预约员' },
  });
  assert.strictEqual(r.status, 201);
  const no = r.json.schedule.scheduleNo;

  // 之后改草稿：改事件标题、加主张、删关系，均不改变预约
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '改过的标题', description: '' } });
  await makeClaim(e1, { precision: 'year', year: 2000, source: '新加的主张' });
  // 恢复草稿同样不影响（这里用删除所有关系代替模拟草稿变动）
  const rels = getDb().prepare('SELECT id FROM relations').all();
  for (const { id } of rels) await call('DELETE', `/api/editor/relations/${id}`);

  // 到期执行
  const out = runDueSchedules(Date.now() + 120 * 1000);
  assert.strictEqual(out.published.length, 1);
  assert.strictEqual(out.published[0].scheduleNo, no);

  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.status, 'published');
  assert.strictEqual(detail.json.schedule.resultVersionNo, latest + 1);

  // 新版本来自冻结内容：旧标题、旧关系、旧求解日期
  const v = await call('GET', `/api/public/versions/${latest + 1}`, { token: null });
  assert.strictEqual(v.json.version.events[0].title, '动员会');
  assert.strictEqual(v.json.version.events[0].resolvedDate, '1958-09-12');
  assert.strictEqual(v.json.version.relations.length, 1);
  assert.strictEqual(v.json.version.relations[0].source, '二人口述一致');

  // 访客最新已切换
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, latest + 1);
});

test('到期时基准版本已落后（期间有即时发布）→ 标 conflict 保留内容，不自动改基准', async () => {
  const { e1, e2, c1, c2, selection, latest } = await setupDraftWithV1();
  const r = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: latest },
  });
  assert.strictEqual(r.status, 201);
  const no = r.json.schedule.scheduleNo;

  // 期间另一次即时发布（内容增加一个事件不现实——直接用同选择再发一版）
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: latest, editor: '插队者', note: '抢先发布' },
  });
  assert.strictEqual(pub.status, 201);
  assert.strictEqual(pub.json.versionNo, latest + 1);

  // 到期
  const out = runDueSchedules(Date.now() + 120 * 1000);
  assert.strictEqual(out.published.length, 0);
  assert.strictEqual(out.conflicts.length, 1);
  assert.strictEqual(out.conflicts[0].scheduleNo, no);
  assert.strictEqual(out.conflicts[0].baseVersionNo, latest);
  assert.strictEqual(out.conflicts[0].currentVersionNo, latest + 1);

  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.status, 'conflict');
  assert.strictEqual(detail.json.schedule.resultVersionNo, null);
  assert.match(detail.json.schedule.resultMessage, /冲突|基准版本号/);
  // 冻结内容保留可查看
  assert.strictEqual(detail.json.schedule.frozen.events.length, 2);
  assert.strictEqual(detail.json.schedule.frozen.relations.length, 1);

  // 最新版本仍是插队者的版本，没有多出一版
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, latest + 1);
});

test('同一时刻多条预约：按预约号顺序，第一条发布后其余冲突', async () => {
  const { selection, latest } = await setupDraftWithV1();
  const at = secondsFromNow(60);
  const a = await call('POST', '/api/editor/schedules', { body: { selection, scheduledAt: at, baseVersionNo: latest, note: '甲' } });
  const b = await call('POST', '/api/editor/schedules', { body: { selection, scheduledAt: at, baseVersionNo: latest, note: '乙' } });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.status, 201);
  assert.ok(b.json.schedule.scheduleNo > a.json.schedule.scheduleNo);

  const out = runDueSchedules(Date.now() + 120 * 1000);
  assert.deepStrictEqual(out.published.map((x) => x.scheduleNo), [a.json.schedule.scheduleNo]);
  assert.deepStrictEqual(out.conflicts.map((x) => x.scheduleNo), [b.json.schedule.scheduleNo]);
  assert.strictEqual(out.published[0].versionNo, latest + 1);
});

test('不同时刻的预约同样按时间顺序处理：先到者发布后，后到者因冻结基准过期而冲突', async () => {
  const { selection, latest } = await setupDraftWithV1();
  const s1 = await call('POST', '/api/editor/schedules', { body: { selection, scheduledAt: secondsFromNow(10), baseVersionNo: latest, note: '先' } });
  const s2 = await call('POST', '/api/editor/schedules', { body: { selection, scheduledAt: secondsFromNow(20), baseVersionNo: latest, note: '后' } });
  assert.strictEqual(s1.status, 201);
  assert.strictEqual(s2.status, 201);
  // 两条预约建立时基准均为 latest（预约未执行不推进版本号）；按时间顺序，
  // 第一条发布后最新版本号推进，第二条冻结的基准过期，按规约标冲突。
  const out = runDueSchedules(Date.now() + 60 * 1000);
  assert.deepStrictEqual(out.published.map((x) => x.scheduleNo), [s1.json.schedule.scheduleNo]);
  assert.deepStrictEqual(out.conflicts.map((x) => x.scheduleNo), [s2.json.schedule.scheduleNo]);
});

test('重复触发 / 重启不重复发布；未到期预约不提前执行', async () => {
  const { selection, latest } = await setupDraftWithV1();
  const s = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(3600), baseVersionNo: latest },
  });
  const no = s.json.schedule.scheduleNo;

  // 尚未到期：任何触发都不发布
  let out = runDueSchedules();
  assert.deepStrictEqual(out.published, []);
  out = runDueSchedules();
  assert.deepStrictEqual(out.published, []);
  let view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, latest);

  // 到期后重复触发，只发布一次
  out = runDueSchedules(Date.now() + 4000 * 1000);
  assert.strictEqual(out.published.length, 1);
  out = runDueSchedules(Date.now() + 5000 * 1000);
  assert.deepStrictEqual(out.published, []);
  out = runDueSchedules(Date.now() + 6000 * 1000);
  assert.deepStrictEqual(out.published, []);

  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.status, 'published');
  view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, latest + 1);
});

test('取消：pending 可取消；已执行不能取消（409）；重复取消幂等；不存在 404', async () => {
  const { selection, latest } = await setupDraftWithV1();
  const s = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(3600), baseVersionNo: latest },
  });
  const no = s.json.schedule.scheduleNo;

  const d = await call('DELETE', `/api/editor/schedules/${no}`);
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.json.cancelled, true);
  assert.strictEqual(d.json.schedule.status, 'cancelled');
  assert.ok(d.json.schedule.cancelledAt);

  // 到期后也不会发布
  const out = runDueSchedules(Date.now() + 4000 * 1000);
  assert.deepStrictEqual(out.published, []);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, latest);

  // 重复取消幂等
  const d2 = await call('DELETE', `/api/editor/schedules/${no}`);
  assert.strictEqual(d2.status, 200);
  assert.strictEqual(d2.json.alreadyCancelled, true);

  // 已生效的预约不能取消
  const s2 = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: latest },
  });
  const no2 = s2.json.schedule.scheduleNo;
  runDueSchedules(Date.now() + 120 * 1000);
  const d3 = await call('DELETE', `/api/editor/schedules/${no2}`);
  assert.strictEqual(d3.status, 409);
  assert.strictEqual(d3.json.code, 'SCHEDULE_NOT_CANCELLABLE');

  const d4 = await call('DELETE', '/api/editor/schedules/9999');
  assert.strictEqual(d4.status, 404);
});

test('调度器自动 tick：到期后无需手动触发即发布（端到端）', async () => {
  scheduler.start({ intervalMs: 50 });
  try {
    const { selection, latest } = await setupDraftWithV1();
    const r = await call('POST', '/api/editor/schedules', {
      body: { selection, scheduledAt: secondsFromNow(1), baseVersionNo: latest },
    });
    assert.strictEqual(r.status, 201);
    // 轮询访客接口，最多 3 秒内看到新版本
    let cur = latest;
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const view = await call('GET', '/api/public/chronicle', { token: null });
      cur = view.json.currentVersionNo;
      if (cur === latest + 1) break;
    }
    assert.strictEqual(cur, latest + 1);
  } finally {
    scheduler.stop();
  }
});

test('重启补跑：停机期间到期的预约在启动补跑时发布，不丢失不重复', async () => {
  const { selection, latest } = await setupDraftWithV1();
  const r = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: latest },
  });
  assert.strictEqual(r.status, 201);
  const no = r.json.schedule.scheduleNo;
  getDb()
    .prepare("UPDATE publish_schedules SET scheduled_at = ? WHERE id = ?")
    .run(nowIsoUtc(Date.now() - 10 * 1000), no);

  // 启动调度器立即补跑
  scheduler.start({ intervalMs: 3_600_000 }); // 超长间隔，确保只靠启动补跑
  try {
    await new Promise((resolve) => setImmediate(resolve)); // start 中 kick 同步执行
    const detail = await call('GET', `/api/editor/schedules/${no}`);
    assert.strictEqual(detail.json.schedule.status, 'published');
    assert.strictEqual(detail.json.schedule.resultVersionNo, latest + 1);
    const view = await call('GET', '/api/public/chronicle', { token: null });
    assert.strictEqual(view.json.currentVersionNo, latest + 1);
  } finally {
    scheduler.stop();
  }
});

test('预约生成的新版本公开读取继续应用出处遮盖，编辑原文视图不遮盖', async () => {
  const { e1, e2, c1, c2, selection, latest } = await setupDraftWithV1();
  // 预约前先登记遮盖其中一条出处
  const red = await call('POST', '/api/editor/redaction', {
    body: { source: '李宝山口述', currentVersionNo: latest, editor: '遮盖员' },
  });
  assert.strictEqual(red.status, 200, JSON.stringify(red.json));

  const r = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: latest },
  });
  const no = r.json.schedule.scheduleNo;
  runDueSchedules(Date.now() + 120 * 1000);

  const newNo = latest + 1;
  // 访客：命中处遮盖
  const v = await call('GET', `/api/public/versions/${newNo}`, { token: null });
  assert.strictEqual(v.json.version.events.find((e) => e.title === '动员会').source, '出处已遮盖');
  assert.strictEqual(v.json.version.events.find((e) => e.title === '通水会').source, '王秀兰口述');
  // 编辑原文视图不遮盖
  const raw = await call('GET', `/api/editor/versions/${newNo}/raw`);
  assert.strictEqual(raw.json.version.events.find((e) => e.title === '动员会').source, '李宝山口述');
  // 预约冻结内容保留原文
  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.frozen.events.find((e) => e.title === '动员会').source, '李宝山口述');
  void c1; void c2; void e1; void e2;
});

test('列表接口：pending 在前并按到期时刻升序；详情 404', async () => {
  const { selection, latest } = await setupDraftWithV1();
  const far = await call('POST', '/api/editor/schedules', { body: { selection, scheduledAt: secondsFromNow(7200), baseVersionNo: latest } });
  const near = await call('POST', '/api/editor/schedules', { body: { selection, scheduledAt: secondsFromNow(60), baseVersionNo: latest } });
  const list = await call('GET', '/api/editor/schedules');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.currentVersionNo, latest);
  assert.strictEqual(list.json.schedules[0].scheduleNo, near.json.schedule.scheduleNo);
  assert.strictEqual(list.json.schedules[1].scheduleNo, far.json.schedule.scheduleNo);
  // 列表项带轻量摘要
  assert.ok(list.json.schedules[0].events[0].title);
  assert.strictEqual(list.json.schedules[0].events[0].resolvedDate, '1958-09-12');

  const d = await call('GET', '/api/editor/schedules/9999');
  assert.strictEqual(d.status, 404);
});
