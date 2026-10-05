'use strict';

// 访客页：只读最新已发布版本（不可变快照）
const $ = (sel) => document.querySelector(sel);

const PREC_LABEL = { year: '年精度', month: '月精度', day: '日精度' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${y} 年 ${m} 月 ${d} 日`;
}

async function main() {
  const msg = $('#message');
  try {
    const res = await fetch('/api/public/chronicle');
    const data = await res.json();
    if (!data.published) {
      // 尚无版本，或全部已发布版本均已撤回（尚无可读版本）
      msg.innerHTML = data.allRetracted
        ? `<div class="alert warn">${esc(data.message || '尚无可读版本：已发布版本均已撤回')}，请等待编辑者发布修正版本。</div>`
        : '<div class="alert warn">年表尚未发布任何版本，敬请期待。<br><span class="muted">（草稿中的未发布内容对外不可见）</span></div>';
      $('#versionTag').textContent = data.allRetracted ? '尚无可读版本' : '未发布';
      return;
    }
    const v = data.version;
    $('#versionTag').textContent = `第 ${v.versionNo} 版 · 发布于 ${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑：${esc(v.editor || '匿名')}`;
    $('#chronicle').style.display = 'grid';
    $('#caveat').textContent = `本页为第 ${v.versionNo} 版不可变快照，共 ${v.eventCount} 个事件、${v.relationCount} 条先后关系。`;

    const titleById = new Map(v.events.map((e) => [e.eventId, e.title]));

    $('#timeline').innerHTML = v.events.map((e) => `
      <div class="item">
        <div class="date">${esc(fmtDate(e.resolvedDate))}</div>
        <div><strong>${esc(e.title)}</strong>
          <span class="badge prec">${PREC_LABEL[e.precision] || e.precision}</span>
        </div>
        ${e.description ? `<div class="muted">${esc(e.description)}</div>` : ''}
        <div class="source">
          <b>所选出处：</b>${esc(e.source || '（未注明出处）')}
          <br><span class="muted">原始主张：${esc(e.dateLabel)}
          （覆盖区间 ${e.intervalStart} ~ ${e.intervalEnd}）${e.claimNote ? '；' + esc(e.claimNote) : ''}</span>
        </div>
      </div>
    `).join('');

    $('#relations').innerHTML = v.relations.length
      ? v.relations.map((r) => `
          <div class="rel-line">
            <strong>${esc(titleById.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
            <span class="badge">先于</span>
            <strong>${esc(titleById.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
            ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
          </div>`).join('')
      : '<p class="muted">本版未记录先于关系。</p>';

    // 勘误附记：本版各目标的最新生效附记（出处已按遮盖规则处理）
    if (Array.isArray(v.errata) && v.errata.length) {
      $('#errataCard').style.display = '';
      $('#errata').innerHTML = v.errata.map((x) => {
        const target = x.targetType === 'event'
          ? `事件「${esc((x.target && x.target.title) || '#' + x.targetId)}」`
          : `「先于」关系：${esc((x.target && x.target.earlierTitle) || '#' + (x.target && x.target.earlierEventId))}
             <span class="badge">先于</span> ${esc((x.target && x.target.laterTitle) || '#' + (x.target && x.target.laterEventId))}`;
        return `
          <div class="rel-line">
            <span class="badge prec">勘误</span> ${target}
            <div>${esc(x.note)}</div>
            <div class="source"><b>出处：</b>${esc(x.source)}</div>
            <div class="muted">附记 #${x.errataId} · 登记于 ${esc(x.createdAt)} UTC${x.editor ? ` · ${esc(x.editor)}` : ''}</div>
          </div>`;
      }).join('');
    }

    loadRoutes();
  } catch (err) {
    msg.innerHTML = `<div class="alert error">加载失败：${esc(err.message)}</div>`;
  }
}

// ---------- 专题脉络路线（公开只读，出处已按遮盖规则处理） ----------
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const anchorMark = (pos) => CIRCLED[pos] || `(${pos + 1})`;

async function loadRoutes() {
  try {
    const res = await fetch('/api/public/routes');
    const data = await res.json();
    if (!data.routes || !data.routes.length) return;
    $('#routesCard').style.display = '';
    $('#routeList').innerHTML = data.routes.map((r) => `
      <button class="secondary" type="button" data-open-route="${r.routeNo}" style="margin:0 8px 8px 0">
        ⚑ ${esc(r.title)} <span class="muted">（路线 #${r.routeNo} · 据第 ${r.versionNo} 版 · ${r.anchorCount} 个锚点）</span>
      </button>`).join('');
  } catch { /* 路线加载失败不影响年表主体 */ }
}

async function openRoute(routeNo) {
  const box = $('#routeDetail');
  box.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const res = await fetch(`/api/public/routes/${routeNo}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
    box.innerHTML = routeHtml(data.route);
  } catch (err) {
    box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}

function routeHtml(route) {
  const evById = new Map(route.events.map((e) => [e.eventId, e]));
  const relById = new Map(route.relations.map((r) => [r.relationId, r]));
  const anchorLine = route.anchors
    .map((a) => `<span class="badge prec">${anchorMark(a.position)} ${esc(a.title)}</span>`)
    .join(' <span class="muted">→</span> ');

  const eventNode = (eid) => {
    const ev = evById.get(eid) || { title: `#${eid}`, role: 'intermediate' };
    const roleBadge = ev.role === 'anchor'
      ? `<span class="badge prec">锚点 ${anchorMark(ev.anchorPosition)}</span>`
      : '<span class="badge">中间事件</span>';
    return `
      <div class="rel-line">
        ${roleBadge} <strong>${esc(ev.title)}</strong>
        ${ev.resolvedDate ? `<span class="muted">${esc(fmtDate(ev.resolvedDate))}</span>` : ''}
        ${ev.dateLabel ? `<div class="muted">原始主张：${esc(ev.dateLabel)}（区间 ${esc(ev.intervalStart)} ~ ${esc(ev.intervalEnd)}）</div>` : ''}
        ${ev.source ? `<div class="source"><b>出处：</b>${esc(ev.source)}</div>` : ''}
      </div>`;
  };

  const segments = route.segments.map((s) => {
    const parts = [];
    s.eventIds.forEach((eid, i) => {
      if (i > 0) {
        const rel = relById.get(s.relationIds[i - 1]) || {};
        parts.push(`
          <div class="muted" style="padding-left:18px">
            ↓ 先于（关系 #${s.relationIds[i - 1]}${rel.source ? `，出处：${esc(rel.source)}` : '，未注明出处'}）
          </div>`);
      }
      parts.push(eventNode(eid));
    });
    return `
      <div class="card" style="background:#fff;margin-bottom:8px">
        <h3 style="font-size:13px">第 ${s.position + 1} 段：锚点 ${anchorMark(s.position)} → 锚点 ${anchorMark(s.position + 1)}
          <span class="muted">（见证链含 ${s.relationIds.length} 条关系，为该版中最少）</span></h3>
        ${parts.join('')}
      </div>`;
  }).join('');

  return `
    <h3 style="margin-top:14px">⚑ ${esc(route.title)} <span class="muted">（路线 #${route.routeNo}）</span></h3>
    <p class="muted">据第 ${route.versionNo} 版年表 · 建立于 ${esc(route.createdAt)} UTC · 编辑：${esc(route.editor || '匿名')}${route.note ? ` · 说明：${esc(route.note)}` : ''}</p>
    <p>${anchorLine}</p>
    ${segments}`;
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const open = t.dataset && t.dataset.openRoute;
  if (open !== undefined) openRoute(Number(open));
});

main();
