'use strict';

// 编辑台：草稿 CRUD + 逐事件选定主张 + 发布乐观并发控制
const $ = (sel) => document.querySelector(sel);

const PREC_LABEL = { year: '精确到年', month: '精确到月', day: '精确到日' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const store = {
  get token() { return localStorage.getItem('editorToken') || ''; },
  set token(v) { localStorage.setItem('editorToken', v); },
  get editor() { return localStorage.getItem('editorName') || ''; },
  set editor(v) { localStorage.setItem('editorName', v); },
  get selections() {
    try { return JSON.parse(localStorage.getItem('selections') || '{}'); }
    catch { return {}; }
  },
  setSelection(eventId, claimId) {
    const m = this.selections;
    m[eventId] = claimId;
    localStorage.setItem('selections', JSON.stringify(m));
  },
  clearSelections() { localStorage.removeItem('selections'); },
};

let state = { events: [], relations: [], currentVersionNo: 0, latestVisibleVersionNo: 0, draftRevisionNo: 0 };
let baseVersionNo = 0; // 发起修改时所基于的版本号
let conflictData = null;
let restorePreview = null; // 恢复草稿预览（确认时提交其中的修订号/最新版本号）
let bundleParsed = null;   // 解析后的整理包原包（确认时原样提交）
let bundlePreview = null;  // 导入预览（确认时提交其中的指纹/草稿修订号）
let redactPreview = null;  // 出处遮盖预览（确认时提交其中的最新版本号）
let scheduleDetail = null; // 当前打开的预约详情
let routeVersionEvents = []; // 路线编辑：当前加载的版本事件（点击追加为锚点）
let routeAnchorIds = [];   // 路线编辑：已选锚点事件 id（有序）
let sessionCurrent = null; // 并行编辑会话：当前查看的会话详情

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Editor-Token': store.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 无响应体 */ }
  if (res.status === 401) {
    showGlobal('warn', data?.message || '请先在右上角输入正确的编辑者口令。');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const err = new Error(data?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function showGlobal(kind, html) {
  $('#globalMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function showPublishResult(kind, html) {
  $('#publishResult').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

// ---------- 渲染 ----------
function render() {
  const visible = state.latestVisibleVersionNo;
  const retractHint =
    state.currentVersionNo > 0 && visible !== state.currentVersionNo
      ? `（访客当前可见：${visible === 0 ? '尚无可读版本' : `第 ${visible} 版`}）`
      : '';
  $('#versionTag').textContent =
    state.currentVersionNo === 0
      ? '尚无已发布版本（草稿未公开）'
      : `当前已发布：第 ${state.currentVersionNo} 版${retractHint}`;

  const sel = store.selections;
  $('#eventList').innerHTML = state.events.map((ev) => {
    const claims = ev.claims.map((c) => {
      const checked = sel[ev.id] === c.id ? 'checked' : '';
      return `
        <div class="claim ${checked ? 'selected' : ''}" data-claim="${c.id}">
          <div class="row">
            <div style="flex:0 0 auto;padding-top:2px">
              <input type="radio" name="sel-${ev.id}" data-select-claim="${c.id}" ${checked} style="width:auto" />
            </div>
            <div style="flex:1">
              <strong>${esc(c.dateLabel)}</strong>
              <span class="badge prec">${PREC_LABEL[c.precision]}</span>
              <span class="badge">区间 ${c.intervalStart} ~ ${c.intervalEnd}</span>
              <div class="source"><b>出处：</b>${esc(c.source || '（未注明）')}</div>
              ${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}
            </div>
            <div style="flex:0 0 auto">
              <button class="danger" data-del-claim="${c.id}" type="button">删除主张</button>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="card event-card" id="event-card-${ev.id}" data-event="${ev.id}">
        <div class="row">
          <div class="field">
            <label>事件标题</label>
            <input type="text" value="${esc(ev.title)}" data-edit-title="${ev.id}" />
          </div>
          <div style="flex:0 0 auto">
            <button class="secondary" data-save-event="${ev.id}" type="button">保存</button>
            <button class="danger" data-del-event="${ev.id}" type="button">删除事件</button>
          </div>
        </div>
        <label style="margin-top:6px">描述</label>
        <textarea data-edit-desc="${ev.id}">${esc(ev.description)}</textarea>

        <h3 style="margin-top:10px">时间主张${ev.claims.length === 0 ? '（尚无主张，无法发布）' : `（${ev.claims.length} 条，发布时单选）`}</h3>
        ${claims || '<p class="muted">暂无主张</p>'}

        <div class="claim" style="border-style:dashed">
          <h3>新增主张</h3>
          <div class="row">
            <div class="field" style="max-width:130px">
              <label>精度</label>
              <select data-new-precision="${ev.id}">
                <option value="day">精确到日</option>
                <option value="month">精确到月</option>
                <option value="year">精确到年</option>
              </select>
            </div>
            <div class="field" style="max-width:110px"><label>年</label><input type="number" min="1" max="9999" data-new-year="${ev.id}" placeholder="1958" /></div>
            <div class="field js-month" style="max-width:100px"><label>月</label><input type="number" min="1" max="12" data-new-month="${ev.id}" placeholder="3" /></div>
            <div class="field js-day" style="max-width:100px"><label>日</label><input type="number" min="1" max="31" data-new-day="${ev.id}" placeholder="12" /></div>
          </div>
          <label style="margin-top:6px">出处（受访人 / 档案 / 页码）</label>
          <input type="text" data-new-source="${ev.id}" placeholder="如：李宝山口述，2021-07-05 访谈" />
          <label style="margin-top:6px">考异备注（可选，记录矛盾说法）</label>
          <textarea data-new-note="${ev.id}"></textarea>
          <div style="margin-top:8px"><button data-add-claim="${ev.id}" type="button">添加主张</button></div>
        </div>
      </div>`;
  }).join('') || '<p class="muted">草稿中还没有事件。</p>';

  // 精度联动
  document.querySelectorAll('select[data-new-precision]').forEach((selEl) => {
    const card = selEl.closest('.event-card');
    const apply = () => {
      const p = selEl.value;
      card.querySelector('.js-month').style.display = p === 'year' ? 'none' : '';
      card.querySelector('.js-day').style.display = p === 'day' ? '' : 'none';
    };
    selEl.addEventListener('change', apply);
    apply();
  });

  renderRelations();
}

function titleOf(id) {
  const ev = state.events.find((e) => e.id === id);
  return ev ? ev.title : `#${id}`;
}

function renderRelations() {
  const opts = state.events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  $('#relEarlier').innerHTML = opts;
  $('#relLater').innerHTML = opts;

  $('#relList').innerHTML = state.relations.length
    ? state.relations.map((r) => `
        <div class="rel-line" id="rel-line-${r.id}">
          <strong>${esc(titleOf(r.earlierId))}</strong>
          <span class="badge">先于</span>
          <strong>${esc(titleOf(r.laterId))}</strong>
          <button class="danger" data-del-rel="${r.id}" type="button" style="float:right">删除</button>
          ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
          ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}
        </div>`).join('')
    : '<p class="muted">尚无先后关系。</p>';
}

async function loadState() {
  state = await api('GET', '/api/editor/state');
  baseVersionNo = state.currentVersionNo;
  // 清掉已失效的选择
  const valid = new Map();
  state.events.forEach((e) => e.claims.forEach((c) => valid.set(c.id, e.id)));
  const m = store.selections;
  let changed = false;
  for (const [eid, cid] of Object.entries(m)) {
    if (valid.get(cid) !== Number(eid)) { delete m[eid]; changed = true; }
  }
  if (changed) localStorage.setItem('selections', JSON.stringify(m));
  render();
  loadVersions();
  loadSchedules();
  loadRoutes();
  loadSessions();
}

async function loadVersions() {
  const data = await api('GET', '/api/editor/versions');
  // 路线编辑的版本下拉（默认选当前最新版）
  const sel = $('#routeVersion');
  if (sel) {
    const keep = sel.value;
    sel.innerHTML = data.versions.length
      ? data.versions.map((v) => `<option value="${v.versionNo}">第 ${v.versionNo} 版${v.retracted ? '（已撤回）' : ''}</option>`).join('')
      : '<option value="">（尚无已发布版本）</option>';
    if (keep && data.versions.some((v) => String(v.versionNo) === keep)) sel.value = keep;
  }
  // 勘误附记的目标版本下拉（撤回版可查阅不可登记，同样标注）
  const esel = $('#errataVersion');
  if (esel) {
    const keep = esel.value;
    esel.innerHTML = data.versions.length
      ? data.versions.map((v) => `<option value="${v.versionNo}">第 ${v.versionNo} 版${v.retracted ? '（已撤回，仅查阅）' : ''}</option>`).join('')
      : '<option value="">（尚无已发布版本）</option>';
    if (keep && data.versions.some((v) => String(v.versionNo) === keep)) esel.value = keep;
  }
  $('#versionList').innerHTML = data.versions.length
    ? data.versions.map((v) => `
        <div class="rel-line"${v.retracted ? ' style="opacity:.75"' : ''}>
          <div class="row" style="align-items:center">
            <strong>第 ${v.versionNo} 版</strong>
            ${v.retracted ? '<span class="badge" style="background:#fbeaea;color:#a33">已撤回</span>' : ''}
            <span class="muted" style="flex:1">${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · ${esc(v.editor || '匿名')}${v.parentNo ? ` · 基于第 ${v.parentNo} 版` : ''}</span>
            <button class="secondary" type="button" data-restore-version="${v.versionNo}" style="padding:2px 10px;font-size:13px">预览并恢复草稿</button>
            ${v.retracted ? '' : `<button class="danger" type="button" data-retract-version="${v.versionNo}" style="padding:2px 10px;font-size:13px">撤回该版</button>`}
          </div>
          ${v.note ? `<div>${esc(v.note)}</div>` : ''}
          ${v.retracted && v.retraction
            ? `<div class="source" style="color:#a33"><b>撤回原因：</b>${esc(v.retraction.reason)}
                 <span class="muted">（${esc(v.retraction.retractedAt)} UTC · ${esc(v.retraction.editor || '匿名')}；快照未改动，仅访客不可见）</span></div>`
            : ''}
          <div>
            <button class="linkbtn" type="button" data-raw-version="${v.versionNo}">查看该版快照原文（编辑者，不遮盖）</button>
            ${v.retracted
              ? '<span class="muted" style="font-size:13px"> · 已撤回：访客版本清单、指定版读取与引用本版的路线均不可见</span>'
              : `· <a href="/api/public/versions/${v.versionNo}" target="_blank">访客视角 JSON（遮盖后）</a>`}
          </div>
        </div>`).join('')
    : '尚无版本。';
}

// ---------- 撤回已发布版本（按版本号 + 非空原因，只追加审计记录） ----------
async function retractVersionFromUi(versionNo) {
  const reason = window.prompt(
    `确定撤回第 ${versionNo} 版的公开展示？\n` +
      '撤回只追加审计记录：历史快照与版本号不变，访客最新年表将指向编号最大的未撤回版，\n' +
      '该版详情与引用它的专题路线对访客隐藏；编辑者仍可见原文与原因。\n\n' +
      '请输入非空撤回原因（编年依据错误说明）：'
  );
  if (reason === null) return; // 取消
  if (!reason.trim()) {
    showGlobal('error', '撤回原因不能为空，未做任何改动。');
    return;
  }
  try {
    const data = await api('POST', `/api/editor/versions/${versionNo}/retract`, {
      reason,
      editor: store.editor || '匿名编辑',
    });
    showGlobal(
      data.alreadyRetracted ? 'warn' : 'ok',
      data.alreadyRetracted
        ? `第 ${versionNo} 版<b>此前已撤回</b>（${esc(data.retraction.retractedAt)} UTC），本次未重复登记、原因未覆盖：<br>「${esc(data.retraction.reason)}」`
        : `已撤回 <b>第 ${versionNo} 版</b>：快照与版本号未改动；访客最新年表现指向第 ${data.latestVisibleVersionNo || '（暂无可读）'} 版，` +
          `该版详情与引用它的路线对访客隐藏。发布与预约仍以最高已发布版本号（第 ${data.currentVersionNo} 版）为基准。`
    );
    await loadState();
  } catch (err) {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  }
}

// ---------- 发布 ----------
function gatherSelection() {
  const m = store.selections;
  return state.events.map((e) => ({ eventId: e.id, claimId: Number(m[e.id]) }));
}

function clientCheck() {
  const missing = state.events.filter((e) => !store.selections[e.id]);
  if (state.events.length === 0) return '草稿中没有事件，无法发布。';
  if (missing.length) return `还有 ${missing.length} 个事件未选定主张：${missing.map((e) => `「${e.title}」`).join('、')}`;
  return null;
}

async function doValidate() {
  const err = clientCheck();
  if (err) { showPublishResult('error', esc(err)); return; }
  try {
    const data = await api('POST', '/api/editor/validate', { selection: gatherSelection() });
    if (!data.ok) {
      renderSolverErrors(data.errors);
    } else {
      showPublishResult('ok', `
        <b>校验通过，可以发布。</b>系统确定的具体日期：
        <ol style="margin:6px 0">
          ${data.preview.map((p) => `<li>${esc(p.resolvedDate)} — ${esc(p.title)}（主张区间 ${p.intervalStart} ~ ${p.intervalEnd}）</li>`).join('')}
        </ol>`);
    }
  } catch (e) {
    showPublishResult('error', esc(e.message));
  }
}

function renderSolverErrors(errors) {
  const typeName = { missing: '缺少主张', cycle: '关系成环', temporal: '时间无解', bad_selection: '主张选择无效', broken_relation: '关系失效' };
  const items = errors.map((er, i) => {
    const targets = [...new Set(er.eventIds.map((id) => `#event-card-${id}`))].join(',');
    return `<li data-targets="${targets}" title="点击定位事件">
      <b>[${typeName[er.type] || er.type}]</b> ${esc(er.message)}
      ${er.detail ? `<div class="muted">涉事关系：${esc(er.detail)}</div>` : ''}
      ${er.relationIds && er.relationIds.length ? `<div class="muted">涉事关系 id：${er.relationIds.join(', ')}</div>` : ''}
    </li>`;
  }).join('');
  showPublishResult('error', `
    <b>无法发布，上一已发布版本保持不变。</b>
    <ul class="error-list">${items}</ul>`);
  document.querySelectorAll('#publishResult .error-list li').forEach((li) => {
    li.addEventListener('click', () => {
      const targets = (li.dataset.targets || '').split(',').filter(Boolean);
      const first = targets[0] && document.querySelector(targets[0]);
      if (first) {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targets.forEach((t) => document.querySelector(t)?.classList.add('has-error', 'highlight-flash'));
        setTimeout(() => targets.forEach((t) => document.querySelector(t)?.classList.remove('highlight-flash')), 1800);
      }
    });
  });
}

async function doPublish() {
  const err = clientCheck();
  if (err) { showPublishResult('error', esc(err)); return; }
  const btn = $('#btnPublish');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/publish', {
      selection: gatherSelection(),
      baseVersionNo,
      editor: store.editor || '匿名编辑',
      note: $('#publishNote').value,
    });
    showPublishResult('ok', `已发布 <b>第 ${data.versionNo} 版</b>（不可变快照）。访客年表已更新。<a href="/" target="_blank">打开访客年表</a>`);
    $('#publishNote').value = '';
    await loadState();
  } catch (e) {
    if (e.status === 422 && e.body?.errors) {
      renderSolverErrors(e.body.errors);
    } else if (e.status === 409) {
      conflictData = e.body;
      showConflictDialog(e.body);
      showPublishResult('error', esc(e.message));
    } else {
      showPublishResult('error', esc(e.message));
    }
  } finally {
    btn.disabled = false;
  }
}

function showConflictDialog(body) {
  // 草稿冲突（两进程共用库时，读快照与写事务之间草稿被另一操作改动）：
  // 本次发布 / 预约已整次取消，只需刷新草稿、重新确认选择后重试，不涉及版本号。
  if (body.code === 'DRAFT_REVISION_CONFLICT') {
    $('#conflictBody').innerHTML = `
      <p><b>草稿在你读取后被另一位编辑者改动过。</b></p>
      <p>系统在写入前发现草稿修订号已由 <b>${esc(body.expectedRevisionNo)}</b> 变为
         <b>${esc(body.currentRevisionNo)}</b>（事件 / 主张 / 关系可能已变化）。为避免冻结
         从未同时存在过的混合内容，<b>本次操作已整体取消，未生成任何版本或预约</b>。</p>
      <p class="muted">点击下方按钮刷新为最新草稿，<b>请逐条重新确认每个事件的主张选择</b>，再重新发布或建立预约。</p>`;
    $('#conflictDialog').showModal();
    return;
  }

  const cur = body.currentVersion;
  const list = (evs) => (evs || []).map((e) => `<li>${esc(e.title)}</li>`).join('');
  $('#conflictBody').innerHTML = `
    <p>你发起修改时基于的是<b>第 ${body.baseVersionNo} 版</b>，但另一位编辑者已经在此期间发布了
       <b>第 ${body.currentVersionNo} 版</b>，系统<b>没有</b>覆盖对方的版本。</p>
    ${cur ? `
      <div class="card" style="background:#fff">
        <h3>第 ${cur.versionNo} 版概况</h3>
        <p class="muted">发布于 ${cur.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑者：${esc(cur.editor || '匿名')}${cur.note ? ' · 说明：' + esc(cur.note) : ''}</p>
        <p>事件 ${cur.eventCount} 个，先后关系 ${cur.relationCount} 条。</p>
      </div>` : ''}
    <p class="muted">点击下方按钮后，草稿区将刷新为最新状态，<b>请逐条重新确认每个事件的主张选择</b>，再重新发布；若不重新确认，你的提交不会被接受。</p>`;
  $('#conflictDialog').showModal();
}

// ---------- 从历史版本恢复草稿 ----------
async function openRestorePreview(versionNo) {
  $('#restoreBody').innerHTML = '加载预览中…（只读，不修改草稿）';
  $('#restoreConfirm').disabled = false;
  $('#restoreDialog').showModal();
  restorePreview = null;
  try {
    const data = await api('GET', `/api/editor/restore-preview/${versionNo}`);
    restorePreview = data;
    renderRestorePreview(data);
  } catch (err) {
    if (err.message === 'unauthorized') {
      $('#restoreDialog').close();
      return;
    }
    $('#restoreBody').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    $('#restoreConfirm').disabled = true;
  }
}

function restoreEventListHtml(events) {
  if (!events.length) return '<p class="muted">（无事件）</p>';
  return events.map((ev) => `
    <div class="rel-line">
      <strong>${esc(ev.title)}</strong>
      <span class="badge prec">${esc(ev.dateLabel)}</span>
      <span class="badge">区间 ${ev.intervalStart} ~ ${ev.intervalEnd}</span>
      <div class="source"><b>出处：</b>${esc(ev.source || '（未注明）')}</div>
      ${ev.claimNote ? `<div class="muted">${esc(ev.claimNote)}</div>` : ''}
      ${ev.description ? `<div class="muted">${esc(ev.description)}</div>` : ''}
    </div>`).join('');
}

function draftEventListHtml(events) {
  if (!events.length) return '<p class="muted">（草稿为空）</p>';
  return events.map((ev) => `
    <div class="rel-line">
      <strong>${esc(ev.title)}</strong>
      <span class="badge">主张 ${ev.claims.length} 条</span>
      ${ev.description ? `<div class="muted">${esc(ev.description)}</div>` : ''}
    </div>`).join('');
}

function restoreRelationListHtml(version) {
  const titleByEvent = new Map(version.events.map((e) => [e.eventId, e.title]));
  if (!version.relations.length) return '<p class="muted">（无先后关系）</p>';
  return version.relations.map((r) => `
    <div class="rel-line">
      <strong>${esc(titleByEvent.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
      <span class="badge">先于</span>
      <strong>${esc(titleByEvent.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
      ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
    </div>`).join('');
}

function draftRelationListHtml(relations, events) {
  const titleById = new Map(events.map((e) => [e.id, e.title]));
  if (!relations.length) return '<p class="muted">（无先后关系）</p>';
  return relations.map((r) => `
    <div class="rel-line">
      <strong>${esc(titleById.get(r.earlierId) || '#' + r.earlierId)}</strong>
      <span class="badge">先于</span>
      <strong>${esc(titleById.get(r.laterId) || '#' + r.laterId)}</strong>
    </div>`).join('');
}

function renderRestorePreview(data) {
  const v = data.version;
  const d = data.currentDraft;
  $('#restoreBody').innerHTML = `
    ${data.retraction
      ? `<div class="alert warn">注意：第 ${data.versionNo} 版已于 ${esc(data.retraction.retractedAt)} UTC 被撤回（${esc(data.retraction.reason)}）。
           恢复的是其快照原文，请修正编年依据后再发布新版本。</div>`
      : ''}
    <p>将从 <b>第 ${data.versionNo} 版</b>（${v.eventCount} 个事件、${v.relationCount} 条关系）恢复草稿。
       确认后会<b>原子替换整个当前草稿</b>：当前草稿的 ${d.counts.eventCount} 个事件、${d.counts.claimCount} 条主张、
       ${d.counts.relationCount} 条关系将全部移除，按快照重建，且每个事件<b>只恢复该版被选的那一条主张</b>
       （其余未选主张不会回来）。</p>
    <p class="muted">历史快照与访客年表保持不变；恢复仅替换草稿，仍需重新校验、发布才会公开。
       发布时沿用现有口令、校验规则与 baseVersionNo 约定（当前最新仍为第 ${data.currentVersionNo} 版）。</p>
    <div class="grid2">
      <div class="card" style="background:#fff;margin-bottom:0">
        <h3>第 ${data.versionNo} 版将恢复的内容</h3>
        <h3 style="font-size:13px">事件与被选主张</h3>
        ${restoreEventListHtml(v.events)}
        <h3 style="font-size:13px;margin-top:10px">「先于」关系</h3>
        ${restoreRelationListHtml(v)}
      </div>
      <div class="card" style="background:#fff;margin-bottom:0">
        <h3>当前草稿将被替换的内容</h3>
        <h3 style="font-size:13px">事件（全部主张）</h3>
        ${draftEventListHtml(d.events)}
        <h3 style="font-size:13px;margin-top:10px">「先于」关系</h3>
        ${draftRelationListHtml(d.relations, d.events)}
      </div>
    </div>
    <p class="muted" style="margin-top:10px">预览基准：草稿修订号 ${data.draftRevisionNo} · 最新版本号 ${data.currentVersionNo}。
       确认前若草稿或最新版本发生变化，将报冲突且不改动数据。</p>
    <div id="restoreMsg"></div>`;
}

async function confirmRestore() {
  if (!restorePreview) return;
  const btn = $('#restoreConfirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/restore', {
      versionNo: restorePreview.versionNo,
      draftRevisionNo: restorePreview.draftRevisionNo,
      currentVersionNo: restorePreview.currentVersionNo,
    });
    $('#restoreDialog').close();
    // 用恢复后的待选主张替换本地单选；旧 id 已失效，不能保留
    const m = {};
    data.pendingSelection.forEach((s) => { m[s.eventId] = s.claimId; });
    localStorage.setItem('selections', JSON.stringify(m));
    await loadState();
    showPublishResult('ok', `
      草稿已从 <b>第 ${data.restoredFromVersionNo} 版</b>恢复（新草稿修订号 ${data.revisionNo}）。
      每个事件仅带回该版被选主张且已替你选中。历史快照与访客年表未变，
      请<b>校验能否发布</b>后再发布新版本；发布仍按 baseVersionNo = 第 ${data.currentVersionNo} 版做冲突检查。`);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#restoreDialog').close(); return; }
    if (err.status === 409) {
      $('#restoreMsg').innerHTML = `<div class="alert error">${esc(err.message)}<br>
        <span class="muted">数据未做任何改动。请关闭本框后重新点击「预览并恢复草稿」。</span></div>`;
      btn.disabled = true;
    } else {
      $('#restoreMsg').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  }
}

// ---------- 导入采访整理包（JSON，预览 → 确认） ----------
function showBundleMsg(kind, html) {
  $('#bundleMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function bundleProblemsHtml(problems) {
  return `<ul class="error-list">${problems.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul>`;
}

async function previewBundleImport() {
  const text = $('#bundleText').value.trim();
  if (!text) { showBundleMsg('error', '请先选择 JSON 文件或粘贴整理包 JSON。'); return; }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    showBundleMsg('error', `JSON 解析失败：${esc(e.message)}`);
    return;
  }
  try {
    const data = await api('POST', '/api/editor/import-preview', parsed);
    bundleParsed = parsed;
    bundlePreview = data;
    renderBundlePreview(data);
    $('#bundleConfirm').disabled = Boolean(data.alreadyImported);
    $('#bundleDialog').showModal();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    if (err.status === 422 && err.body && Array.isArray(err.body.problems)) {
      showBundleMsg('error', `<b>${esc(err.body.message)}</b>${bundleProblemsHtml(err.body.problems)}`);
    } else {
      showBundleMsg('error', esc(err.message));
    }
  }
}

function renderBundlePreview(data) {
  const evHtml = data.events.map((ev) => `
    <div class="rel-line">
      <strong>${esc(ev.title)}</strong> <span class="badge">键 ${esc(ev.key)}</span>
      ${ev.description ? `<div class="muted">${esc(ev.description)}</div>` : ''}
      ${ev.claims.map((c) => `<div class="source"><b>${esc(c.dateLabel)}</b>（区间 ${c.intervalStart} ~ ${c.intervalEnd}）<br><b>出处：</b>${esc(c.source)}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</div>`).join('')}
    </div>`).join('');
  const relHtml = data.relations.length
    ? data.relations.map((r) => `
        <div class="rel-line">
          <strong>${esc(r.earlierTitle)}</strong> <span class="badge">先于</span> <strong>${esc(r.laterTitle)}</strong>
          ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
        </div>`).join('')
    : '<p class="muted">（无「先于」关系）</p>';
  $('#bundleBody').innerHTML = `
    ${data.alreadyImported ? `<div class="alert error">批次标识「${esc(data.batchId)}」已于 ${esc(data.alreadyImported.importedAt)} UTC 成功导入过，确认将返回冲突。请更换批次标识后再预览。</div>` : ''}
    <p>批次 <b>${esc(data.batchId)}</b> 校验通过，将<b>追加</b>到当前草稿（既有草稿、历史快照与访客年表不受影响）：</p>
    <p>
      <span class="badge prec">事件 ${data.counts.eventCount} 个</span>
      <span class="badge prec">时间主张 ${data.counts.claimCount} 条</span>
      <span class="badge prec">先于关系 ${data.counts.relationCount} 条</span>
    </p>
    <h3 style="font-size:13px">待写入事件与主张</h3>
    <div style="max-height:220px;overflow:auto">${evHtml}</div>
    <h3 style="font-size:13px;margin-top:10px">待写入「先于」关系</h3>
    ${relHtml}
    <p class="muted" style="margin-top:10px">内容指纹 <code>${esc(data.fingerprint.slice(0, 16))}…</code> · 预览时草稿修订号 ${data.draftRevisionNo}。
      确认时须提交原包与该指纹；内容被替换、草稿已变化或批次已导入都会冲突且不写入。
      导入后仍需为事件选定主张并「校验能否发布」。</p>
    <div id="bundleDialogMsg"></div>`;
}

async function confirmBundleImport() {
  if (!bundleParsed || !bundlePreview) return;
  const btn = $('#bundleConfirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/import', {
      bundle: bundleParsed,
      fingerprint: bundlePreview.fingerprint,
      draftRevisionNo: bundlePreview.draftRevisionNo,
    });
    $('#bundleDialog').close();
    const mapping = data.idMap.events.map((m) => `「${m.key}」→ 事件 #${m.eventId}（主张 ${m.claimIds.length} 条）`).join('、');
    bundleParsed = null;
    bundlePreview = null;
    $('#bundleText').value = '';
    $('#bundleFile').value = '';
    await loadState();
    showBundleMsg('ok', `
      批次 <b>${esc(data.batchId)}</b> 已导入草稿（新草稿修订号 ${data.revisionNo}）：
      ${data.counts.eventCount} 个事件、${data.counts.claimCount} 条主张、${data.counts.relationCount} 条关系。<br>
      <span class="muted">键 → 草稿 ID：${esc(mapping)}。历史快照与访客年表未变；
      请为导入的事件选定主张并「校验能否发布」后再发布。</span>`);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#bundleDialog').close(); return; }
    const box = $('#bundleDialogMsg');
    if (err.status === 409) {
      box.innerHTML = `<div class="alert error">${esc(err.message)}<br>
        <span class="muted">未写入任何数据。请关闭本框后重新「预览导入内容」。</span></div>`;
      btn.disabled = true;
    } else if (err.status === 422 && err.body && Array.isArray(err.body.problems)) {
      box.innerHTML = `<div class="alert error">${esc(err.body.message)}${bundleProblemsHtml(err.body.problems)}</div>`;
      btn.disabled = true;
    } else {
      box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  }
}

// ---------- 按出处原文撤回公开展示（预览 → 确认） ----------
function showRedactMsg(kind, html) {
  $('#redactMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function redactHitsHtml(data) {
  // 命中处库存原文若与规范文本不同（首尾空白变体），用单独一行标出来
  const variantNote = (stored) =>
    stored && stored !== data.source
      ? ` <span class="muted">库存原文 <code>${esc(JSON.stringify(stored))}</code>（仅首尾空白不同，同样命中）</span>`
      : '';
  const perVersion = data.versions.length
    ? data.versions.map((v) => {
        const evs = v.eventHits
          .map((h) => `<li>事件「${esc(h.title)}」（事件主张，eventId ${h.eventId}）${variantNote(h.source)}</li>`)
          .join('');
        const rels = v.relationHits
          .map((h) => `<li>先于关系 ${h.earlierEventId} → ${h.laterEventId}（relationId ${h.relationId}）${variantNote(h.source)}</li>`)
          .join('');
        return `
          <div class="rel-line">
            <strong>第 ${v.versionNo} 版</strong>
            <span class="badge prec">事件主张 ${v.eventHitCount} 处</span>
            <span class="badge prec">先于关系 ${v.relationHitCount} 处</span>
            ${v.totalHitCount ? `<ul class="error-list" style="margin:4px 0">${evs}${rels}</ul>` : '<div class="muted">本版无命中</div>'}
          </div>`;
      }).join('')
    : '<p class="muted">尚无已发布版本（没有可遮盖的公开内容）。</p>';

  const d = data.draft;
  const draftHtml = d
    ? `<p class="muted">另：当前草稿中有 ${d.claimHitCount} 条未发布主张、${d.relationHitCount} 条未发布关系的出处折叠首尾空白后与之一致；
       它们不在本次公开命中范围内，但<b>以后发布时会自动遮盖</b>（草稿与恢复草稿始终保留原文）。</p>`
    : '';

  return `
    ${data.alreadyRedacted ? '<div class="alert warn">该出处文本此前已确认遮盖，重复确认将直接返回已遮盖状态（不重复落库）。</div>' : ''}
    <p>规范出处（折叠首尾空白后）：<code>${esc(data.source)}</code></p>
    <p class="muted">命中规则：仅首尾空白不同的写法互相命中；内部空白与其他文字逐字区分，部分包含不命中。</p>
    <p>
      <span class="badge prec">已发布版本 ${data.versionCount} 个</span>
      <span class="badge prec">事件主张命中 ${data.totalEventHitCount} 处</span>
      <span class="badge prec">先于关系命中 ${data.totalRelationHitCount} 处</span>
      <span class="badge">合计 ${data.totalHitCount} 处</span>
    </p>
    ${draftHtml}
    <div style="max-height:240px;overflow:auto">${perVersion}</div>
    <p class="muted" style="margin-top:10px">预览基准：当前最新版本号 <b>${data.currentVersionNo}</b>。
      确认后不改写历史快照或草稿；访客读最新年表、任一历史版本、专题路线与勘误附记时，命中处出处统一显示<b>「出处已遮盖」</b>，
      其余字段与版本号不变。预览后若已发布新版本，确认将报冲突且不落库。</p>
    <div id="redactDialogMsg"></div>`;
}

async function previewRedaction() {
  const source = $('#redactSource').value;
  if (!source.trim()) { showRedactMsg('error', '出处原文不能为空，请输入要撤回公开展示的出处文本（首尾空白会自动折叠）。'); return; }
  try {
    const data = await api('POST', '/api/editor/redaction-preview', { source });
    redactPreview = data;
    $('#redactBody').innerHTML = redactHitsHtml(data);
    $('#redactConfirm').disabled = false;
    $('#redactDialog').showModal();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    showRedactMsg('error', esc(err.message));
  }
}

async function confirmRedaction() {
  if (!redactPreview) return;
  const btn = $('#redactConfirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/redaction', {
      source: redactPreview.source,
      currentVersionNo: redactPreview.currentVersionNo,
      editor: store.editor || '匿名编辑',
    });
    $('#redactDialog').close();
    redactPreview = null;
    showRedactMsg('ok',
      data.alreadyRedacted
        ? `该出处<b>已处于遮盖状态</b>（此前已确认，未重复落库）：当前共遮盖 ${data.totalHitCount} 处公开位置。`
        : `已确认遮盖：访客读取最新年表或任一历史版本时，${data.totalHitCount} 处命中位置的出处统一显示
           <b>「出处已遮盖」</b>（事件主张 ${data.totalEventHitCount} 处、先于关系 ${data.totalRelationHitCount} 处）；
           历史快照、草稿与版本号均未改动，以后发布含同一文本的版本也自动遮盖。
           <a href="/" target="_blank">打开访客年表查看效果</a>`);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#redactDialog').close(); return; }
    const box = $('#redactDialogMsg');
    if (err.status === 409) {
      box.innerHTML = `<div class="alert error">${esc(err.message)}<br>
        <span class="muted">未做任何改动。请关闭本框后重新「预览命中位置」。</span></div>`;
      btn.disabled = true;
    } else {
      box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  }
}

// ---------- 版本原文（持口令，不遮盖） ----------
async function openRawVersion(versionNo) {
  $('#rawVersionNo').textContent = versionNo;
  $('#rawVersionBody').textContent = '加载中…';
  $('#rawVersionDialog').showModal();
  try {
    const data = await api('GET', `/api/editor/versions/${versionNo}/raw`);
    const v = data.version;
    const titleById = new Map(v.events.map((e) => [e.eventId, e.title]));
    const evs = v.events.map((e) => `
      <div class="rel-line">
        <strong>${esc(e.title)}</strong> <span class="badge">${esc(e.dateLabel)}</span>
        <div class="source"><b>出处原文：</b>${esc(e.source || '（未注明）')}</div>
        ${e.claimNote ? `<div class="muted">${esc(e.claimNote)}</div>` : ''}
      </div>`).join('');
    const rels = v.relations.length
      ? v.relations.map((r) => `
          <div class="rel-line">
            <strong>${esc(titleById.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
            <span class="badge">先于</span>
            <strong>${esc(titleById.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
            ${r.source ? `<div class="source"><b>出处原文：</b>${esc(r.source)}</div>` : ''}
          </div>`).join('')
      : '<p class="muted">（无先于关系）</p>';
    $('#rawVersionBody').innerHTML = `
      ${data.retraction
        ? `<div class="alert error">本版已于 ${esc(data.retraction.retractedAt)} UTC 被 ${esc(data.retraction.editor || '匿名')} 撤回（访客不可见）：<br>
            <b>撤回原因：</b>${esc(data.retraction.reason)}</div>`
        : ''}
      <p class="muted">${v.eventCount} 个事件、${v.relationCount} 条关系 · 发布于 ${esc(v.publishedAt)} UTC。
        以下为快照<b>原文</b>；访客公开接口中命中遮盖登记的出处会显示「出处已遮盖」。</p>
      <h3 style="font-size:13px">事件与被选主张</h3>${evs}
      <h3 style="font-size:13px;margin-top:10px">「先于」关系</h3>${rels}`;
  } catch (err) {
    if (err.message === 'unauthorized') { $('#rawVersionDialog').close(); return; }
    $('#rawVersionBody').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}

// ---------- 预约发布 ----------
function showScheduleResult(kind, html) {
  $('#scheduleResult').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function utcIsoFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const SCHEDULE_STATUS_LABEL = {
  pending: '待执行',
  published: '已发布',
  conflict: '冲突未发布',
  cancelled: '已取消',
};

async function loadSchedules() {
  try {
    const data = await api('GET', '/api/editor/schedules');
    renderScheduleList(data.schedules);
  } catch (err) {
    if (err.message !== 'unauthorized') $('#scheduleList').innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}

function renderScheduleList(schedules) {
  if (!schedules.length) {
    $('#scheduleList').innerHTML = '<p class="muted">尚无预约。</p>';
    return;
  }
  const nowMs = Date.now();
  $('#scheduleList').innerHTML = schedules.map((s) => {
    const dueMs = Date.parse(s.scheduledAt);
    const countdown = s.status === 'pending'
      ? `<span class="muted">（${esc(describeDelta(dueMs - nowMs))}后执行）</span>`
      : '';
    const statusBadge = s.status === 'conflict'
      ? '<span class="badge" style="background:#fbeaea;color:#a33">冲突未发布</span>'
      : `<span class="badge">${esc(SCHEDULE_STATUS_LABEL[s.status] || s.status)}</span>`;
    const action = s.status === 'pending'
      ? `<button class="danger" type="button" data-cancel-schedule="${s.scheduleNo}" style="padding:2px 10px;font-size:13px">取消预约</button>`
      : '';
    return `
      <div class="rel-line">
        <div class="row" style="align-items:center">
          <strong>预约 #${s.scheduleNo}</strong>
          ${statusBadge}
          <span class="muted" style="flex:1">${esc(s.scheduledAt)} ${countdown} · ${esc(s.editor || '匿名')} ·
            冻结于第 ${s.baseVersionNo} 版 · ${s.eventCount} 事件 / ${s.relationCount} 关系</span>
          <button class="secondary" type="button" data-view-schedule="${s.scheduleNo}" style="padding:2px 10px;font-size:13px">查看冻结内容</button>
          ${action}
        </div>
        ${s.note ? `<div class="muted">说明：${esc(s.note)}</div>` : ''}
        ${s.status === 'published'
          ? `<div class="muted">已于 ${esc(s.attemptedAt || '')} UTC 生成 <b>第 ${s.resultVersionNo} 版</b>。</div>` : ''}
        ${s.status === 'conflict'
          ? `<div class="muted" style="color:#a33">${esc(s.resultMessage)}</div>` : ''}
      </div>`;
  }).join('');
}

function describeDelta(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.round(min / 60);
  return `${hr} 小时`;
}

async function doCreateSchedule() {
  const err = clientCheck();
  if (err) { showScheduleResult('error', esc(err)); return; }
  const scheduledAt = $('#scheduleAt').value.trim();
  if (!scheduledAt) { showScheduleResult('error', '请填写预约发布的未来 UTC 时刻（形如 2026-10-02T12:34:00Z）。'); return; }
  const btn = $('#btnSchedule');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/schedules', {
      selection: gatherSelection(),
      scheduledAt,
      baseVersionNo,
      editor: store.editor || '匿名编辑',
      note: $('#publishNote').value,
    });
    showScheduleResult('ok',
      `已建立 <b>预约 #${data.schedule.scheduleNo}</b>：将在 <b>${esc(data.schedule.scheduledAt)}</b> 尝试发布。
       事件、所选主张、关系、求解日期与基准版本号（第 ${data.schedule.baseVersionNo} 版）已冻结；
       到期前访客仍只见当前最新版，之后修改草稿不影响本预约。`);
    $('#scheduleAt').value = '';
    await loadSchedules();
  } catch (e) {
    if (e.status === 422 && e.body?.errors) {
      showScheduleResult('error',
        `<b>草稿未通过发布校验，未建立预约。</b><ul class="error-list">${
          e.body.errors.map((er) => `<li><b>${esc(er.message)}</b></li>`).join('')
        }</ul>`);
    } else if (e.status === 409) {
      showScheduleResult('error', esc(e.message) + ' 未建立任何预约。');
      conflictData = e.body;
      showConflictDialog(e.body);
    } else {
      showScheduleResult('error', esc(e.message));
    }
  } finally {
    btn.disabled = false;
  }
}

async function openScheduleDetail(no) {
  $('#scheduleDetailNo').textContent = '#' + no;
  $('#scheduleBody').textContent = '加载中…';
  $('#scheduleCancelDlg').disabled = false;
  $('#scheduleDialog').showModal();
  scheduleDetail = null;
  try {
    const data = await api('GET', `/api/editor/schedules/${no}`);
    scheduleDetail = data.schedule;
    renderScheduleDetail(data.schedule);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#scheduleDialog').close(); return; }
    $('#scheduleBody').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    $('#scheduleCancelDlg').disabled = true;
  }
}

function renderScheduleDetail(s) {
  const evs = s.frozen.events.map((e) => `
    <div class="rel-line">
      <strong>${esc(e.title)}</strong>
      <span class="badge prec">${esc(e.dateLabel)}</span>
      <span class="badge">求解日期 ${esc(e.resolvedDate)}</span>
      <span class="muted">区间 ${esc(e.intervalStart)} ~ ${esc(e.intervalEnd)}</span>
      <div class="source"><b>出处：</b>${esc(e.source || '（未注明）')}</div>
      ${e.claimNote ? `<div class="muted">${esc(e.claimNote)}</div>` : ''}
    </div>`).join('');
  const titleById = new Map(s.frozen.events.map((e) => [e.eventId, e.title]));
  const rels = s.frozen.relations.length
    ? s.frozen.relations.map((r) => `
      <div class="rel-line">
        <strong>${esc(titleById.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
        <span class="badge">先于</span>
        <strong>${esc(titleById.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
        ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
      </div>`).join('')
    : '<p class="muted">（无先于关系）</p>';

  const statusLine = {
    pending: `<p>状态：<b>待执行</b>，将于 <b>${esc(s.scheduledAt)}</b> 尝试发布。到期前可取消。</p>`,
    published: `<p>状态：<b>已发布</b>，${esc(s.attemptedAt || '')} UTC 生成 <b>第 ${s.resultVersionNo} 版</b>，不可取消。</p>`,
    conflict: `<p>状态：<b style="color:#a33">冲突未发布</b>。${esc(s.resultMessage)}<br>
      <span class="muted">冻结内容完整保留如下，可重新核对草稿后即时发布或另建预约。</span></p>`,
    cancelled: '<p>状态：<b>已取消</b>，不会发布。</p>',
  }[s.status];

  $('#scheduleBody').innerHTML = `
    ${statusLine}
    <p class="muted">冻结时基准版本号：第 ${s.baseVersionNo} 版 · 草稿修订号 ${s.draftRevisionNo} ·
      建立于 ${esc(s.createdAt)} UTC · 编辑者：${esc(s.editor || '匿名')}${s.note ? ' · 说明：' + esc(s.note) : ''}</p>
    <h3 style="font-size:13px">冻结的事件与被选主张（${s.eventCount}）</h3>
    ${evs}
    <h3 style="font-size:13px;margin-top:10px">冻结的「先于」关系（${s.relationCount}）</h3>
    ${rels}
    <div id="scheduleDlgMsg"></div>`;
  $('#scheduleCancelDlg').style.display = s.status === 'pending' ? '' : 'none';
}

async function cancelScheduleFromDialog() {
  if (!scheduleDetail) return;
  const btn = $('#scheduleCancelDlg');
  btn.disabled = true;
  try {
    await api('DELETE', `/api/editor/schedules/${scheduleDetail.scheduleNo}`);
    $('#scheduleDialog').close();
    showScheduleResult('ok', `预约 #${scheduleDetail.scheduleNo} 已取消，不会发布。`);
    await loadSchedules();
  } catch (err) {
    if (err.message === 'unauthorized') { $('#scheduleDialog').close(); return; }
    $('#scheduleDlgMsg').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    btn.disabled = false;
  }
}

async function cancelScheduleInline(no) {
  if (!confirm(`确定取消预约 #${no}？取消后该预约不会发布。`)) return;
  try {
    await api('DELETE', `/api/editor/schedules/${no}`);
    await loadSchedules();
    showScheduleResult('ok', `预约 #${no} 已取消。`);
  } catch (err) {
    if (err.message !== 'unauthorized') showScheduleResult('error', esc(err.message));
  }
}

// ---------- 专题「先于」脉络路线 ----------
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const anchorMark = (pos) => CIRCLED[pos] || `(${pos + 1})`;

function showRouteMsg(kind, html) {
  $('#routeMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

// 路线详情渲染（编辑者原文视图与访客视图共用的结构）：
// 锚点顺序条 + 每段见证链（锚点与中间事件区分，只含路线涉及的事件与关系）。
function routeDetailHtml(route) {
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
        ${ev.resolvedDate ? `<span class="muted">${esc(ev.resolvedDate)}</span>` : ''}
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
          <span class="muted">（见证链含 ${s.relationIds.length} 条关系，为最少）</span></h3>
        ${parts.join('')}
      </div>`;
  }).join('');

  return `
    <p class="muted">路线 #${route.routeNo} · 据第 ${route.versionNo} 版年表 · 建立于 ${esc(route.createdAt)} UTC ·
      编辑者：${esc(route.editor || '匿名')}${route.note ? ` · 说明：${esc(route.note)}` : ''}<br>
      路线已固定所据版本、锚点顺序与见证链；之后修改草稿、恢复草稿或发布新版均不改变本路线。</p>
    <p>${anchorLine}</p>
    ${segments}`;
}

async function loadRoutes() {
  try {
    const data = await api('GET', '/api/editor/routes');
    renderRouteList(data.routes);
  } catch (err) {
    if (err.message !== 'unauthorized') $('#routeList').innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}

function renderRouteList(routes) {
  if (!routes.length) {
    $('#routeList').innerHTML = '<p class="muted">尚无路线。</p>';
    return;
  }
  $('#routeList').innerHTML = routes.map((r) => `
    <div class="rel-line">
      <div class="row" style="align-items:center">
        <strong>#${r.routeNo} ${esc(r.title)}</strong>
        <span class="badge">据第 ${r.versionNo} 版</span>
        ${r.versionRetracted ? '<span class="badge" style="background:#fbeaea;color:#a33">所据版本已撤回（访客不可见）</span>' : ''}
        <span class="muted" style="flex:1">${r.anchorCount} 个锚点 · ${r.segmentCount} 段 · ${esc(r.createdAt)} UTC · ${esc(r.editor || '匿名')}</span>
        <button class="secondary" type="button" data-view-route="${r.routeNo}" style="padding:2px 10px;font-size:13px">查看路线（原文）</button>
        ${r.versionRetracted
          ? '<span class="muted" style="font-size:13px">撤回版路线对访客隐藏</span>'
          : `<a href="/api/public/routes/${r.routeNo}" target="_blank" style="font-size:13px">访客视角 JSON</a>`}
      </div>
      ${r.note ? `<div class="muted">说明：${esc(r.note)}</div>` : ''}
    </div>`).join('');
}

async function loadRouteVersionEvents() {
  const no = Number($('#routeVersion').value);
  if (!no) { showRouteMsg('error', '请先发布一个版本，再从中挑选锚点事件。'); return; }
  routeAnchorIds = [];
  renderRouteAnchors();
  try {
    const data = await api('GET', `/api/editor/versions/${no}/raw`);
    routeVersionEvents = data.version.events;
    $('#routeEventPool').innerHTML = `
      <p class="muted" style="margin:4px 0">第 ${no} 版事件（点击按顺序追加为锚点；事件 id 见括号）：</p>
      ${routeVersionEvents.map((e) => `
        <button class="secondary" type="button" data-add-anchor="${e.eventId}" style="margin:2px 4px 2px 0;padding:3px 10px;font-size:13px">
          ＋ ${esc(e.title)} <span class="muted">(#${e.eventId} · ${esc(e.resolvedDate)})</span>
        </button>`).join('')}`;
    showRouteMsg('ok', `已加载第 ${no} 版共 ${routeVersionEvents.length} 个事件，请依次点击追加锚点。`);
  } catch (err) {
    if (err.message !== 'unauthorized') showRouteMsg('error', esc(err.message));
  }
}

function renderRouteAnchors() {
  if (!routeAnchorIds.length) {
    $('#routeAnchors').innerHTML = '<p class="muted">尚未选择锚点。</p>';
    return;
  }
  const titleOf = (id) => {
    const ev = routeVersionEvents.find((e) => e.eventId === id);
    return ev ? ev.title : `#${id}`;
  };
  $('#routeAnchors').innerHTML = routeAnchorIds.map((id, i) => `
    <div class="rel-line">
      <span class="badge prec">锚点 ${anchorMark(i)}</span>
      <strong>${esc(titleOf(id))}</strong>
      <span class="muted">(#${id})</span>
      ${i < routeAnchorIds.length - 1 ? '<span class="muted">→ 须先于下一锚点（该版关系图中须有有向路径）</span>' : ''}
      <button class="danger" type="button" data-remove-anchor="${i}" style="float:right;padding:2px 10px;font-size:13px">移除</button>
    </div>`).join('');
}

async function createRouteFromUi() {
  const title = $('#routeTitle').value.trim();
  if (!title) { showRouteMsg('error', '请填写专题标题。'); return; }
  const versionNo = Number($('#routeVersion').value);
  if (!versionNo) { showRouteMsg('error', '请先选择所据版本。'); return; }
  if (routeAnchorIds.length < 2) { showRouteMsg('error', '请至少选择两个互异的锚点事件。'); return; }
  const btn = $('#btnRouteCreate');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/routes', {
      title,
      versionNo,
      anchorEventIds: routeAnchorIds,
      editor: store.editor || '匿名编辑',
      note: $('#routeNote').value,
    });
    showRouteMsg('ok', `
      已建立 <b>路线 #${data.route.routeNo}「${esc(data.route.title)}」</b>（据第 ${data.route.versionNo} 版，
      ${data.route.anchors.length} 个锚点、${data.route.segments.length} 段见证链），内容已冻结、不可变。
      之后修改草稿、恢复草稿或发布新版均不改变本路线。
      <a href="/" target="_blank">打开访客年表查看</a>`);
    $('#routeTitle').value = '';
    $('#routeNote').value = '';
    routeAnchorIds = [];
    renderRouteAnchors();
    await loadRoutes();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    if (err.status === 422 && err.body && Array.isArray(err.body.errors)) {
      const items = err.body.errors.map((e2) => `<li>${esc(e2.message)}</li>`).join('');
      showRouteMsg('error', `<b>${esc(err.body.message || '路线未保存')}</b><ul class="error-list">${items}</ul>`);
    } else {
      showRouteMsg('error', esc(err.message));
    }
  } finally {
    btn.disabled = false;
  }
}

async function openRouteDetail(no) {
  $('#routeDetailNo').textContent = '#' + no;
  $('#routeBody').textContent = '加载中…';
  $('#routeDialog').showModal();
  try {
    const data = await api('GET', `/api/editor/routes/${no}/raw`);
    $('#routeBody').innerHTML = routeDetailHtml(data.route);
  } catch (err) {
    if (err.message === 'unauthorized') { $('#routeDialog').close(); return; }
    $('#routeBody').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}

// ---------- 并行编辑会话（暂存 → 三方合并提交） ----------
const SESSION_STATUS_LABEL = { open: '进行中', committed: '已提交', conflicted: '冲突已关闭' };
const SESSION_STATUS_STYLE = {
  open: '',
  committed: 'background:#edf5ee;color:#3e7a4f',
  conflicted: 'background:#fbeaea;color:#a33',
};

function showSessionMsg(kind, html) {
  $('#sessionMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

async function loadSessions() {
  try {
    const data = await api('GET', '/api/editor/sessions');
    renderSessionList(data.sessions);
  } catch (err) {
    if (err.message !== 'unauthorized') $('#sessionList').innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}

function renderSessionList(sessions) {
  if (!sessions.length) {
    $('#sessionList').innerHTML = '<p class="muted">尚无会话。两名编辑者并行整理时，请各自「开启新会话」。</p>';
    return;
  }
  $('#sessionList').innerHTML = sessions.map((s) => `
    <div class="rel-line">
      <div class="row" style="align-items:center">
        <strong>会话 #${s.sessionId}</strong>
        <span class="badge" style="${SESSION_STATUS_STYLE[s.status] || ''}">${SESSION_STATUS_LABEL[s.status] || s.status}</span>
        <span class="muted" style="flex:1">${esc(s.editor || '匿名')} · 基线修订号 ${s.baseRevisionNo} · 暂存操作 ${s.opCount} 条 ·
          开启于 ${esc(s.openedAt)} UTC${s.closedAt ? ` · 关闭于 ${esc(s.closedAt)} UTC` : ''}</span>
        <button class="secondary" type="button" data-view-session="${s.sessionId}" style="padding:2px 10px;font-size:13px">查看会话</button>
      </div>
      ${s.status === 'committed' ? `<div class="muted">已提交：新草稿修订号 ${s.revisionNo}。</div>` : ''}
      ${s.status === 'conflicted' ? `<div class="muted" style="color:#a33">提交因 ${s.conflictCount} 处冲突被拒绝，草稿未改动；请基于最新草稿重开会话。</div>` : ''}
      ${s.status === 'open' && s.restoredAfterOpen ? `<div class="muted" style="color:#a33">草稿在此期间被「从历史版本恢复」替换过，本会话提交将被拒绝；请开启新会话。</div>` : ''}
    </div>`).join('');
}

async function openEditSession() {
  try {
    const data = await api('POST', '/api/editor/sessions', {
      editor: store.editor || '匿名编辑',
      note: '',
    });
    showSessionMsg('ok',
      `已开启 <b>会话 #${data.session.sessionId}</b>：基线草稿修订号 ${data.session.baseRevisionNo}
       （事件 ${data.session.baseline.counts.eventCount} 个 / 主张 ${data.session.baseline.counts.claimCount} 条 /
       关系 ${data.session.baseline.counts.relationCount} 条已快照）。请在下方暂存修改，完成后提交。`);
    await loadSessions();
    await openSessionDetail(data.session.sessionId);
  } catch (err) {
    if (err.message !== 'unauthorized') showSessionMsg('error', esc(err.message));
  }
}

async function openSessionDetail(id) {
  try {
    const data = await api('GET', `/api/editor/sessions/${id}`);
    sessionCurrent = data.session;
    renderSessionDetail();
  } catch (err) {
    if (err.message !== 'unauthorized') showSessionMsg('error', esc(err.message));
  }
}

function sessionEventTitle(working, id, tempId) {
  const ev = working.events.find((e) => (id !== null && e.id === id) || (tempId !== null && e.tempId === tempId));
  if (ev) return ev.title;
  return tempId !== null ? `临时「${tempId}」` : `#${id}`;
}

function sessionWorkingHtml(working) {
  const evs = working.events.map((ev) => `
    <div class="rel-line">
      <strong>${esc(ev.title)}</strong>
      ${ev.tempId ? `<span class="badge prec">临时编号 ${esc(ev.tempId)}</span>` : `<span class="badge">事件 #${ev.id}</span>`}
      ${ev.description ? `<div class="muted">${esc(ev.description)}</div>` : ''}
      ${ev.claims.map((c) => `
        <div class="source"><b>${esc(c.dateLabel)}</b>（区间 ${c.intervalStart} ~ ${c.intervalEnd}）
          ${c.tempId ? `<span class="badge prec">临时编号 ${esc(c.tempId)}</span>` : `<span class="badge">主张 #${c.id}</span>`}<br>
          <b>出处：</b>${esc(c.source)}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</div>`).join('')}
    </div>`).join('');
  const rels = working.relations.length
    ? working.relations.map((r) => `
        <div class="rel-line">
          <strong>${esc(sessionEventTitle(working, r.earlierId, r.earlierTempId))}</strong>
          <span class="badge">先于</span>
          <strong>${esc(sessionEventTitle(working, r.laterId, r.laterTempId))}</strong>
          ${r.tempId ? `<span class="badge prec">临时编号 ${esc(r.tempId)}</span>` : `<span class="badge">关系 #${r.id}</span>`}
          ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
        </div>`).join('')
    : '<p class="muted">（无「先于」关系）</p>';
  return `
    <h3 style="font-size:13px">事件与主张（${working.counts.eventCount} 事件 / ${working.counts.claimCount} 主张）</h3>
    <div style="max-height:260px;overflow:auto">${evs || '<p class="muted">（无事件）</p>'}</div>
    <h3 style="font-size:13px;margin-top:8px">「先于」关系（${working.counts.relationCount}）</h3>
    ${rels}`;
}

function sessionOpsHtml(ops) {
  if (!ops.length) return '<p class="muted">尚未暂存任何操作。</p>';
  return `<ol style="margin:4px 0;padding-left:20px;font-size:13px">
    ${ops.map((op) => `<li><code>${esc(JSON.stringify(op))}</code></li>`).join('')}
  </ol>`;
}

function fmtVal(v) {
  if (v === null || v === undefined) return '（空）';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function objSummary(obj) {
  if (obj === null || obj === undefined) return '<span class="muted">（已删除 / 不存在）</span>';
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== '');
  if (!entries.length) return '<span class="muted">（空）</span>';
  return entries.map(([k, v]) => `<div><span class="muted">${esc(k)}：</span>${esc(fmtVal(v))}</div>`).join('');
}

function sessionConflictItemHtml(c) {
  const typeLabel = {
    field_conflict: '同一字段双方不同值',
    edit_delete: '编辑与删除相撞',
    endpoint_deleted: '关系端点已删除',
    restore_rebased: '恢复导致对象身份更替',
  }[c.type] || c.type;
  if (c.type === 'restore_rebased') {
    const restores = Array.isArray(c.restores) ? c.restores : [];
    return `
      <div class="rel-line">
        <span class="badge" style="background:#fbeaea;color:#a33">${esc(typeLabel)}</span>
        <div>${esc(c.message)}</div>
        ${restores.length
          ? `<div class="muted">期间发生的恢复：${restores.map((r) => `第 ${r.restoreNo} 次（恢复自第 ${r.versionNo} 版，${esc(r.restoredAt)} UTC）`).join('；')}</div>`
          : ''}
        <div class="muted">恢复会重排对象编号，基线中的对象与当前草稿的同编号对象已不再是同一对象；请「开启新会话」基于最新草稿重新整理。</div>
      </div>`;
  }
  const objLabel = { event: '事件', claim: '主张', relation: '「先于」关系' }[c.objectType] || c.objectType;
  let table;
  if (c.type === 'field_conflict' && Array.isArray(c.fields)) {
    table = `
      <table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:4px">
        <tr style="color:#7a7166"><th style="text-align:left">字段</th><th style="text-align:left">基线</th><th style="text-align:left">当前草稿（对方）</th><th style="text-align:left">拟提交（本会话）</th></tr>
        ${c.fields.map((f) => `<tr>
          <td style="border-top:1px dashed #e3d9c6;padding:2px 6px 2px 0">${esc(f.field)}</td>
          <td style="border-top:1px dashed #e3d9c6">${esc(fmtVal(f.baseline))}</td>
          <td style="border-top:1px dashed #e3d9c6">${esc(fmtVal(f.current))}</td>
          <td style="border-top:1px dashed #e3d9c6">${esc(fmtVal(f.proposed))}</td>
        </tr>`).join('')}
      </table>`;
  } else {
    table = `
      <table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:4px">
        <tr style="color:#7a7166"><th style="text-align:left"></th><th style="text-align:left">基线</th><th style="text-align:left">当前草稿（对方）</th><th style="text-align:left">拟提交（本会话）</th></tr>
        <tr>
          <td style="border-top:1px dashed #e3d9c6;padding:2px 6px 2px 0">${esc(objLabel)}</td>
          <td style="border-top:1px dashed #e3d9c6;vertical-align:top">${objSummary(c.baseline)}</td>
          <td style="border-top:1px dashed #e3d9c6;vertical-align:top">${objSummary(c.current)}</td>
          <td style="border-top:1px dashed #e3d9c6;vertical-align:top">${objSummary(c.proposed)}</td>
        </tr>
      </table>`;
  }
  const blockers = Array.isArray(c.blockers) && c.blockers.length
    ? `<div class="muted">对方新增的内容：${c.blockers.map((b) => esc(JSON.stringify(b))).join('；')}</div>`
    : '';
  return `
    <div class="rel-line">
      <span class="badge" style="background:#fbeaea;color:#a33">${esc(typeLabel)}</span>
      <strong>${esc(objLabel)}${c.id ? ` #${c.id}` : ''}${c.tempId ? `（临时编号 ${esc(c.tempId)}）` : ''}</strong>
      <div>${esc(c.message)}</div>
      ${blockers}
      ${table}
    </div>`;
}

function renderSessionDetail() {
  const s = sessionCurrent;
  if (!s) {
    $('#sessionDetail').innerHTML = '';
    return;
  }
  const statusBadge = `<span class="badge" style="${SESSION_STATUS_STYLE[s.status] || ''}">${SESSION_STATUS_LABEL[s.status] || s.status}</span>`;
  let body = '';

  if (s.status === 'open') {
    body = `
      ${s.restoredAfterOpen
        ? `<div class="alert error">本会话开启后，草稿被「从历史版本恢复」整体替换过：对象编号已重新占用，
            基线中的对象与当前草稿的同编号对象已不再是同一对象。本会话的提交将被整次拒绝（409），
            请「开启新会话」基于最新草稿重新整理。</div>`
        : ''}
      <p class="muted">会话进行中：草稿不加锁，对方可继续编辑。把本轮修改写成操作暂存进来（不直接写草稿），
        完成后点「提交会话」。引用基线中的对象用其 id（见下方工作稿），新建对象用临时编号互相引用。</p>
      <label>暂存操作（JSON 数组，整批校验、整批拒绝）</label>
      <textarea id="sessionOpsText" rows="6" placeholder='[{"op":"update_event","eventId":1,"title":"新标题"}]'></textarea>
      <div style="margin-top:6px">
        <button class="secondary" type="button" id="btnSessionOpsExample" style="font-size:13px">填入示例</button>
        <button type="button" id="btnSessionStage">暂存这批操作</button>
      </div>
      <h3 style="font-size:13px;margin-top:12px">已暂存操作（${s.ops.length}）</h3>
      ${sessionOpsHtml(s.ops)}
      <h3 style="font-size:13px;margin-top:10px">会话工作稿预览（基线 + 暂存操作）</h3>
      ${sessionWorkingHtml(s.working)}
      <div style="margin-top:10px">
        <button type="button" id="btnSessionCommit">提交会话（三方合并）</button>
      </div>`;
  } else if (s.status === 'committed') {
    const r = s.result || {};
    const idMapLines = [
      ...(r.idMap?.events || []).map((m) => `事件 临时「${m.tempId}」→ 正式 #${m.eventId}`),
      ...(r.idMap?.claims || []).map((m) => `主张 临时「${m.tempId}」→ 正式 #${m.claimId}（事件 #${m.eventId}）`),
      ...(r.idMap?.relations || []).map((m) => `关系 临时「${m.tempId}」→ 正式 #${m.relationId}`),
    ];
    const a = r.applied || {};
    body = `
      <div class="alert ok">已提交：全部变更已原子应用，新草稿修订号 <b>${r.revisionNo}</b>。
        重试本提交不会重复写入（返回首次结果）。</div>
      <p class="muted">应用明细：事件 +${a.eventsCreated} 改${a.eventsUpdated} 删${a.eventsDeleted} ·
        主张 +${a.claimsCreated} 改${a.claimsUpdated} 删${a.claimsDeleted} ·
        关系 +${a.relationsCreated} 改${a.relationsUpdated} 删${a.relationsDeleted}</p>
      ${(r.autoMerged || []).length
        ? `<p class="muted">自动合并（双方改了不同字段）：${r.autoMerged.map((m) => `${m.objectType} #${m.id}`).join('、')}</p>`
        : ''}
      ${idMapLines.length ? `<h3 style="font-size:13px">临时编号 → 正式编号</h3><ul style="margin:4px 0;padding-left:20px;font-size:13px">${idMapLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}`;
  } else {
    const r = s.result || {};
    body = `
      <div class="alert error">提交被拒绝：${(r.conflicts || []).length} 处冲突，草稿未做任何改动（对方的改动原样保留）。
        请逐项核对下方的基线 / 当前值 / 拟提交值，然后<b>基于最新草稿重开会话</b>人工重编。</div>
      ${(r.conflicts || []).map(sessionConflictItemHtml).join('')}`;
  }

  $('#sessionDetail').innerHTML = `
    <div class="card" style="background:#fff;margin-bottom:0">
      <div class="row" style="align-items:center">
        <strong>会话 #${s.sessionId}</strong>
        ${statusBadge}
        <span class="muted" style="flex:1">${esc(s.editor || '匿名')} · 基线修订号 ${s.baseRevisionNo} ·
          当前草稿修订号 ${s.currentRevisionNo} · 开启于 ${esc(s.openedAt)} UTC</span>
        <button class="secondary" type="button" id="btnSessionClose" style="padding:2px 10px;font-size:13px">收起</button>
      </div>
      <div style="margin-top:8px">${body}</div>
    </div>`;
}

function fillSessionOpsExample() {
  const ev = state.events[0];
  const ops = [
    { op: 'create_event', tempId: 'linshi-1', title: '会话内新事件', description: '提交时才写入草稿' },
    { op: 'create_claim', tempId: 'linshi-c1', eventRef: 'linshi-1', precision: 'year', year: 1960, source: '出处必填' },
  ];
  if (ev) {
    ops.push({ op: 'update_event', eventId: ev.id, description: '会话内修改的描述（只改这一个字段）' });
    const ev2 = state.events[1];
    if (ev2) ops.push({ op: 'create_relation', tempId: 'linshi-r1', earlierId: ev.id, laterId: ev2.id, source: '可选出处' });
  }
  $('#sessionOpsText').value = JSON.stringify(ops, null, 2);
}

async function stageSessionOps() {
  if (!sessionCurrent) return;
  const text = $('#sessionOpsText').value.trim();
  if (!text) { showSessionMsg('error', '请先填写要暂存的操作（JSON 数组），或点「填入示例」。'); return; }
  let ops;
  try {
    ops = JSON.parse(text);
    if (Array.isArray(ops)) { /* ok */ } else if (ops && Array.isArray(ops.ops)) { ops = ops.ops; } else {
      throw new Error('应为操作数组，如 [{"op":"update_event","eventId":1,"title":"…"}]');
    }
  } catch (e) {
    showSessionMsg('error', `JSON 解析失败：${esc(e.message)}`);
    return;
  }
  try {
    const data = await api('POST', `/api/editor/sessions/${sessionCurrent.sessionId}/ops`, { ops });
    showSessionMsg('ok', `已暂存 ${data.staged} 条操作（会话共 ${data.opCount} 条）。草稿尚未变化，提交时才合并写入。`);
    await openSessionDetail(sessionCurrent.sessionId);
    await loadSessions();
  } catch (err) {
    if (err.message === 'unauthorized') return;
    if (err.status === 422 && err.body && Array.isArray(err.body.problems)) {
      showSessionMsg('error', `<b>${esc(err.body.message)}</b>
        <ul class="error-list">${err.body.problems.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul>`);
    } else {
      showSessionMsg('error', esc(err.message));
    }
  }
}

async function commitEditSession() {
  if (!sessionCurrent) return;
  if (!confirm(`提交会话 #${sessionCurrent.sessionId}？\n将对照会话基线与当前草稿做三方合并：无冲突则原子应用全部变更；有冲突则整次拒绝（不覆盖对方改动）。`)) return;
  try {
    const data = await api('POST', `/api/editor/sessions/${sessionCurrent.sessionId}/commit`);
    showSessionMsg('ok',
      `会话 #${data.sessionId} <b>提交成功</b>：新草稿修订号 ${data.revisionNo}。
       临时编号 → 正式编号映射见会话详情。下方草稿区已刷新。`);
    await openSessionDetail(data.sessionId);
    await loadSessions();
    await loadState(); // 草稿已变化，刷新主编辑区
  } catch (err) {
    if (err.message === 'unauthorized') return;
    if (err.status === 409 && err.body && Array.isArray(err.body.conflicts)) {
      showSessionMsg('error',
        `<b>${esc(err.body.message)}</b><br>
         <span class="muted">逐项明细见会话详情；冲突后请「开启新会话」基于最新草稿人工重编。</span>`);
      await openSessionDetail(sessionCurrent.sessionId);
      await loadSessions();
    } else {
      showSessionMsg('error', esc(err.message));
    }
  }
}

// ---------- 勘误附记（对指定已发布版本的事件 / 「先于」关系） ----------
let errataVersionData = null; // 当前加载的目标版 {versionNo, detail, errata:{targets}}
let errataSelected = null;    // 当前选中的附记目标 {targetType, targetId}

function showErrataMsg(kind, html) {
  $('#errataMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function errataTargetLabel(targetType, targetId) {
  const d = errataVersionData && errataVersionData.detail;
  if (!d) return `#${targetId}`;
  if (targetType === 'event') {
    const ev = d.events.find((e) => e.eventId === targetId);
    return `事件「${ev ? ev.title : '#' + targetId}」`;
  }
  const rel = d.relations.find((r) => r.relationId === targetId);
  if (!rel) return `关系 #${targetId}`;
  const titleOf = (id) => (d.events.find((e) => e.eventId === id) || {}).title || `#${id}`;
  return `关系「${titleOf(rel.earlierEventId)} 先于 ${titleOf(rel.laterEventId)}」`;
}

function errataEffectiveOf(targetType, targetId) {
  const t = errataVersionData && errataVersionData.errata.targets.find(
    (x) => x.targetType === targetType && x.targetId === targetId
  );
  return t ? t.effective : null;
}

async function loadErrataVersion() {
  const no = Number($('#errataVersion').value);
  if (!no) { showErrataMsg('error', '请先发布一个版本，再对其登记勘误附记。'); return; }
  errataSelected = null;
  $('#errataForm').style.display = 'none';
  try {
    const [raw, list] = await Promise.all([
      api('GET', `/api/editor/versions/${no}/raw`),
      api('GET', `/api/editor/versions/${no}/errata`),
    ]);
    errataVersionData = { versionNo: no, detail: raw.version, retraction: raw.retraction, errata: list };
    renderErrataPool();
    renderErrataList();
    const retractHint = raw.retraction
      ? `注意：第 ${no} 版已撤回（${esc(raw.retraction.reason)}），只能查阅附记，不能登记新附记。`
      : `可点击下方任一事件或「先于」关系登记附记；已撤回版不能登记。`;
    showErrataMsg(raw.retraction ? 'warn' : 'ok',
      `已加载第 ${no} 版：${raw.version.eventCount} 个事件、${raw.version.relationCount} 条关系、
       附记 ${list.totalCount} 条（${list.targets.length} 个目标）。${retractHint}`);
  } catch (err) {
    if (err.message !== 'unauthorized') showErrataMsg('error', esc(err.message));
  }
}

function renderErrataPool() {
  const d = errataVersionData && errataVersionData.detail;
  if (!d) { $('#errataTargetPool').innerHTML = ''; return; }
  const btn = (targetType, targetId, label) => {
    const eff = errataEffectiveOf(targetType, targetId);
    return `
      <button class="secondary" type="button" data-errata-target="${targetType}:${targetId}"
              style="margin:2px 4px 2px 0;padding:3px 10px;font-size:13px">
        ＋ ${esc(label)}
        ${eff ? `<span class="badge prec">附记 #${eff.errataId}</span>` : ''}
      </button>`;
  };
  const titleOf = (id) => (d.events.find((e) => e.eventId === id) || {}).title || `#${id}`;
  $('#errataTargetPool').innerHTML = `
    <p class="muted" style="margin:4px 0">第 ${errataVersionData.versionNo} 版快照对象（点击选择附记目标；带徽标的已有生效附记）：</p>
    ${d.events.map((e) => btn('event', e.eventId, `${e.title} (#${e.eventId})`)).join('')}
    ${d.relations.map((r) => btn('relation', r.relationId,
      `${titleOf(r.earlierEventId)} 先于 ${titleOf(r.laterEventId)} (关系 #${r.relationId})`)).join('')}`;
}

function selectErrataTarget(targetType, targetId) {
  errataSelected = { targetType, targetId };
  $('#errataForm').style.display = '';
  $('#errataTargetInfo').textContent = errataTargetLabel(targetType, targetId);
  renderErrataCurrent();
  $('#errataNote').focus();
}

function renderErrataCurrent() {
  if (!errataSelected) { $('#errataCurrent').innerHTML = ''; return; }
  const eff = errataEffectiveOf(errataSelected.targetType, errataSelected.targetId);
  const retracted = errataVersionData && errataVersionData.retraction;
  $('#errataCurrent').innerHTML = eff
    ? `<div class="rel-line" style="background:#fff">
         <span class="badge prec">当前生效附记 #${eff.errataId}</span>
         <div>${esc(eff.note)}</div>
         <div class="source"><b>出处原文：</b>${esc(eff.source)}</div>
         <div class="muted">登记于 ${esc(eff.createdAt)} UTC${eff.editor ? ` · ${esc(eff.editor)}` : ''}；
           提交新附记将<b>替代</b>本条（旧条保留供追溯）。</div>
       </div>`
    : '<p class="muted">该目标尚无附记，本次登记为首条。</p>';
  $('#btnErrataSubmit').textContent = eff ? `替代附记 #${eff.errataId}（提交所见附记号）` : '登记附记';
  $('#btnErrataSubmit').disabled = Boolean(retracted);
}

async function submitErrata() {
  if (!errataVersionData || !errataSelected) return;
  const note = $('#errataNote').value.trim();
  const source = $('#errataSource').value.trim();
  if (!note) { showErrataMsg('error', '勘误说明不能为空。'); return; }
  if (!source) { showErrataMsg('error', '勘误出处不能为空。'); return; }
  const eff = errataEffectiveOf(errataSelected.targetType, errataSelected.targetId);
  const btn = $('#btnErrataSubmit');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/errata', {
      versionNo: errataVersionData.versionNo,
      targetType: errataSelected.targetType,
      targetId: errataSelected.targetId,
      note,
      source,
      editor: store.editor || '匿名编辑',
      ...(eff ? { replacesErrataId: eff.errataId } : {}),
    });
    $('#errataNote').value = '';
    $('#errataSource').value = '';
    await reloadErrataVersion();
    showErrataMsg('ok',
      data.replaced
        ? `已登记 <b>附记 #${data.errata.errataId}</b> 并替代附记 #${data.replaced.errataId}
           （旧附记保留在替代链中供追溯）。访客读取该版时可见新附记。`
        : `已登记 <b>附记 #${data.errata.errataId}</b>（该目标首条）。访客读取该版时可见；
           附记只属于第 ${data.errata.versionNo} 版，不随后续版本继承。`);
  } catch (err) {
    if (err.message === 'unauthorized') return;
    if (err.status === 409 && err.body && err.body.code === 'ERRATA_CONFLICT') {
      // 两人同时替代：对方已成功，本次未落库；展示当前生效附记供核对
      const cur = err.body.current;
      await reloadErrataVersion();
      showErrataMsg('error', `
        <b>替代冲突，本次未落库。</b>${esc(err.body.message)}<br>
        ${cur ? `当前生效附记 #${cur.errataId}：「${esc(cur.note)}」（出处：${esc(cur.source)}${cur.editor ? ` · ${esc(cur.editor)}` : ''}）。
          你填写的说明与出处仍保留在输入框中，确认要替代当前附记可再次提交。` : ''}`);
    } else if (err.status === 409 && err.body && err.body.code === 'VERSION_RETRACTED') {
      await reloadErrataVersion();
      showErrataMsg('error', esc(err.body.message));
    } else {
      showErrataMsg('error', esc(err.message));
    }
  } finally {
    // 撤回版不可登记（renderErrataCurrent 也会按此控制）
    btn.disabled = Boolean(errataVersionData && errataVersionData.retraction);
  }
}

async function reloadErrataVersion() {
  const no = errataVersionData.versionNo;
  const [raw, list] = await Promise.all([
    api('GET', `/api/editor/versions/${no}/raw`),
    api('GET', `/api/editor/versions/${no}/errata`),
  ]);
  errataVersionData = { versionNo: no, detail: raw.version, retraction: raw.retraction, errata: list };
  renderErrataPool();
  renderErrataList();
  if (errataSelected) renderErrataCurrent();
}

function renderErrataList() {
  const data = errataVersionData && errataVersionData.errata;
  if (!data) { $('#errataList').innerHTML = '尚未加载。'; return; }
  if (!data.targets.length) {
    $('#errataList').innerHTML = `<p class="muted">第 ${data.versionNo} 版尚无勘误附记。</p>`;
    return;
  }
  const itemHtml = (x, isEffective) => `
    <div class="rel-line" style="${isEffective ? '' : 'opacity:.75'}">
      <span class="badge ${isEffective ? 'prec' : ''}">附记 #${x.errataId}${isEffective ? ' · 生效' : ' · 已被替代'}</span>
      <div>${esc(x.note)}</div>
      <div class="source"><b>出处原文：</b>${esc(x.source)}</div>
      <div class="muted">登记于 ${esc(x.createdAt)} UTC${x.editor ? ` · ${esc(x.editor)}` : ''}${x.replacesErrataId ? ` · 替代附记 #${x.replacesErrataId}` : ' · 该目标首条'}</div>
    </div>`;
  $('#errataList').innerHTML = data.targets.map((t) => `
    <div class="card" style="background:#fff;margin-bottom:8px">
      <h3 style="font-size:13px">${esc(errataTargetLabel(t.targetType, t.targetId))}
        <span class="muted">（${t.targetType === 'event' ? '事件' : '关系'} #${t.targetId} · 共 ${t.chain.length} 条附记）</span></h3>
      ${t.chain.map((x) => itemHtml(x, x.errataId === t.effective.errataId)).join('')}
    </div>`).join('');
}

// ---------- 事件委托：增删改 ----------
async function onClick(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.id === 'tokenSave') {
    store.token = $('#tokenInput').value.trim();
    showGlobal('ok', '口令已保存到本浏览器。');
    await loadState();
    return;
  }
  if (t.id === 'btnValidate') return doValidate();
  if (t.id === 'btnPublish') return doPublish();
  if (t.id === 'btnSchedule') return doCreateSchedule();
  if (t.id === 'btnScheduleNow1m') {
    $('#scheduleAt').value = utcIsoFromMs(Date.now() + 60 * 1000);
    return;
  }
  const viewSchedule = t.dataset && t.dataset.viewSchedule;
  if (viewSchedule !== undefined) return openScheduleDetail(Number(viewSchedule));
  const cancelSch = t.dataset && t.dataset.cancelSchedule;
  if (cancelSch !== undefined) return cancelScheduleInline(Number(cancelSch));
  if (t.id === 'scheduleCancelDlg') return cancelScheduleFromDialog();
  if (t.id === 'scheduleClose') { $('#scheduleDialog').close(); scheduleDetail = null; return; }

  if (t.id === 'conflictCancel') { $('#conflictDialog').close(); return; }
  if (t.id === 'conflictReload') {
    $('#conflictDialog').close();
    await loadState();
    if (conflictData && conflictData.code === 'DRAFT_REVISION_CONFLICT') {
      showGlobal('warn', `已刷新为最新草稿（修订号 ${conflictData.currentRevisionNo}）。请重新确认各事件的主张选择，再发布或建立预约。`);
    } else {
      showGlobal('warn', `已刷新到第 ${baseVersionNo} 版后的最新草稿。请重新确认各事件的主张选择，再点击发布。`);
    }
    return;
  }

  if (t.id === 'restoreCancel') { $('#restoreDialog').close(); restorePreview = null; return; }
  if (t.id === 'restoreConfirm') return confirmRestore();
  const restoreVersion = t.dataset && t.dataset.restoreVersion;
  if (restoreVersion !== undefined) return openRestorePreview(Number(restoreVersion));
  const retractVersion = t.dataset && t.dataset.retractVersion;
  if (retractVersion !== undefined) return retractVersionFromUi(Number(retractVersion));

  if (t.id === 'btnBundlePreview') return previewBundleImport();
  if (t.id === 'bundleCancel') { $('#bundleDialog').close(); bundleParsed = null; bundlePreview = null; return; }
  if (t.id === 'bundleConfirm') return confirmBundleImport();

  if (t.id === 'btnRedactPreview') return previewRedaction();
  if (t.id === 'redactCancel') { $('#redactDialog').close(); redactPreview = null; return; }
  if (t.id === 'redactConfirm') return confirmRedaction();

  // 勘误附记
  if (t.id === 'btnErrataLoad') return loadErrataVersion();
  if (t.id === 'btnErrataSubmit') return submitErrata();
  const errataTarget = t.dataset && t.dataset.errataTarget;
  if (errataTarget !== undefined) {
    const [targetType, targetId] = errataTarget.split(':');
    return selectErrataTarget(targetType, Number(targetId));
  }
  if (t.id === 'rawVersionClose') { $('#rawVersionDialog').close(); return; }
  const rawVersion = t.dataset && t.dataset.rawVersion;
  if (rawVersion !== undefined) return openRawVersion(Number(rawVersion));

  // 专题脉络路线
  if (t.id === 'btnRouteLoadEvents') return loadRouteVersionEvents();
  if (t.id === 'btnRouteCreate') return createRouteFromUi();
  if (t.id === 'btnRouteClear') { routeAnchorIds = []; renderRouteAnchors(); return; }
  if (t.id === 'routeClose') { $('#routeDialog').close(); return; }
  const addAnchor = t.dataset && t.dataset.addAnchor;
  if (addAnchor !== undefined) {
    const eid = Number(addAnchor);
    if (routeAnchorIds.includes(eid)) {
      showRouteMsg('error', '锚点事件必须互异：该事件已在路线中。');
      return;
    }
    routeAnchorIds.push(eid);
    renderRouteAnchors();
    return;
  }
  const removeAnchor = t.dataset && t.dataset.removeAnchor;
  if (removeAnchor !== undefined) {
    routeAnchorIds.splice(Number(removeAnchor), 1);
    renderRouteAnchors();
    return;
  }
  const viewRoute = t.dataset && t.dataset.viewRoute;
  if (viewRoute !== undefined) return openRouteDetail(Number(viewRoute));

  // 并行编辑会话
  if (t.id === 'btnSessionOpen') return openEditSession();
  if (t.id === 'btnSessionRefresh') return loadSessions();
  if (t.id === 'btnSessionClose') { sessionCurrent = null; renderSessionDetail(); return; }
  if (t.id === 'btnSessionOpsExample') return fillSessionOpsExample();
  if (t.id === 'btnSessionStage') return stageSessionOps();
  if (t.id === 'btnSessionCommit') return commitEditSession();
  const viewSession = t.dataset && t.dataset.viewSession;
  if (viewSession !== undefined) return openSessionDetail(Number(viewSession));

  const addEvent = t.dataset && t.dataset.addEvent !== undefined;
  if (t.id === 'btnAddEvent') {
    const title = $('#newEventTitle').value.trim();
    if (!title) { showGlobal('error', '事件标题不能为空。'); return; }
    await api('POST', '/api/editor/events', { title, description: $('#newEventDesc').value });
    $('#newEventTitle').value = ''; $('#newEventDesc').value = '';
    await loadState();
    return;
  }

  const saveEvent = t.dataset && t.dataset.saveEvent;
  if (saveEvent) {
    const id = Number(saveEvent);
    const title = document.querySelector(`[data-edit-title="${id}"]`).value.trim();
    const description = document.querySelector(`[data-edit-desc="${id}"]`).value;
    if (!title) { showGlobal('error', '事件标题不能为空。'); return; }
    await api('PUT', `/api/editor/events/${id}`, { title, description });
    await loadState();
    return;
  }

  const delEvent = t.dataset && t.dataset.delEvent;
  if (delEvent) {
    if (!confirm(`删除事件「${titleOf(Number(delEvent))}」将同时删除其全部主张与相关先后关系，确定？`)) return;
    await api('DELETE', `/api/editor/events/${delEvent}`);
    await loadState();
    return;
  }

  const addClaim = t.dataset && t.dataset.addClaim;
  if (addClaim) {
    const id = Number(addClaim);
    const precision = document.querySelector(`[data-new-precision="${id}"]`).value;
    const year = Number(document.querySelector(`[data-new-year="${id}"]`).value);
    const monthEl = document.querySelector(`[data-new-month="${id}"]`);
    const dayEl = document.querySelector(`[data-new-day="${id}"]`);
    const payload = {
      precision,
      year,
      month: precision === 'year' ? undefined : Number(monthEl.value),
      day: precision === 'day' ? Number(dayEl.value) : undefined,
      source: document.querySelector(`[data-new-source="${id}"]`).value,
      note: document.querySelector(`[data-new-note="${id}"]`).value,
    };
    try {
      const data = await api('POST', `/api/editor/events/${id}/claims`, payload);
      store.setSelection(id, data.claim.id); // 新增主张默认选中，可改
      await loadState();
    } catch (err) { showGlobal('error', esc(err.message)); }
    return;
  }

  const delClaim = t.dataset && t.dataset.delClaim;
  if (delClaim) {
    if (!confirm('删除这条时间主张？')) return;
    await api('DELETE', `/api/editor/claims/${delClaim}`);
    await loadState();
    return;
  }

  if (t.id === 'btnAddRel') {
    const earlierId = Number($('#relEarlier').value);
    const laterId = Number($('#relLater').value);
    if (earlierId === laterId) { showGlobal('error', '一个事件不能先于自身。'); return; }
    try {
      await api('POST', '/api/editor/relations', {
        earlierId, laterId, source: $('#relSource').value,
      });
      $('#relSource').value = '';
      await loadState();
    } catch (err) { showGlobal('error', esc(err.message)); }
    return;
  }

  const delRel = t.dataset && t.dataset.delRel;
  if (delRel) {
    await api('DELETE', `/api/editor/relations/${delRel}`);
    await loadState();
  }
}

function onChange(e) {
  const claimId = e.target.dataset && e.target.dataset.selectClaim;
  if (claimId !== undefined) {
    const card = e.target.closest('.event-card');
    store.setSelection(Number(card.dataset.event), Number(claimId));
    render();
  }
}

// ---------- 启动 ----------
document.addEventListener('click', (e) => {
  onClick(e).catch((err) => {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  });
});
document.addEventListener('change', onChange);

$('#tokenInput').value = store.token;
$('#editorName').value = store.editor;
$('#editorName').addEventListener('input', (e) => { store.editor = e.target.value; });
$('#bundleFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    $('#bundleText').value = await f.text();
  } catch {
    showBundleMsg('error', '读取文件失败，请重试或直接粘贴 JSON。');
  }
});

(async function init() {
  if (!store.token) {
    showGlobal('warn', '请先在右上角输入编辑者口令（默认 <code>editor</code>，可用环境变量 EDITOR_TOKEN 修改），然后点“保存口令”。');
    return;
  }
  try {
    await loadState();
  } catch (err) {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  }
  // 预约列表每 5 秒轻量刷新一次（状态/倒计时；不打扰草稿编辑）
  setInterval(() => {
    if (store.token && !document.hidden) loadSchedules();
  }, 5000);
})();
