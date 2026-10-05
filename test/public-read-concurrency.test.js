'use strict';

// 公开读取（访客：最新年表 / 历史版本 / 版本清单 / 专题路线）的并发一致性测试
// （模拟两个服务进程共用同一 SQLite 文件）。
//
// 修复前的问题：公开读取把「最新可见版本号、撤回登记、版本快照、遮盖登记、
// 生效勘误附记、路线骨架」分多条 SELECT 各自读出（每条语句各取最新 WAL 快照）。
// 读取期间另一进程若发布新版本、撤回版本、登记出处遮盖或替代勘误附记，
// 响应就会混合不同已提交状态（例如版本号取自撤回前、遮盖判定取自登记后）。
//
// 本轮修复：五个公开读取统一走 src/public-read.js——整份响应在同一只读事务
// （同一 WAL 快照）内组装；撤回集合与遮盖登记整请求各读一次（O(1) 集合判定，
// 长路线 / 大版本不逐条重复扫描登记）；只读事务不取写锁，不阻塞其他进程写入。
//
// 本文件用独立 better-sqlite3 连接复现另一进程（SQLite 文件锁 / WAL 快照语义
// 与两个真实进程完全一致），并用「语句执行前注入另一连接的提交」确定性地把
// 并发提交插进公开读取的两条语句之间：
//   - 注入后的整份响应必须与「提交前」的完整读取逐字节一致（同一快照），
//     读取结束后的新读取再整体落在「提交后」状态——绝不出现混合；
//   - 注入本身即证明读取期间另一进程的写入不被阻塞（读事务不取写锁）。

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { SCHEMA, setDb } = require('../src/db');
const { publishVersion } = require('../src/publish');
const { createRoute } = require('../src/route');
const { registerErrata } = require('../src/errata');
const { claimInterval, formatClaimDate, ordinalFromIso, isoFromOrdinal } = require('../src/dates');
const {
  readPublicChronicle,
  readPublicVersionList,
  readPublicVersion,
  readPublicRouteList,
  readPublicRoute,
} = require('../src/public-read');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-public-read-'));
const dbPath = path.join(tmpDir, 'public-read-concurrency.db');

// 主连接（服务进程的连接，模块内 getDb 使用它）
const dbA = new Database(dbPath);
dbA.pragma('journal_mode = WAL');
dbA.pragma('busy_timeout = 5000');
dbA.exec(SCHEMA);
setDb(dbA);

// 另一「服务进程」的连接：busy_timeout 调低——若公开读取错误地持有写锁，
// 注入的提交会迅速以 SQLITE_BUSY 失败（而不是静默通过）。
function openConnB() {
  const conn = new Database(dbPath);
  conn.pragma('busy_timeout = 300');
  return conn;
}

