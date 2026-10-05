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
const { runDueSchedules } = require('../src/schedule');
const { REDACTED_SOURCE } = require('../src/redact');

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

async function publish(selection, baseVersionNo) {
  const r = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

const SRC = '李宝山口述，2021-07-05 访谈';
const SRC2 = '《县水利志》1994 年版，第 87 页';

// 发两版：v1 两个事件 + 一条带 SRC 的先于关系；v2 再加一个事件
async function setupTwoVersions() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: SRC });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: SRC2 });
  await makeRel(e1, e2, SRC);
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: SRC }); // 同一出处
  await publish(
    [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }],
    1
  );
  return { e1, e2, e3, c1, c2, c3 };
}

test('遮盖接口需要编辑口令；公开接口无需口令', async () => {
  const r1 = await call('POST', '/api/editor/redaction-preview', { token: null, body: { source: 'x' } });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('POST', '/api/editor/redaction', { token: null, body: { source: 'x', currentVersionNo: 0 } });
  assert.strictEqual(r2.status, 401);
});

test('预览：列全全部已发布版本中事件主张与先于关系的命中位置与数量，只读不落库', async () => {
  await setupTwoVersions();
  const r = await call('POST', '/api/editor/redaction-preview', { body: { source: `  ${SRC}  ` } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const p = r.json;
  assert.strictEqual(p.source, SRC); // 返回 trim 后的精确文本
  assert.strictEqual(p.alreadyRedacted, false);
  assert.strictEqual(p.currentVersionNo, 2);
  assert.strictEqual(p.versionCount, 2);
  assert.strictEqual(p.totalEventHitCount, 3); // v1 动员会 1 + v2 动员会、抽水机 2
  assert.strictEqual(p.totalRelationHitCount, 2); // 关系复制进每个版本快照：v1、v2 各 1
  assert.strictEqual(p.totalHitCount, 5);

  const v1 = p.versions.find((v) => v.versionNo === 1);
  assert.strictEqual(v1.eventHitCount, 1);
  assert.strictEqual(v1.eventHits[0].title, '动员会');
  assert.strictEqual(v1.eventHits[0].source, SRC); // 命中附库存原文
  assert.strictEqual(v1.relationHitCount, 1);
  assert.deepStrictEqual(Object.keys(v1.relationHits[0]).sort(),
    ['earlierEventId', 'laterEventId', 'relationId', 'sortOrder', 'source'].sort());
  assert.strictEqual(v1.relationHits[0].source, SRC);
  const v2 = p.versions.find((v) => v.versionNo === 2);
  assert.strictEqual(v2.eventHitCount, 2); // 动员会（沿自 v1）与抽水机
  assert.strictEqual(v2.relationHitCount, 1); // 关系在 v2 快照中同样存在
  assert.strictEqual(v2.eventHits.some((h) => h.title === '抽水机到站'), true);

  // 预览只读：尚未遮盖
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.events.find((e) => e.title === '抽水机到站').source, SRC);
  assert.strictEqual(pub.json.version.relations[0].source, SRC);

  // 未命中文本合计为 0
  const none = await call('POST', '/api/editor/redaction-preview', { body: { source: '不存在的出处' } });
  assert.strictEqual(none.json.totalHitCount, 0);
});

test('空 / 纯空白 / 非字符串文本拒绝（400）', async () => {
  for (const source of ['', '   ', '\t\n']) {
    const r = await call('POST', '/api/editor/redaction-preview', { body: { source } });
    assert.strictEqual(r.status, 400, JSON.stringify(source));
  }
  const r1 = await call('POST', '/api/editor/redaction-preview', { body: { source: 123 } });
  assert.strictEqual(r1.status, 400);
  const missing = await call('POST', '/api/editor/redaction-preview', { body: {} });
  assert.strictEqual(missing.status, 400);
});

test('空文本确认同样 400；currentVersionNo 非法 400', async () => {
  const r1 = await call('POST', '/api/editor/redaction', { body: { source: '   ', currentVersionNo: 0 } });
  assert.strictEqual(r1.status, 400);
  const r2 = await call('POST', '/api/editor/redaction', { body: { source: 123, currentVersionNo: 0 } });
  assert.strictEqual(r2.status, 400);
  const r3 = await call('POST', '/api/editor/redaction', { body: { source: 'x' } });
  assert.strictEqual(r3.status, 400);
});

test('确认后访客读最新年表与历史版本：命中处显示「出处已遮盖」，其余字段与版本号不变', async () => {
  const ids = await setupTwoVersions();
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: preview.json.currentVersionNo, editor: '志愿者小王' },
  });
  assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.json));
  assert.strictEqual(confirm.json.alreadyRedacted, false);
  assert.strictEqual(confirm.json.redactedLabel, REDACTED_SOURCE);
  assert.strictEqual(confirm.json.totalHitCount, 5);

  // 最新年表（v2）
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, 2);
  const v2 = latest.json.version;
  for (const ev of v2.events) {
    if (ev.title === '动员会' || ev.title === '抽水机到站') {
      assert.strictEqual(ev.source, REDACTED_SOURCE);
    } else {
      assert.strictEqual(ev.source, SRC2); // 未命中不变
    }
    // 其余字段不变
    assert.ok(ev.dateLabel && ev.resolvedDate && ev.intervalStart);
  }
  assert.strictEqual(v2.relations[0].source, REDACTED_SOURCE);

  // 指定历史版本 v1
  const old = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(old.status, 200);
  assert.strictEqual(old.json.version.versionNo, 1);
  assert.strictEqual(old.json.version.events[0].source, REDACTED_SOURCE);
  assert.strictEqual(old.json.version.relations[0].source, REDACTED_SOURCE);

  // 快照行在库里未被改写（原文仍在）
  const rawRow = mem.prepare('SELECT source FROM version_events WHERE event_id = ? ORDER BY sort_order').get(ids.e1);
  assert.strictEqual(rawRow.source, SRC);
});

