'use strict';

// 访客公开读出的快照一致性测试（统一公开读取流程）。
//
// 需求：访客请求最新年表、历史版本、专题路线时，整份响应须取自**同一个已提交的
// 数据库状态**；读取期间另一服务进程发布新版本、撤回版本、登记出处遮盖或替代
// 勘误附记，应返回变更前或变更后的完整结果，不能混合版本可见性、出处与附记。
//
// 实现：src/public-read.js 把可见性判定（撤回版 / 引用撤回版的路线）与内容投影
// （出处遮盖、生效勘误附记）收敛进同一个延迟只读事务（同一 WAL 快照）。
//
// 与 test/concurrency.test.js 相同，这里用独立 better-sqlite3 连接模拟另一服务
// 进程：在读事务首次取快照之后、后续投影语句执行之前，让连接 B 在自己的写事务
// 里提交变更（撤回 / 发布 / 登记遮盖 / 替代附记）。统一流程下整个读取钉在变更前
// 快照上，结果完整为「变更前」；读取结束后再读即为「变更后」。
// 另含：遮盖登记表每请求只扫描一次、读事务不阻塞另一进程写入、HTTP 契约兼容。

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

process.env.EDITOR_TOKEN = 'test-token';

const { SCHEMA, setDb } = require('../src/db');
const {
  inReadSnapshot,
  publicChronicle,
  publicVersionList,
  publicVersionDetail,
  publicRouteList,
  publicRouteDetail,
} = require('../src/public-read');
const { publishVersion } = require('../src/publish');
const { claimInterval, formatClaimDate, isoFromOrdinal } = require('../src/dates');
const { createRoute } = require('../src/route');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-public-read-'));
const dbPath = path.join(tmpDir, 'public-read.db');

// 主连接（服务 A：模块内 getDb 使用它）
const dbA = new Database(dbPath);
dbA.pragma('journal_mode = WAL');
dbA.pragma('busy_timeout = 5000');
dbA.exec(SCHEMA);
setDb(dbA);

// 另一服务进程的连接
let connB;
function openConnB() {
  const c = new Database(dbPath);
  c.pragma('busy_timeout = 5000');
  return c;
}
function closeConn(c) {
  try {
    c.close();
  } catch {
    /* 已关闭 */
  }
}

after(() => {
  closeConn(connB);
  closeConn(dbA);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function resetData() {
  dbA.exec(`
    DELETE FROM edit_session_ops;
    DELETE FROM edit_sessions;
    DELETE FROM publish_schedules;
    DELETE FROM route_segments;
    DELETE FROM route_anchors;
    DELETE FROM routes;
    DELETE FROM errata;
    DELETE FROM version_retractions;
    DELETE FROM source_redactions;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM import_batches;
    DELETE FROM draft_restores;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
}

before(resetData);
beforeEach(resetData);

// ---------- 造数 ----------
function addEvent(title) {
  return dbA.prepare('INSERT INTO events (title, description) VALUES (?, ?)').run(title, '').lastInsertRowid;
}
function addClaim(eventId, { precision = 'day', year, month, day, source }) {
  const iv = claimInterval(precision, year, month, day);
  return dbA
    .prepare(
      `INSERT INTO claims
         (event_id, precision, year, month, day, date_label, interval_start, interval_end, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eventId, precision, year, month ?? null, day ?? null, formatClaimDate(precision, year, month, day), iv.start, iv.end, source)
    .lastInsertRowid;
}
function addRel(earlierId, laterId, source = '') {
  return dbA
    .prepare('INSERT INTO relations (earlier_id, later_id, source) VALUES (?, ?, ?)')
    .run(earlierId, laterId, source)
    .lastInsertRowid;
}

// 2 个事件（A 先于 B），各一条主张，一条关系；发布成版本（baseNo 指定基准）。
function seedPublishedVersion({ sourceA = '李宝山口述', sourceB = '王秀兰口述', relSource = '二人口述一致', baseNo = 0 } = {}) {
  const e1 = addEvent('动员会');
  const e2 = addEvent('通水会');
  const c1 = addClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: sourceA });
  const c2 = addClaim(e2, { precision: 'month', year: 1959, month: 5, source: sourceB });
  addRel(e1, e2, relSource);
  const out = publishVersion({
    selectionList: [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    baseVersionNo: baseNo,
    editor: '测试员',
  });
  return { e1, e2, c1, c2, versionNo: out.versionNo };
}

// 同一草稿连续发布两版：事件 A 有两条同日期不同出处的主张，v1 / v2 各选一条
// （正式发布要求覆盖草稿全部事件，故两版复用同一批事件，而不是新增事件）。
// v1.sourceA、v2.sourceA 不同，用于核对撤回后最新年表回退到 v1 的内容。
function seedTwoPublishedVersions({ v1SourceA = '首版出处', v2SourceA = '二版出处', sourceB = '王秀兰口述', relSource = '二人口述一致' } = {}) {
  const e1 = addEvent('动员会');
  const e2 = addEvent('通水会');
  const c1a = addClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: v1SourceA });
  const c2 = addClaim(e2, { precision: 'month', year: 1959, month: 5, source: sourceB });
  addRel(e1, e2, relSource);
  const v1 = publishVersion({
    selectionList: [
      { eventId: e1, claimId: c1a },
      { eventId: e2, claimId: c2 },
    ],
    baseVersionNo: 0,
    editor: '测试员',
  });
  const c1b = addClaim(e1, { precision: 'day', year: 1958, month: 9, day: 13, source: v2SourceA });
  const v2 = publishVersion({
    selectionList: [
      { eventId: e1, claimId: c1b },
      { eventId: e2, claimId: c2 },
    ],
    baseVersionNo: v1.versionNo,
    editor: '测试员',
  });
  return { e1, e2, c1a, c1b, c2, v1: v1.versionNo, v2: v2.versionNo };
}

