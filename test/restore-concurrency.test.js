'use strict';

// 「从历史版本恢复草稿」预览 / 确认的并发一致性测试（模拟两个服务进程共用同一 SQLite 文件）。
//
// 修复前的问题：buildRestorePreview 对「当前草稿（事件 / 主张 / 关系）」「草稿修订号」
// 「最新版本号」分次独立 SELECT（各自取最新 WAL 快照）。两个进程共用同一库时，
// 另一进程若在「读草稿」与「读修订号」之间写入事件 / 主张 / 关系（或发布新版本），
// 预览就可能展示旧草稿内容却返回新修订号 / 新版本号——随后确认按新修订号校验会通过，
// 于是把预览中从未展示过的改动随清空一并删除。
//
// 本轮修复：
//   1. buildRestorePreview 在同一只读事务（同一 WAL 快照）内读出目标版本、当前草稿
//      （全部事件 / 主张 / 关系）、草稿修订号与最新版本号，四者对应同一数据库状态；
//      预览只发 SELECT，不写任何数据。另一进程在读取窗口内提交只会让整份预览整体
//      落在提交前或提交后的快照上，不再产生「旧内容配新修订号」的混合结果。
//   2. restoreDraftFromVersion 以 BEGIN IMMEDIATE 取写锁后再核对修订号 / 最新版本号 /
//      目标版本；预览后草稿或最新版本变化沿用既有 409（DRAFT_REVISION_CONFLICT /
//      VERSION_CONFLICT），整次不改库；写锁等待超时同样归为草稿冲突（不透传 500）。
//
// 与 concurrency.test.js 相同：用独立 better-sqlite3 连接复现，SQLite 文件锁 /
// WAL 快照语义与两个真实进程完全一致。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { SCHEMA, setDb } = require('../src/db');
const { buildRestorePreview, restoreDraftFromVersion } = require('../src/restore');
const { publishVersion } = require('../src/publish');
const { claimInterval, formatClaimDate } = require('../src/dates');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-restore-cc-'));
const dbPath = path.join(tmpDir, 'restore-concurrency.db');

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
    DELETE FROM draft_restores;
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

