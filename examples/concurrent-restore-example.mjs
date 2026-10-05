#!/usr/bin/env node
'use strict';

// 两个服务进程共用同一数据库时，「从历史版本恢复草稿」预览 / 确认的并发端到端示例。
//
// 背景：生产上可能起两个 node src/server.js 进程（容器副本 / 双机热备）共用同一个
// SQLite 文件（better-sqlite3 + WAL）。本轮修复前，恢复预览对「将被替换的草稿」
// 「草稿修订号」「最新版本号」分次独立 SELECT（各自取最新 WAL 快照）：另一进程若在
// 读草稿与读修订号之间写入事件 / 主张 / 关系（或发布新版本），预览可能展示旧草稿
// 内容却返回新修订号 / 新版本号，随后确认按新号校验通过，会把预览里从未展示过的
// 改动随清空一并删除。
//
// 本脚本自动拉起两个共享同一 DB_PATH 的服务进程（端口不同），只通过编辑者
// HTTP API 操作，演示修复后的四个并发场景（请求 / 响应字段保持兼容）：
//
//   场景一：预览后、确认前，另一进程改动草稿
//     → 确认得到既有 409 DRAFT_REVISION_CONFLICT（含 currentRevisionNo），整次不改库；
//       重新预览后再确认 → 200 成功，草稿整体替换为目标版（每事件仅被选主张），
//       历史快照与访客年表不变。
//
//   场景二：预览后、确认前，另一进程发布新版本
//     → 确认得到既有 409 VERSION_CONFLICT（含 currentVersionNo），草稿与版本均不动；
//       重新预览后再确认 → 200 成功。
//
//   场景三：另一进程持续写草稿期间反复预览（预览读窗口本身的一致性）
//     每轮严格按「A 预览 → B 写入（新事件 + 主张）→ A 再预览」交错：后一次预览的
//     draftRevisionNo 必须恰好 +2、currentDraft 必须包含刚写入的事件；预览自身
//     绝不写库（修订号不随预览推进）。修复前这里会出现「旧草稿内容配新修订号」。
//
//   场景四：目标版已被撤回仍可恢复
//     撤回只影响访客视图：预览 200（响应附 retraction）、确认 200，恢复仅复制
//     该版被选主张；访客最新年表仍指向撤回前的最新未撤回版。
//
// 依赖：仅 Node >= 20（内置 fetch 与 child_process）；脚本结束自动关掉两个服务并删临时库。
//
// 用法：
//   node examples/concurrent-restore-example.mjs
//   可选：ROUNDS=12（场景三交错轮数）、PORT_A=4201 PORT_B=4202、
//         KEEP=1（结束时保留临时数据库与服务，便于人工复查）。

import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = Number(process.env.ROUNDS || 12);
const PORT_A = Number(process.env.PORT_A || 4201);
const PORT_B = Number(process.env.PORT_B || 4202);
const TOKEN = 'example-token';
const KEEP = process.env.KEEP === '1';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-restore-cc-'));
const dbPath = path.join(tmpDir, 'shared.db');

