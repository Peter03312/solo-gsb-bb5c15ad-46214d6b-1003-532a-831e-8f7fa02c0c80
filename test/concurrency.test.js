'use strict';

// 即时发布与建立预约的并发一致性测试（模拟两个服务进程共用同一 SQLite 文件）。
//
// 修复前的问题：evaluateDraft 分次 SELECT 事件 / 主张 / 关系（各自独立读快照），
// 写入事务只核对基准版本号——另一进程若在读取之间一次性改动事件与主张，
// 可能冻结从未同时存在过的混合内容；预约还会把旧快照记成新修订号。
//
// 本轮修复：
//   1. evaluateDraft 在同一只读事务（同一 WAL 快照）内读出事件 / 主张 / 关系 / 修订号；
//   2. publishVersion / createSchedule 在 BEGIN IMMEDIATE 写事务内再次核对草稿修订号，
//      快照之后草稿被另一进程改动 → 409 DRAFT_REVISION_CONFLICT，整次不生成版本或预约；
//      写锁等待超时同样归为该草稿冲突。
//
// 这里用两类独立连接复现并发，SQLite 文件锁 / WAL 快照语义与两个进程完全相同：
//   - 同进程第二个 better-sqlite3 连接（覆盖锁等待 / 抢先提交版本等确定性场景）；
//   - worker_threads 中的独立连接（覆盖「读取/求解与另一进程提交同时发生」的真实窗口）。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const { SCHEMA, setDb } = require('../src/db');
const { publishVersion, evaluateDraft } = require('../src/publish');
const { createSchedule, runDueSchedules } = require('../src/schedule');
const { claimInterval, formatClaimDate, isoFromOrdinal } = require('../src/dates');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-concurrency-'));
const dbPath = path.join(tmpDir, 'concurrency.db');

// 主连接（服务 A 视角，模块内 getDb 使用它）
const dbA = new Database(dbPath);
dbA.pragma('journal_mode = WAL');
dbA.pragma('busy_timeout = 5000');
dbA.exec(SCHEMA);
setDb(dbA);

function openConnB(busyMs = 5000) {
  const conn = new Database(dbPath);
  conn.pragma('busy_timeout = ' + busyMs);
  return conn;
}
function closeConn(conn) {
  try {
    conn.close();
  } catch {
    /* 已关闭 */
  }
}

