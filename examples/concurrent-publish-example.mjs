#!/usr/bin/env node
'use strict';

// 两个服务进程共用同一数据库时，并发调用「即时发布 / 建立预约」的端到端示例。
//
// 背景：生产上可能起两个 node src/server.js 进程（容器副本 / 双机热备）共用同一个
// SQLite 文件（better-sqlite3 + WAL）。即时发布与建立预约都是「先分次读草稿、求解，
// 再进写事务」的长操作；本轮修复前，另一进程若在读取之间一次性改动事件与主张，
// 可能冻结从未同时存在过的混合内容，预约还会把旧快照记为新修订号。
//
// 本脚本自动拉起两个共享同一 DB_PATH 的服务进程（端口不同），只通过编辑者 HTTP API
// 操作，演示修复后的两类并发裁决：
//
//   场景一：版本冲突（既有语义 VERSION_CONFLICT）
//     甲、乙两个进程同时基于同一最新版本号发布：抢得写锁者生成新版本，
//     另一方在写事务内发现最新版本号已推进 → 409，绝不静默覆盖。
//
//   场景二：草稿冲突（本轮新增 DRAFT_REVISION_CONFLICT）
//     甲进程正在发布 / 建预约（事件 / 所选主张 / 关系 / 求解日期 / 修订号已在同一
//     快照读出、正在求解，尚未进入写事务），乙进程在此窗口内改动草稿并提交。
//     甲进入写事务复核草稿修订号时发现已变 → 409 草稿冲突，整次取消：
//     不冻结混合内容、不生成版本或预约。甲刷新草稿、重新确认选择后重试成功。
//
// 依赖：仅 Node >= 20（内置 fetch 与 child_process）；脚本结束自动关掉两个服务并删临时库。
//
// 用法：
//   node examples/concurrent-publish-example.mjs
//   可选：N=8000（长链规模，越大场景二的求解窗口越宽）、PORT_A=4101 PORT_B=4102、
//         KEEP=1（结束时保留临时数据库与服务，便于人工复查）。

import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.env.N || 8000);
const PORT_A = Number(process.env.PORT_A || 4101);
const PORT_B = Number(process.env.PORT_B || 4102);
const TOKEN = 'example-token';
const KEEP = process.env.KEEP === '1';
const TS = Date.now();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-cc-'));
const dbPath = path.join(tmpDir, 'shared.db');

const H_A = { 'Content-Type': 'application/json', 'X-Editor-Token': TOKEN };

const say = (t) => console.log(`\n\x1b[1;36m== ${t} ==\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);

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

async function latestNo(base) {
  const r = await fetch(base + '/api/public/versions');
  if (!r.ok) throw new Error(`读取版本列表失败：${r.status}`);
  return (await r.json()).currentVersionNo;
}

function isoFromOrdinal(ord) {
  return new Date(ord * 86400000).toISOString().slice(0, 10);
}

// 经整理包导入（import-preview → import）分批铺 N 个逐日相接事件的长链。
async function seedChain(base) {
  const BATCH = 1000;
  const pairs = [];
  const batches = Math.ceil(N / BATCH);
  for (let b = 0; b < batches; b++) {
    const lo = b * BATCH + 1;
    const hi = Math.min(lo + BATCH - 1, N);
    const events = [];
    for (let i = lo; i <= hi; i++) {
      const ord = Math.floor(Date.UTC(1950, 0, 1) / 86400000) + i - 1;
      const [y, m, d] = isoFromOrdinal(ord).split('-').map(Number);
      events.push({
        key: `cc-${TS}-e${i}`,
        title: `并发示例第${i}日 ${TS}`,
        claims: [{ precision: 'day', year: y, month: m, day: d, source: `并发示例口述第${i}册 ${TS}` }],
      });
    }
    const relations = [];
    for (let i = lo; i < hi; i++) {
      relations.push({ earlierKey: `cc-${TS}-e${i}`, laterKey: `cc-${TS}-e${i + 1}`, source: '逐日衔接' });
    }
    const bundle = { batchId: `cc-${TS}-b${lo}`, events, relations };
    const preview = await call(base, 'POST', '/api/editor/import-preview', bundle);
    if (preview.status !== 200 || !preview.json.ok) {
      throw new Error(`导入预览失败：${JSON.stringify(preview.json).slice(0, 300)}`);
    }
    const done = await call(base, 'POST', '/api/editor/import', {
      bundle,
      fingerprint: preview.json.fingerprint,
      draftRevisionNo: preview.json.draftRevisionNo,
    });
    if (done.status !== 201 || !done.json.ok) {
      throw new Error(`导入确认失败：${JSON.stringify(done.json).slice(0, 300)}`);
    }
    for (const e of done.json.idMap.events) pairs.push([e.eventId, e.claimIds[0]]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < batches; k++) {
    const r = await call(base, 'POST', '/api/editor/relations', {
      earlierId: pairs[k * BATCH - 1][0],
      laterId: pairs[k * BATCH][0],
      source: '跨批衔接',
    });
    if (r.status !== 201) throw new Error(`跨批衔接失败：${r.status}`);
  }
  return pairs.map(([eventId, claimId]) => ({ eventId, claimId }));
}

function describe(tag, r) {
  if (r.status === 201 && r.json.ok) {
    const what = r.json.versionNo ? `生成第 ${r.json.versionNo} 版` : `建立预约 #${r.json.schedule?.scheduleNo}`;
    return `${tag} 201 ${what}`;
  }
  return `${tag} ${r.status} ${r.json.code || ''} ${r.json.message || ''}`;
}