// 另一连接在独立写事务中提交变更（模拟另一服务进程的已提交状态推进）。
function bCommit(fn) {
  return connB.transaction(fn).immediate();
}
const retractOnB = (no, reason = '编年依据错误（并发测试）') =>
  bCommit(() =>
    connB
      .prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)')
      .run(no, reason, '进程B')
  );
const registerRedactionOnB = (text) =>
  bCommit(() =>
    connB.prepare('INSERT INTO source_redactions (source_text, editor) VALUES (?, ?)').run(text, '进程B')
  );
const replaceErrataOnB = (versionNo, targetType, targetId, source, note = '进程 B 替代附记') =>
  bCommit(() =>
    connB
      .prepare(
        `INSERT INTO errata (version_no, target_type, target_id, note, source, editor, replaces_errata_id)
         SELECT ?, ?, ?, ?, ?, '进程B', MAX(id) FROM errata
          WHERE version_no = ? AND target_type = ? AND target_id = ?`
      )
      .run(versionNo, targetType, targetId, note, source, versionNo, targetType, targetId)
  );

// 在服务 A 的读事务执行到第一条 SQL 匹配 re 的语句**之后**，只触发一次 fn
// （通常是让连接 B 提交变更）。该语句执行时读事务已取得自己的 WAL 快照，
// 故触发后同一事务内的后续语句仍读变更前快照。返回 disarm，供核对触发确实发生。
function armOnFirstSql(re, fn) {
  const originalPrepare = dbA.prepare.bind(dbA);
  let armed = true;
  const wrap = (orig) =>
    function (...args) {
      const result = orig.apply(this, args);
      if (armed) {
        armed = false;
        dbA.prepare = originalPrepare;
        fn();
      }
      return result;
    };
  dbA.prepare = (sql, ...rest) => {
    const stmt = originalPrepare(sql, ...rest);
    if (armed && re.test(String(sql))) {
      stmt.get = wrap(stmt.get.bind(stmt));
      stmt.all = wrap(stmt.all.bind(stmt));
    }
    return stmt;
  };
  return () => {
    dbA.prepare = originalPrepare;
    return armed;
  };
}

// ---------- 一、读取期间撤回版本：整份响应停留在撤回前状态 ----------

test('历史版本详情：读快照后、撤回判定前另一进程撤回该版 → 仍完整返回该版（变更前），再读即 404', () => {
  const { versionNo, e1 } = seedPublishedVersion();
  connB = openConnB();
  // 触发点：取版本详情（versions 子查询）；触发后同一事务内才执行撤回判定
  const disarm = armOnFirstSql(/FROM version_events/, () => retractOnB(versionNo));

  const detail = publicVersionDetail(versionNo);
  assert.strictEqual(disarm(), false, '拦截器应已触发');
  assert.ok(detail, '变更前快照中该版未撤回，应完整返回');
  assert.strictEqual(detail.versionNo, versionNo);
  assert.strictEqual(detail.events.find((e) => e.eventId === e1).title, '动员会');
  assert.deepStrictEqual(detail.errata, []);

  // 读事务结束后：撤回已提交，新请求按变更后状态 → 404
  assert.strictEqual(publicVersionDetail(versionNo), null);
});

