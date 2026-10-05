'use strict';

// 年表发布求解器。
//
// 输入：
//   events: [{ id, title }]
//   selected: Map(eventId -> { claimId, precision, startOrd, endOrd, source })
//   relations: [{ id, earlierId, laterId, source }]
//
// 每个事件需在其区间 [startOrd, endOrd] 内取一个具体日；
// 每条关系 later 必须严格晚于 earlier：d(later) >= d(earlier) + 1。
//
// 输出 { ok, dates: Map(eventId -> ord), errors: [...] }
// 错误类型：
//   missing    —— 事件缺少被选主张
//   cycle      —— “先于”关系成环（Tarjan SCC，列出涉事事件与边）
//   temporal   —— 时间无解（传播后给出一条见证链，列出涉事事件与关系）

const { ordinalFromIso, isoFromOrdinal } = require('./dates');

function solve(events, selected, relations) {
  const errors = [];

  // 1) 缺少主张
  for (const ev of events) {
    if (!selected.has(ev.id)) {
      errors.push({
        type: 'missing',
        eventIds: [ev.id],
        relationIds: [],
        message: `事件「${ev.title}」缺少被选定的时间主张`,
      });
    }
  }
  if (errors.length) return { ok: false, dates: null, errors };

  const byId = new Map(events.map((e) => [e.id, e]));

  // 2) 关系合法性（指向不存在事件）
  for (const r of relations) {
    if (!byId.has(r.earlierId) || !byId.has(r.laterId)) {
      errors.push({
        type: 'broken_relation',
        eventIds: [r.earlierId, r.laterId].filter((id) => byId.has(id)),
        relationIds: [r.id],
        message: '先于关系指向了不存在的事件',
      });
    }
  }
  if (errors.length) return { ok: false, dates: null, errors };

  // 3) 成环检测（自环也会被 SCC 捕获）
  const adj = new Map(events.map((e) => [e.id, []]));
  for (const r of relations) {
    adj.get(r.earlierId).push({ to: r.laterId, rel: r });
  }
  const cycle = findCycleSCC(events.map((e) => e.id), adj);
  if (cycle) {
    const { nodeIds, edgeKeys } = cycle;
    const edges = collectCycleEdges(nodeIds, relations);
    const titles = nodeIds.map((id) => byId.get(id).title).join(' → ');
    errors.push({
      type: 'cycle',
      eventIds: nodeIds,
      relationIds: edges.map((r) => r.id),
      message: `“先于”关系成环：${titles}`,
      detail: edges
        .map((r) => `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`)
        .join('；'),
    });
    return { ok: false, dates: null, errors };
  }

  // 4) 时间传播：一遍拓扑（DAG 已保证）。
  //    lower[v] = max( 区间起点v, 对每条 u->v: lower[u] + 1 )
  //    若 lower[v] > 区间终点v，则无解。
  const indeg = new Map(events.map((e) => [e.id, 0]));
  const incoming = new Map(events.map((e) => [e.id, []]));
  for (const r of relations) {
    indeg.set(r.laterId, indeg.get(r.laterId) + 1);
    incoming.get(r.laterId).push(r);
  }

  // Kahn 拓扑（头指针代替 shift，长链下保持线性时间）
  const order = [];
  const queue = events.filter((e) => indeg.get(e.id) === 0).map((e) => e.id);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    order.push(id);
    for (const { to } of adj.get(id)) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }

  const lower = new Map();
  // parent[id] = { fromEventId, relationId } 记录是谁把下界推上来的
  const parent = new Map();
  for (const id of order) {
    const sel = selected.get(id);
    let lo = sel.startOrd;
    let via = null;
    for (const r of incoming.get(id)) {
      const candidate = lower.get(r.earlierId) + 1;
      if (candidate > lo) {
        lo = candidate;
        via = { fromEventId: r.earlierId, relationId: r.id };
      }
    }
    lower.set(id, lo);
    if (via) parent.set(id, via);
    if (lo > sel.endOrd) {
      // 回溯见证链：从该事件一路追到某个区间起点
      const chainIds = [id];
      const chainRels = [];
      let cur = id;
      while (parent.has(cur)) {
        const p = parent.get(cur);
        chainRels.push(p.relationId);
        chainIds.push(p.fromEventId);
        cur = p.fromEventId;
      }
      chainIds.reverse();
      chainRels.reverse();
      const names = chainIds.map((eid) => byId.get(eid).title).join(' 先于 ');
      const relSet = new Map(relations.map((r) => [r.id, r]));
      errors.push({
        type: 'temporal',
        eventIds: chainIds,
        relationIds: chainRels,
        message: `时间无解：按「${names}」的先后要求，「${byId.get(id).title}」最早只能是 ${isoFromOrdinal(lo)}，已超出其选定主张「${sel.label}」的覆盖区间（止于 ${isoFromOrdinal(sel.endOrd)}）`,
        detail: chainRels
          .map((rid) => {
            const r = relSet.get(rid);
            return `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`;
          })
          .join('；'),
      });
      return { ok: false, dates: null, errors };
    }
  }

  return { ok: true, dates: lower, errors: [] };
}

// Tarjan 强连通分量：返回包含有向环的 SCC（含自环），按出现顺序给出节点与边键。
// 迭代实现（显式调用栈）：逐日相接的长链草稿可能深达数千层，
// 递归实现会触发调用栈溢出（RangeError），这里用显式栈帧模拟递归，
// 遍历顺序与递归版完全一致（先序 DFS、出边按插入序），找到的 SCC 相同。
function findCycleSCC(ids, adj) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  let found = null;

  // 显式调用栈帧：{ v, nextEdge } —— nextEdge 是 v 的下一条待处理出边下标
  const frames = [];

  const pushFrame = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    frames.push({ v, nextEdge: 0 });
  };

  for (const id of ids) {
    if (idx.has(id)) continue;
    pushFrame(id);

    while (frames.length) {
      const frame = frames[frames.length - 1];
      const v = frame.v;
      const edges = adj.get(v);

      if (frame.nextEdge < edges.length) {
        const { to } = edges[frame.nextEdge];
        frame.nextEdge++;
        if (!idx.has(to)) {
          pushFrame(to); // 进入子调用
        } else if (onStack.has(to)) {
          low.set(v, Math.min(low.get(v), idx.get(to)));
        }
        continue;
      }

      // v 的子调用全部返回：弹帧，并把 low[v] 沿树边回传给父帧
      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1].v;
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }

      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        // SCC 内多于 1 个节点即有环；单节点检查自环
        if (comp.length > 1 || adj.get(v).some((e) => e.to === v)) {
          found = { nodeIds: comp };
        }
      }
      if (found) break;
    }
    if (found) break;
  }
  return found;
}

function collectCycleEdges(nodeIds, relations) {
  const set = new Set(nodeIds);
  return relations.filter((r) => set.has(r.earlierId) && set.has(r.laterId));
}

// 由数据库主张行构造求解器输入项
function claimToInterval(claim) {
  const start = ordinalFromIso(claim.interval_start);
  const end = ordinalFromIso(claim.interval_end);
  return {
    claimId: claim.id,
    startOrd: start,
    endOrd: end,
    source: claim.source || '',
    label: claim.date_label,
  };
}

module.exports = { solve, claimToInterval };