test('持编辑口令查看版本原文仍是原文；草稿状态与恢复预览/恢复草稿均用原文', async () => {
  await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  const raw = await call('GET', '/api/editor/versions/1/raw');
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.json.version.events[0].source, SRC);
  assert.strictEqual(raw.json.version.relations[0].source, SRC);

  // 草稿状态：原文
  const state = await call('GET', '/api/editor/state');
  assert.ok(state.json.events.some((e) => e.claims.some((c) => c.source === SRC)));
  assert.ok(state.json.relations.some((r) => r.source === SRC));

  // 恢复预览：版本部分为原文
  const rp = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(rp.json.version.events[0].source, SRC);
  assert.strictEqual(rp.json.version.relations[0].source, SRC);

  // 确认恢复：重建的草稿仍是原文
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: rp.json.draftRevisionNo,
      currentVersionNo: rp.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  const state2 = await call('GET', '/api/editor/state');
  assert.ok(state2.json.events.every((e) => e.claims.length === 1));
  assert.strictEqual(state2.json.events[0].claims[0].source, SRC);
  assert.strictEqual(state2.json.relations[0].source, SRC);
});

test('以后发布含同一文本的新版本自动遮盖；快照本身仍存原文', async () => {
  const ids = await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  // 草稿里再补一个带 SRC 的主张并发布 v3
  const e4 = await makeEvent('新发现事件');
  const c4 = await makeClaim(e4, { precision: 'year', year: 1963, source: SRC });
  const pub = await publish(
    [
      { eventId: ids.e1, claimId: ids.c1 },
      { eventId: ids.e2, claimId: ids.c2 },
      { eventId: ids.e3, claimId: ids.c3 },
      { eventId: e4, claimId: c4 },
    ],
    2
  );
  assert.strictEqual(pub.versionNo, 3);

  // 发布返回（编辑者视角）是原文
  assert.strictEqual(pub.version.events.find((e) => e.title === '新发现事件').source, SRC);
  // 访客视图自动遮盖
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, 3);
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '新发现事件').source, REDACTED_SOURCE);

  // 快照库存原文
  const row = mem.prepare('SELECT source FROM version_events WHERE event_id = ?').get(e4);
  assert.strictEqual(row.source, SRC);
});