test('路线详情：读快照后、撤回判定前另一进程撤回所据版 → 仍返回路线（变更前），再读即 404', () => {
  const { versionNo, e1, e2 } = seedPublishedVersion();
  const route = createRoute({
    title: '专题路线',
    versionNo,
    anchorEventIds: [e1, e2],
  });
  connB = openConnB();
  // 触发点：读路线骨架（routes 行）；触发后同一事务内才执行 isRetracted 判定
  const disarm = armOnFirstSql(/FROM routes WHERE id/, () => retractOnB(versionNo));

  const got = publicRouteDetail(route.routeNo);
  assert.strictEqual(disarm(), false);
  assert.ok(got, '变更前快照中路线所据版未撤回，应完整返回');
  assert.strictEqual(got.routeNo, route.routeNo);
  assert.strictEqual(got.anchors.length, 2);
  assert.strictEqual(got.segments[0].eventIds[0], e1);

  assert.strictEqual(publicRouteDetail(route.routeNo), null);
});

test('路线清单：另一进程在清单读取期间撤回版本 → 清单与撤回集合同源，不含混合', () => {
  const { versionNo, e1, e2 } = seedPublishedVersion();
  const route = createRoute({ title: '专题路线', versionNo, anchorEventIds: [e1, e2] });
  connB = openConnB();

  // 触发点：撤回集合装载之后、路线清单 SELECT 之前撤回
  const disarm = armOnFirstSql(/FROM routes r/, () => retractOnB(versionNo));
  const before = publicRouteList();
  assert.strictEqual(disarm(), false);
  // 撤回集合取自变更前快照（未撤回），故清单仍含该路线
  assert.deepStrictEqual(before.routes.map((r) => r.routeNo), [route.routeNo]);

  // 再读即变更后：清单不含
  const after = publicRouteList();
  assert.deepStrictEqual(after.routes, []);
});

test('版本清单：另一进程在清单读取期间撤回 → currentVersionNo 与清单同源（整份变更前）', () => {
  resetData();
  const { v1, v2 } = seedTwoPublishedVersions();
  connB = openConnB();
  // 触发点：撤回集合先装载（SELECT version_retractions），在版本清单 SELECT 时撤回最新版
  const disarm = armOnFirstSql(/FROM versions ORDER BY/, () => retractOnB(v2));

  const before = publicVersionList();
  assert.strictEqual(disarm(), false);
  // 变更前：两版都在清单、currentVersionNo = 2
  assert.deepStrictEqual(before.versions.map((v) => v.versionNo), [2, 1]);
  assert.strictEqual(before.currentVersionNo, 2);

  const after = publicVersionList();
  assert.deepStrictEqual(after.versions.map((v) => v.versionNo), [1]);
  assert.strictEqual(after.currentVersionNo, 1);
});

test('最新年表：读快照后另一进程撤回最新版 → 仍指向被撤回前的最新版（完整变更前），再读即回退', () => {
  resetData();
  const { v1, v2 } = seedTwoPublishedVersions({ v1SourceA: '首版出处', v2SourceA: '二版出处' });
  connB = openConnB();
  // 触发点：latestVisibleVersionNo 已执行（取到变更前快照），在装载遮盖集合时撤回
  const disarm = armOnFirstSql(/FROM source_redactions/, () => retractOnB(v2));

  const before = publicChronicle();
  assert.strictEqual(disarm(), false);
  assert.strictEqual(before.published, true);
  assert.strictEqual(before.currentVersionNo, v2);
  assert.strictEqual(before.version.versionNo, v2);
  assert.strictEqual(before.version.events[0].source, '二版出处');

  const after = publicChronicle();
  assert.strictEqual(after.published, true);
  assert.strictEqual(after.currentVersionNo, v1);
  assert.strictEqual(after.version.events[0].source, '首版出处');
});

