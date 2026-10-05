'use strict';

// 并行编辑会话 × 从历史版本恢复草稿：
// 恢复会清空草稿并按版本快照重建、重排全部对象编号（旧事件 A 的编号 1 可能被
// 新事件 B 占用）。开启中的会话基线仍指向旧对象，按编号对齐的三方合并会把
// 旧对象的改动写进同编号的新对象。本文件验证：
//   · 跨恢复的未关闭会话提交 → 409 SESSION_MERGE_CONFLICT（restore_rebased），草稿一字未动；
//   · 重复提交保持首次结果（幂等）；已提交会话跨恢复重复提交仍返回首次成功结果；
//   · 恢复后新开的会话照常三方合并；普通并行编辑（无恢复）合并规则不变；
//   · 恢复的编号映射、已发布快照与既有接口契约保持兼容。

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
    DELETE FROM edit_session_ops;
    DELETE FROM edit_sessions;
    DELETE FROM draft_restores;
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
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
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

async function openSession(editor = '甲') {
  const r = await call('POST', '/api/editor/sessions', { body: { editor } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.session;
}

async function stageOps(sessionId, ops, expect = 201) {
  const r = await call('POST', `/api/editor/sessions/${sessionId}/ops`, { body: { ops } });
  assert.strictEqual(r.status, expect, JSON.stringify(r.json));
  return r.json;
}

// 另一编辑者：删除旧事件、新建事件 B 并发布，再从该版恢复草稿（B 重新占用编号 1）
async function deleteCreatePublishRestore({ oldEventId, newTitle, claim, extraSelection = [] }) {
  await call('DELETE', `/api/editor/events/${oldEventId}`);
  const b = await makeEvent(newTitle);
  const cb = await makeClaim(b, claim);
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: b, claimId: cb }, ...extraSelection], baseVersionNo: 0, editor: '乙' },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  const pv = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(pv.status, 200);
  const restored = await call('POST', '/api/editor/restore', {
    body: { versionNo: 1, draftRevisionNo: pv.json.draftRevisionNo, currentVersionNo: pv.json.currentVersionNo },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  return { b, cb, restored: restored.json };
}

test('跨恢复提交：409 SESSION_MERGE_CONFLICT（restore_rebased），描述不会写进占用同编号的新事件', async () => {
  // 甲的会话基线含事件 A（编号 1，描述为空）
  const a = await makeEvent('事件A');
  assert.strictEqual(a, 1);
  const s = await openSession('甲');
  assert.strictEqual(s.baseRestoreNo, 0);
  assert.strictEqual(s.restoredAfterOpen, false);
  // 旧会话只改 A 的描述
  await stageOps(s.sessionId, [{ op: 'update_event', eventId: a, description: '甲改的描述' }]);

  // 乙删除 A、创建 B、发布第 1 版，再从该版恢复草稿：B 重新占用编号 1
  const { restored } = await deleteCreatePublishRestore({
    oldEventId: a,
    newTitle: '事件B',
    claim: { precision: 'year', year: 1958, source: '乙的出处' },
  });
  // 恢复后的编号映射保持既有契约：旧快照 id → 新草稿 id
  assert.deepStrictEqual(restored.idMap.events[0], {
    oldEventId: 2,
    newEventId: 1,
    oldClaimId: 1,
    newClaimId: 1,
  });
  const revAfterRestore = (await getState()).draftRevisionNo;

  // 恢复后、提交前：会话详情即提示对象身份已更替
  const detail = await call('GET', `/api/editor/sessions/${s.sessionId}`);
  assert.strictEqual(detail.json.session.status, 'open');
  assert.strictEqual(detail.json.session.restoredAfterOpen, true);
  const list = await call('GET', '/api/editor/sessions');
  assert.strictEqual(list.json.sessions[0].restoredAfterOpen, true);

  // 提交：整次拒绝，可辨认的冲突原因
  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  assert.strictEqual(r.json.code, 'SESSION_MERGE_CONFLICT');
  assert.strictEqual(r.json.conflicts.length, 1);
  const c = r.json.conflicts[0];
  assert.strictEqual(c.type, 'restore_rebased');
  assert.ok(c.message.includes('恢复'));
  assert.strictEqual(c.restores.length, 1);
  assert.strictEqual(c.restores[0].versionNo, 1);
  assert.strictEqual(c.restores[0].restoreNo, 1);
  assert.ok(r.json.message.includes('恢复'));

  // 草稿一字未动：B 的描述未被写入，修订号未推进
  const st = await getState();
  assert.strictEqual(st.draftRevisionNo, revAfterRestore);
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.events[0].id, 1);
  assert.strictEqual(st.events[0].title, '事件B');
  assert.strictEqual(st.events[0].description, '');

  // 已发布快照与访客年表不受会话提交影响
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.events[0].title, '事件B');

  // 重复提交：保持首次冲突结果（幂等，不重复写入）
  const again = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.json.code, 'SESSION_MERGE_CONFLICT');
  assert.strictEqual(again.json.alreadyConflicted, true);
  assert.deepStrictEqual(again.json.conflicts, r.json.conflicts);
  assert.strictEqual((await getState()).draftRevisionNo, revAfterRestore);

  // 会话已关闭，不能再暂存
  const closed = await call('GET', `/api/editor/sessions/${s.sessionId}`);
  assert.strictEqual(closed.json.session.status, 'conflicted');
  assert.strictEqual(closed.json.session.result.conflicts[0].type, 'restore_rebased');
});