test('预览后发布了新版本，确认报 409 VERSION_CONFLICT 且不落库', async () => {
  const ids = await setupTwoVersions(); // 最新 = 2
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.currentVersionNo, 2);

  // 期间发布 v3（把现有选择重发一版）
  await publish(
    [{ eventId: ids.e1, claimId: ids.c1 }, { eventId: ids.e2, claimId: ids.c2 }, { eventId: ids.e3, claimId: ids.c3 }],
    2
  );

  const stale = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 2 },
  });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(stale.json.currentVersionNo, 3);

  // 未登记：访客仍见原文
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '动员会').source, SRC);

  // 重新预览后确认成功
  const preview2 = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  const ok = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: preview2.json.currentVersionNo },
  });
  assert.strictEqual(ok.status, 200);
  const latest2 = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest2.json.version.events.find((e) => e.title === '动员会').source, REDACTED_SOURCE);
});

test('重复确认幂等：返回已遮盖状态，不重复登记', async () => {
  await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  // 即便携的是过期版本号，重复确认也返回已遮盖状态（幂等优先于冲突）
  const again = await call('POST', '/api/editor/redaction', {
    body: { source: ` ${SRC} `, currentVersionNo: 1 },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyRedacted, true);
  assert.strictEqual(again.json.totalHitCount, 5);

  const n = mem.prepare('SELECT COUNT(*) AS n FROM source_redactions WHERE source_text = ?').get(SRC).n;
  assert.strictEqual(n, 1);

  // 清单接口（编辑者，含原文）
  const list = await call('GET', '/api/editor/redactions');
  assert.strictEqual(list.json.redactions.length, 1);
  assert.strictEqual(list.json.redactions[0].source, SRC);
  assert.strictEqual(list.json.redactions[0].editor, '');
});

test('遮盖不推进草稿修订号（不触碰草稿区）', async () => {
  await setupTwoVersions();
  const before = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });
  const after = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  assert.strictEqual(before, after);
});

test('尚无发布版本也可预览（命中 0）并确认登记；之后发布即自动遮盖', async () => {
  const e1 = await makeEvent('草稿事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: SRC });
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.json.versionCount, 0);
  assert.strictEqual(preview.json.totalHitCount, 0);
  assert.strictEqual(preview.json.draft.claimHitCount, 1); // 草稿命中仅供参考

  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 0 },
  });
  assert.strictEqual(confirm.status, 200);
  assert.strictEqual(confirm.json.currentVersionNo, 0);

  await publish([{ eventId: e1, claimId: c1 }], 0);
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, REDACTED_SOURCE);
});

test('精确匹配：部分包含 / 前后多字的出处不被遮盖', async () => {
  const e1 = await makeEvent('事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: `${SRC}；另见档案第 3 页` });
  await publish([{ eventId: e1, claimId: c1 }], 0);
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.totalEventHitCount, 0);
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, `${SRC}；另见档案第 3 页`);
});

// ============ 本轮修复：出处首尾空白漏匹配 ============
// 手工录入、整理包导入、并行会话保存的出处都可能带首尾空白；编辑者粘贴预览 /
// 确认时通常没有。两侧各自 trim 后严格相等即命中，内部空白与其他文字仍逐字区分。

const WS = ' \t\n'; // 首尾空白（空格 / 制表 / 换行）