test('最新年表：全部撤回发生在读快照之后 → 本次仍可读，再读返回 allRetracted', () => {
  const { versionNo } = seedPublishedVersion();
  connB = openConnB();
  const disarm = armOnFirstSql(/FROM source_redactions/, () => retractOnB(versionNo));

  const before = publicChronicle();
  assert.strictEqual(disarm(), false);
  assert.strictEqual(before.published, true);
  assert.strictEqual(before.currentVersionNo, versionNo);

  const after = publicChronicle();
  assert.strictEqual(after.published, false);
  assert.strictEqual(after.allRetracted, true);
  assert.match(after.message, /均已撤回/);
});

// ---------- 二、读取期间发布新版本：整份响应停留在发布前 ----------

test('最新年表：读快照后另一进程发布新版本 → 本次仍为旧版（不混合），再读才是新版', () => {
  const v1 = seedPublishedVersion();
  connB = openConnB();
  // 在 A 的读事务内、装载遮盖集合时，由 B 把草稿再发一版
  const disarm = armOnFirstSql(/FROM source_redactions/, () => {
    bCommit(() => {
      // 用 B 连接走完整发布流程（模块 getDb 仍是 A；发布仅为造数，直接插快照等价）
      const before = connB.prepare('SELECT MAX(version_no) AS n FROM versions').get().n;
      connB
        .prepare('INSERT INTO versions (version_no, parent_no, editor, note) VALUES (?, ?, ?, ?)')
        .run(before + 1, before, '进程B', '读取期间发布');
      const vid = connB.prepare('SELECT id FROM versions WHERE version_no = ?').get(before + 1).id;
      connB
        .prepare(
          `INSERT INTO version_events
             (version_id, event_id, title, description, claim_id, precision, date_label,
              interval_start, interval_end, resolved_date, source, claim_note, sort_order)
           SELECT ?, event_id, '读取期间新事件', '', claim_id, precision, date_label,
                  interval_start, interval_end, resolved_date, source, claim_note, sort_order
             FROM version_events WHERE version_id = (SELECT id FROM versions WHERE version_no = ?)`
        )
        .run(vid, before);
      connB
        .prepare(
          `INSERT INTO version_relations
             (version_id, relation_id, earlier_event_id, later_event_id, source, note, sort_order)
           SELECT ?, relation_id, earlier_event_id, later_event_id, source, note, sort_order
             FROM version_relations WHERE version_id = (SELECT id FROM versions WHERE version_no = ?)`
        )
        .run(vid, before);
    });
  });

  const before = publicChronicle();
  assert.strictEqual(disarm(), false);
  assert.strictEqual(before.published, true);
  assert.strictEqual(before.currentVersionNo, v1.versionNo, '本次响应必须停留在变更前');
  assert.strictEqual(before.version.title, undefined); // 结构不变（summary 字段无 title）
  assert.ok(!before.version.events.some((e) => e.title === '读取期间新事件'));

  const after = publicChronicle();
  assert.strictEqual(after.currentVersionNo, v1.versionNo + 1);
  assert.ok(after.version.events.some((e) => e.title === '读取期间新事件'));
});

test('最新年表：从未发布时读快照后另一进程发布首版 → 本次仍未发布，再读即为已发布', () => {
  resetData();
  connB = openConnB();
  // no === 0 分支：latestVisibleVersionNo 与 latestVersionNo 之后才返回；
  // 在 versions 统计语句（MAX(version_no)）处触发 B 发布
  const disarm = armOnFirstSql(/FROM versions\s*$/, () => {
    bCommit(() => {
      connB.prepare('INSERT INTO versions (version_no, parent_no, editor, note) VALUES (1, 0, ?, ?)').run('B', '');
      const vid = connB.prepare('SELECT id FROM versions WHERE version_no = 1').get().id;
      connB
        .prepare(
          `INSERT INTO version_events
             (version_id, event_id, title, description, claim_id, precision, date_label,
              interval_start, interval_end, resolved_date, source, claim_note, sort_order)
           VALUES (?, 1, '新事件', '', 1, 'year', '2000 年', '2000-01-01', '2000-12-31', '2000-06-15', 'x', '', 0)`
        )
        .run(vid);
    });
  });

  const before = publicChronicle();
  assert.strictEqual(disarm(), false);
  assert.strictEqual(before.published, false);
  assert.strictEqual(before.allRetracted, undefined);
  assert.match(before.message, /尚未发布/);

  const after = publicChronicle();
  assert.strictEqual(after.published, true);
  assert.strictEqual(after.currentVersionNo, 1);
});

// ---------- 三、读取期间登记出处遮盖：版本出处与附记出处同批生效，不半遮盖 ----------