// 直接插草稿：2 事件（动员会 先于 通水会）各 1 条主张，并发布第 1 版
function seedV1() {
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
  publishVersion({
    selectionList: [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    baseVersionNo: 0,
    editor: '甲',
    note: '首版',
  });
  return { e1, e2, c1, c2 };
}

// 另一连接在单事务内一次性写入「新事件 + 其主张 + 一条关系」：
// 事件/主张/关系三条 INSERT 各推进一次修订号（共 +3）。
function mutateDraftAtomically(conn) {
  return conn
    .transaction(() => {
      const eid = conn
        .prepare('INSERT INTO events (title, description) VALUES (?, ?)')
        .run('另一进程插入的事件', '')
        .lastInsertRowid;
      conn
        .prepare(
          `INSERT INTO claims
             (event_id, precision, year, date_label, interval_start, interval_end, source)
           VALUES (?, 'year', 2000, '2000 年', '2000-01-01', '2000-12-31', '另一进程的出处')`
        )
        .run(eid);
      conn
        .prepare('INSERT INTO relations (earlier_id, later_id, source) VALUES (?, ?, ?)')
        .run(1, eid, '另一进程补的关系');
      return {
        eventId: eid,
        revision: conn.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision,
      };
    })
    .immediate();
}

test('恢复预览：目标版本/当前草稿/修订号/最新版本号在同一快照读出；读草稿期间另一连接提交不产生混合内容', () => {
  resetData();
  seedV1();
  const connB = openConnB();
  try {
    const revBefore = dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;

    // 在预览读到事件、尚未读到关系表 / 修订号时，让另一连接提交一次完整草稿写入。
    // 修复前：currentDraft 是旧内容（2 事件），draftRevisionNo 却是写入后的新值。
    const originalPrepare = dbA.prepare.bind(dbA);
    let armed = true;
    let fired = false;
    dbA.prepare = (sql, ...rest) => {
      const stmt = originalPrepare(sql, ...rest);
      if (armed && /FROM relations ORDER BY id/.test(String(sql))) {
        const originalAll = stmt.all.bind(stmt);
        stmt.all = (...args) => {
          if (armed) {
            armed = false;
            fired = true;
            dbA.prepare = originalPrepare;
            mutateDraftAtomically(connB);
          }
          return originalAll(...args);
        };
      }
      return stmt;
    };

    const preview = buildRestorePreview(1);
    dbA.prepare = originalPrepare;
    assert.strictEqual(fired, true, '拦截器应在预览读关系表时触发');

    const revAfter = dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
    assert.strictEqual(revAfter, revBefore + 3);

    // 修复后：预览整体固定在「另一连接提交前」的快照——草稿是旧内容，
    // 修订号也必须是旧值（修复前这里会是 revAfter，新旧混合）。
    assert.strictEqual(preview.draftRevisionNo, revBefore, '预览修订号必须与所展示草稿同源（旧快照）');
    assert.strictEqual(preview.currentVersionNo, 1);
    assert.strictEqual(preview.currentDraft.counts.eventCount, 2);
    assert.strictEqual(preview.currentDraft.counts.claimCount, 2);
    assert.strictEqual(preview.currentDraft.counts.relationCount, 1);
    assert.ok(!preview.currentDraft.events.some((e) => e.title === '另一进程插入的事件'));
    assert.strictEqual(preview.version.versionNo, 1);
    assert.strictEqual(preview.version.events.length, 2);

    // 事务结束后新状态才可见
    const fresh = buildRestorePreview(1);
    assert.strictEqual(fresh.draftRevisionNo, revAfter);
    assert.strictEqual(fresh.currentDraft.counts.eventCount, 3);
    assert.ok(fresh.currentDraft.events.some((e) => e.title === '另一进程插入的事件'));
  } finally {
    closeConn(connB);
  }
});

test('恢复预览只读：另一连接多次提交前后，预览本身不写库（修订号不因预览推进）', () => {
  resetData();
  seedV1();
  const connB = openConnB();
  try {
    const rev0 = dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
    buildRestorePreview(1);
    buildRestorePreview(1);
    assert.strictEqual(dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision, rev0);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM draft_restores').get().n, 0);

    // 另一连接提交后再预览：修订号是对方推进的值，预览自身仍不推进
    const { revision } = mutateDraftAtomically(connB);
    buildRestorePreview(1);
    assert.strictEqual(dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision, revision);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM draft_restores').get().n, 0);
  } finally {
    closeConn(connB);
  }
});

test('确认恢复：另一连接在预览与确认之间写入草稿 → 409 DRAFT_REVISION_CONFLICT，草稿保持对方改动', () => {
  resetData();
  const { e1 } = seedV1();
  const connB = openConnB();
  try {
    const preview = buildRestorePreview(1);
    assert.strictEqual(preview.draftRevisionNo, dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision);

    const { eventId, revision } = mutateDraftAtomically(connB);

    let err;
    try {
      restoreDraftFromVersion({
        versionNo: 1,
        expectedRevision: preview.draftRevisionNo,
        expectedLatestVersionNo: preview.currentVersionNo,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '预览后草稿被另一进程改过，确认应抛 409');
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.code, 'DRAFT_REVISION_CONFLICT');
    assert.strictEqual(err.expectedRevisionNo, preview.draftRevisionNo);
    assert.strictEqual(err.currentRevisionNo, revision);

    // 整次不改库：另一进程写入的事件 / 主张 / 关系仍在，原有两事件也未被删
    const titles = dbA.prepare('SELECT title FROM events ORDER BY id').all().map((r) => r.title);
    assert.deepStrictEqual(titles, ['动员会', '通水会', '另一进程插入的事件']);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 3);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM relations').get().n, 2);
    assert.ok(dbA.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId));
    assert.ok(dbA.prepare('SELECT 1 FROM events WHERE id = ?').get(e1));
    assert.strictEqual(dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision, revision);
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM draft_restores').get().n, 0);
  } finally {
    closeConn(connB);
  }
});