test('库存出处带首尾空白：预览按 trim 后文本命中全部已发布版本（事件主张 + 先于关系）', async () => {
  // 主张出处首尾带空白：经整包导入（手工录入会 trim；导入 / 并行会话原样保留）
  const imported = await importEventsWithSources(
    [
      { title: '动员会', precision: 'day', year: 1958, month: 9, day: 12, source: `${WS}${SRC}${WS}` },
      { title: '通水会', precision: 'month', year: 1959, month: 5, source: `\n${SRC2}\n` },
    ],
    [[0, 1, ` ${SRC} `]]
  );
  const e1 = imported[0].eventId;
  const e2 = imported[1].eventId;
  const c1 = imported[0].claimId;
  const c2 = imported[1].claimId;
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  // 编辑者不带空白预览：修复前命中 0（漏报），修复后事件 1 + 关系 1
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.json.source, SRC); // 返回 trim 后的规范文本
  assert.strictEqual(preview.json.totalEventHitCount, 1);
  assert.strictEqual(preview.json.totalRelationHitCount, 1);
  assert.strictEqual(preview.json.totalHitCount, 2);
  // 命中位置附库存原文（首尾空白可见），便于核对实际命中的写法
  const v1 = preview.json.versions[0];
  assert.strictEqual(v1.eventHits[0].source, `${WS}${SRC}${WS}`);
  assert.strictEqual(v1.relationHits[0].source, ` ${SRC} `);
  // 未登记：访客仍见库存原文（预览只读）
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.events.find((e) => e.title === '动员会').source, `${WS}${SRC}${WS}`);

  // 反向：编辑者带首尾空白预览、库存无空白，同样命中
  const preview2 = await call('POST', '/api/editor/redaction-preview', { body: { source: ` ${SRC2} ` } });
  assert.strictEqual(preview2.json.source, SRC2);
  assert.strictEqual(preview2.json.totalEventHitCount, 1);
  assert.strictEqual(preview2.json.versions[0].eventHits[0].source, `\n${SRC2}\n`);

  // 草稿区命中同样按 trim 规则（草稿里 c1 带空白、预览无空白）
  assert.strictEqual(preview.json.draft.claimHitCount, 1);
  assert.strictEqual(preview.json.draft.claimHits[0].source, `${WS}${SRC}${WS}`);
  assert.strictEqual(preview.json.draft.relationHitCount, 1);
});

test('内部空白与其他文字仍逐字精确区分：内部多空格 / 部分包含 / 多字均不命中', async () => {
  // 两事件：一个出处与 SRC 内部完全一致，一个仅内部空格数不同
  const e0 = await makeEvent('基准事件');
  const c0 = await makeClaim(e0, { precision: 'year', year: 2000, source: SRC });
  const e1 = await makeEvent('内双空格事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 2001, source: SRC.replace(' ', '  ') });
  await publish([{ eventId: e0, claimId: c0 }, { eventId: e1, claimId: c1 }], 0);

  // 用 SRC 预览：仅基准事件命中（trim 不触碰内部，双空格不命中）
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.totalEventHitCount, 1);
  assert.strictEqual(preview.json.versions[0].eventHits[0].title, '基准事件');

  // 用内部双空格的文本预览：只命中它自己
  const preview2 = await call('POST', '/api/editor/redaction-preview', {
    body: { source: SRC.replace(' ', '  ') },
  });
  assert.strictEqual(preview2.json.totalEventHitCount, 1);
  assert.strictEqual(preview2.json.versions[0].eventHits[0].title, '内双空格事件');

  // 登记 SRC 后访客视图：双空格变体不被遮盖（其他文字 / 部分包含同理）
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '基准事件').source, REDACTED_SOURCE);
  assert.strictEqual(
    latest.json.version.events.find((e) => e.title === '内双空格事件').source,
    SRC.replace(' ', '  ')
  );
});

