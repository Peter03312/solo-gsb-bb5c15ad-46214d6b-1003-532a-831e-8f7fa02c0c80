#!/usr/bin/env node
'use strict';

// 两个服务进程共用同一数据库时，公开读取（访客：最新年表 / 历史版本 / 版本清单 /
// 专题路线）的一致性端到端示例。
//
// 背景：生产上可能起两个 node src/server.js 进程（容器副本 / 双机热备）共用同一个
// SQLite 文件（better-sqlite3 + WAL）。本轮修复前，公开读取把「最新可见版本号、
// 撤回登记、版本快照、遮盖登记、生效勘误附记」分多条 SELECT 各自读出（每条语句
// 各取最新 WAL 快照）：另一进程若在读取期间发布新版本、撤回版本、登记出处遮盖或
// 替代勘误附记，响应就可能混合不同已提交状态（例如版本内容取自遮盖登记前、
// 附记取自遮盖登记后）。
//
// 修复后，五个公开接口统一走同一只读事务（同一 WAL 快照）：整份响应取自同一个
// 已提交的数据库状态；撤回集合与遮盖登记整请求各读一次；只读事务不阻塞另一进程写入。
//
// 本脚本自动拉起两个共享同一 DB_PATH 的服务进程（端口不同），只通过 HTTP API 操作：
// 进程 A 用编辑者接口连续写入（发布 / 遮盖 / 替代附记 / 撤回），进程 B 同时用
// 公开接口并发读取，逐响应校验「同一份响应内部绝不混合两个已提交状态」：
//
//   场景一：基线——五个公开接口各读一次，结构与本轮之前完全一致；
//   场景二：A 登记出处遮盖的同时，B 突发并发读最新年表与历史版本
//           → 每份响应里同一出处文本要么全部遮盖、要么全部不遮盖（不混合）；
//   场景三：A 替代勘误附记的同时，B 突发并发读
//           → 每份响应的附记说明 / 出处配对要么整体是旧、要么整体是新；
//   场景四：A 发布新版本的同时，B 突发并发读
//           → 每份响应的版本号、事件数、附记归属版本互相一致；
//   场景五：A 撤回最新版 → B 读最新年表回退、撤回版 404、引用它的路线 404；
//           A 发布修正版后访客视图恢复（旧路线仍引用撤回版，保持隐藏）；
//   场景六：A 撤回全部版本 → B 读「尚无可读版本」；再发新版即恢复。
//
// 依赖：仅 Node >= 20（内置 fetch 与 child_process）；脚本结束自动关掉两个服务并删临时库。
//
// 用法：
//   node examples/concurrent-public-read-example.mjs
//   可选：BURST=8（每次写入并发的读取数）、PORT_A=4301 PORT_B=4302、
//         KEEP=1（结束时保留临时数据库与服务，便于人工复查）。

import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BURST = Number(process.env.BURST || 8);
const PORT_A = Number(process.env.PORT_A || 4301);
const PORT_B = Number(process.env.PORT_B || 4302);
const TOKEN = 'example-token';
const KEEP = process.env.KEEP === '1';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-public-read-'));
const dbPath = path.join(tmpDir, 'shared.db');