// 场景一：两个进程同时发布同一 selection（同一 baseVersionNo）。
async function scenarioVersionConflict(baseA, baseB, selection) {
  say('场景一：进程 A / B 同时即时发布（同一 baseVersionNo）→ 一成一 409 VERSION_CONFLICT');
  const base = await latestNo(baseA);
  info(`当前最新版本号 = ${base}，同时向两个进程发发布请求…`);
  const [ra, rb] = await Promise.all([
    call(baseA, 'POST', '/api/editor/publish', { selection, baseVersionNo: base, editor: '进程甲' }),
    call(baseB, 'POST', '/api/editor/publish', { selection, baseVersionNo: base, editor: '进程乙' }),
  ]);
  info('  ' + describe('A：', ra));
  info('  ' + describe('B：', rb));
  const codes = [ra.status, rb.status].sort((x, y) => x - y).join(',');
  if (codes !== '201,409') throw new Error(`期望 201 + 409，实际 ${codes}`);
  const loser = ra.status === 409 ? ra.json : rb.json;
  if (loser.code !== 'VERSION_CONFLICT') throw new Error(`失败方应为 VERSION_CONFLICT，实际 ${loser.code}`);
  ok(`失败方 currentVersionNo=${loser.currentVersionNo}、baseVersionNo=${loser.baseVersionNo}，未静默覆盖`);
}

// 取全量草稿 selection（每事件选其最后一条主张）+ 当前版本号
async function fullSelection(base) {
  const s = await call(base, 'GET', '/api/editor/state');
  const events = s.json.events;
  const selection = events.map((e) => {
    if (!e.claims.length) throw new Error('存在无主张事件');
    return { eventId: e.id, claimId: e.claims[e.claims.length - 1].id };
  });
  return { events, selection, base: s.json.currentVersionNo, rev: s.json.draftRevisionNo };
}

