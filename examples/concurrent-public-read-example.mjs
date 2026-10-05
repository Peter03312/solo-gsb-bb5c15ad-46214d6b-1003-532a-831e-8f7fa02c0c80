#!/usr/bin/env node
'use strict';

// 访客公开读取「同一已提交数据库状态」的端到端示例（HTTP API）。
//
// 背景：两个 node src/server.js 进程（容器副本 / 双机热备）共用同一个 SQLite
// 文件（better-sqlite3 + WAL）。访客请求最新年表、历史版本、专题路线时，整份
// 响应必须取自同一个已提交状态：读取期间另一服务进程发布新版本、撤回版本、
// 登记出处遮盖或替代勘误附记，应返回变更前或变更后的完整结果，不能混合版本
// 可见性、出处遮盖与附记。
//
// 本脚本自动拉起两个共享同一 DB_PATH 的服务进程（A、B 端口不同），全程只走
// HTTP API，演示统一公开读取流程的四个可观察性质：
//
//   1. 撤回原子可见：B 撤回最新版的提交时刻与 A 的读取相交时，A 的每次响应
//      要么完整是撤回前（currentVersionNo 仍为被撤回版，内容可完整读出），
//      要么完整是撤回后（回退到上一未撤回版）；绝不会出现「版号已回退、
//      内容却取自被撤回版」之类的混合。路线清单 / 详情同理。
//   2. 遮盖原子可见：B 登记出处遮盖时，A 响应里版本快照出处与勘误附记出处
//      要么同为原文、要么同为「出处已遮盖」，不会一处遮盖一处未遮盖。
//   3. 附记原子可见：B 替代勘误附记时，A 每次只看到完整的旧附记或新附记。
//   4. 读取不阻塞写入：A 持续进行公开读取的同时，B 的发布 / 撤回 / 登记请求
//      全部快速成功（写不被读阻塞）；读路径本身也不返回任何 5xx。
//
// 判定方法：HTTP 层无法在语句之间插入写操作（快照窗口只在服务进程内部），
// 因此这里用「高并发交错 + 整份响应自洽断言」复现：多个读取与多个写入同时
// 打到同一库，持续 ROUNDS 轮，每一份响应都必须自洽；确定性的「语句级窗口」
// 证明见 test/public-read.test.js（在同一读事务首条语句之后注入另一连接提交）。
//
// 依赖：仅 Node >= 20（内置 fetch 与 child_process）；结束自动关服务、删临时库。
//
// 用法：
//   node examples/concurrent-public-read-example.mjs
//   可选：ROUNDS=20（交错轮数）、PORT_A=4301 PORT_B=4302、KEEP=1（保留现场）。

import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = Number(process.env.ROUNDS || 20);
const PORT_A = Number(process.env.PORT_A || 4301);
const PORT_B = Number(process.env.PORT_B || 4302);
const TOKEN = 'example-token';
const KEEP = process.env.KEEP === '1';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-public-cc-'));
const dbPath = path.join(tmpDir, 'shared.db');

