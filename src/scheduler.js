'use strict';

// 预约发布的进程内调度器：周期性检查到期 pending 预约，并在服务启动时立即补跑一次。
//
// 重启安全：所有状态都在 SQLite（publish_schedules.status）。服务停机期间到期的预约
// 会在下次启动（runDueSchedules）时立即补执行，不丢失；执行过的预约不是 pending，
// 重复触发 / 重启不会重复发布。
//
// 发布原子性见 schedule.js：每条预约在单事务内「基准检查 + 写版本 + 翻状态」，
// 失败整体回滚仍为 pending，下一轮重试，绝不留半版。

const { runDueSchedules } = require('./schedule');

const DEFAULT_TICK_MS = 1000;

let timer = null;
let started = false;
let tickMs = DEFAULT_TICK_MS;

// 立即触发一次处理（新建预约时无需等待下一个 tick）；上一轮仍在跑则跳过。
function kick() {
  if (!started) return; // 调度器未启动（如测试环境）
  try {
    runDueSchedules();
  } catch (err) {
    console.error('预约发布调度执行出错：', err);
  }
}

function start({ intervalMs = Number(process.env.SCHEDULE_TICK_MS) || DEFAULT_TICK_MS } = {}) {
  tickMs = intervalMs;
  started = true;
  // 启动即补跑：处理停机期间 / 建库时就已到期的预约
  kick();
  if (!timer) {
    timer = setInterval(kick, tickMs);
    // 不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
  }
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

module.exports = { start, stop, kick, DEFAULT_TICK_MS };