const say = (t) => console.log(`\n\x1b[1;36m== ${t} ==\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
const req = (m) => console.log(`  \x1b[2m→ ${m}\x1b[0m`);

async function call(base, method, url, body, token = TOKEN) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Editor-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      EDITOR_TOKEN: TOKEN,
      SCHEDULE_TICK_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function waitReady(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/public/chronicle');
      if (r.ok) return;
    } catch {
      /* 尚未监听 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`服务 ${base} 在 ${timeoutMs}ms 内未就绪`);
}

async function addEvent(base, title, claim, description = '') {
  const e = await call(base, 'POST', '/api/editor/events', { title, description });
  if (e.status !== 201) throw new Error(`建事件失败：${e.status} ${JSON.stringify(e.json)}`);
  const c = await call(base, 'POST', `/api/editor/events/${e.json.event.id}/claims`, {
    precision: claim.precision,
    year: claim.year,
    month: claim.month,
    day: claim.day,
    source: claim.source,
    note: claim.note || '',
  });
  if (c.status !== 201) throw new Error(`建主张失败：${c.status} ${JSON.stringify(c.json)}`);
  return { eventId: e.json.event.id, claimId: c.json.claim.id };
}

async function addRelation(base, earlierId, laterId, source) {
  const r = await call(base, 'POST', '/api/editor/relations', { earlierId, laterId, source });
  if (r.status !== 201) throw new Error(`建关系失败：${r.status} ${JSON.stringify(r.json)}`);
  return r.json.relation.id;
}

async function publish(base, selection, baseVersionNo, editor, note = '') {
  const r = await call(base, 'POST', '/api/editor/publish', { selection, baseVersionNo, editor, note });
  if (r.status !== 201) throw new Error(`发布失败：${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

// 当前草稿全量选择（每事件取其唯一 / 最后一条主张）
async function fullSelection(base) {
  const s = await call(base, 'GET', '/api/editor/state');
  if (s.status !== 200) throw new Error('读取草稿失败');
  return {
    selection: s.json.events.map((ev) => ({ eventId: ev.id, claimId: ev.claims[ev.claims.length - 1].id })),
    base: s.json.currentVersionNo,
    revision: s.json.draftRevisionNo,
    events: s.json.events,
  };
}

async function preview(base, no) {
  const r = await call(base, 'GET', `/api/editor/restore-preview/${no}`);
  if (r.status !== 200) throw new Error(`预览失败：${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function confirm(base, p) {
  // 确认字段与预览返回一一对应：versionNo / draftRevisionNo / currentVersionNo
  return call(base, 'POST', '/api/editor/restore', {
    versionNo: p.versionNo,
    draftRevisionNo: p.draftRevisionNo,
    currentVersionNo: p.currentVersionNo,
  });
}

async function publicChronicle(baseB) {
  const r = await call(baseB, 'GET', '/api/public/chronicle', undefined, null);
  return r.json;
}

async function main() {
  say(`启动两个共享同一数据库的服务进程：A=:${PORT_A}  B=:${PORT_B}\n     库文件 ${dbPath}`);
  const serverA = startServer(PORT_A);
  const serverB = startServer(PORT_B);
  const baseA = `http://127.0.0.1:${PORT_A}`;
  const baseB = `http://127.0.0.1:${PORT_B}`;
  let exitCode = 0;
  try {
    await waitReady(baseA);
    await waitReady(baseB);
    ok('两个进程均已就绪（共用 DB_PATH，WAL 模式）；恢复接口沿用 X-Editor-Token 口令');

    // ---------- 铺底：发布第 1 版（动员会 先于 通水会），再发布第 2 版（多一个事件） ----------
    say('铺底：进程 A 发布第 1 版、第 2 版（恢复目标为第 1 版）');
    const e1 = await addEvent(baseA, '动员会', { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' }, '晒谷场开会');
    const e2 = await addEvent(baseA, '通水会', { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
    await addRelation(baseA, e1.eventId, e2.eventId, '二人口述一致');
    await publish(baseA, [{ eventId: e1.eventId, claimId: e1.claimId }, { eventId: e2.eventId, claimId: e2.claimId }], 0, '甲', '首版');
    const e3 = await addEvent(baseA, '抽水机到站', { precision: 'year', year: 1962, source: '张德福口述' });
    await addRelation(baseA, e2.eventId, e3.eventId, '先有水渠后有抽水机');
    {
      const { selection } = await fullSelection(baseA);
      await publish(baseA, selection, 1, '乙', '再发一版');
    }
    ok('当前最新版本号 = 2；草稿含 3 事件，恢复目标为第 1 版（2 事件）');

    // ---------- 场景一：预览后草稿被另一进程改动 → 409，重新预览后成功 ----------
    say('场景一：A 预览第 1 版后，B 改动草稿；A 确认 → 409 DRAFT_REVISION_CONFLICT，整次不改库');
    let p = await preview(baseA, 1);
    req(`GET  A /api/editor/restore-preview/1 => draftRevisionNo=${p.draftRevisionNo}, currentVersionNo=${p.currentVersionNo}, 预览草稿 ${p.currentDraft.counts.eventCount} 事件`);
    const sneaky = await call(baseB, 'PUT', `/api/editor/events/${e1.eventId}`, { title: '动员会（B 进程改的标题）', description: '晒谷场开会' });
    if (sneaky.status !== 200) throw new Error('B 改草稿失败');
    info(`B 已改草稿：PUT /api/editor/events/${e1.eventId}（修订号推进）`);
    let r = await confirm(baseA, p);
    info(`POST A /api/editor/restore => ${r.status} ${r.json.code}：${r.json.message}`);
    if (r.status !== 409 || r.json.code !== 'DRAFT_REVISION_CONFLICT') throw new Error('期望 409 DRAFT_REVISION_CONFLICT');
    ok(`冲突返回 currentRevisionNo=${r.json.currentRevisionNo}（预览值 ${r.json.expectedRevisionNo}），B 的改动仍在草稿中`);
    {
      const st = await call(baseA, 'GET', '/api/editor/state');
      if (st.json.events.length !== 3 || st.json.events[0].title !== '动员会（B 进程改的标题）') {
        throw new Error('409 应整次不改库：B 的标题与 3 个事件都应保留');
      }
      ok('整次不改库：草稿仍是 3 事件且保留 B 改后的标题');
    }

    p = await preview(baseA, 1);
    r = await confirm(baseA, p);
    info(`重新预览后 POST /api/editor/restore => ${r.status}，新修订号 ${r.json.revisionNo}`);
    if (r.status !== 200) throw new Error(`重新预览后应成功：${JSON.stringify(r.json)}`);
    if (r.json.draft.counts.eventCount !== 2 || r.json.draft.counts.claimCount !== 2) {
      throw new Error('成功后草稿应为 2 事件 2 主张（每事件仅被选主张）');
    }
    ok('恢复成功：草稿 2 事件 / 每事件仅 1 条当版被选主张；返回 idMap 与 pendingSelection');
    {
      const view = await publicChronicle(baseB);
      if (view.currentVersionNo !== 2 || view.version.eventCount !== 3) {
        throw new Error('访客年表应仍是第 2 版（3 事件）');
      }
      ok('历史快照与访客视图不变：访客最新年表仍是第 2 版（3 事件）');
    }

    // ---------- 场景二：预览后另一进程发布新版本 → 409 VERSION_CONFLICT ----------
    say('场景二：A 预览后，B 发布新版本；A 确认 → 409 VERSION_CONFLICT，重新预览后成功');
    {
      const { selection } = await fullSelection(baseA); // 恢复后的 2 事件
      await publish(baseA, selection, 2, '甲', '恢复后发第 3 版');
      ok('A 先以最新版本号 2 为基准发布第 3 版');
    }
    p = await preview(baseA, 1);
    req(`A 预览第 1 版：draftRevisionNo=${p.draftRevisionNo}, currentVersionNo=${p.currentVersionNo}`);
    {
      const { selection } = await fullSelection(baseB);
      await publish(baseB, selection, 3, 'B 进程', '抢先发布第 4 版');
      info('B 以基准 3 抢先发布第 4 版（最新版本号推进到 4）');
    }
    r = await confirm(baseA, p);
    info(`A 用旧预览确认 => ${r.status} ${r.json.code}：${r.json.message}`);
    if (r.status !== 409 || r.json.code !== 'VERSION_CONFLICT' || r.json.currentVersionNo !== 4) {
      throw new Error(`期望 409 VERSION_CONFLICT 且 currentVersionNo=4，实际 ${r.status} ${r.json.code}`);
    }
    {
      const st = await call(baseA, 'GET', '/api/editor/state');
      if (st.json.events.length !== 2) throw new Error('版本冲突时草稿不应被改动');
      ok('整次不改库：草稿仍 2 事件，第 3、4 版快照都在');
    }
    p = await preview(baseA, 1);
    r = await confirm(baseA, p);
    if (r.status !== 200) throw new Error(`重新预览后应成功：${JSON.stringify(r.json)}`);
    ok(`重新预览（currentVersionNo=${p.currentVersionNo}）后确认 → 200，最新版本号仍为 ${r.json.currentVersionNo}`);

    // ---------- 场景三：B 持续写草稿，A 严格交错预览：每次预览内容与修订号必须同源 ----------
    say(`场景三：「A 预览 → B 写入（事件+主张，修订号 +2）→ A 再预览」严格交错 ${ROUNDS} 轮`);
    {
      let last = await preview(baseA, 1);
      for (let i = 1; i <= ROUNDS; i++) {
        const title = `并发窗口事件 ${i}`;
        const added = await addEvent(baseB, title, { precision: 'year', year: 1970 + i, source: `窗口出处 ${i}` });
        const now = await preview(baseA, 1);
        // 关键不变式：预览展示的草稿内容与其返回的修订号必须对应同一数据库状态
        if (now.draftRevisionNo !== last.draftRevisionNo + 2) {
          throw new Error(`第 ${i} 轮：修订号应 +2（事件与主张各一），实际 ${last.draftRevisionNo} → ${now.draftRevisionNo}`);
        }
        if (now.currentDraft.counts.eventCount !== last.currentDraft.counts.eventCount + 1) {
          throw new Error(`第 ${i} 轮：预览草稿事件数应 +1，出现新旧混合内容`);
        }
        if (!now.currentDraft.events.some((ev) => ev.id === added.eventId && ev.title === title)) {
          throw new Error(`第 ${i} 轮：预览草稿必须包含 B 刚写入的事件 ${title}（修订号与内容同源）`);
        }
        if (now.currentVersionNo !== 4) throw new Error('期间无人发布，最新版本号应保持 4');
        last = now;
      }
      // 对照 state：最后一次预览与 state 同修订号时，内容必须逐项一致
      const st = await call(baseA, 'GET', '/api/editor/state');
      if (st.json.draftRevisionNo !== last.draftRevisionNo) throw new Error('对照 state 修订号不一致');
      if (st.json.events.length !== last.currentDraft.counts.eventCount) {
        throw new Error('同修订号下预览草稿与 /state 事件数不一致');
      }
      ok(`每轮预览都整体一致：修订号 ${last.draftRevisionNo - ROUNDS * 2} → ${last.draftRevisionNo}，草稿 ${last.currentDraft.counts.eventCount} 事件；预览自身不写库`);
    }

    // ---------- 场景四：已撤回版本仍可恢复；访客视图不变 ----------
    say('场景四：A 发布第 5 版并撤回，仍可从第 5 版恢复草稿（访客只见第 4 版）');
    {
      const { selection, base } = await fullSelection(baseA);
      const pub = await publish(baseA, selection, base, '甲', '待撤回的一版');
      const no = pub.versionNo; // 5
      const ret = await call(baseA, 'POST', `/api/editor/versions/${no}/retract`, { reason: '编年依据错误，撤回整版', editor: '甲' });
      if (ret.status !== 200) throw new Error(`撤回失败：${JSON.stringify(ret.json)}`);
      info(`第 ${no} 版已撤回（只追加审计记录，快照不动）`);

      const pv = await call(baseA, 'GET', `/api/editor/restore-preview/${no}`);
      if (pv.status !== 200 || !pv.json.retraction) throw new Error('撤回版预览仍应 200 且附 retraction');
      ok(`撤回版预览 200：retraction.reason = ${JSON.stringify(pv.json.retraction.reason)}，currentVersionNo=${pv.json.currentVersionNo}`);
      const done = await call(baseA, 'POST', '/api/editor/restore', {
        versionNo: pv.json.versionNo,
        draftRevisionNo: pv.json.draftRevisionNo,
        currentVersionNo: pv.json.currentVersionNo,
      });
      if (done.status !== 200) throw new Error(`撤回版应可恢复：${done.status} ${JSON.stringify(done.json)}`);
      ok(`从撤回版恢复成功：草稿 ${done.json.draft.counts.eventCount} 事件 / ${done.json.draft.counts.claimCount} 主张（仅被选主张）`);

      const view = await publicChronicle(baseB);
      if (view.currentVersionNo !== 4) throw new Error(`访客最新年表应仍为第 4 版，实际 ${view.currentVersionNo}`);
      const raw = await call(baseA, 'GET', `/api/editor/versions/${no}/raw`);
      if (raw.status !== 200) throw new Error('编辑者应仍可读撤回版原文');
      ok(`访客年表仍指向第 4 版；第 ${no} 版快照原文与编号保留（编辑者 raw 可读）`);
    }

    say('全部并发裁决符合预期：预览四值同源且只读；确认沿用 409/404 语义，冲突整次不改库；撤回版可恢复');
    if (KEEP) info(`KEEP=1：服务仍在运行（A=${baseA} B=${baseB}），临时库保留在 ${tmpDir}`);
  } catch (err) {
    console.error('\x1b[31m示例失败：\x1b[0m', err.message);
    exitCode = 1;
  } finally {
    if (!KEEP) {
      serverA.kill('SIGTERM');
      serverB.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  process.exit(exitCode);
}

main();
