'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseClaimDate,
  claimInterval,
  ordinalFromIso,
  isoFromOrdinal,
} = require('../src/dates');

test('日精度区间仅当天', () => {
  assert.deepStrictEqual(claimInterval('day', 1958, 9, 12), {
    start: '1958-09-12',
    end: '1958-09-12',
  });
});

test('月精度覆盖整月（含闰年 2 月）', () => {
  assert.deepStrictEqual(claimInterval('month', 2024, 2, null), {
    start: '2024-02-01',
    end: '2024-02-29',
  });
  assert.deepStrictEqual(claimInterval('month', 1958, 12, null), {
    start: '1958-12-01',
    end: '1958-12-31',
  });
});

test('年精度覆盖全年，且岁末接下一年元旦', () => {
  const iv = claimInterval('year', 1958, null, null);
  assert.strictEqual(iv.start, '1958-01-01');
  assert.strictEqual(iv.end, '1958-12-31');
  assert.strictEqual(ordinalFromIso(iv.end) + 1, ordinalFromIso('1959-01-01'));
});

test('序数日严格相邻', () => {
  assert.strictEqual(ordinalFromIso('1958-12-31') + 1, ordinalFromIso('1959-01-01'));
  assert.strictEqual(isoFromOrdinal(ordinalFromIso('2024-02-29')), '2024-02-29');
});

test('非法日期被拒绝', () => {
  assert.throws(() => parseClaimDate({ precision: 'day', year: 2023, month: 2, day: 29 }));
  assert.throws(() => parseClaimDate({ precision: 'month', year: 2023 }));
  assert.throws(() => parseClaimDate({ precision: 'bad', year: 2023 }));
});