after(() => {
  try { dbA.close(); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  dbA.exec(`
    DELETE FROM draft_restores;
    DELETE FROM edit_session_ops;
    DELETE FROM edit_sessions;
    DELETE FROM import_batches;
    DELETE FROM errata;
    DELETE FROM publish_schedules;
    DELETE FROM route_segments;
    DELETE FROM route_anchors;
    DELETE FROM routes;
    DELETE FROM version_retractions;
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

// ---------- 数据准备 ----------

function insertEvent(title) {
  return dbA.prepare('INSERT INTO events (title, description) VALUES (?, ?)').run(title, '').lastInsertRowid;
}

function insertClaim(eventId, precision, year, month, day, source) {
  const iv = claimInterval(precision, year, month, day);
  return dbA
    .prepare(
      `INSERT INTO claims
         (event_id, precision, year, month, day, date_label, interval_start, interval_end, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eventId, precision, year, month, day ?? null, formatClaimDate(precision, year, month, day), iv.start, iv.end, source)
    .lastInsertRowid;
}

// 基础草稿：动员会（1958-09-12，李宝山口述）先于 通水会（1959-05，王秀兰口述）
function seedDraft() {
  const e1 = insertEvent('动员会');
  const e2 = insertEvent('通水会');
  const c1 = insertClaim(e1, 'day', 1958, 9, 12, '李宝山口述');
  const c2 = insertClaim(e2, 'month', 1959, 5, undefined, '王秀兰口述');
  dbA.prepare('INSERT INTO relations (earlier_id, later_id, source) VALUES (?, ?, ?)').run(e1, e2, '李宝山口述');
  return { e1, e2, c1, c2, selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] };
}

function publish(selection, baseVersionNo, note = '') {
  return publishVersion({ selectionList: selection, baseVersionNo, editor: '编辑甲', note });
}

// 发两版 + 第 2 版一条路线 + 第 2 版一条附记，返回各对象编号
function seedTwoVersionsWithRouteAndErrata() {
  const d = seedDraft();
  publish(d.selection, 0, '首版');
  // 改草稿再发第 2 版（追加一个事件）
  const e3 = insertEvent('庆功会');
  const c3 = insertClaim(e3, 'year', 1960, undefined, undefined, '张德福口述');
  dbA.prepare('INSERT INTO relations (earlier_id, later_id, source) VALUES (?, ?, ?)').run(d.e2, e3, '王秀兰口述');
  const selection2 = [...d.selection, { eventId: e3, claimId: c3 }];
  publish(selection2, 1, '第二版');
  const route = createRoute({ title: '建设脉络', versionNo: 2, anchorEventIds: [d.e1, e3], editor: '编辑甲' });
  const err = registerErrata({
    versionNo: 2,
    targetType: 'event',
    targetId: d.e1,
    note: '动员会日期另有说法待核',
    source: '张德福口述',
    editor: '编辑乙',
  });
  return { ...d, e3, c3, selection2, routeNo: route.routeNo, errataId: err.errata.errataId };
}

// ---------- 并发注入工具 ----------

// 让另一连接的一笔提交确定性地落在「公开读取的两条语句之间」：
// 包装 dbA.prepare，命中 pattern 的下一条语句**执行前**先在 connB 上执行
// commitFn（一笔写入提交），随后恢复原 prepare。此时主连接的只读事务已经
// 开始（快照已建立），注入的提交对本读取不可见——响应必须整体落在提交前。
function injectCommitBeforeStatement(pattern, commitFn) {
  const original = dbA.prepare;
  let armed = true;
  let fired = false;
  dbA.prepare = function patchedPrepare(sql, ...rest) {
    const stmt = original.call(this, sql, ...rest);
    if (armed && pattern.test(sql)) {
      armed = false;
      for (const method of ['get', 'all', 'run']) {
        const exec = stmt[method];
        stmt[method] = (...args) => {
          if (!fired) {
            fired = true;
            commitFn();
          }
          return exec.apply(stmt, args);
        };
      };
    }
    return stmt;
  };
  return {
    fired: () => fired,
    restore: () => { dbA.prepare = original; },
  };
}

// 统计 fn 执行期间、匹配 pattern 的 SQL 语句被执行的次数（用于验证
// 「遮盖登记整请求只读一次」，而不是逐行 / 逐段重复扫描）。
function countStatements(pattern, fn) {
  const original = dbA.prepare;
  let count = 0;
  dbA.prepare = function patchedPrepare(sql, ...rest) {
    const stmt = original.call(this, sql, ...rest);
    if (pattern.test(sql)) {
      count += 1;
    }
    return stmt;
  };
  try {
    const result = fn();
    return { result, count };
  } finally {
    dbA.prepare = original;
  }
}

// 在另一连接上执行一笔写入（自动开关连接）；写操作走模块 API 时临时切换 getDb。
function commitViaConnB(fn, { useModuleDb = false } = {}) {
  const connB = openConnB();
  try {
    if (useModuleDb) setDb(connB);
    return fn(connB);
  } finally {
    if (useModuleDb) setDb(dbA);
    connB.close();
  }
}

// ---------- 同一快照：读取期间另一进程提交，响应整体落在提交前或提交后 ----------

test('最新年表读取期间另一进程撤回最新版：整份响应落在撤回前，新读取落在撤回后', () => {
  seedTwoVersionsWithRouteAndErrata();

  const before = readPublicChronicle(); // 撤回前完整对照
  assert.strictEqual(before.currentVersionNo, 2);

  // 注入：读到版本事件之前，另一进程撤回第 2 版（一笔提交）
  const injection = injectCommitBeforeStatement(/FROM version_events/, () =>
    commitViaConnB((connB) =>
      connB
        .prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)')
        .run(2, '编年依据有误', '另一进程')
    )
  );
  const during = readPublicChronicle();
  injection.restore();

  assert.ok(injection.fired(), '注入的撤回提交确实落在读取中途');
  // 整份响应与撤回前逐字段一致：不混合「撤回后的可见性」
  assert.deepStrictEqual(during, before);
  assert.strictEqual(during.currentVersionNo, 2);

  // 读取结束后的新读取整体落在撤回后：最新年表回退到第 1 版
  const after = readPublicChronicle();
  assert.strictEqual(after.currentVersionNo, 1);
  assert.strictEqual(after.version.versionNo, 1);
});

test('最新年表读取期间另一进程登记遮盖并替代附记：响应不混合遮盖 / 附记前后状态', () => {
  const { e1, errataId } = seedTwoVersionsWithRouteAndErrata();

  const before = readPublicChronicle();
  assert.strictEqual(before.version.events.find((e) => e.title === '动员会').source, '李宝山口述');
  assert.strictEqual(before.version.errata[0].note, '动员会日期另有说法待核');

  // 注入：另一进程在一个事务里同时登记出处遮盖 + 替代附记
  const injection = injectCommitBeforeStatement(/FROM version_events/, () =>
    commitViaConnB((connB) => {
      const tx = connB.transaction(() => {
        connB.prepare('INSERT INTO source_redactions (source_text, editor) VALUES (?, ?)').run('李宝山口述', '另一进程');
        connB
          .prepare(
            `INSERT INTO errata (version_no, target_type, target_id, note, source, editor, replaces_errata_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(2, 'event', e1, '更正：应为 1958-09-13', '某档案第 12 页', '另一进程', errataId);
      });
      tx();
    })
  );
  const during = readPublicChronicle();
  injection.restore();

  assert.ok(injection.fired(), '注入的遮盖 + 附记提交确实落在读取中途');
  // 整份响应与提交前一致：出处未遮盖、附记仍是旧说明（不混合）
  assert.deepStrictEqual(during, before);

  // 新读取整体落在提交后：命中处遮盖、附记为新说明
  const after = readPublicChronicle();
  assert.strictEqual(after.version.events.find((e) => e.title === '动员会').source, '出处已遮盖');
  assert.strictEqual(after.version.relations.find((r) => r.earlierEventId === e1).source, '出处已遮盖');
  assert.strictEqual(after.version.errata[0].note, '更正：应为 1958-09-13');
  assert.strictEqual(after.version.errata[0].replacesErrataId, errataId);
});

test('最新年表读取期间另一进程发布新版本：响应仍是旧版全貌，新读取才是新版', () => {
  const d = seedDraft();
  publish(d.selection, 0, '首版');

  const before = readPublicChronicle();
  assert.strictEqual(before.currentVersionNo, 1);

  // 注入：另一进程改草稿并发布第 2 版（走模块 API，临时切到 connB）
  const injection = injectCommitBeforeStatement(/FROM version_events/, () =>
    commitViaConnB((connB) => {
      const e3 = connB.prepare('INSERT INTO events (title, description) VALUES (?, ?)').run('庆功会', '').lastInsertRowid;
      const iv = claimInterval('year', 1960);
      const c3 = connB
        .prepare(
          `INSERT INTO claims
             (event_id, precision, year, month, day, date_label, interval_start, interval_end, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(e3, 'year', 1960, null, null, formatClaimDate('year', 1960), iv.start, iv.end, '张德福口述')
        .lastInsertRowid;
      connB.prepare('INSERT INTO relations (earlier_id, later_id, source) VALUES (?, ?, ?)').run(d.e2, e3, '王秀兰口述');
      setDb(connB);
      try {
        publishVersion({
          selectionList: [...d.selection, { eventId: e3, claimId: c3 }],
          baseVersionNo: 1,
          editor: '另一进程',
          note: '第二版',
        });
      } finally {
        setDb(dbA);
      }
    })
  );
  const during = readPublicChronicle();
  injection.restore();

  assert.ok(injection.fired(), '注入的发布提交确实落在读取中途');
  assert.deepStrictEqual(during, before);
  assert.strictEqual(during.currentVersionNo, 1);
  assert.strictEqual(during.version.eventCount, 2);

  const after = readPublicChronicle();
  assert.strictEqual(after.currentVersionNo, 2);
  assert.strictEqual(after.version.eventCount, 3);
});

test('历史版本读取期间另一进程撤回该版：本次仍返回完整版本，新读取按不存在处理', () => {
  seedTwoVersionsWithRouteAndErrata();

  const before = readPublicVersion(2);
  assert.ok(before && before.version.versionNo === 2);

  const injection = injectCommitBeforeStatement(/FROM version_events/, () =>
    commitViaConnB((connB) =>
      connB
        .prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)')
        .run(2, '编年依据有误', '另一进程')
    )
  );
  const during = readPublicVersion(2);
  injection.restore();

  assert.ok(injection.fired(), '注入的撤回提交确实落在读取中途');
  assert.deepStrictEqual(during, before); // 同一快照：撤回前完整内容

  assert.strictEqual(readPublicVersion(2), null); // 撤回后按不存在处理（404）
  assert.ok(readPublicVersion(1)); // 未撤回版不受影响
});

test('路线详情读取期间另一进程撤回所据版本：本次仍返回完整路线，新读取 404', () => {
  const { routeNo } = seedTwoVersionsWithRouteAndErrata();

  const before = readPublicRoute(routeNo);
  assert.ok(before && before.route.routeNo === routeNo);

  const injection = injectCommitBeforeStatement(/FROM routes WHERE id/, () =>
    commitViaConnB((connB) =>
      connB
        .prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)')
        .run(2, '编年依据有误', '另一进程')
    )
  );
  const during = readPublicRoute(routeNo);
  injection.restore();

  assert.ok(injection.fired(), '注入的撤回提交确实落在读取中途');
  assert.deepStrictEqual(during, before);

  assert.strictEqual(readPublicRoute(routeNo), null); // 引用撤回版的路线按不存在处理
});

test('版本清单与路线清单读取期间另一进程撤回版本：清单整体落在撤回前或撤回后', () => {
  const { routeNo } = seedTwoVersionsWithRouteAndErrata();

  const versionsBefore = readPublicVersionList();
  const routesBefore = readPublicRouteList();
  assert.deepStrictEqual(versionsBefore.versions.map((v) => v.versionNo), [2, 1]);
  assert.deepStrictEqual(routesBefore.routes.map((r) => r.routeNo), [routeNo]);

  // 版本清单：注入撤回（在清单 SELECT 之前）
  const inj1 = injectCommitBeforeStatement(/FROM versions ORDER BY version_no DESC/, () =>
    commitViaConnB((connB) =>
      connB
        .prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)')
        .run(2, '编年依据有误', '另一进程')
    )
  );
  const versionsDuring = readPublicVersionList();
  inj1.restore();
  assert.ok(inj1.fired(), '注入的撤回提交确实落在版本清单读取中途');
  assert.deepStrictEqual(versionsDuring, versionsBefore); // 仍含第 2 版，currentVersionNo 仍为 2

  // 路线清单：同一已提交状态（撤回已生效）
  const inj2 = injectCommitBeforeStatement(/FROM routes r ORDER BY/, () =>
    commitViaConnB((connB) =>
      connB
        .prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)')
        .run(1, '再撤回第 1 版', '另一进程')
    )
  );
  const routesDuring = readPublicRouteList();
  inj2.restore();
  assert.ok(inj2.fired(), '注入的撤回提交确实落在路线清单读取中途');
  // 第 2 版已撤回（上一笔提交），第 1 版的撤回对本读取不可见：清单与「第 2 版撤回后」一致
  assert.deepStrictEqual(routesDuring, { routes: [] });

  const versionsAfter = readPublicVersionList();
  assert.deepStrictEqual(versionsAfter.versions, []);
  assert.strictEqual(versionsAfter.currentVersionNo, 0);
  assert.deepStrictEqual(readPublicRouteList(), { routes: [] });

  // 全部撤回后的最新年表：结构兼容（allRetracted）
  const chronicle = readPublicChronicle();
  assert.strictEqual(chronicle.published, false);
  assert.strictEqual(chronicle.allRetracted, true);
});

test('公开读取不阻塞另一进程写入：读事务打开期间写提交立即成功', () => {
  seedTwoVersionsWithRouteAndErrata();

  // 注入的提交使用 busy_timeout=300ms 的连接：若公开读取持有写锁，
  // 该提交会以 SQLITE_BUSY 失败；成功即证明读取不阻塞写入。
  let committed = false;
  const injection = injectCommitBeforeStatement(/FROM version_events/, () => {
    commitViaConnB((connB) =>
      connB.prepare('INSERT INTO source_redactions (source_text, editor) VALUES (?, ?)').run('王秀兰口述', '另一进程')
    );
    committed = true;
  });
  const during = readPublicChronicle();
  injection.restore();

  assert.ok(injection.fired() && committed, '读事务打开期间另一进程的写提交成功（未被阻塞）');
  // 本读取落在提交前：通水会出处未遮盖
  assert.strictEqual(during.version.events.find((e) => e.title === '通水会').source, '王秀兰口述');
  // 新读取落在提交后：已遮盖
  assert.strictEqual(readPublicChronicle().version.events.find((e) => e.title === '通水会').source, '出处已遮盖');
});

// ---------- 遮盖登记整请求只读一次（长路线 / 大版本不逐条重复扫描） ----------

test('遮盖登记在每个公开读取请求中只读一次（版本含附记时亦然）', () => {
  seedTwoVersionsWithRouteAndErrata();
  commitViaConnB((connB) => {
    connB.prepare('INSERT INTO source_redactions (source_text, editor) VALUES (?, ?)').run('李宝山口述', '编辑甲');
  });

  const chronicle = countStatements(/FROM source_redactions/, () => readPublicChronicle());
  assert.strictEqual(chronicle.count, 1, '最新年表（含附记）整请求只扫描一次遮盖登记');
  assert.strictEqual(chronicle.result.version.events.find((e) => e.title === '动员会').source, '出处已遮盖');

  const version = countStatements(/FROM source_redactions/, () => readPublicVersion(2));
  assert.strictEqual(version.count, 1, '历史版本读取整请求只扫描一次遮盖登记');

  const route = countStatements(/FROM source_redactions/, () => readPublicRoute(1));
  assert.strictEqual(route.count, 1, '路线详情读取整请求只扫描一次遮盖登记');
  assert.strictEqual(route.result.route.events.find((e) => e.title === '动员会').source, '出处已遮盖');

  const versionList = countStatements(/FROM source_redactions/, () => readPublicVersionList());
  assert.ok(versionList.count <= 1, '版本清单不逐条扫描遮盖登记');
  const routeList = countStatements(/FROM source_redactions/, () => readPublicRouteList());
  assert.ok(routeList.count <= 1, '路线清单不逐条扫描遮盖登记');
});

test('长链大版本与长路线读取：遮盖登记仍只读一次，行数增长不带来重复扫描', () => {
  // 300 事件逐日相接的长链（足以暴露「逐行查登记」的写法：那会发出数百条 SELECT）
  const N = 300;
  const selection = [];
  let prev = null;
  for (let i = 1; i <= N; i++) {
    const eid = insertEvent(`事件${i}`);
    const iso = isoFromOrdinal(ordinalFromIso('1950-01-01') + (i - 1));
    const [year, month, day] = iso.split('-').map(Number);
    const cid = insertClaim(eid, 'day', year, month, day, i % 7 === 0 ? '李宝山口述' : `出处${i}`);
    if (prev) {
      dbA.prepare('INSERT INTO relations (earlier_id, later_id, source) VALUES (?, ?, ?)').run(prev, eid, i % 9 === 0 ? '李宝山口述' : '');
    }
    selection.push({ eventId: eid, claimId: cid });
    prev = eid;
  }
  publish(selection, 0, '长链首版');
  const route = createRoute({ title: '长链路线', versionNo: 1, anchorEventIds: [selection[0].eventId, selection[N - 1].eventId] });
  commitViaConnB((connB) => {
    connB.prepare('INSERT INTO source_redactions (source_text, editor) VALUES (?, ?)').run('李宝山口述', '编辑甲');
  });

  const chronicle = countStatements(/FROM source_redactions/, () => readPublicChronicle());
  assert.strictEqual(chronicle.count, 1, '300 事件大版本读取只扫描一次遮盖登记');
  assert.strictEqual(chronicle.result.version.eventCount, N);
  // 事件 i（1 起）i % 7 === 0 的主张出处命中遮盖
  assert.strictEqual(
    chronicle.result.version.events.filter((e) => e.source === '出处已遮盖').length,
    Math.floor(N / 7)
  );

  const detail = countStatements(/FROM source_redactions/, () => readPublicRoute(route.routeNo));
  assert.strictEqual(detail.count, 1, '300 事件长路线读取只扫描一次遮盖登记');
  assert.strictEqual(detail.result.route.events.length, N);
  assert.strictEqual(detail.result.route.relations.length, N - 1);
  // 关系（i-1 → i）在 i % 9 === 0 时出处命中遮盖（i 取 2..N）
  assert.strictEqual(
    detail.result.route.relations.filter((r) => r.source === '出处已遮盖').length,
    Math.floor(N / 9)
  );
});

// ---------- 机制保证：五个公开读取的全部 SQL 都在同一个事务内执行 ----------

test('五个公开读取的全部 SQL 都在同一个只读事务内执行（同一快照的机制保证）', () => {
  const { routeNo } = seedTwoVersionsWithRouteAndErrata();
  const readers = {
    chronicle: () => readPublicChronicle(),
    versionList: () => readPublicVersionList(),
    version: () => readPublicVersion(2),
    routeList: () => readPublicRouteList(),
    route: () => readPublicRoute(routeNo),
  };
  for (const [name, read] of Object.entries(readers)) {
    const inTx = [];
    const original = dbA.prepare;
    dbA.prepare = function patchedPrepare(sql, ...rest) {
      const stmt = original.call(this, sql, ...rest);
      for (const method of ['get', 'all', 'run']) {
        const exec = stmt[method];
        stmt[method] = (...args) => {
          inTx.push(dbA.inTransaction);
          return exec.apply(stmt, args);
        };
      }
      return stmt;
    };
    try {
      read();
    } finally {
      dbA.prepare = original;
    }
    assert.ok(inTx.length > 0, `${name} 应执行了 SQL 语句`);
    assert.ok(
      inTx.every((t) => t === true),
      `${name} 的全部 ${inTx.length} 条语句都应在同一个事务内执行（同一 WAL 快照）`
    );
  }
});

// ---------- 响应结构兼容（未发布 / 对象不存在） ----------

test('未发布与不存在对象的结果结构保持兼容', () => {
  assert.deepStrictEqual(readPublicChronicle(), {
    published: false,
    message: '年表尚未发布任何版本',
  });
  assert.deepStrictEqual(readPublicVersionList(), { currentVersionNo: 0, versions: [] });
  assert.strictEqual(readPublicVersion(1), null);
  assert.strictEqual(readPublicVersion(Number('abc')), null); // 非法版本号 → 按不存在（NaN）
  assert.deepStrictEqual(readPublicRouteList(), { routes: [] });
  assert.strictEqual(readPublicRoute(1), null);
});
