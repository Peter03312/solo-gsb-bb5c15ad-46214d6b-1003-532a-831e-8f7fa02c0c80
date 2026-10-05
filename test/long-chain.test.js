'use strict';

// 长链草稿（逐日相接的数千事件 + 逐条「先于」关系）端到端测试：
// 校验、即时发布、预约建立三个入口对同一草稿得出一致结果；
// 失败（成环 / 时间无解）按各入口既有结构反馈，且不写入版本或预约。

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
const { runDueSchedules } = require('../src/schedule');

const TOKEN = 'test-token';
const CHAIN_LEN = 6000;
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

// 直接在库中铺一条 n 个事件的逐日相接长链（事件 i 先于事件 i+1），
// 每个事件一条日精度主张，区间统一为 1950-01-01 ~ 1990-12-31（可解）。
// 返回 selection（每事件选中其唯一主张）。
function seedChain(n) {
  const insE = mem.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  const insC = mem.prepare(
    `INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
     VALUES (?, 'day', 1958, 1, 1, '1958 年 01 月 01 日', '1950-01-01', '1990-12-31', ?, '')`
  );
  const insR = mem.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');
  const selection = [];
  mem.transaction(() => {
    for (let i = 1; i <= n; i++) {
      const eventId = insE.run(`长链事件${i}`, '').lastInsertRowid;
      const claimId = insC.run(eventId, `口述记录第${i}册`).lastInsertRowid;
      selection.push({ eventId: Number(eventId), claimId: Number(claimId) });
      if (i > 1) insR.run(i - 1, i, '逐日衔接', '');
    }
  })();
  return selection;
}