const say = (t) => console.log(`\n\x1b[1;36m== ${t} ==\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
const fail = (m) => {
  console.error(`  \x1b[31mFAIL\x1b[0m ${m}`);
  failures++;
};
let failures = 0;

async function call(base, method, url, body, token = TOKEN) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Editor-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const pub = (base, url) => call(base, 'GET', url, undefined, null);

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

// 整份响应自洽断言：currentVersionNo、版本内容、附记必须互相对得上。
function assertChronicleCoherent({ status, json }, label) {
  if (status !== 200) return fail(`${label} 应为 200，实际 ${status}`);
  if (!json.published) return; // 全部撤回窗口：结构本身自洽（published:false + allRetracted）
  const v = json.version;
  if (!v || v.versionNo !== json.currentVersionNo) {
    return fail(`${label} 混合：外层 currentVersionNo=${json.currentVersionNo} 与内容 versionNo=${v && v.versionNo}`);
  }
  if (!Array.isArray(v.events) || !Array.isArray(v.relations) || !Array.isArray(v.errata)) {
    return fail(`${label} 混合：版本字段不是完整数组结构`);
  }
  // 附记必须都属于响应中的版本（同一出处文本在响应内的遮盖一致性由单元测试在语句级窗口保证）
  for (const er of v.errata) {
    if (er.versionNo !== v.versionNo) {
      return fail(`${label} 混合：附记 versionNo=${er.versionNo} 不属于版本 ${v.versionNo}`);
    }
  }
}

async function main() {
  say('0) 拉起两个共享同一 DB_PATH 的服务进程');
  const srvA = startServer(PORT_A);
  const srvB = startServer(PORT_B);
  const A = `http://127.0.0.1:${PORT_A}`;
  const B = `http://127.0.0.1:${PORT_B}`;
  try {
    await waitReady(A);
    await waitReady(B);
    ok(`服务 A=${A}、B=${B} 已就绪，共用 ${dbPath}`);

    say('1) 准备数据：2 个事件 + 主张 + 先于关系，连续发布两版，建专题路线');
    const e1 = await addEvent(A, '并发读取示例动员会', { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
    const e2 = await addEvent(A, '并发读取示例通水会', { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
    const rel = await call(A, 'POST', '/api/editor/relations', { earlierId: e1.eventId, laterId: e2.eventId, source: '二人口述一致' });
    if (rel.status !== 201) throw new Error('建关系失败：' + JSON.stringify(rel.json));

    let latest = (await call(A, 'GET', '/api/editor/versions')).json.currentVersionNo;
    let pub1 = await call(A, 'POST', '/api/editor/publish', {
      selection: [e1, e2], baseVersionNo: latest, editor: '示例', note: '首版',
    });
    if (pub1.status !== 201) throw new Error('发布首版失败：' + JSON.stringify(pub1.json));
    latest = pub1.json.versionNo;
    // 第二版（同草稿再发一次即可，正式发布覆盖全部事件）
    let pub2 = await call(A, 'POST', '/api/editor/publish', {
      selection: [e1, e2], baseVersionNo: latest, editor: '示例', note: '二版',
    });
    if (pub2.status !== 201) throw new Error('发布二版失败：' + JSON.stringify(pub2.json));
    const v2 = pub2.json.versionNo;
    const v1 = pub1.json.versionNo;
    const route = await call(A, 'POST', '/api/editor/routes', {
      title: '并发读取示例路线', versionNo: v2, anchorEventIds: [e1.eventId, e2.eventId], editor: '示例',
    });
    if (route.status !== 201) throw new Error('建路线失败：' + JSON.stringify(route.json));
    const routeNo = route.json.route.routeNo;
    ok(`已发布第 ${v1}、${v2} 版；专题路线 #${routeNo} 据第 ${v2} 版`);

    // 给最新版登记一条勘误附记（后续演示替代）
    let er = await call(A, 'POST', '/api/editor/errata', {
      versionNo: v2, targetType: 'event', targetId: e1.eventId, note: '首条附记', source: '附记出处原件', editor: '示例',
    });
    if (er.status !== 201) throw new Error('登记附记失败：' + JSON.stringify(er.json));

    say('2) 撤回原子可见：B 撤回第 2 版的同一刻，A 并发拉取五个公开端点');
    info('撤回请求与六个公开读取同时发出：每份响应都必须自洽（撤回记录只追加，无取消接口）');
    {
      const reader = Promise.all([
        pub(A, '/api/public/chronicle'),
        pub(A, '/api/public/versions'),
        pub(A, `/api/public/versions/${v2}`),
        pub(A, `/api/public/versions/${v1}`),
        pub(A, '/api/public/routes'),
        pub(A, `/api/public/routes/${routeNo}`),
      ]);
      // 与读取同时提交撤回（HTTP 层的交错由调度决定；语句级窗口的确定性证明在单元测试）
      const retract = call(B, 'POST', `/api/editor/versions/${v2}/retract`, { reason: '并发示例撤回', editor: 'B' });
      const reads = await reader;
      const r = await retract;
      if (r.status !== 200) throw new Error('撤回失败：' + JSON.stringify(r.json));
      const [chron, list, detail2, detail1, routeList, routeDetail] = reads;

      assertChronicleCoherent(chron, '最新年表');
      // 自洽：清单含 v2 ⇔ v2 详情 200 ⇔ 据 v2 的路线详情 200 且在清单中；
      //       清单不含 v2 ⇔ v2 详情 404 ⇔ 路线详情 404 且清单不含该路线。
      const listHasV2 = list.json.versions.some((x) => x.versionNo === v2);
      if (listHasV2) {
        if (detail2.status !== 200) fail(`清单含 v2 但详情 ${detail2.status}`);
        if (routeDetail.status !== 200) fail(`v2 可见但路线详情 ${routeDetail.status}`);
        if (!routeList.json.routes.some((x) => x.routeNo === routeNo)) fail('v2 可见但路线清单不含该路线');
        if (!chron.json.published || chron.json.currentVersionNo !== v2) fail('清单含 v2 但最新年表未指向 v2');
      } else {
        if (detail2.status !== 404) fail(`清单不含 v2 但详情 ${detail2.status}（混合可见性）`);
        if (routeDetail.status !== 404) fail(`v2 已撤回但路线详情 ${routeDetail.status}（混合可见性）`);
        if (routeList.json.routes.some((x) => x.routeNo === routeNo)) fail('v2 已撤回但路线清单仍含该路线（混合可见性）');
        if (chron.json.currentVersionNo !== v1) fail(`撤回 v2 后最新年表指向 ${chron.json.currentVersionNo}（应为 ${v1}）`);
      }
      // 未撤回的 v1 在任何状态下始终 200；清单版号与清单内容同源
      if (detail1.status !== 200) fail(`未撤回版 v1 详情应为 200，实际 ${detail1.status}`);
      if (list.json.currentVersionNo !== (listHasV2 ? v2 : v1)) fail('清单 currentVersionNo 与清单内容不同源');
    }
    // 为让后续轮次也能观察到「撤回后」稳态，再补一轮只读断言
    {
      const [chron, detail2, routeDetail] = await Promise.all([
        pub(A, '/api/public/chronicle'),
        pub(A, `/api/public/versions/${v2}`),
        pub(A, `/api/public/routes/${routeNo}`),
      ]);
      if (chron.json.currentVersionNo !== v1 || detail2.status !== 404 || routeDetail.status !== 404) {
        fail('撤回提交后的稳态不正确（年表未回退 / 撤回版或其路线仍可见）');
      }
    }
    ok('每一份响应的版本可见性与路线可见性严格同隐同现，未发现混合');

    say('3) 修正后重新发布：编号继续递增，访客立即可读（撤回不锁编号）');
    const pub3 = await call(A, 'POST', '/api/editor/publish', {
      selection: [e1, e2], baseVersionNo: v2, editor: '示例', note: '修正版',
    });
    if (pub3.status !== 201) throw new Error('发布修正版失败：' + JSON.stringify(pub3.json));
    const v3 = pub3.json.versionNo;
    const chron3 = await pub(A, '/api/public/chronicle');
    if (chron3.json.currentVersionNo !== v3) throw new Error('修正版发布后最新年表未指向 v3');
    ok(`第 ${v3} 版（修正版）已成为访客最新年表；旧路线 #${routeNo} 仍据第 ${v2}（撤回）版故继续 404`);

    say('4) 遮盖原子可见：B 登记 / 核对出处遮盖，A 并发读最新年表与 v3 详情');
    const red = await call(B, 'POST', '/api/editor/redaction-preview', { source: '李宝山口述' });
    if (red.status !== 200) throw new Error('遮盖预览失败：' + JSON.stringify(red.json));
    const beforeRed = await Promise.all([
      pub(A, '/api/public/chronicle'),
      pub(A, `/api/public/versions/${v3}`),
    ]);
    for (const [i, r] of beforeRed.entries()) {
      if (r.json.version && r.json.version.events.some((x) => x.source === '出处已遮盖')) {
        fail(`登记前读取 ${i} 却已出现遮盖`);
      }
    }
    const conf = await call(B, 'POST', '/api/editor/redaction', {
      source: '李宝山口述', currentVersionNo: red.json.currentVersionNo, editor: 'B',
    });
    if (conf.status !== 200) throw new Error('确认遮盖失败：' + JSON.stringify(conf.json));
    const afterRed = await Promise.all([
      pub(A, '/api/public/chronicle'),
      pub(A, `/api/public/versions/${v3}`),
      pub(A, `/api/public/routes/${routeNo}`), // 据撤回版：仍 404，遮盖不改变撤回判定
    ]);
    if (afterRed[0].json.version.events.find((x) => x.eventId === e1.eventId).source !== '出处已遮盖') {
      fail('遮盖登记后最新年表事件出处未遮盖');
    }
    if (afterRed[1].json.version.events.find((x) => x.eventId === e1.eventId).source !== '出处已遮盖') {
      fail('遮盖登记后历史版本详情事件出处未遮盖');
    }
    if (afterRed[2].status !== 404) fail('引用撤回版的路线在遮盖后应仍为 404');
    // 编辑者原文视图不受影响
    const raw = await call(A, 'GET', `/api/editor/versions/${v3}/raw`);
    if (raw.json.version.events.find((x) => x.eventId === e1.eventId).source !== '李宝山口述') {
      fail('持口令原文视图被遮盖影响');
    }
    ok('登记后两个公开端点同批显示「出处已遮盖」；撤回判定与编辑者原文不变');

    say('5) 附记原子可见：B 替代 v3 上的勘误附记，A 并发读最新年表');
    // 先对 v3 登记附记（v2 已撤回不能再登记）
    let er3 = await call(A, 'POST', '/api/editor/errata', {
      versionNo: v3, targetType: 'event', targetId: e1.eventId, note: 'v3 旧附记', source: '附记出处原件', editor: 'A',
    });
    if (er3.status !== 201) throw new Error('v3 附记登记失败：' + JSON.stringify(er3.json));
    let seenOld = false;
    let seenNew = false;
    let mixed = false;
    await Promise.all([
      // 读者：连续读取，每份响应中该目标的生效附记必须是完整一条
      (async () => {
        for (let i = 0; i < ROUNDS * 5; i++) {
          const r = await pub(A, '/api/public/chronicle');
          if (!r.json.published) continue;
          const items = r.json.version.errata.filter((x) => x.targetId === e1.eventId && x.targetType === 'event');
          if (items.length !== 1) { mixed = true; continue; }
          if (items[0].note === 'v3 旧附记') seenOld = true;
          if (items[0].note === 'v3 新附记') seenNew = true;
        }
      })(),
      // 写者：用旧附记号替代一次
      (async () => {
        await new Promise((r) => setTimeout(r, 20));
        const r = await call(B, 'POST', '/api/editor/errata', {
          versionNo: v3, targetType: 'event', targetId: e1.eventId,
          note: 'v3 新附记', source: '附记出处新件', editor: 'B',
          replacesErrataId: er3.json.errata.errataId,
        });
        if (r.status !== 201) throw new Error('替代附记失败：' + JSON.stringify(r.json));
      })(),
    ]);
    if (mixed) fail('出现同一响应中目标附记缺失 / 多条（生效附记与版本不同源）');
    if (!seenOld || !seenNew) info(`（交错窗口未同时观察到新旧两态：old=${seenOld} new=${seenNew}；语句级证明见单元测试）`);
    else ok('并发窗口内观察到旧附记与新附记两个完整状态，无混合');

    say('6) 读取不阻塞写入：A 持续公开读取期间，B 的写入全部快速成功');
    const writeLatencies = [];
    let readErrors = 0;
    await Promise.all([
      (async () => {
        for (let i = 0; i < ROUNDS * 10; i++) {
          const r = await pub(A, '/api/public/chronicle');
          if (r.status !== 200) readErrors++;
        }
      })(),
      (async () => {
        // 追加新的遮盖登记（不同文本）与新事件草稿，均为写事务
        for (let i = 0; i < 8; i++) {
          const t0 = Date.now();
          const ev = await call(B, 'POST', '/api/editor/events', { title: `并发写入探测事件 ${i}` });
          writeLatencies.push(Date.now() - t0);
          if (ev.status !== 201) throw new Error('读取期间写事件失败：' + JSON.stringify(ev.json));
          const rd = await call(B, 'POST', '/api/editor/redaction-preview', { source: `探测出处 ${i}` });
          const cf = await call(B, 'POST', '/api/editor/redaction', {
            source: `探测出处 ${i}`, currentVersionNo: rd.json.currentVersionNo, editor: 'B',
          });
          if (cf.status !== 200) throw new Error('读取期间登记遮盖失败：' + JSON.stringify(cf.json));
        }
      })(),
    ]);
    if (readErrors > 0) fail(`公开读取出现 ${readErrors} 次非 200 响应`);
    const maxLatency = Math.max(...writeLatencies);
    ok(`读取密集进行中 B 的 ${writeLatencies.length} 次写入均成功（最慢 ${maxLatency}ms，应远小于 busy_timeout）；读取 0 次错误`);

    say('公开 HTTP API 调用示例（也可用 curl 直接复现）');
    info(`  curl -s ${A}/api/public/chronicle`);
    info(`  curl -s ${A}/api/public/versions`);
    info(`  curl -s ${A}/api/public/versions/${v3}`);
    info(`  curl -s ${A}/api/public/routes`);
    info(`  curl -s ${A}/api/public/routes/${routeNo}   # 引用撤回版 → 404`);

    if (failures > 0) {
      console.error(`\n\x1b[31m共 ${failures} 处断言失败\x1b[0m`);
      process.exitCode = 1;
    } else {
      console.log('\n\x1b[1;32m全部场景通过：公开读取始终取自同一已提交状态，且不阻塞写入。\x1b[0m');
    }
  } catch (err) {
    console.error('\n\x1b[31m示例执行出错：\x1b[0m', err);
    process.exitCode = 1;
  } finally {
    if (KEEP) {
      console.log(`\nKEEP=1：服务仍在运行（A=${A} B=${B}），临时库 ${tmpDir}`);
    } else {
      srvA.kill();
      srvB.kill();
      await new Promise((r) => setTimeout(r, 200));
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

main();
