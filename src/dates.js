'use strict';

// 日期工具：以“日”为最小粒度的序数（UTC），支持年/月/日三种精度。
// 年精度覆盖整个公历年，月精度覆盖整个公历月，日精度仅当天。

const MS_PER_DAY = 86400000;

function pad2(n) {
  return String(n).padStart(2, '0');
}
function pad4(n) {
  return String(n).padStart(4, '0');
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 归一化并校验主张日期输入，返回 { precision, year, month, day }（不需要的部分为 null）。
function parseClaimDate(input = {}) {
  const precision = input.precision;
  if (!['year', 'month', 'day'].includes(precision)) {
    throw httpError(400, '日期精度必须是 year、month 或 day');
  }
  const year = Number(input.year);
  if (!isInt(year) || year < 1 || year > 9999) {
    throw httpError(400, '年份必须是 1 到 9999 之间的整数');
  }
  let month = null;
  let day = null;
  if (precision === 'month' || precision === 'day') {
    month = Number(input.month);
    if (!isInt(month) || month < 1 || month > 12) {
      throw httpError(400, '月精度主张需要 1 到 12 的月份');
    }
  }
  if (precision === 'day') {
    day = Number(input.day);
    const dim = daysInMonth(year, month);
    if (!isInt(day) || day < 1 || day > dim) {
      throw httpError(400, `${year} 年 ${month} 月没有第 ${input.day} 天`);
    }
  }
  return { precision, year, month, day };
}

function daysInMonth(year, month) {
  // 1-based 月份：下个月第 1 天的序数减去本月第 1 天即本月天数
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return ordinalFromYMD(nextYear, nextMonth, 1) - ordinalFromYMD(year, month, 1);
}

// 显式 setUTCFullYear，避免 Date 把 0-99 的年份解释成 19xx。
function ordinalFromYMD(year, month, day) {
  const d = new Date(Date.UTC(1970, 0, 1));
  d.setUTCFullYear(year, month - 1, day);
  return Math.round(d.getTime() / MS_PER_DAY);
}

function ymdFromOrdinal(ord) {
  const d = new Date(ord * MS_PER_DAY);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function isoFromOrdinal(ord) {
  const { year, month, day } = ymdFromOrdinal(ord);
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

function ordinalFromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`非法 ISO 日期: ${iso}`);
  return ordinalFromYMD(Number(m[1]), Number(m[2]), Number(m[3]));
}

// 返回主张覆盖的闭区间 [start, end]，均为 ISO 日期。
function claimInterval(precision, year, month, day) {
  if (precision === 'day') {
    const o = ordinalFromYMD(year, month, day);
    return { start: isoFromOrdinal(o), end: isoFromOrdinal(o) };
  }
  if (precision === 'month') {
    const start = ordinalFromYMD(year, month, 1);
    const endYear = month === 12 ? year + 1 : year;
    const endMonth = month === 12 ? 1 : month + 1;
    const end = ordinalFromYMD(endYear, endMonth, 1) - 1;
    return { start: isoFromOrdinal(start), end: isoFromOrdinal(end) };
  }
  // year
  const start = ordinalFromYMD(year, 1, 1);
  const end = ordinalFromYMD(year + 1, 1, 1) - 1;
  return { start: isoFromOrdinal(start), end: isoFromOrdinal(end) };
}

const PRECISION_LABEL = { year: '年', month: '月', day: '日' };

function formatClaimDate(precision, year, month, day) {
  if (precision === 'year') return `${year} 年`;
  if (precision === 'month') return `${year} 年 ${pad2(month)} 月`;
  return `${year} 年 ${pad2(month)} 月 ${pad2(day)} 日`;
}

module.exports = {
  parseClaimDate,
  claimInterval,
  ordinalFromIso,
  isoFromOrdinal,
  formatClaimDate,
  PRECISION_LABEL,
};