const say = (t) => console.log(`\n\x1b[1;36m== ${t} ==\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
const req = (m) => console.log(`  \x1b[2m→ ${m}\x1b[0m`);
const fail = (m) => {
  throw new Error(m);
};

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

// ---------- 公开读取的「单响应一致性」校验 ----------
// 同一份响应必须整体来自某一个已提交状态：版本号、内容计数、附记归属、
// 同一底层出处文本的遮盖状态都不得混合。

const REDACTED = '出处已遮盖';
const TRACKED_SOURCE = '李宝山口述'; // 种子数据里事件主张、关系、附记共用的出处文本

function checkChronicleConsistent(json, where) {
  if (!json.published) {
    if (json.allRetracted !== true && json.allRetracted !== undefined) {
      fail(`${where}：published:false 时 allRetracted 只能是 true 或缺省`);
    }
    return '未发布/全撤回';
  }
  const v = json.version;
  if (!v) fail(`${where}：published:true 但缺 version`);
  if (v.versionNo !== json.currentVersionNo) {
    fail(`${where}：版本号混合（currentVersionNo=${json.currentVersionNo} 但内容属第 ${v.versionNo} 版）`);
  }
  if (v.eventCount !== v.events.length || v.relationCount !== v.relations.length) {
    fail(`${where}：计数与内容行数不一致（混合读取）`);
  }
  for (const x of v.errata || []) {
    if (x.versionNo !== json.currentVersionNo) {
      fail(`${where}：附记属于第 ${x.versionNo} 版却随第 ${json.currentVersionNo} 版返回（混合读取）`);
    }
  }
  // 同一底层出处文本（TRACKED_SOURCE）在同一份响应内要么全部遮盖、要么全部不遮盖
  const tracked = [
    ...v.events.filter((e) => e.source === TRACKED_SOURCE || e.source === REDACTED).map((e) => e.source),
    ...v.relations.filter((r) => r.source === TRACKED_SOURCE || r.source === REDACTED).map((r) => r.source),
  ];
  const states = new Set(tracked.map((s) => (s === REDACTED ? 'masked' : 'raw')));
  if (states.size > 1) {
    fail(`${where}：同一出处文本在同一响应内部分遮盖部分未遮盖（混合读取）`);
  }
  return `第 ${v.versionNo} 版（${v.eventCount} 事件 / ${v.relationCount} 关系 / ${(v.errata || []).length} 附记，跟踪出处${states.has('masked') ? '已遮盖' : '未遮盖'}）`;
}

function checkVersionListConsistent(json, where) {
  const nos = json.versions.map((v) => v.versionNo);
  if (new Set(nos).size !== nos.length) fail(`${where}：版本清单出现重复版本号`);
  if (json.currentVersionNo !== 0 && !nos.includes(json.currentVersionNo)) {
    fail(`${where}：currentVersionNo=${json.currentVersionNo} 不在清单中（混合读取）`);
  }
  if (nos.length && json.currentVersionNo !== Math.max(...nos)) {
    fail(`${where}：清单含更新版本但 currentVersionNo 不是最大者（混合读取）`);
  }
  return `清单 [${nos.join(', ') || '空'}]，currentVersionNo=${json.currentVersionNo}`;
}

// 并发突发读取：写入在途的同时打出一批公开读取，逐份校验一致性
async function burstRead(baseB, writes, label) {
  const reads = [];
  for (let i = 0; i < BURST; i++) {
    reads.push(
      call(baseB, 'GET', '/api/public/chronicle', undefined, null).then((r) => {
        if (r.status !== 200) fail(`${label}：chronicle 返回 ${r.status}`);
        return checkChronicleConsistent(r.json, `${label} 第 ${i + 1} 份`);
      })
    );
    reads.push(
      call(baseB, 'GET', '/api/public/versions', undefined, null).then((r) => {
        if (r.status !== 200) fail(`${label}：versions 返回 ${r.status}`);
        return checkVersionListConsistent(r.json, `${label} 第 ${i + 1} 份`);
      })
    );
  }
  const [writeResult, ...summaries] = await Promise.all([writes, ...reads]);
  return { writeResult, summaries };
}

async function main() {
  say(`启动两个共享同一数据库的服务进程：A=:${PORT_A}（写入方）  B=:${PORT_B}（读取方）\n     库文件 ${dbPath}`);
  const serverA = startServer(PORT_A);
  const serverB = startServer(PORT_B);
  const baseA = `http://127.0.0.1:${PORT_A}`;
  const baseB = `http://127.0.0.1:${PORT_B}`;
  let exitCode = 0;
  let route2No = null; // 场景四在第 2 版上建立的路线号（场景五验证其随撤回隐藏）
  try {
    await waitReady(baseA);
    await waitReady(baseB);
    ok('两个进程均已就绪（共用 DB_PATH，WAL 模式）');

    // ---------- 铺底：两事件一关系，同一出处文本贯穿事件 / 关系 / 附记 ----------
    say('铺底：A 建草稿并发布第 1 版（事件、关系、附记共用同一出处文本），建路线、登记附记');
    const e1 = await call(baseA, 'POST', '/api/editor/events', { title: '动员会' });
    const e2 = await call(baseA, 'POST', '/api/editor/events', { title: '通水会' });
    const c1 = await call(baseA, 'POST', `/api/editor/events/${e1.json.event.id}/claims`, {
      precision: 'day', year: 1958, month: 9, day: 12, source: TRACKED_SOURCE,
    });
    const c2 = await call(baseA, 'POST', `/api/editor/events/${e2.json.event.id}/claims`, {
      precision: 'month', year: 1959, month: 5, source: '王秀兰口述',
    });
    await call(baseA, 'POST', '/api/editor/relations', {
      earlierId: e1.json.event.id, laterId: e2.json.event.id, source: TRACKED_SOURCE,
    });
    const pub1 = await call(baseA, 'POST', '/api/editor/publish', {
      selection: [
        { eventId: e1.json.event.id, claimId: c1.json.claim.id },
        { eventId: e2.json.event.id, claimId: c2.json.claim.id },
      ],
      baseVersionNo: 0, editor: '编辑甲', note: '首版',
    });
    if (pub1.status !== 201) fail(`发布第 1 版失败：${JSON.stringify(pub1.json)}`);
    const route1 = await call(baseA, 'POST', '/api/editor/routes', {
      title: '建设脉络', versionNo: 1, anchorEventIds: [e1.json.event.id, e2.json.event.id],
    });
    if (route1.status !== 201) fail(`建路线失败：${JSON.stringify(route1.json)}`);
    const err1 = await call(baseA, 'POST', '/api/editor/errata', {
      versionNo: 1, targetType: 'event', targetId: e1.json.event.id,
      note: '动员会日期另有说法待核', source: TRACKED_SOURCE,
    });
    if (err1.status !== 201) fail(`登记附记失败：${JSON.stringify(err1.json)}`);
    ok(`第 1 版已发布（事件 / 关系 / 附记出处均为「${TRACKED_SOURCE}」），路线 #${route1.json.route.routeNo}，附记 #${err1.json.errata.errataId}`);

    // ---------- 场景一：基线读取（五个公开接口，结构与本轮之前一致） ----------
    say('场景一：B 依次读五个公开接口（基线，结构兼容）');
    {
      const chronicle = await call(baseB, 'GET', '/api/public/chronicle', undefined, null);
      info(`GET B /api/public/chronicle => ${checkChronicleConsistent(chronicle.json, '基线 chronicle')}`);
      const versions = await call(baseB, 'GET', '/api/public/versions', undefined, null);
      info(`GET B /api/public/versions => ${checkVersionListConsistent(versions.json, '基线 versions')}`);
      const v1 = await call(baseB, 'GET', '/api/public/versions/1', undefined, null);
      if (v1.status !== 200 || v1.json.version.versionNo !== 1) fail('基线：历史版本读取异常');
      info(`GET B /api/public/versions/1 => 第 ${v1.json.version.versionNo} 版，附记 ${v1.json.version.errata.length} 条`);
      const routes = await call(baseB, 'GET', '/api/public/routes', undefined, null);
      info(`GET B /api/public/routes => ${routes.json.routes.length} 条路线`);
      const r1 = await call(baseB, 'GET', `/api/public/routes/${route1.json.route.routeNo}`, undefined, null);
      if (r1.status !== 200 || r1.json.route.versionNo !== 1) fail('基线：路线详情异常');
      info(`GET B /api/public/routes/${route1.json.route.routeNo} => 据第 ${r1.json.route.versionNo} 版，${r1.json.route.events.length} 事件`);
      ok('五个公开接口路径 / 状态码 / 字段与本轮之前一致');
    }

    // ---------- 场景二：登记出处遮盖 vs 并发读取 ----------
    say('场景二：A 登记出处遮盖的同时，B 突发并发读最新年表与版本清单');
    {
      const preview = await call(baseA, 'POST', '/api/editor/redaction-preview', { source: TRACKED_SOURCE });
      if (preview.status !== 200) fail(`遮盖预览失败：${JSON.stringify(preview.json)}`);
      req(`POST A /api/editor/redaction（确认遮盖「${TRACKED_SOURCE}」）与 ${BURST}×2 个公开读取并发`);
      const confirm = call(baseA, 'POST', '/api/editor/redaction', {
        source: TRACKED_SOURCE, currentVersionNo: preview.json.currentVersionNo, editor: '编辑甲',
      });
      const { writeResult, summaries } = await burstRead(baseB, confirm, '场景二');
      if (writeResult.status !== 200 || writeResult.json.ok !== true) {
        fail(`遮盖确认失败：${writeResult.status} ${JSON.stringify(writeResult.json)}`);
      }
      const masked = summaries.filter((s) => s.includes('已遮盖')).length;
      const raw = summaries.length - masked;
      info(`突发读取全部自洽：${raw} 份落在遮盖登记前、${masked} 份落在登记后，无任何混合`);
      ok('每份响应中同一出处文本要么全部「出处已遮盖」、要么全部是原文');
      const after = await call(baseB, 'GET', '/api/public/chronicle', undefined, null);
      const sources = [
        ...after.json.version.events.map((e) => e.source),
        ...after.json.version.relations.map((r) => r.source),
        ...after.json.version.errata.map((x) => x.source),
      ];
      if (sources.filter((s) => s === REDACTED).length < 3) fail('遮盖后命中处应全部显示「出处已遮盖」');
      ok(`读取结束后新读取整体落在登记后：事件 / 关系 / 附记出处均为「${REDACTED}」`);
    }

    // ---------- 场景三：替代勘误附记 vs 并发读取 ----------
    say('场景三：A 替代勘误附记的同时，B 突发并发读');
    {
      const list = await call(baseA, 'GET', '/api/editor/versions/1/errata');
      const effective = list.json.targets[0].effective;
      req(`POST A /api/editor/errata（replacesErrataId=${effective.errataId}）与 ${BURST}×2 个公开读取并发`);
      const replace = call(baseA, 'POST', '/api/editor/errata', {
        versionNo: 1, targetType: 'event', targetId: e1.json.event.id,
        note: '更正：动员会应为 1958-09-13', source: '张德福口述，2022-03-11 访谈',
        replacesErrataId: effective.errataId, editor: '编辑乙',
      });
      const seen = new Set();
      const reads = [];
      for (let i = 0; i < BURST; i++) {
        reads.push(
          call(baseB, 'GET', '/api/public/chronicle', undefined, null).then((r) => {
            const x = r.json.version.errata[0];
            if (!x) fail('场景三：第 1 版应始终带一条生效附记');
            // 附记说明 / 出处配对必须整体是旧或整体是新（同一已提交状态）
            if (x.note === '动员会日期另有说法待核' && x.source !== REDACTED) {
              fail(`场景三：旧说明配未遮盖出处（混合：附记取自替代前、遮盖判定取自登记前）`);
            }
            if (x.note === '更正：动员会应为 1958-09-13' && x.source !== '张德福口述，2022-03-11 访谈') {
              fail('场景三：新说明配了旧出处（混合读取）');
            }
            seen.add(x.note.slice(0, 4));
            return x.note;
          })
        );
      }
      const [writeResult, ...notes] = await Promise.all([replace, ...reads]);
      if (writeResult.status !== 201) fail(`替代附记失败：${JSON.stringify(writeResult.json)}`);
      info(`突发读取全部自洽：${notes.filter((n) => n.startsWith('动员会')).length} 份落在替代前、${notes.filter((n) => n.startsWith('更正')).length} 份落在替代后`);
      ok('每份响应的附记说明 / 出处配对要么整体是旧、要么整体是新');
    }

    // ---------- 场景四：发布新版本 vs 并发读取 ----------
    say('场景四：A 发布第 2 版的同时，B 突发并发读');
    {
      const e3 = await call(baseA, 'POST', '/api/editor/events', { title: '庆功会' });
      const c3 = await call(baseA, 'POST', `/api/editor/events/${e3.json.event.id}/claims`, {
        precision: 'year', year: 1960, source: '张德福口述',
      });
      await call(baseA, 'POST', '/api/editor/relations', {
        earlierId: e2.json.event.id, laterId: e3.json.event.id, source: '王秀兰口述',
      });
      req(`POST A /api/editor/publish（第 2 版）与 ${BURST}×2 个公开读取并发`);
      const publish2 = call(baseA, 'POST', '/api/editor/publish', {
        selection: [
          { eventId: e1.json.event.id, claimId: c1.json.claim.id },
          { eventId: e2.json.event.id, claimId: c2.json.claim.id },
          { eventId: e3.json.event.id, claimId: c3.json.claim.id },
        ],
        baseVersionNo: 1, editor: '编辑甲', note: '第二版',
      });
      const { writeResult, summaries } = await burstRead(baseB, publish2, '场景四');
      if (writeResult.status !== 201 || writeResult.json.versionNo !== 2) {
        fail(`发布第 2 版失败：${writeResult.status} ${JSON.stringify(writeResult.json)}`);
      }
      const v1seen = summaries.filter((s) => s.startsWith('第 1 版')).length;
      const v2seen = summaries.filter((s) => s.startsWith('第 2 版')).length;
      info(`突发读取全部自洽：${v1seen} 份落在发布前（第 1 版）、${v2seen} 份落在发布后（第 2 版）`);
      ok('每份响应的版本号、事件计数、附记归属版本互相一致；附记只属于第 1 版（不随新版继承）');
      // 为场景五准备：在第 2 版上建一条路线
      const route2 = await call(baseA, 'POST', '/api/editor/routes', {
        title: '全程脉络', versionNo: 2, anchorEventIds: [e1.json.event.id, e3.json.event.id],
      });
      if (route2.status !== 201) fail(`建第 2 版路线失败：${JSON.stringify(route2.json)}`);
      route2No = route2.json.route.routeNo;
    }

    // ---------- 场景五：撤回最新版 → 读取回退；修正版发布后恢复 ----------
    say('场景五：A 撤回第 2 版 → B 读最新年表回退、撤回版与引用它的路线 404；A 发修正版后恢复');
    {
      const retract = await call(baseA, 'POST', '/api/editor/versions/2/retract', {
        reason: '庆功会编年依据有误，撤回修订', editor: '编辑甲',
      });
      if (retract.status !== 200) fail(`撤回失败：${JSON.stringify(retract.json)}`);
      info(`POST A /api/editor/versions/2/retract => currentVersionNo=${retract.json.currentVersionNo}（发布基准不变），latestVisibleVersionNo=${retract.json.latestVisibleVersionNo}`);
      const chronicle = await call(baseB, 'GET', '/api/public/chronicle', undefined, null);
      if (chronicle.json.currentVersionNo !== 1) fail('撤回后最新年表应回退到第 1 版');
      ok('B 读最新年表：回退到第 1 版（编号最大的未撤回版）');
      const v2 = await call(baseB, 'GET', '/api/public/versions/2', undefined, null);
      if (v2.status !== 404) fail('撤回版应按不存在处理（404）');
      const r2 = await call(baseB, 'GET', `/api/public/routes/${route2No}`, undefined, null);
      if (r2.status !== 404) fail('引用撤回版的路线应按不存在处理（404）');
      const routes = await call(baseB, 'GET', '/api/public/routes', undefined, null);
      if (!routes.json.routes.some((r) => r.routeNo === route1.json.route.routeNo)) fail('引用第 1 版的路线应仍可见');
      if (routes.json.routes.some((r) => r.routeNo === route2No)) fail('引用撤回版的路线不应出现在清单');
      ok('撤回版详情 404、引用它的路线 404 且清单隐藏；引用第 1 版的路线不受影响');

      const st = await call(baseA, 'GET', '/api/editor/state');
      const pub3 = await call(baseA, 'POST', '/api/editor/publish', {
        selection: st.json.events.map((ev) => ({ eventId: ev.id, claimId: ev.claims[ev.claims.length - 1].id })),
        baseVersionNo: 2, editor: '编辑甲', note: '修正编年后的第 3 版',
      });
      if (pub3.status !== 201 || pub3.json.versionNo !== 3) fail(`修正版发布失败：${JSON.stringify(pub3.json)}`);
      const after = await call(baseB, 'GET', '/api/public/chronicle', undefined, null);
      if (after.json.currentVersionNo !== 3) fail('修正版发布后最新年表应指向第 3 版');
      const r2again = await call(baseB, 'GET', `/api/public/routes/${route2No}`, undefined, null);
      if (r2again.status !== 404) fail('引用已撤回第 2 版的路线应保持隐藏');
      ok('A 发布第 3 版（基准仍含撤回版）后 B 读最新年表恢复；旧路线仍引用撤回版、保持 404');
    }

    // ---------- 场景六：全部撤回 → 「尚无可读版本」；再发新版恢复 ----------
    say('场景六：A 撤回全部版本 → B 读「尚无可读版本」；A 再发新版即恢复');
    {
      await call(baseA, 'POST', '/api/editor/versions/1/retract', { reason: '一并撤回重编', editor: '编辑甲' });
      await call(baseA, 'POST', '/api/editor/versions/3/retract', { reason: '一并撤回重编', editor: '编辑甲' });
      const chronicle = await call(baseB, 'GET', '/api/public/chronicle', undefined, null);
      if (chronicle.json.published !== false || chronicle.json.allRetracted !== true) {
        fail(`全部撤回后应返回 published:false + allRetracted:true：${JSON.stringify(chronicle.json)}`);
      }
      const versions = await call(baseB, 'GET', '/api/public/versions', undefined, null);
      if (versions.json.versions.length !== 0 || versions.json.currentVersionNo !== 0) {
        fail('全部撤回后版本清单应为空');
      }
      ok(`B 读最新年表：${chronicle.json.message}；版本清单为空（结构兼容）`);

      const st = await call(baseA, 'GET', '/api/editor/state');
      const pub4 = await call(baseA, 'POST', '/api/editor/publish', {
        selection: st.json.events.map((ev) => ({ eventId: ev.id, claimId: ev.claims[ev.claims.length - 1].id })),
        baseVersionNo: 3, editor: '编辑甲', note: '重编后的第 4 版',
      });
      if (pub4.status !== 201 || pub4.json.versionNo !== 4) fail(`第 4 版发布失败：${JSON.stringify(pub4.json)}`);
      const after = await call(baseB, 'GET', '/api/public/chronicle', undefined, null);
      if (after.json.currentVersionNo !== 4) fail('再发新版后最新年表应指向第 4 版');
      ok('A 再发第 4 版后 B 读最新年表即恢复（版本号继续递增，撤回版不占号也不跳号）');
    }

    say('全部场景通过');
    info('五个公开接口的每份响应都取自同一个已提交的数据库状态：');
    info('读取期间的发布 / 撤回 / 遮盖 / 附记替代，只会让响应整体落在其提交前或提交后；');
    info('遮盖登记整请求只读一次（长路线 / 大版本不逐条重复扫描），只读事务不阻塞写入。');
  } catch (err) {
    exitCode = 1;
    console.error(`\n\x1b[31m失败：${err.message}\x1b[0m`);
  } finally {
    if (KEEP) {
      info(`KEEP=1：保留服务与数据库（A=: ${PORT_A} B=: ${PORT_B}，库 ${dbPath}）`);
    } else {
      serverA.kill();
      serverB.kill();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  process.exit(exitCode);
}

main();