test('最新年表：读快照后另一进程登记遮盖 → 版本出处与附记出处都保持变更前（不混合遮盖）', () => {
  const { versionNo, e1 } = seedPublishedVersion({ sourceA: '受访人赵某访谈第3页' });
  dbA.prepare(
    `INSERT INTO errata (version_no, target_type, target_id, note, source, editor)
     VALUES (?, 'event', ?, '首条附记', '受访人赵某访谈第3页', '编辑甲')`
  ).run(versionNo, e1);
  connB = openConnB();
  // 触发点：遮盖集合装载（SELECT source_text）——它只在事务内装载这一次，
  // 版本投影与附记投影共用该集合；在装载后、投影前由 B 登记遮盖。
  const disarm = armOnFirstSql(/FROM source_redactions/, () =>
    registerRedactionOnB('受访人赵某访谈第3页')
  );

  const before = publicChronicle();
  assert.strictEqual(disarm(), false);
  // 变更前：快照出处与附记出处都为原文（不会出现一个遮盖、一个未遮盖的混合）
  assert.strictEqual(before.version.events.find((e) => e.eventId === e1).source, '受访人赵某访谈第3页');
  assert.strictEqual(before.version.errata.length, 1);
  assert.strictEqual(before.version.errata[0].source, '受访人赵某访谈第3页');

  // 再读即变更后：两处都显示「出处已遮盖」
  const after = publicChronicle();
  assert.strictEqual(after.version.events.find((e) => e.eventId === e1).source, '出处已遮盖');
  assert.strictEqual(after.version.errata[0].source, '出处已遮盖');
});

test('路线详情：读快照后登记遮盖 → 路线内全部出处保持变更前；再读统一遮盖', () => {
  const { versionNo, e1, e2 } = seedPublishedVersion({
    sourceA: '路线遮盖出处',
    relSource: '路线遮盖出处',
  });
  const route = createRoute({ title: '遮盖路线', versionNo, anchorEventIds: [e1, e2] });
  // 变更后基线：先登记遮盖，验证再读时事件与关系出处都被遮盖
  dbA.prepare('INSERT INTO source_redactions (source_text, editor) VALUES (?, ?)').run('路线遮盖出处', '甲');
  const masked = publicRouteDetail(route.routeNo);
  assert.strictEqual(masked.events.find((e) => e.eventId === e1).source, '出处已遮盖');
  assert.strictEqual(masked.relations[0].source, '出处已遮盖');
  dbA.prepare('DELETE FROM source_redactions').run();

  connB = openConnB();
  const disarm = armOnFirstSql(/FROM source_redactions/, () => registerRedactionOnB('路线遮盖出处'));
  const before = publicRouteDetail(route.routeNo);
  assert.strictEqual(disarm(), false);
  assert.strictEqual(before.events.find((e) => e.eventId === e1).source, '路线遮盖出处');
  assert.strictEqual(before.relations[0].source, '路线遮盖出处');
});

// ---------- 四、读取期间替代勘误附记：生效附记与版本同源 ----------

test('最新年表：读快照后另一进程替代附记 → 本次仍是旧生效附记，再读才是新附记', () => {
  const { versionNo, e1 } = seedPublishedVersion();
  dbA.prepare(
    `INSERT INTO errata (version_no, target_type, target_id, note, source, editor)
     VALUES (?, 'event', ?, '旧附记', '旧附记出处', '编辑甲')`
  ).run(versionNo, e1);
  connB = openConnB();
  // 触发点：版本详情已读出（含 targetInfo 所需事件），在生效附记查询时 B 提交替代
  const disarm = armOnFirstSql(/FROM errata e/, () =>
    replaceErrataOnB(versionNo, 'event', e1, '新附记出处', '新附记')
  );

  const before = publicChronicle();
  assert.strictEqual(disarm(), false);
  assert.strictEqual(before.version.errata.length, 1);
  assert.strictEqual(before.version.errata[0].note, '旧附记');
  assert.strictEqual(before.version.errata[0].source, '旧附记出处');
  assert.strictEqual(before.version.errata[0].replacesErrataId, null);

  const after = publicChronicle();
  assert.strictEqual(after.version.errata.length, 1);
  assert.strictEqual(after.version.errata[0].note, '新附记');
  assert.strictEqual(after.version.errata[0].source, '新附记出处');
  assert.strictEqual(after.version.errata[0].replacesErrataId, 1);
});

