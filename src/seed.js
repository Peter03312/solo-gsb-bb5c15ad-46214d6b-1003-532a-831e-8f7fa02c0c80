'use strict';

// 写入一组演示用口述史数据（仅草稿区），用于体验发布流程。
// 用法：SEED_DEMO=1 随容器启动执行一次；或 npm run seed
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { latestVersionNo } = require('./publish');

function run() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  if (count > 0) {
    console.log('草稿区已有数据，跳过演示数据写入。');
    return;
  }

  const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  const insClaim = db.prepare(`
    INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insRel = db.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');

  function addEvent(title, description, claims, rels = []) {
    const eid = insEvent.run(title, description).lastInsertRowid;
    for (const c of claims) {
      const { year, month, day } = parseClaimDate(c);
      const iv = claimInterval(c.precision, year, month, day);
      insClaim.run(
        eid, c.precision, year, month, day,
        formatClaimDate(c.precision, year, month, day),
        iv.start, iv.end, c.source, c.note || ''
      );
    }
    return { eid, rels };
  }

  const e1 = addEvent('修水渠动员会', '大队在晒谷场召开修建东干渠动员会。', [
    { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述，2021-07-05 访谈，录音 03 段 08:12', note: '受访人清楚记得是中秋节后第三天' },
    { precision: 'year', year: 1958, source: '《县水利志》1994 年版，第 87 页', note: '志书仅记年份' },
  ]);

  const e2 = addEvent('东干渠通水', '东干渠第一期工程通水至公社驻地。', [
    { precision: 'month', year: 1959, month: 5, source: '王秀兰口述，2021-08-02 访谈', note: '“割麦子前通的水”' },
    { precision: 'year', year: 1960, source: '公社档案 1960 年总结（全宗 12，目录 3，案卷 41）', note: '与口述存在出入，保留待考' },
  ]);

  const e3 = addEvent('第一台抽水机到站', '公社购置第一台柴油机抽水机。', [
    { precision: 'year', year: 1962, source: '张德福口述，2022-03-19 访谈', note: '“六二年困难时期刚缓过来”' },
    { precision: 'day', year: 1962, month: 10, day: 1, source: '《公社机电站志（手稿）》第 12 页' },
  ]);

  // 动员会 先于 通水 先于 抽水机到站
  insRel.run(e1.eid, e2.eid, '李宝山、王秀兰二人口述一致', '');
  insRel.run(e2.eid, e3.eid, '张德福口述：“先有水渠，后有抽水机”', '');

  console.log('演示数据已写入草稿区（3 个事件，含矛盾主张各 2 条，2 条先于关系）。');
  console.log(`当前已发布版本数：${latestVersionNo()}。请到 /editor 选择主张并发布。`);
}

run();