// 场景二：A 发布 / 建预约的「读快照—求解」窗口内，B 提交一次草稿改动。
// 跨进程才可能在此窗口交错（单进程内 better-sqlite3 同步执行，HTTP 请求互不插入）。
async function scenarioDraftConflict(baseA, baseB, kind) {
  const endpoint = kind === 'schedule' ? '/api/editor/schedules' : '/api/editor/publish';
  const label = kind === 'schedule' ? '建立预约' : '即时发布';
  say(`场景二：A 进程${label}的求解窗口内，B 进程改草稿 → 409 DRAFT_REVISION_CONFLICT`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const futureUtc = () => new Date(Date.now() + 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // 阶梯延迟逐轮尝试撞窗口：太早（B 先于 A 读快照提交）或太晚（A 已提交）A 都会成功，
  // 只有 B 的提交落在 A 的快照读出与写事务复核之间才返回草稿冲突。
  // 注意：未撞上的轮次 A 会真的生成版本（正常行为），所以每轮按版本号增量判断，
  // 撞上的那一轮必须恰好「零新增版本 / 预约」。
  const delays = [0, 5, 15, 30, 60, 120, 240];
  let conflict = null;
  for (let attempt = 0; attempt < delays.length && !conflict; attempt++) {
    const { events, selection, base } = await fullSelection(baseA);
    const targetId = events[0].id;
    const versionBefore = await latestNo(baseA);
    const schedBefore = (await call(baseA, 'GET', '/api/editor/schedules')).json.schedules.length;
    const reqA = call(baseA, 'POST', endpoint, kind === 'schedule'
      ? { selection, scheduledAt: futureUtc(), baseVersionNo: base, editor: '进程甲', note: '并发示例-预约' }
      : { selection, baseVersionNo: base, editor: '进程甲', note: '并发示例-发布' });
    await sleep(delays[attempt]);
    const reqB = call(baseB, 'PUT', `/api/editor/events/${targetId}`, {
      title: `B 进程在并发窗口改的标题 ${TS}-${attempt}`,
      description: '',
    });
    const [ra, rb] = await Promise.all([reqA, reqB]);
    if (rb.status !== 200) throw new Error(`B 改草稿失败：${rb.status} ${JSON.stringify(rb.json)}`);
    const versionAfter = await latestNo(baseA);
    const schedAfter = (await call(baseA, 'GET', '/api/editor/schedules')).json.schedules.length;
    if (ra.status === 409 && ra.json.code === 'DRAFT_REVISION_CONFLICT') {
      conflict = ra.json;
      info(`  第 ${attempt + 1} 轮（B 延迟 ${delays[attempt]}ms）撞上窗口：`);
      if (kind === 'schedule') {
        if (schedAfter !== schedBefore) throw new Error('草稿冲突这一轮不应新增预约');
        if (versionAfter !== versionBefore) throw new Error('草稿冲突这一轮不应生成版本');
      } else if (versionAfter !== versionBefore) {
        throw new Error('草稿冲突这一轮不应生成版本');
      }
    } else if (ra.status === 201) {
      info(`  第 ${attempt + 1} 轮（延迟 ${delays[attempt]}ms）未撞上，A 已成功，下轮再试…`);
    } else {
      throw new Error(`A 出现非预期响应：${ra.status} ${JSON.stringify(ra.json).slice(0, 300)}`);
    }
  }
  if (!conflict) throw new Error('多轮都未撞上求解窗口，可用更大的 N 重试（如 N=20000）');

  info(`  草稿修订号 ${conflict.expectedRevisionNo} → ${conflict.currentRevisionNo}`);
  info(`  ${conflict.message}`);
  ok(`撞窗口的这一轮零新增${kind === 'schedule' ? '预约或版本' : '版本'}，整次取消`);

  // A 刷新草稿、重新确认选择后重试 → 成功
  const { selection: fresh, base: freshBase } = await fullSelection(baseA);
  const retry = await call(baseA, 'POST', endpoint, kind === 'schedule'
    ? { selection: fresh, scheduledAt: futureUtc(), baseVersionNo: freshBase, editor: '进程甲', note: '并发示例-重试预约' }
    : { selection: fresh, baseVersionNo: freshBase, editor: '进程甲', note: '并发示例-重试发布' });
  if (retry.status !== 201) throw new Error(`重试应 201：${retry.status} ${JSON.stringify(retry.json).slice(0, 300)}`);
  ok('A 刷新草稿重新确认选择后重试 → 201 成功');
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
    ok('两个进程均已就绪（共用 DB_PATH，WAL 模式）');

    // 口令仍由各自进程校验
    const denied = await fetch(baseA + '/api/editor/state', { headers: { 'X-Editor-Token': 'wrong' } });
    if (denied.status !== 401) throw new Error('编辑者口令校验异常');
    ok('编辑者 HTTP API 保持原有口令校验（错误口令 401）');

    say(`铺草稿：经整理包导入 ${N} 个逐日相接事件（拉长求解窗口）`);
    const selection = await seedChain(baseA);
    info(`草稿就绪：${selection.length} 事件 / ${selection.length - 1} 条先于关系；最新版本号 ${await latestNo(baseA)}`);

    await scenarioVersionConflict(baseA, baseB, selection);
    await scenarioDraftConflict(baseA, baseB, 'publish');
    await scenarioDraftConflict(baseA, baseB, 'schedule');

    say('全部裁决符合预期：版本冲突保持原语义；草稿冲突整次取消，不冻结混合内容');
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