// ---------- 五、撤回可见性在同一快照内判定（撤回版与引用它的路线仍不可见） ----------

test('撤回版与引用它的路线在变更后状态下整体不可见；未撤回部分不受影响', () => {
  resetData();
  const { e1, e2, v1, v2 } = seedTwoPublishedVersions();
  const route2 = createRoute({ title: '据二版', versionNo: v2, anchorEventIds: [e1, e2] });

  // 撤回前都可见
  assert.ok(publicVersionDetail(v2));
  assert.ok(publicRouteDetail(route2.routeNo));

  dbA.prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)').run(
    v2,
    '依据错误',
    '甲'
  );

  // 撤回版不可见
  assert.strictEqual(publicVersionDetail(v2), null);
  // 引用撤回版的路线不可见
  assert.strictEqual(publicRouteDetail(route2.routeNo), null);
  // 最新年表回退到未撤回版
  assert.strictEqual(publicChronicle().currentVersionNo, v1);
  // 清单不含撤回版
  assert.deepStrictEqual(publicVersionList().versions.map((v) => v.versionNo), [v1]);
  assert.deepStrictEqual(publicRouteList().routes, []);
});

test('不存在对象：版本 / 路线详情稳定返回 null（404 由路由层输出），无版本时未发布 / 全撤回形态不变', () => {
  resetData();
  assert.strictEqual(publicVersionDetail(999), null);
  assert.strictEqual(publicRouteDetail(999), null);

  const none = publicChronicle();
  assert.strictEqual(none.published, false);
  assert.strictEqual(none.allRetracted, undefined);

  const v = seedPublishedVersion();
  dbA.prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)').run(
    v.versionNo,
    'x',
    '甲'
  );
  const all = publicChronicle();
  assert.strictEqual(all.published, false);
  assert.strictEqual(all.allRetracted, true);
});

// ---------- 六、性能：遮盖登记表每请求只装载（全表扫描）一次 ----------

// 统计一次读取期间针对某张表的 SELECT 执行次数。
function countSelectsDuring(tableRe, fn) {
  let count = 0;
  const originalPrepare = dbA.prepare.bind(dbA);
  const countMethod = (orig) =>
    function (...args) {
      count += 1;
      return orig.apply(this, args);
    };
  dbA.prepare = (sql, ...rest) => {
    const stmt = originalPrepare(sql, ...rest);
    if (tableRe.test(String(sql))) {
      stmt.get = countMethod(stmt.get.bind(stmt));
      stmt.all = countMethod(stmt.all.bind(stmt));
    }
    return stmt;
  };
  try {
    const result = fn();
    return { count, result };
  } finally {
    dbA.prepare = originalPrepare;
  }
}

test('长路线 / 大版本读取：source_redactions 全表只扫描一次，与事件 / 关系条数无关', () => {
  resetData();
  // 造一条逐日长链版本：N 个事件、N-1 条关系，全部同一出处
  const N = 1500;
  const events = [];
  const selection = [];
  const base = Date.UTC(1958, 0, 1) / 86400000;
  for (let i = 0; i < N; i++) {
    const eid = addEvent(`长链事件 ${i + 1}`);
    const ord = base + i;
    const iso = isoFromOrdinal(ord);
    const [y, m, d] = iso.split('-').map(Number);
    const cid = addClaim(eid, { precision: 'day', year: y, month: m, day: d, source: '链上出处' });
    events.push(eid);
    selection.push({ eventId: eid, claimId: cid });
    if (i > 0) addRel(events[i - 1], eid, '链上出处');
  }
  // 登记一批遮盖文本（其中一条命中），迫使投影做集合比对
  for (let i = 0; i < 200; i++) {
    dbA.prepare('INSERT INTO source_redactions (source_text) VALUES (?)').run(`不相关出处 ${i}`);
  }
  dbA.prepare('INSERT INTO source_redactions (source_text) VALUES (?)').run('链上出处');
  const pub = publishVersion({ selectionList: selection, baseVersionNo: 0 });
  const route = createRoute({ title: '长链路线', versionNo: pub.versionNo, anchorEventIds: [events[0], events[N - 1]] });

  const chronicle = countSelectsDuring(/FROM source_redactions/, () => publicChronicle());
  assert.strictEqual(chronicle.count, 1, '最新年表只能全表装载一次遮盖集合');
  assert.strictEqual(chronicle.result.version.events.length, N);
  assert.ok(chronicle.result.version.events.every((e) => e.source === '出处已遮盖'));

  const detail = countSelectsDuring(/FROM source_redactions/, () => publicVersionDetail(pub.versionNo));
  assert.strictEqual(detail.count, 1, '历史版本详情只能全表装载一次遮盖集合');

  const routeRead = countSelectsDuring(/FROM source_redactions/, () => publicRouteDetail(route.routeNo));
  assert.strictEqual(routeRead.count, 1, '长路线详情只能全表装载一次遮盖集合');
  // 长路线见证链命中遮盖
  assert.ok(routeRead.result.relations.length >= N - 1);
  assert.ok(routeRead.result.relations.every((r) => r.source === '出处已遮盖'));

  // 清单端点不需要遮盖集合
  assert.strictEqual(countSelectsDuring(/FROM source_redactions/, () => publicVersionList()).count, 0);
  assert.strictEqual(countSelectsDuring(/FROM source_redactions/, () => publicRouteList()).count, 0);
});