function countRows(table) {
  return mem.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test('长链草稿：校验 / 即时发布 / 预约建立结果一致，失败不写版本或预约', async () => {
  // ---- 1) 6000 事件长链：校验通过，逐日严格 +1、均在区间内 ----
  const selection = seedChain(CHAIN_LEN);
  const v1 = await call('POST', '/api/editor/validate', { body: { selection } });
  assert.strictEqual(v1.status, 200);
  assert.strictEqual(v1.json.ok, true, JSON.stringify(v1.json).slice(0, 300));
  assert.strictEqual(v1.json.preview.length, CHAIN_LEN);
  const previewDates = new Map(v1.json.preview.map((p) => [p.eventId, p]));
  for (let i = 1; i <= CHAIN_LEN; i++) {
    const p = previewDates.get(i);
    assert.ok(p.intervalStart <= p.resolvedDate && p.resolvedDate <= p.intervalEnd, `事件 ${i} 求解日期应在区间内`);
    if (i > 1) {
      assert.ok(previewDates.get(i).resolvedDate > previewDates.get(i - 1).resolvedDate, `事件 ${i} 应严格晚于前一事件`);
    }
  }
  assert.strictEqual(previewDates.get(1).resolvedDate, '1950-01-01');
  assert.strictEqual(previewDates.get(CHAIN_LEN).resolvedDate, '1966-06-05');

  // ---- 2) 即时发布第 1 版：求解日期与校验预览逐事件一致 ----
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 0, editor: '长链测试', note: '长链首版' },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json).slice(0, 300));
  assert.strictEqual(pub.json.versionNo, 1);
  assert.strictEqual(pub.json.version.events.length, CHAIN_LEN);
  assert.strictEqual(pub.json.version.relations.length, CHAIN_LEN - 1);
  for (const e of pub.json.version.events) {
    assert.strictEqual(e.resolvedDate, previewDates.get(e.eventId).resolvedDate, `事件 ${e.eventId} 发布日期应与校验一致`);
  }

  // ---- 3) 建立预约：冻结的求解日期与校验、即时发布一致 ----
  const sch = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: '2099-01-01T00:00:00Z', baseVersionNo: 1, editor: '长链测试' },
  });
  assert.strictEqual(sch.status, 201, JSON.stringify(sch.json).slice(0, 300));
  const scheduleNo = sch.json.schedule.scheduleNo;
  assert.strictEqual(sch.json.schedule.status, 'pending');
  assert.strictEqual(sch.json.schedule.frozen.events.length, CHAIN_LEN);
  for (const e of sch.json.schedule.frozen.events) {
    assert.strictEqual(e.resolvedDate, previewDates.get(e.eventId).resolvedDate, `事件 ${e.eventId} 预约冻结日期应与校验一致`);
  }

  // ---- 4) 预约到期执行：生成的第 2 版与即时发布的第 1 版逐日一致 ----
  const out = runDueSchedules(Date.UTC(2099, 0, 2));
  assert.deepStrictEqual(out.published, [{ scheduleNo, versionNo: 2 }]);
  const schDetail = await call('GET', `/api/editor/schedules/${scheduleNo}`);
  assert.strictEqual(schDetail.json.schedule.status, 'published');
  assert.strictEqual(schDetail.json.schedule.resultVersionNo, 2);

  const ver1 = await call('GET', '/api/public/versions/1', { token: null });
  const ver2 = await call('GET', '/api/public/versions/2', { token: null });
  assert.strictEqual(ver1.status, 200);
  assert.strictEqual(ver2.status, 200);
  const d1 = ver1.json.version.events.map((e) => `${e.eventId}:${e.resolvedDate}`);
  const d2 = ver2.json.version.events.map((e) => `${e.eventId}:${e.resolvedDate}`);
  assert.deepStrictEqual(d2, d1, '预约发布版本应与即时发布版本逐事件同日期');

  const pubView = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pubView.json.currentVersionNo, 2);
  assert.strictEqual(pubView.json.version.events.length, CHAIN_LEN);

  // ---- 5) 同一草稿变为时间无解：三入口一致报 temporal，且不写版本或预约 ----
  mem.prepare(
    `UPDATE claims SET interval_start = '1950-01-01', interval_end = '1950-06-30', date_label = '1950 年上半年'
     WHERE event_id = ?`
  ).run(CHAIN_LEN);

  let versionsBefore = countRows('versions');
  let schedulesBefore = countRows('publish_schedules');

  const vBad = await call('POST', '/api/editor/validate', { body: { selection } });
  assert.strictEqual(vBad.status, 200);
  assert.strictEqual(vBad.json.ok, false);
  assert.strictEqual(vBad.json.errors[0].type, 'temporal');
  assert.strictEqual(vBad.json.errors[0].eventIds.length, CHAIN_LEN);
  assert.strictEqual(vBad.json.errors[0].relationIds.length, CHAIN_LEN - 1);

  const pubBad = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 2, editor: '长链测试' },
  });
  assert.strictEqual(pubBad.status, 422);
  assert.strictEqual(pubBad.json.errors[0].type, 'temporal');
  assert.deepStrictEqual(pubBad.json.errors[0].eventIds, vBad.json.errors[0].eventIds);
  assert.deepStrictEqual(pubBad.json.errors[0].relationIds, vBad.json.errors[0].relationIds);

  const schBad = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: '2099-01-01T00:00:00Z', baseVersionNo: 2 },
  });
  assert.strictEqual(schBad.status, 422);
  assert.strictEqual(schBad.json.errors[0].type, 'temporal');
  assert.deepStrictEqual(schBad.json.errors[0].eventIds, vBad.json.errors[0].eventIds);
  assert.deepStrictEqual(schBad.json.errors[0].relationIds, vBad.json.errors[0].relationIds);

  assert.strictEqual(countRows('versions'), versionsBefore, '时间无解不得写入新版本');
  assert.strictEqual(countRows('publish_schedules'), schedulesBefore, '时间无解不得建立预约');
  const stillV2 = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(stillV2.json.currentVersionNo, 2);

  // ---- 6) 同一草稿成环：三入口一致报 cycle，且不写版本或预约 ----
  mem.prepare(
    `UPDATE claims SET interval_start = '1950-01-01', interval_end = '1990-12-31', date_label = '1958 年 01 月 01 日'
     WHERE event_id = ?`
  ).run(CHAIN_LEN);
  mem.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, 1, ?, ?)').run(CHAIN_LEN, '回边出处', '');

  versionsBefore = countRows('versions');
  schedulesBefore = countRows('publish_schedules');

  const vCyc = await call('POST', '/api/editor/validate', { body: { selection } });
  assert.strictEqual(vCyc.json.ok, false);
  assert.strictEqual(vCyc.json.errors[0].type, 'cycle');
  assert.strictEqual(vCyc.json.errors[0].eventIds.length, CHAIN_LEN);

  const pubCyc = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 2, editor: '长链测试' },
  });
  assert.strictEqual(pubCyc.status, 422);
  assert.strictEqual(pubCyc.json.errors[0].type, 'cycle');
  assert.deepStrictEqual(pubCyc.json.errors[0].eventIds, vCyc.json.errors[0].eventIds);
  assert.deepStrictEqual(pubCyc.json.errors[0].relationIds, vCyc.json.errors[0].relationIds);

  const schCyc = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: '2099-01-01T00:00:00Z', baseVersionNo: 2 },
  });
  assert.strictEqual(schCyc.status, 422);
  assert.strictEqual(schCyc.json.errors[0].type, 'cycle');
  assert.deepStrictEqual(schCyc.json.errors[0].eventIds, vCyc.json.errors[0].eventIds);

  assert.strictEqual(countRows('versions'), versionsBefore, '成环不得写入新版本');
  assert.strictEqual(countRows('publish_schedules'), schedulesBefore, '成环不得建立预约');
});