after(() => {
  closeConn(dbA);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function resetData() {
  dbA.exec(`
    DELETE FROM publish_schedules;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
}

before(resetData);

// 直接插草稿：2 事件（e1 先于 e2）各 1 条主张
function seedTwoEvents() {
  const add = (title) =>
    dbA.prepare('INSERT INTO events (title, description) VALUES (?, ?)').run(title, '').lastInsertRowid;
  const claim = (eventId, precision, year, month, day, source) => {
    const iv = claimInterval(precision, year, month, day);
    return dbA
      .prepare(
        `INSERT INTO claims
           (event_id, precision, year, month, day, date_label, interval_start, interval_end, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(eventId, precision, year, month, day ?? null, formatClaimDate(precision, year, month, day), iv.start, iv.end, source)
      .lastInsertRowid;
  };
  const e1 = add('动员会');
  const e2 = add('通水会');
  const c1 = claim(e1, 'day', 1958, 9, 12, '李宝山口述');
  const c2 = claim(e2, 'month', 1959, 5, undefined, '王秀兰口述');
  dbA.prepare('INSERT INTO relations (earlier_id, later_id, source) VALUES (?, ?, ?)').run(e1, e2, '二人口述一致');
  return { e1, e2, c1, c2, selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] };
}

// 在指定连接的单事务内一次性改动草稿（模拟「另一进程一次性改动事件与主张」）。
function mutateDraftAtomically(conn, eventId = 1) {
  return conn
    .transaction(() => {
      conn.prepare('UPDATE events SET title = ? WHERE id = ?').run('另一进程改后的动员会', eventId);
      conn
        .prepare(
          "INSERT INTO claims (event_id, precision, year, date_label, interval_start, interval_end, source) VALUES (?, 'year', 2000, '2000 年', '2000-01-01', '2000-12-31', '新增主张')"
        )
        .run(eventId);
      return conn.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
    })
    .immediate();
}

// 建一条逐日相接的长链（事件 3 起，接续已有事件 2），返回链上的 selection。
// 长链的求解（Tarjan + 拓扑传播）耗时随规模线性增长，给跨连接并发提交留出窗口。
function seedChain(count) {
  const insE = dbA.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  const insC = dbA.prepare(
    `INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source)
     VALUES (?, 'day', ?, ?, ?, ?, ?, ?, '链上出处')`
  );
  const insR = dbA.prepare('INSERT INTO relations (earlier_id, later_id) VALUES (?, ?)');
  const selection = [];
  // 事件 1=1958-09-12（日）、事件 2=1959-05（月，求解为 1959-05-01）；链从 1959-05-02 起逐日
  const base = Date.UTC(1959, 4, 2) / 86400000;
  let prev = 2;
  for (let i = 0; i < count; i++) {
    const ord = base + i;
    const iso = isoFromOrdinal(ord);
    const [y, m, d] = iso.split('-').map(Number);
    const eid = insE.run(`链上事件 ${i + 1}`, '').lastInsertRowid;
    const cid = insC.run(eid, y, m, d, iso, iso, iso).lastInsertRowid;
    selection.push({ eventId: eid, claimId: cid });
    insR.run(prev, eid);
    prev = eid;
  }
  return selection;
}

// 工作线程（独立连接，等同另一进程）：轮询直到草稿事件数达到阈值，
// 随后在单事务内一次性改动事件 1 的标题并新增主张，提交后回报修订号。
const WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const db = new Database(workerData.dbPath);
db.pragma('busy_timeout = 10000');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
(async () => {
  const deadline = Date.now() + workerData.waitMs;
  let n = 0;
  while (Date.now() < deadline) {
    n = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    if (n >= workerData.threshold) break;
    sleep(5);
  }
  if (n < workerData.threshold) {
    parentPort.postMessage({ fired: false, events: n });
    return;
  }
  const rev = db.transaction(() => {
    db.prepare("UPDATE events SET title = '另一进程改后的动员会' WHERE id = 1").run();
    db.prepare("INSERT INTO claims (event_id, precision, year, date_label, interval_start, interval_end, source) VALUES (1, 'year', 2000, '2000 年', '2000-01-01', '2000-12-31', '新增主张')").run();
    return db.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
  }).immediate();
  parentPort.postMessage({ fired: true, events: n, rev });
})().finally(() => db.close());
`;

// 在工作线程等待提交的同时执行 fn；返回 { result } 或 { error }，并附 worker 回报。
async function runAgainstMutatingWorker(fn, { threshold, waitMs = 15000 }) {
  const worker = new Worker(WORKER_CODE, { eval: true, workerData: { dbPath, threshold, waitMs } });
  const workerMsg = new Promise((resolve) => worker.once('message', resolve));
  // 让工作线程先进入轮询
  await new Promise((r) => setTimeout(r, 20));
  let result;
  let error;
  try {
    result = fn();
  } catch (e) {
    error = e;
  }
  const msg = await workerMsg;
  await worker.terminate().catch(() => {});
  return { result, error, worker: msg };
}

test('evaluateDraft：事件/主张/关系/修订号在同一快照内读出；读取期间另一连接提交不产生混合内容', () => {
  resetData();
  const connB = openConnB();
  try {
    const { e1, c1, c2, selection } = seedTwoEvents();
    const rev0 = dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;

    // 在 evaluateDraft 的只读事务读到修订号之后、读主张表语句执行之前，
    // 服务 B 在独立连接的单事务里改标题并提交。拦截的是语句「执行」而非 prepare
    //（better-sqlite3 会缓存 prepared statement；claims 用的是 .all()）。
    const originalPrepare = dbA.prepare.bind(dbA);
    let armed = true;
    const fireOnce = (originalMethod) => (...args) => {
      if (armed) {
        armed = false;
        dbA.prepare = originalPrepare;
        mutateDraftAtomically(connB, e1);
      }
      return originalMethod(...args);
    };
    dbA.prepare = (sql, ...rest) => {
      const stmt = originalPrepare(sql, ...rest);
      if (armed && /FROM claims/.test(String(sql))) {
        stmt.get = fireOnce(stmt.get.bind(stmt));
        stmt.all = fireOnce(stmt.all.bind(stmt));
      }
      return stmt;
    };

    const result = evaluateDraft(selection);
    dbA.prepare = originalPrepare;
    assert.strictEqual(armed, false, '拦截器应在读主张时触发');

    assert.strictEqual(result.ok, true);
    // 快照固定在服务 B 提交之前：修订号为 rev0，标题与主张仍是旧内容
    assert.strictEqual(result.revisionNo, rev0);
    assert.strictEqual(result.events.find((e) => e.id === e1).title, '动员会');
    assert.strictEqual(result.claims.length, 2);
    assert.deepStrictEqual(
      result.claims.map((c) => c.id).sort((a, b) => a - b),
      [c1, c2]
    );
    assert.strictEqual(isoFromOrdinal(result.dates.get(e1)), '1958-09-12');

    // 读事务结束后再读，才能看到服务 B 的新状态（修订号推进、新主张可见）
    const nowRev = dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
    // 服务 B 的一次改动含 1 条事件 UPDATE + 1 条主张 INSERT，各推进一次修订号
    assert.strictEqual(nowRev, rev0 + 2);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 3);
  } finally {
    closeConn(connB);
  }
});

test('即时发布：求解期间另一进程提交草稿改动 → 409 草稿冲突，不生成版本（未撞上则重试）', async () => {
  const CHAIN = Number(process.env.CONCURRENCY_CHAIN || 4000);
  const ROUNDS = 3;
  let hit = false;

  for (let round = 0; round < ROUNDS && !hit; round++) {
    resetData();
    seedTwoEvents(); // 事件 1=动员会（工作线程据此改标题），事件 2 先于链首
    const tail = seedChain(CHAIN);
    const selection = [
      { eventId: 1, claimId: dbA.prepare('SELECT id FROM claims WHERE event_id = 1').get().id },
      { eventId: 2, claimId: dbA.prepare('SELECT id FROM claims WHERE event_id = 2').get().id },
      ...tail,
    ];

    const revBefore = dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
    const out = await runAgainstMutatingWorker(
      () => publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '甲' }),
      { threshold: CHAIN + 2 }
    );

    if (!out.worker.fired) continue; // 工作线程没等到窗口，整轮重来
    hit = true;
    assert.ok(out.error, '另一进程在求解窗口内提交，应抛 409');
    assert.strictEqual(out.error.status, 409);
    assert.strictEqual(out.error.code, 'DRAFT_REVISION_CONFLICT');
    assert.strictEqual(out.error.expectedRevisionNo, revBefore);
    assert.strictEqual(out.error.currentRevisionNo, revBefore + 2);
    assert.match(out.error.message, /草稿冲突/);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 0);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM version_events').get().n, 0);
  }
  assert.ok(hit, `连续 ${ROUNDS} 轮都没撞上并发窗口，可用更大 CONCURRENCY_CHAIN 重试`);
});

test('即时发布：冲突后基于最新草稿重新确认选择再发布 → 成功，冻结内容与新草稿一致', () => {
  resetData();
  const connB = openConnB();
  try {
    const { e1, e2 } = seedTwoEvents();
    // 另一进程改动草稿：改标题，并为 e1 新增一条「仍满足先于 e2」的更早主张
    // （1958-09-10，日精度），编辑者刷新后改选这条主张重新发布。
    connB
      .transaction(() => {
        connB.prepare('UPDATE events SET title = ? WHERE id = ?').run('另一进程改后的动员会', e1);
        connB
          .prepare(
            `INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source)
             VALUES (?, 'day', 1958, 9, 10, '1958 年 09 月 10 日', '1958-09-10', '1958-09-10', '新发现档案')`
          )
          .run(e1);
      })
      .immediate();

    const newClaimId = connB
      .prepare('SELECT id FROM claims WHERE event_id = ? AND source = ?')
      .get(e1, '新发现档案').id;
    const freshSelection = [
      { eventId: e1, claimId: newClaimId },
      { eventId: e2, claimId: dbA.prepare('SELECT id FROM claims WHERE event_id = ? AND source = ?').get(e2, '王秀兰口述').id },
    ];
    const out = publishVersion({ selectionList: freshSelection, baseVersionNo: 0, editor: '甲' });
    assert.strictEqual(out.versionNo, 1);
    const v = out.version;
    assert.strictEqual(v.events.find((x) => x.eventId === e1).title, '另一进程改后的动员会');
    assert.strictEqual(v.events.find((x) => x.eventId === e1).claimId, newClaimId);
    assert.strictEqual(v.events.find((x) => x.eventId === e1).resolvedDate, '1958-09-10');
  } finally {
    closeConn(connB);
  }
});

test('即时发布：另一连接持有写事务导致写锁等待超时 → 409 草稿冲突，不生成版本', () => {
  resetData();
  dbA.pragma('busy_timeout = 150');
  try {
    const { selection } = seedTwoEvents();
    const connB = openConnB(5000);
    try {
      const hold = connB.transaction(() => {
        connB.prepare("UPDATE events SET title = '服务 B 暂存中' WHERE id = 1").run();
        // 服务 A 此时求值并尝试 BEGIN IMMEDIATE：等不到写锁
        let err;
        try {
          publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '甲' });
        } catch (e) {
          err = e;
        }
        assert.ok(err, '应抛出 409');
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.code, 'DRAFT_REVISION_CONFLICT');
        assert.match(err.message, /另一进程正在修改草稿/);
        throw Object.assign(new Error('回滚服务 B'), { rollback: true });
      });
      assert.throws(() => hold.immediate(), /回滚服务 B/);
    } finally {
      closeConn(connB);
    }
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 0);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM publish_schedules').get().n, 0);
  } finally {
    dbA.pragma('busy_timeout = 5000');
  }
});

test('即时发布：无并发改动时正常发布（既有发布路径与冻结语义不变）', () => {
  resetData();
  const { e1, e2, selection } = seedTwoEvents();
  const out = publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '甲', note: '首版' });
  assert.strictEqual(out.versionNo, 1);
  assert.strictEqual(out.version.events.length, 2);
  assert.strictEqual(out.version.relations.length, 1);
  assert.strictEqual(out.version.events.find((x) => x.eventId === e1).resolvedDate, '1958-09-12');
  assert.strictEqual(out.version.events.find((x) => x.eventId === e2).resolvedDate, '1959-05-01');
});

test('即时发布：草稿一致但基准版本号被另一连接抢先推进 → 仍为既有 409 VERSION_CONFLICT', () => {
  resetData();
  const { selection } = seedTwoEvents();
  publishVersion({ selectionList: selection, baseVersionNo: 0, editor: 'B' });
  let err;
  try {
    publishVersion({ selectionList: selection, baseVersionNo: 0, editor: 'A' });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.strictEqual(err.status, 409);
  assert.strictEqual(err.code, 'VERSION_CONFLICT');
  assert.strictEqual(err.currentVersionNo, 1);
  assert.strictEqual(err.baseVersionNo, 0);
  assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 1);
});

function futureUtc(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

test('建立预约：求解期间另一进程提交草稿改动 → 409 草稿冲突，不建立预约（未撞上则重试）', async () => {
  const CHAIN = Number(process.env.CONCURRENCY_CHAIN || 4000);
  const ROUNDS = 3;
  let hit = false;

  for (let round = 0; round < ROUNDS && !hit; round++) {
    resetData();
    seedTwoEvents();
    publishVersion({
      selectionList: [
        { eventId: 1, claimId: dbA.prepare('SELECT id FROM claims WHERE event_id = 1').get().id },
        { eventId: 2, claimId: dbA.prepare('SELECT id FROM claims WHERE event_id = 2').get().id },
      ],
      baseVersionNo: 0,
      editor: '首版',
    });
    const tail = seedChain(CHAIN);
    const selection = [
      { eventId: 1, claimId: dbA.prepare('SELECT id FROM claims WHERE event_id = 1').get().id },
      { eventId: 2, claimId: dbA.prepare('SELECT id FROM claims WHERE event_id = 2').get().id },
      ...tail,
    ];

    const revBefore = dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
    const out = await runAgainstMutatingWorker(
      () =>
        createSchedule({
          selectionList: selection,
          scheduledAtRaw: futureUtc(3600),
          baseVersionNo: 1,
          editor: '预约员',
        }),
      { threshold: CHAIN + 2 }
    );

    if (!out.worker.fired) continue;
    hit = true;
    assert.ok(out.error, '另一进程在求解窗口内提交，应抛 409');
    assert.strictEqual(out.error.status, 409);
    assert.strictEqual(out.error.code, 'DRAFT_REVISION_CONFLICT');
    assert.strictEqual(out.error.expectedRevisionNo, revBefore);
    assert.strictEqual(out.error.currentRevisionNo, revBefore + 2);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM publish_schedules').get().n, 0);
    // 到期补跑也无东西可发，版本仍只有首版
    const ran = runDueSchedules(Date.now() + 7200 * 1000);
    assert.deepStrictEqual(ran.published, []);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 1);
  }
  assert.ok(hit, `连续 ${ROUNDS} 轮都没撞上并发窗口，可用更大 CONCURRENCY_CHAIN 重试`);
});

test('建立预约：成功时记录的草稿修订号与冻结快照同源（不会把旧快照记成新修订号）', () => {
  resetData();
  const { e1, selection } = seedTwoEvents();
  publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '首版' });
  const revNow = dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;

  const schedule = createSchedule({
    selectionList: selection,
    scheduledAtRaw: futureUtc(3600),
    baseVersionNo: 1,
    editor: '预约员',
  });
  assert.strictEqual(schedule.draftRevisionNo, revNow);
  assert.strictEqual(schedule.baseVersionNo, 1);
  assert.strictEqual(schedule.frozen.events.length, 2);
  assert.strictEqual(schedule.frozen.relations.length, 1);

  // 之后另一进程改草稿：预约冻结内容与记录的修订号均不变
  const connB = openConnB();
  try {
    mutateDraftAtomically(connB, e1);
  } finally {
    closeConn(connB);
  }
  const row = dbA
    .prepare('SELECT draft_revision_no AS r, base_version_no AS b FROM publish_schedules WHERE id = ?')
    .get(schedule.scheduleNo);
  assert.strictEqual(row.r, revNow);
  assert.strictEqual(row.b, 1);
});

test('建立预约：草稿一致但基准版本过期 → 既有 409 VERSION_CONFLICT，不建立预约', () => {
  resetData();
  const { selection } = seedTwoEvents();
  publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '首版' });
  let err;
  try {
    createSchedule({ selectionList: selection, scheduledAtRaw: futureUtc(3600), baseVersionNo: 0 });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.strictEqual(err.status, 409);
  assert.strictEqual(err.code, 'VERSION_CONFLICT');
  assert.strictEqual(err.currentVersionNo, 1);
  assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM publish_schedules').get().n, 0);
});

test('建立预约：另一连接持有写事务导致锁等待超时 → 409 草稿冲突，不建立预约', () => {
  resetData();
  dbA.pragma('busy_timeout = 150');
  try {
    const { selection } = seedTwoEvents();
    publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '首版' });
    const connB = openConnB(5000);
    try {
      const hold = connB.transaction(() => {
        connB.prepare("UPDATE events SET title = '服务 B 暂存中' WHERE id = 1").run();
        let err;
        try {
          createSchedule({ selectionList: selection, scheduledAtRaw: futureUtc(3600), baseVersionNo: 1 });
        } catch (e) {
          err = e;
        }
        assert.ok(err);
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.code, 'DRAFT_REVISION_CONFLICT');
        throw Object.assign(new Error('回滚服务 B'), { rollback: true });
      });
      assert.throws(() => hold.immediate(), /回滚服务 B/);
    } finally {
      closeConn(connB);
    }
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM publish_schedules').get().n, 0);
  } finally {
    dbA.pragma('busy_timeout = 5000');
  }
});