// ---------- 七、不阻塞其他进程写入（WAL 延迟只读事务） ----------

test('公开读取持同一快照期间，另一进程的写事务可立即提交，且读取仍只见变更前状态', () => {
  const { versionNo } = seedPublishedVersion();
  connB = openConnB();

  let writeTookMs = Infinity;
  let visibleDuringRead;
  let stillVisible;
  inReadSnapshot(() => {
    const { latestVisibleVersionNo } = require('../src/retract');
    // 事务内先执行一条 SELECT，取得本次读快照
    visibleDuringRead = latestVisibleVersionNo();
    // 读快照已固定：另一进程在此期间提交撤回
    const t0 = process.hrtime.bigint();
    retractOnB(versionNo);
    writeTookMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // 同一读事务内仍只见变更前：该版未撤回
    stillVisible = latestVisibleVersionNo();
  });

  assert.strictEqual(visibleDuringRead, versionNo);
  assert.ok(writeTookMs < 1000, `另一进程写入被读事务阻塞：${writeTookMs.toFixed(1)}ms`);
  assert.strictEqual(stillVisible, versionNo, '读事务内快照不被另一进程提交改变');
  // 读事务结束后新状态可见
  assert.strictEqual(publicChronicle().published, false);
});

// ---------- 八、HTTP API 契约：路径 / 状态码 / 字段 / 未发布 / 全撤回 / 404 兼容 ----------

test('HTTP 公开接口契约保持兼容', async () => {
  resetData();
  const { app } = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url) => fetch(base + url).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    // 未发布
    let r = await get('/api/public/chronicle');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.published, false);
    assert.strictEqual(r.json.allRetracted, undefined);

    r = await get('/api/public/versions');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { currentVersionNo: 0, versions: [] });

    r = await get('/api/public/versions/1');
    assert.strictEqual(r.status, 404);
    assert.match(r.json.message, /版本 1 不存在/);

    r = await get('/api/public/routes');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { routes: [] });

    r = await get('/api/public/routes/1');
    assert.strictEqual(r.status, 404);
    assert.match(r.json.message, /路线 1 不存在/);

    // 非法路线号仍为 400
    r = await fetch(base + '/api/public/routes/0').then(async (x) => ({ status: x.status, json: await x.json() }));
    assert.strictEqual(r.status, 400);

    // 发布一版后字段结构不变
    const seeded = seedPublishedVersion();
    r = await get('/api/public/chronicle');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.published, true);
    assert.strictEqual(r.json.currentVersionNo, seeded.versionNo);
    assert.ok(r.json.version.versionNo);
    assert.ok(Array.isArray(r.json.version.events));
    assert.ok(Array.isArray(r.json.version.relations));
    assert.ok(Array.isArray(r.json.version.errata));

    r = await get('/api/public/versions');
    assert.strictEqual(r.json.versions[0].versionNo, seeded.versionNo);
    assert.ok('publishedAt' in r.json.versions[0] && 'parentNo' in r.json.versions[0]);

    // 全部撤回
    dbA.prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)').run(
      seeded.versionNo,
      '依据错误',
      '甲'
    );
    r = await get('/api/public/chronicle');
    assert.strictEqual(r.json.published, false);
    assert.strictEqual(r.json.allRetracted, true);
    r = await get(`/api/public/versions/${seeded.versionNo}`);
    assert.strictEqual(r.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