test('空会话跨恢复提交同样整次拒绝（恢复即更替全部对象身份）', async () => {
  const a = await makeEvent('事件A');
  const s = await openSession('甲'); // 不暂存任何操作
  await deleteCreatePublishRestore({
    oldEventId: a,
    newTitle: '事件B',
    claim: { precision: 'year', year: 1958, source: '乙的出处' },
  });
  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'SESSION_MERGE_CONFLICT');
  assert.strictEqual(r.json.conflicts[0].type, 'restore_rebased');
});

test('恢复后新开的会话照常三方合并；普通并行编辑（无恢复）合并规则不变', async () => {
  const a = await makeEvent('事件A');
  // 旧会话先因跨恢复被拒
  const stale = await openSession('甲');
  await stageOps(stale.sessionId, [{ op: 'update_event', eventId: a, description: '旧会话的描述' }]);
  await deleteCreatePublishRestore({
    oldEventId: a,
    newTitle: '事件B',
    claim: { precision: 'year', year: 1958, source: '乙的出处' },
  });
  const rejected = await call('POST', `/api/editor/sessions/${stale.sessionId}/commit`);
  assert.strictEqual(rejected.status, 409);

  // 基于最新草稿重开会话：基线即恢复后的草稿（B 占用编号 1）
  const s2 = await openSession('甲');
  assert.strictEqual(s2.restoredAfterOpen, false);
  assert.strictEqual(s2.baseRestoreNo, 1);
  assert.strictEqual(s2.baseline.events[0].id, 1);
  assert.strictEqual(s2.baseline.events[0].title, '事件B');
  await stageOps(s2.sessionId, [{ op: 'update_event', eventId: 1, description: '甲补充的描述' }]);

  // 对方并行直接改另一字段（无恢复）：不同字段自动合并
  await call('PUT', '/api/editor/events/1', { body: { title: '事件B（乙校订）', description: '' } });
  const ok = await call('POST', `/api/editor/sessions/${s2.sessionId}/commit`);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  const am = ok.json.autoMerged.find((m) => m.objectType === 'event' && m.id === 1);
  assert.deepStrictEqual(am.sessionFields, ['description']);
  assert.deepStrictEqual(am.otherFields, ['title']);
  const st = await getState();
  assert.strictEqual(st.events[0].title, '事件B（乙校订）');
  assert.strictEqual(st.events[0].description, '甲补充的描述');

  // 同字段异值仍整次拒绝（既有规则不变）
  const s3 = await openSession('甲');
  await stageOps(s3.sessionId, [{ op: 'update_event', eventId: 1, title: '甲定稿' }]);
  await call('PUT', '/api/editor/events/1', { body: { title: '乙定稿', description: '甲补充的描述' } });
  const conflict = await call('POST', `/api/editor/sessions/${s3.sessionId}/commit`);
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.json.conflicts[0].type, 'field_conflict');
});