// 经整理包导入在草稿中建立带首尾空白出处的事件主张（手工录入会 trim 出处，
// 带空白的主张出处只可能来自整包导入或并行会话提交；关系出处手工录入即原样保留）。
async function importEventsWithSources(entries, relations = []) {
  const batchId = `batch-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bundle = {
    batchId,
    events: entries.map((en, i) => ({
      key: `k${i}`,
      title: en.title,
      claims: [
        {
          precision: en.precision || 'year',
          year: en.year,
          month: en.month,
          day: en.day,
          source: en.source,
        },
      ],
    })),
    relations: relations.map((r, i) => ({
      earlierKey: `k${r[0]}`,
      laterKey: `k${r[1]}`,
      source: r[2],
    })),
  };
  const pv = await call('POST', '/api/editor/import-preview', { body: bundle });
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.json));
  const ci = await call('POST', '/api/editor/import', {
    body: { bundle, fingerprint: pv.json.fingerprint, draftRevisionNo: pv.json.draftRevisionNo },
  });
  assert.strictEqual(ci.status, 201, JSON.stringify(ci.json));
  return ci.json.idMap.events.map((m) => ({ eventId: m.eventId, claimId: m.claimIds[0] }));
}

test('确认登记无空白文本后：库存带首尾空白的出处对访客一致遮盖（历史版 + 最新年表 + 路线 + 附记）', async () => {
  // 主张出处带首尾空白：经整包导入（手工录入会 trim；导入 / 会话原样保留）
  const imported = await importEventsWithSources([
    { title: '动员会', precision: 'day', year: 1958, month: 9, day: 12, source: ` ${SRC} ` },
    { title: '通水会', precision: 'month', year: 1959, month: 5, source: SRC2 },
  ]);
  const e1 = imported[0].eventId;
  const e2 = imported[1].eventId;
  const c1 = imported[0].claimId;
  const c2 = imported[1].claimId;
  // 关系出处带首尾空白：手工录入即原样保留
  const relId = await makeRel(e1, e2, `\t${SRC}\t`);
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  // 对该出处登记一条勘误附记。登记接口按既有规则 trim 出处（兼容行为不变）；
  // 为验证附记读出层对「库存带首尾空白出处」的 trim 匹配，直接在库里补一条
  // 带首尾空白的附记行（与历史数据 / 旁路写入同形）。
  const err = await call('POST', '/api/editor/errata', {
    body: { versionNo: 1, targetType: 'relation', targetId: relId, note: '关系依据存疑', source: SRC },
  });
  assert.strictEqual(err.status, 201, JSON.stringify(err.json));
  mem.prepare('INSERT INTO errata (version_no, target_type, target_id, note, source, editor) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'event', e1, '日期存疑（带空白出处）', ` ${SRC} `, '测试');

  // 建立一条专题路线（两锚点之间有关系链）
  const route = await call('POST', '/api/editor/routes', {
    body: { title: '专题路线', versionNo: 1, anchorEventIds: [e1, e2] },
  });
  assert.strictEqual(route.status, 201, JSON.stringify(route.json));
  const routeNo = route.json.route.routeNo;

  // 编辑者用不带空白的规范文本确认遮盖
  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 1, editor: '志愿者小王' },
  });
  assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.json));
  assert.strictEqual(confirm.json.alreadyRedacted, false);
  assert.strictEqual(confirm.json.totalHitCount, 2, '预览命中事件主张 1 + 先于关系 1');

  // 访客最新年表
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '动员会').source, REDACTED_SOURCE);
  assert.strictEqual(latest.json.version.relations[0].source, REDACTED_SOURCE);
  // 两条勘误附记出处（一条规范、一条库存带首尾空白）同样遮盖
  assert.strictEqual(latest.json.version.errata.length, 2);
  for (const it of latest.json.version.errata) assert.strictEqual(it.source, REDACTED_SOURCE);

  // 访客历史版本
  const old = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(old.json.version.events[0].source, REDACTED_SOURCE);
  assert.strictEqual(old.json.version.relations[0].source, REDACTED_SOURCE);
  assert.strictEqual(old.json.version.errata.length, 2);
  for (const it of old.json.version.errata) assert.strictEqual(it.source, REDACTED_SOURCE);

  // 访客专题路线（命中的事件与关系出处遮盖；未命中的 SRC2 保持原文）
  const pubRoute = await call('GET', `/api/public/routes/${routeNo}`, { token: null });
  assert.strictEqual(pubRoute.status, 200);
  for (const ev of pubRoute.json.route.events) {
    if (ev.eventId === e1) assert.strictEqual(ev.source, REDACTED_SOURCE);
    if (ev.eventId === e2) assert.strictEqual(ev.source, SRC2);
  }
  for (const rel of pubRoute.json.route.relations) assert.strictEqual(rel.source, REDACTED_SOURCE);

  // 快照 / 草稿 / 附记库存原文未改写
  const snapRow = mem.prepare('SELECT source FROM version_events WHERE event_id = ?').get(e1);
  assert.strictEqual(snapRow.source, ` ${SRC} `);
  const relRow = mem.prepare('SELECT source FROM version_relations WHERE relation_id = ?').get(relId);
  assert.strictEqual(relRow.source, `\t${SRC}\t`);

  // 编辑者原文视图：版本原文、路线原文、附记链、草稿、恢复预览均保留原文
  const raw = await call('GET', '/api/editor/versions/1/raw');
  assert.strictEqual(raw.json.version.events[0].source, ` ${SRC} `);
  assert.strictEqual(raw.json.version.relations[0].source, `\t${SRC}\t`);
  // 附记原文不遮盖：库存带首尾空白的那条原样可见
  assert.ok(raw.json.version.errata.some((it) => it.source === ` ${SRC} `));
  assert.ok(raw.json.version.errata.some((it) => it.source === SRC));
  const rawRoute = await call('GET', `/api/editor/routes/${routeNo}/raw`);
  assert.strictEqual(rawRoute.json.route.events.find((e) => e.eventId === e1).source, ` ${SRC} `);
  const state = await call('GET', '/api/editor/state');
  assert.ok(state.json.events.some((e) => e.claims.some((c) => c.source === ` ${SRC} `)));
  assert.ok(state.json.relations.some((r) => r.source === `\t${SRC}\t`));
  const rp = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(rp.json.version.events[0].source, ` ${SRC} `);
});

test('以后发布首尾空白变体的新版本：访客自动遮盖；发布返回（编辑者）仍是原文', async () => {
  const e1 = await makeEvent('事件一');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: SRC });
  await publish([{ eventId: e1, claimId: c1 }], 0);
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });

  // 新主张出处仅首尾空白不同（经整包导入进入草稿，手工录入会 trim）
  const imported = await importEventsWithSources([
    { title: '事件二', precision: 'year', year: 1963, source: `\n ${SRC} \t` },
  ]);
  const e2 = imported[0].eventId;
  const c2 = imported[0].claimId;
  const pub = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 1);
  assert.strictEqual(pub.versionNo, 2);
  // 发布返回为编辑者视角：原文（带空白）
  assert.strictEqual(pub.version.events.find((e) => e.title === '事件二').source, `\n ${SRC} \t`);
  // 访客视图自动遮盖
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, 2);
  for (const ev of latest.json.version.events) assert.strictEqual(ev.source, REDACTED_SOURCE);
  // 库存仍为带空白原文
  const row = mem.prepare('SELECT source FROM version_events WHERE event_id = ?').get(e2);
  assert.strictEqual(row.source, `\n ${SRC} \t`);
});

test('重复确认按 trim 归一空文本：带空白重复提交幂等，不重复登记；冲突优先级不变', async () => {
  // 带首尾空白的主张出处经整包导入进入草稿并发布
  const imported = await importEventsWithSources([
    { title: '事件', precision: 'year', year: 1958, source: ` ${SRC} ` },
  ]);
  const { eventId, claimId } = imported[0];
  await publish([{ eventId, claimId }], 0);
  // 首次用带空白的文本确认（登记的是 trim 后规范文本）
  const first = await call('POST', '/api/editor/redaction', {
    body: { source: ` ${SRC} `, currentVersionNo: 1 },
  });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.json.alreadyRedacted, false);
  assert.strictEqual(first.json.totalHitCount, 1);

  // 不带空白重复确认、且版本号已过期：幂等优先（200 alreadyRedacted）
  const again = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 0 },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyRedacted, true);

  // 库里只有一条规范文本
  const rows = mem.prepare('SELECT source_text AS t FROM source_redactions').all();
  assert.deepStrictEqual(rows.map((r) => r.t), [SRC]);
});

test('整理包导入的首尾空白出处：发布后被既有遮盖登记一致遮盖', async () => {
  const batchId = `batch-ws-${Date.now()}`;
  const bundle = {
    batchId,
    events: [
      {
        key: 'ev1',
        title: '导入事件',
        claims: [{ precision: 'year', year: 1970, source: ` ${SRC} ` }],
      },
    ],
    relations: [],
  };
  const pv = await call('POST', '/api/editor/import-preview', { body: bundle });
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.json));
  const ci = await call('POST', '/api/editor/import', {
    body: { bundle, fingerprint: pv.json.fingerprint, draftRevisionNo: pv.json.draftRevisionNo },
  });
  assert.strictEqual(ci.status, 201, JSON.stringify(ci.json));
  const eventId = ci.json.idMap.events[0].eventId;
  const claimId = ci.json.idMap.events[0].claimIds[0];

  // 草稿命中按 trim 规则
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.draft.claimHitCount, 1);

  await publish([{ eventId, claimId }], 0);
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, REDACTED_SOURCE);
});

test('并行会话提交的首尾空白出处：发布后被既有遮盖登记一致遮盖', async () => {
  const open = await call('POST', '/api/editor/sessions', { body: { editor: '会话编辑甲' } });
  assert.strictEqual(open.status, 201, JSON.stringify(open.json));
  const sid = open.json.session.sessionId;
  const ops = await call('POST', `/api/editor/sessions/${sid}/ops`, {
    body: {
      ops: [
        { op: 'create_event', tempId: 't1', title: '会话事件', description: '' },
        {
          op: 'create_claim',
          tempId: 'c1',
          eventRef: 't1',
          precision: 'year',
          year: 1971,
          source: `\t${SRC}\t`,
          note: '',
        },
      ],
    },
  });
  assert.strictEqual(ops.status, 201, JSON.stringify(ops.json));
  const commit = await call('POST', `/api/editor/sessions/${sid}/commit`, { body: {} });
  assert.strictEqual(commit.status, 200, JSON.stringify(commit.json));
  const mapping = commit.json.idMap.claims.find((m) => m.tempId === 'c1');
  const eventId = commit.json.idMap.events.find((m) => m.tempId === 't1').eventId;

  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.draft.claimHitCount, 1);
  assert.strictEqual(preview.json.draft.claimHits[0].source, `\t${SRC}\t`);

  await publish([{ eventId, claimId: mapping.claimId }], 0);
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, REDACTED_SOURCE);

  // 编辑者草稿原文仍带首尾空白
  const state = await call('GET', '/api/editor/state');
  assert.strictEqual(state.json.events.find((e) => e.id === eventId).claims[0].source, `\t${SRC}\t`);
});

test('预约发布到期生成的版本同样按 trim 规则自动遮盖', async () => {
  const e1 = await makeEvent('预约事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1980, source: ` ${SRC} ` });
  const scheduledAt = new Date(Date.now() + 1500).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sch = await call('POST', '/api/editor/schedules', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }],
      scheduledAt,
      baseVersionNo: 0,
    },
  });
  assert.strictEqual(sch.status, 201, JSON.stringify(sch.json));
  const scheduleNo = sch.json.schedule.scheduleNo;
  // 等待预约确实到期（到期时刻为 +1500ms，留足余量避免定时器提前触发的竞态），再手动补跑
  await new Promise((resolve) => setTimeout(resolve, 1800));
  runDueSchedules();
  const detail = await call('GET', `/api/editor/schedules/${scheduleNo}`);
  assert.strictEqual(detail.json.schedule.status, 'published', JSON.stringify(detail.json.schedule));

  await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 1 },
  });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, REDACTED_SOURCE);
});

test('遮盖登记对以后恢复草稿再发布的快照一致生效（恢复复制带空白原文）', async () => {
  const e1 = await makeEvent('事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: ` ${SRC} ` });
  await publish([{ eventId: e1, claimId: c1 }], 0);
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });

  // 从 v1 恢复草稿，再发布新版本
  const rp = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(rp.status, 200);
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: rp.json.draftRevisionNo,
      currentVersionNo: rp.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  const newEventId = restored.json.pendingSelection[0].eventId;
  const newClaimId = restored.json.pendingSelection[0].claimId;
  await publish([{ eventId: newEventId, claimId: newClaimId }], 1);
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, 2);
  assert.strictEqual(latest.json.version.events[0].source, REDACTED_SOURCE);
});