test('确认恢复：另一连接在预览与确认之间发布新版本 → 409 VERSION_CONFLICT，草稿与版本均不动', () => {
  resetData();
  seedV1();
  const connB = openConnB();
  try {
    const preview = buildRestorePreview(1);

    // 另一连接改草稿并发布第 2 版（最新版本号 1 → 2）
    connB
      .transaction(() => {
        const eid = connB
          .prepare('INSERT INTO events (title, description) VALUES (?, ?)')
          .run('另一进程发布的事件', '')
          .lastInsertRowid;
        const cid = connB
          .prepare(
            `INSERT INTO claims
               (event_id, precision, year, date_label, interval_start, interval_end, source)
             VALUES (?, 'year', 1962, '1962 年', '1962-01-01', '1962-12-31', '张德福口述')`
          )
          .run(eid)
          .lastInsertRowid;
        // 直接在连接 B 上插入第 2 版快照（模拟另一进程发布；版本行与快照行同事务）
        const vid = connB
          .prepare('INSERT INTO versions (version_no, parent_no, editor, note) VALUES (2, 1, ?, ?)')
          .run('乙', '另一进程发布')
          .lastInsertRowid;
        connB
          .prepare(
            `INSERT INTO version_events
               (version_id, event_id, title, description, claim_id, precision, date_label,
                interval_start, interval_end, resolved_date, source, claim_note, sort_order)
             VALUES (?, ?, ?, '', ?, 'year', '1962 年', '1962-01-01', '1962-12-31', '1962-06-01', '张德福口述', '', 0)`
          )
          .run(vid, eid, '另一进程发布的事件', cid);
      })
      .immediate();

    let err;
    try {
      restoreDraftFromVersion({
        versionNo: 1,
        expectedRevision: preview.draftRevisionNo,
        expectedLatestVersionNo: preview.currentVersionNo,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '预览后最新版本被推进，确认应抛 409');
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.code, 'VERSION_CONFLICT');
    assert.strictEqual(err.expectedVersionNo, 1);
    assert.strictEqual(err.currentVersionNo, 2);

    // 草稿未被恢复操作改动（含另一进程的新事件），两版快照都在
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM events').get().n, 3);
    assert.deepStrictEqual(
      dbA.prepare('SELECT version_no AS no FROM versions ORDER BY version_no').all().map((r) => r.no),
      [1, 2]
    );
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM draft_restores').get().n, 0);
  } finally {
    closeConn(connB);
  }
});

test('确认恢复：另一连接持有写事务导致写锁等待超时 → 409 草稿冲突，草稿不变', () => {
  resetData();
  seedV1();
  const connB = openConnB(5000);
  dbA.pragma('busy_timeout = 150');
  try {
    const preview = buildRestorePreview(1);
    const hold = connB.transaction(() => {
      connB.prepare("UPDATE events SET title = '服务 B 暂存中' WHERE id = 1").run();
      // 服务 A 此时 BEGIN IMMEDIATE 取写锁：等不到锁 → 409 草稿冲突
      let err;
      try {
        restoreDraftFromVersion({
          versionNo: 1,
          expectedRevision: preview.draftRevisionNo,
          expectedLatestVersionNo: preview.currentVersionNo,
        });
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

    // 服务 B 回滚后草稿原样：仍是两事件、首事件标题未变、无恢复登记
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
    assert.strictEqual(dbA.prepare('SELECT title FROM events WHERE id = 1').get().title, '动员会');
    assert.strictEqual(dbA.prepare('SELECT COUNT(*) AS n FROM draft_restores').get().n, 0);
  } finally {
    dbA.pragma('busy_timeout = 5000');
    closeConn(connB);
  }
});

test('确认恢复：无并发改动时成功，返回的草稿/修订号/最新版本号同源且只复制被选主张', () => {
  resetData();
  const { e1, c1 } = seedV1();
  // 给动员会再补一条未选矛盾主张（确认恢复后不应被复制）
  dbA
    .prepare(
      `INSERT INTO claims (event_id, precision, year, date_label, interval_start, interval_end, source)
       VALUES (?, 'year', 1958, '1958 年', '1958-01-01', '1958-12-31', '未选的县志出处')`
    )
    .run(e1);
  const preview = buildRestorePreview(1);

  const out = restoreDraftFromVersion({
    versionNo: 1,
    expectedRevision: preview.draftRevisionNo,
    expectedLatestVersionNo: preview.currentVersionNo,
  });

  assert.strictEqual(out.restoredFromVersionNo, 1);
  assert.strictEqual(out.currentVersionNo, 1);
  assert.strictEqual(out.revisionNo, preview.draftRevisionNo + 1);
  assert.strictEqual(out.draft.counts.eventCount, 2);
  assert.strictEqual(out.draft.counts.claimCount, 2, '每事件只复制当版被选的一条主张');
  assert.strictEqual(out.draft.counts.relationCount, 1);
  const hui = out.draft.events.find((e) => e.title === '动员会');
  assert.strictEqual(hui.claims.length, 1);
  assert.strictEqual(hui.claims[0].id, out.idMap.events.find((m) => m.oldEventId === e1).newClaimId);
  assert.strictEqual(hui.claims[0].source, '李宝山口述');
  const huiMap = out.idMap.events.find((m) => m.oldEventId === e1);
  assert.strictEqual(hui.claims[0].id, huiMap.newClaimId);
  assert.strictEqual(huiMap.oldClaimId, c1, '映射保留旧快照主张 id');
  // 新草稿编号已重排：动员会为事件 1、其被选主张为主张 1
  assert.strictEqual(hui.id, 1);
  assert.strictEqual(hui.claims[0].id, 1);
  // 响应中的修订号与库里一致、最新版本号未变（快照不动）
  assert.strictEqual(dbA.prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision, out.revisionNo);
  assert.strictEqual(dbA.prepare('SELECT MAX(version_no) AS no FROM versions').get().no, 1);
});