test('已提交会话跨恢复后重复提交保持首次结果，不重复写入', async () => {
  const a = await makeEvent('事件A');
  const s = await openSession('甲');
  await stageOps(s.sessionId, [{ op: 'create_event', tempId: 'x', title: '只应出现一次' }]);
  const first = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.json.alreadyCommitted, false);
  const committedEventId = first.json.idMap.events.find((m) => m.tempId === 'x').eventId;

  // 之后发生恢复（草稿被整体替换；会话提交的事件随第 1 版一起恢复回草稿）
  const cExtra = await makeClaim(committedEventId, { precision: 'year', year: 1960, source: '补出处' });
  await deleteCreatePublishRestore({
    oldEventId: a,
    newTitle: '事件B',
    claim: { precision: 'year', year: 1958, source: '乙的出处' },
    extraSelection: [{ eventId: committedEventId, claimId: cExtra }],
  });
  const revAfterRestore = (await getState()).draftRevisionNo;

  // 重复提交：仍返回首次成功结果（会话已关闭，不受恢复影响）
  const again = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyCommitted, true);
  assert.strictEqual(again.json.revisionNo, first.json.revisionNo);
  assert.deepStrictEqual(again.json.idMap, first.json.idMap);
  // 草稿未因重复提交而变化：恢复后的内容原样保留，会话提交的事件没有被再写一次
  const st = await getState();
  assert.strictEqual(st.draftRevisionNo, revAfterRestore);
  assert.strictEqual(st.events.filter((e) => e.title === '只应出现一次').length, 1);
  assert.strictEqual(st.events.length, 2);
});

test('连续两次恢复：冲突明细列出会话开启后的全部恢复', async () => {
  const a = await makeEvent('事件A');
  const s = await openSession('甲');
  await stageOps(s.sessionId, [{ op: 'update_event', eventId: a, description: '甲改的描述' }]);

  // 第一次：删 A 建 B，发第 1 版并恢复
  await deleteCreatePublishRestore({
    oldEventId: a,
    newTitle: '事件B',
    claim: { precision: 'year', year: 1958, source: '乙的出处' },
  });
  // 第二次：删 B 建 C，发第 2 版并恢复
  await call('DELETE', '/api/editor/events/1');
  const cId = await makeEvent('事件C');
  const cc = await makeClaim(cId, { precision: 'year', year: 1959, source: '丙的出处' });
  const pub2 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: cId, claimId: cc }], baseVersionNo: 1, editor: '丙' },
  });
  assert.strictEqual(pub2.status, 201);
  const pv2 = await call('GET', '/api/editor/restore-preview/2');
  const restored2 = await call('POST', '/api/editor/restore', {
    body: { versionNo: 2, draftRevisionNo: pv2.json.draftRevisionNo, currentVersionNo: pv2.json.currentVersionNo },
  });
  assert.strictEqual(restored2.status, 200);

  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'SESSION_MERGE_CONFLICT');
  const c = r.json.conflicts[0];
  assert.strictEqual(c.type, 'restore_rebased');
  assert.strictEqual(c.restores.length, 2);
  assert.deepStrictEqual(c.restores.map((x) => x.versionNo), [1, 2]);
  // 草稿仍是第二次恢复后的内容
  const st = await getState();
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.events[0].title, '事件C');
  assert.strictEqual(st.events[0].description, '');
});
