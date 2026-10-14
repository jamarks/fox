// fx-panel frontend: sidebar (sessions + states), tmux-backed terminals (xterm over WebSocket), transcript.

const $ = (sel) => document.querySelector(sel);
const state = {
  sessions: [], terminals: [], selected: null,
  tabs: new Map(), // tmux name -> { term, fit, ws, wrap, label, closed }
  activeTab: null, pollTimer: null, prevStates: new Map(), sound: false,
  pinned: new Set(), // tmux names pinned as tabs; restored after reload. Everything else is a preview or runs unseen.
  preview: null,     // the one unpinned terminal currently shown; replaced when you click another session
};
try { state.pinned = new Set(JSON.parse(localStorage.getItem('fox.pinned') ?? '[]')); } catch {}
const savePinned = () => { try { localStorage.setItem('fox.pinned', JSON.stringify([...state.pinned])); } catch {} };
function setPinned(name, on) {
  if (on) { state.pinned.add(name); if (state.preview === name) state.preview = null; }
  else { state.pinned.delete(name); if (state.tabs.has(name)) { if (state.preview && state.preview !== name) closeTab(state.preview); state.preview = name; } }
  savePinned(); renderTabs(); renderSessions();
}

// ---------- utils ----------
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' }) : '');
const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0));
const shortPath = (p) => (p ?? '').replace(/^\/Users\/[^/]+/, '~');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const briefArgs = (args) => {
  if (!args || typeof args !== 'object') return String(args ?? '');
  if (args.request?.task) return args.request.task;
  if (args.request?.message) return `${args.request.agent ? args.request.agent + ': ' : ''}${args.request.message}`;
  const v = args.command ?? args.path ?? args.pattern ?? args.file_path ?? args.query ?? args.prompt ?? Object.values(args)[0];
  return typeof v === 'string' ? v : JSON.stringify(v);
};
const sessionById = (id) => state.sessions.find((s) => s.id === id);
const displayTitle = (s) => s.customName || (s.subagent ? (s.subagent.name ? `🧵 ${s.subagent.name}` : (s.subagent.task ?? s.firstPrompt ?? '').slice(0, 60) || s.title) : s.title);
const post = (path, body, method = 'POST') => fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const showArchived = { value: false };
const collapsed = new Set();
try { for (const g of JSON.parse(localStorage.getItem('fox.collapsed') ?? '[]')) collapsed.add(g); } catch {}
const saveCollapsed = () => { try { localStorage.setItem('fox.collapsed', JSON.stringify([...collapsed])); } catch {} };
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const ICON = {
  archive: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="3" rx=".6"/><path d="M2.5 5.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-7M6.5 8.5h3"/></svg>',
  restore: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/></svg>',
  pin: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2l4.5 4.5-2.3.6-2.6 2.6.3 2.9-1.7 1.7L4.6 11 2 13.6M4.6 11l-1.9-1.9 1.7-1.7 2.9.3 2.6-2.6.6-2.3"/></svg>',
  rename: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/></svg>',
};
const STATE_LABEL = { working: 'working', ready: 'waiting', needs_input: 'needs input', external: 'other terminal', done: 'done', idle: '' };
const STATE_ORDER = { needs_input: 0, working: 1, ready: 2, external: 3, done: 4, idle: 5 };

// ---------- data ----------
async function refresh() {
  const { sessions, terminals } = await (await fetch('/api/overview')).json();
  state.sessions = sessions;
  state.terminals = terminals;
  detectTransitions();
  renderSessions();
  renderSummary();
  syncTabsWithTerminals();
}

function detectTransitions() {
  for (const s of state.sessions) {
    const prev = state.prevStates.get(s.id);
    if (prev && prev !== s.state && (s.state === 'ready' || s.state === 'needs_input') && prev === 'working') {
      notify(`${displayTitle(s)}: ${STATE_LABEL[s.state]}`, s.firstPrompt);
    }
    state.prevStates.set(s.id, s.state);
  }
}

// ---------- sidebar ----------
function renderSummary() {
  const live = state.sessions.filter((s) => s.terminal && !s.archived);
  const count = (st) => live.filter((s) => s.state === st).length;
  const parts = [];
  if (count('needs_input')) parts.push(`<span class="st needs_input">${count('needs_input')} need input</span>`);
  if (count('ready')) parts.push(`<span class="st ready">${count('ready')} waiting</span>`);
  if (count('working')) parts.push(`<span class="st working">${count('working')} working</span>`);
  const subs = state.sessions.filter((s) => s.subagent?.phase === 'running').length;
  if (subs) parts.push(`<span class="st working">🧵 ${subs} subagent${subs === 1 ? '' : 's'}</span>`);
  $('#summary').innerHTML = parts.join('') || '<span class="muted">no agents running</span>';
}

function renderSessions() {
  const active = state.sessions.filter((s) => !s.archived && !s.parentId);
  const archived = state.sessions.filter((s) => s.archived && !s.parentId);
  const groups = new Map();
  for (const s of active) {
    if (!groups.has(s.workspace)) groups.set(s.workspace, []);
    groups.get(s.workspace).push(s);
  }
  const root = $('#session-groups');
  root.innerHTML = '';
  // groups with running agents first
  const ordered = [...groups.entries()].sort((a, b) => Math.min(...a[1].map((s) => STATE_ORDER[s.state])) - Math.min(...b[1].map((s) => STATE_ORDER[s.state])));
  for (const [ws, list] of ordered) {
    list.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const g = document.createElement('div');
    const isCollapsed = collapsed.has(ws);
    g.className = 'group' + (isCollapsed ? ' collapsed' : '');
    const busy = list.filter((s) => s.state === 'working' || s.state === 'needs_input').length;
    g.innerHTML = `<h3><span class="caret" data-toggle-group="${esc(ws)}">${isCollapsed ? '▸' : '▾'}</span><span class="gname" data-toggle-group="${esc(ws)}" title="${esc(ws)}">${esc(shortPath(ws))}</span><span class="gcount">${list.length}${busy ? ` <b class="st working">· ${busy} active</b>` : ''}</span><button class="icon" data-new="${esc(ws)}" title="New session in this folder">+</button></h3>`;
    if (!isCollapsed) for (const s of list) g.appendChild(sessionCard(s));
    root.appendChild(g);
  }
  if (archived.length) {
    const g = document.createElement('div');
    g.className = 'group archived';
    g.innerHTML = `<h3 class="clickable" data-toggle-archived><span>${showArchived.value ? '▾' : '▸'} archived · ${archived.length}</span></h3>`;
    if (showArchived.value) for (const s of archived) g.appendChild(sessionCard(s));
    root.appendChild(g);
  }
}

function sessionCard(s) {
  const el = document.createElement('div');
  el.className = `session state-${s.state}` + (s.id === state.selected ? ' active' : '') + (s.archived ? ' is-archived' : '');
  el.dataset.id = s.id;
  const stateHtml = s.state !== 'idle' ? `<span class="st ${s.state}" title="${s.state === 'external' ? 'open in another terminal; fx allows one process per session' : STATE_LABEL[s.state]}"><i></i>${STATE_LABEL[s.state]}</span>` : '';
  el.innerHTML = `
    <div class="row">
      <div class="title" title="${esc(s.title)}">${esc(displayTitle(s))}</div>
      <div class="actions">
        ${s.terminal ? `<button class="icon ${state.pinned.has(s.terminal) ? 'on' : ''}" data-pin="${esc(s.terminal)}" title="${state.pinned.has(s.terminal) ? 'Unpin tab' : 'Pin as tab'}">${ICON.pin}</button>` : ''}
        <button class="icon" data-rename="${s.id}" title="Rename">${ICON.rename}</button>
        <button class="icon" data-${s.archived ? 'unarchive' : 'archive'}="${s.id}" title="${s.archived ? 'Restore' : (s.terminal ? 'Archive (stops the fx process)' : 'Archive')}">${s.archived ? ICON.restore : ICON.archive}</button>
      </div>
    </div>
    ${s.firstPrompt ? `<div class="prompt">${esc(s.firstPrompt)}</div>` : ''}
    <div class="sub">
      ${stateHtml}
      <span>${esc(s.model ?? '')}</span>
      <span>${s.turns} turn${s.turns === 1 ? '' : 's'}</span>
      <span>${fmtTokens(s.usage.input + s.usage.output)} tok</span>
      ${s.usage.cost ? `<span>$${s.usage.cost.toFixed(4)}</span>` : ''}
      <span>${fmtTime(s.updatedAt)}</span>
    </div>
    ${childrenHtml(s)}`;
  return el;
}

function childrenHtml(parent) {
  if (!parent.children?.length) return '';
  const rows = parent.children.map((c) => {
    const child = sessionById(c.id);
    const st = child?.state ?? (c.phase === 'running' ? 'working' : c.phase === 'idle' ? 'ready' : 'done');
    const label = c.name ? `<b>${esc(c.name)}</b>` : esc((c.task ?? child?.firstPrompt ?? c.id).slice(0, 70));
    const tokN = child ? child.usage.input + child.usage.output : 0;
    const tok = tokN ? fmtTokens(tokN) + ' tok' : '';
    return `<div class="child ${c.id === state.selected ? 'active' : ''}" data-child="${c.id}" title="${esc(c.task ?? '')}">
      <span class="st ${st}"><i></i></span><span class="clabel">${label}</span><span class="cmeta">${c.failure ? '<span class="err">failed</span>' : ''}${tok}</span>
    </div>`;
  });
  return `<div class="children">${rows.join('')}</div>`;
}

$('#session-groups').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const d = btn?.dataset ?? {};
  if (d.new) return openTerminal({ cwd: d.new });
  if (d.pin) return setPinned(d.pin, !state.pinned.has(d.pin));
  if (d.rename) return renameInline(d.rename);
  if (d.archive) {
    const s = sessionById(d.archive);
    if (s?.terminal) {
      if (!confirm('This session has a running fx process. Stop it and archive?')) return;
      await post(`/api/terminals/${encodeURIComponent(s.terminal)}`, null, 'DELETE');
      closeTab(s.terminal);
    }
    await post(`/api/sessions/${d.archive}/archive`);
    if (state.selected === d.archive) state.selected = null;
    return refresh();
  }
  if (d.unarchive) { await post(`/api/sessions/${d.unarchive}/unarchive`); return refresh(); }
  if (e.target.closest('[data-toggle-archived]')) { showArchived.value = !showArchived.value; return renderSessions(); }
  const grp = e.target.closest('[data-toggle-group]');
  if (grp) { const ws = grp.dataset.toggleGroup; collapsed.has(ws) ? collapsed.delete(ws) : collapsed.add(ws); saveCollapsed(); return renderSessions(); }
  const child = e.target.closest('[data-child]');
  if (child) { e.stopPropagation(); setTranscript(true); return selectSession(child.dataset.child); }
  const card = e.target.closest('.session');
  if (card) openSession(card.dataset.id);
});

// Click on a session: focus its tab if open, attach to its tmux terminal if running, otherwise start one.
async function openSession(id) {
  const s = sessionById(id);
  if (!s) return;
  if (s.terminal && state.tabs.has(s.terminal) && !state.tabs.get(s.terminal).closed) { activateTab(s.terminal); return selectSession(id); }
  if (s.terminal) { const t = state.terminals.find((x) => x.name === s.terminal); if (t) { attachTab(t, { user: true }); return selectSession(id); } }
  if (s.archived || s.state === 'external') return selectSession(id);
  await openTerminal({ cwd: s.workspace, resume: id });
}

function selectSession(id) {
  if (state.selected !== id) { $('#search').value = ''; $('#search-done').classList.add('hidden'); }
  state.selected = id;
  renderSessions();
  loadTranscript(id);
}

async function renameInline(id) {
  const s = sessionById(id);
  const titleEl = document.querySelector(`.session[data-id="${id}"] .title`);
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = displayTitle(s);
  titleEl.replaceWith(input);
  input.focus(); input.select();
  let settled = false;
  const done = async (save) => {
    if (settled) return; settled = true;
    if (save) await post(`/api/sessions/${id}/rename`, { name: input.value.trim() === s.title ? '' : input.value });
    await refresh();
    if (state.selected === id) loadTranscript(id);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
}

// ---------- new session form ----------
$('#new-cwd').addEventListener('input', debounce(async (e) => {
  const v = e.target.value.trim();
  const hint = $('#new-cwd-hint');
  if (!v) return (hint.textContent = '', hint.className = 'hint');
  const r = await (await fetch('/api/check-dir?path=' + encodeURIComponent(v))).json();
  hint.textContent = r.ok ? `✓ ${r.path}` : 'Folder not found';
  hint.className = 'hint ' + (r.ok ? 'ok' : 'err');
}, 250));
$('#new-session').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#new-cwd').value.trim();
  if (!v) return;
  const r = await (await fetch('/api/check-dir?path=' + encodeURIComponent(v))).json();
  if (r.ok) openTerminal({ cwd: r.path });
});
$('#refresh').addEventListener('click', refresh);
// Shift-click or right-click the folder icon to type a path instead of using the native picker.
$('#pick-folder').addEventListener('contextmenu', (e) => { e.preventDefault(); $('#new-session').classList.toggle('hidden'); $('#new-cwd').focus(); });
$('#pick-folder').addEventListener('click', async (e) => {
  if (e.shiftKey) { $('#new-session').classList.toggle('hidden'); $('#new-cwd').focus(); return; }
  const btn = $('#pick-folder');
  btn.disabled = true;
  try {
    const r = await post('/api/pick-folder');
    if (r.path) await openTerminal({ cwd: r.path });
    else if (r.error) { $('#new-session').classList.remove('hidden'); $('#new-cwd-hint').textContent = r.error; $('#new-cwd-hint').className = 'hint err'; }
  } finally { btn.disabled = false; }
});

// ---------- terminals (tmux attach over WebSocket) ----------
async function openTerminal({ cwd, resume }) {
  const t = await post('/api/terminals', { cwd, resume });
  if (t.error) { alert(t.error); return; }
  await refresh();
  attachTab(t);
  if (t.resume) selectSession(t.resume);
}

function attachTab(t, { user = false, activate = true } = {}) {
  if (state.tabs.has(t.name) && !state.tabs.get(t.name).closed) { if (activate) activateTab(t.name); return; }
  // An unpinned terminal is a preview: opening another one replaces it (its fx keeps running in tmux).
  if (!state.pinned.has(t.name)) {
    if (state.preview && state.preview !== t.name) closeTab(state.preview);
    state.preview = t.name;
  }
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap warming';
  $('#terminals').appendChild(wrap);
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', scrollback: 5000,
    theme: { background: '#0f1115', foreground: '#e6e8ee', cursor: '#7aa2f7', selectionBackground: '#2a3550' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  state.tabs.set(t.name, { name: t.name, term, fit, ws: null, wrap, closed: false, ready: false });
  renderTabs();
  if (activate) activateTab(t.name); // connects lazily, at the measured size
}

// Connect a tab's WebSocket once it is visible and measured, so tmux draws once at the right size.
function connectTab(tab) {
  if (!tab || tab.ws || tab.closed) return;
  const { term, wrap } = tab;
  const ws = new WebSocket(`ws://${location.host}/pty?name=${encodeURIComponent(tab.name)}&cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = 'arraybuffer';
  tab.ws = ws;
  let reveal = null;
  ws.onmessage = (ev) => {
    term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    if (!tab.ready) { clearTimeout(reveal); reveal = setTimeout(() => { tab.ready = true; wrap.classList.remove('warming'); }, 120); }
  };
  ws.onclose = () => { tab.closed = true; wrap.classList.remove('warming'); renderTabs(); };
  const sendResize = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  term.onData((data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data })));
  term.onResize(sendResize);
}

function tabLabel(name) {
  const t = state.terminals.find((x) => x.name === name);
  const s = t?.resume ? sessionById(t.resume) : null;
  return (s ? displayTitle(s) : 'new') + ' · ' + shortPath(t?.cwd ?? '').split('/').pop();
}

function renderTabs() {
  const root = $('#tabs');
  root.innerHTML = '';
  for (const [name, tab] of state.tabs) {
    const t = state.terminals.find((x) => x.name === name);
    const s = t?.resume ? sessionById(t.resume) : null;
    const st = tab.closed ? 'closed' : (s?.state ?? 'working');
    const el = document.createElement('div');
    const pinned = state.pinned.has(name);
    el.className = 'tab' + (name === state.activeTab ? ' active' : '') + (pinned ? '' : ' preview');
    // The dot only shows when there is something to know: working, needs input, or dead. Waiting is the default.
    const dot = st === 'working' || st === 'needs_input' || st === 'closed' ? `<span class="st ${st}" title="${STATE_LABEL[st] || st}"><i></i></span>` : '';
    el.innerHTML = `${dot}<span class="tab-label">${esc(tabLabel(name))}</span>${pinned
      ? `<span class="close" data-close="${esc(name)}" title="Unpin and close (fx keeps running)">×</span>`
      : `<span class="pin" data-pin="${esc(name)}" title="Pin as tab">${ICON.pin}</span>`}`;
    el.addEventListener('click', (e) => {
      if (e.target.dataset.close) { state.pinned.delete(name); savePinned(); closeTab(name); renderSessions(); }
      else if (e.target.dataset.pin) setPinned(name, !state.pinned.has(name));
      else activateTab(name);
    });
    root.appendChild(el);
  }
  $('#empty-state').style.display = state.tabs.size ? 'none' : 'flex';
}

function activateTab(name) {
  state.activeTab = name;
  try { localStorage.setItem('fox.active', name); } catch {}
  for (const [n, t] of state.tabs) t.wrap.classList.toggle('active', n === name);
  renderTabs();
  const t = state.tabs.get(name);
  if (t) { safeFit(t); connectTab(t); t.term.focus(); }
  const term = state.terminals.find((x) => x.name === name);
  if (term?.resume) selectSession(term.resume);
}

function closeTab(name) {
  if (state.preview === name) state.preview = null;
  const t = state.tabs.get(name);
  if (!t) return;
  try { t.ws.close(); } catch {}
  t.term.dispose();
  t.wrap.remove();
  state.tabs.delete(name);
  if (state.activeTab === name) state.activeTab = [...state.tabs.keys()].pop() ?? null;
  if (state.activeTab) activateTab(state.activeTab); else renderTabs();
}

// Tabs follow tmux: terminals that died disappear, new ones (e.g. opened from another browser) get a tab.
function syncTabsWithTerminals() {
  const names = new Set(state.terminals.map((t) => t.name));
  for (const [name, tab] of state.tabs) if (!names.has(name) && tab.closed) closeTab(name);
  for (const name of [...state.pinned]) if (!names.has(name)) state.pinned.delete(name);
  savePinned();
  for (const t of state.terminals) if (!state.tabs.has(t.name) && state.pinned.has(t.name)) attachTab(t, { activate: false });
  renderTabs();
}

// Fit, then verify: if xterm's screen is taller than the box (rounding, font metrics), drop rows until it fits.
function safeFit(t) {
  if (!t || t.closed || !t.wrap.classList.contains('active')) return;
  const dims = t.fit.proposeDimensions();
  if (!dims) return;
  // Same proposal as last time means the box has not changed: nothing to do (avoids a resize loop).
  if (t.settled && t.settled.cols === dims.cols && t.settled.rows === dims.rows) return;
  if (dims.cols !== t.term.cols || dims.rows !== t.term.rows) t.fit.fit();
  const screen = t.wrap.querySelector('.xterm-screen');
  const cs = getComputedStyle(t.wrap);
  const avail = t.wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  let guard = 3;
  while (screen && screen.offsetHeight > avail && t.term.rows > 5 && guard-- > 0) t.term.resize(t.term.cols, t.term.rows - 1);
  t.settled = { cols: dims.cols, rows: dims.rows };
  t.term.scrollToBottom();
}
const fitActive = debounce(() => safeFit(state.tabs.get(state.activeTab)), 50);
window.addEventListener('resize', fitActive);
new ResizeObserver(fitActive).observe($('#terminals'));

// ---------- notifications ----------
function notify(title, body) {
  if (state.sound) beep();
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.12);
  } catch {}
}
$('#bell').addEventListener('click', () => {
  state.sound = !state.sound;
  $('#bell').classList.toggle('on', state.sound);
  if (state.sound && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  try { localStorage.setItem('fx-panel.sound', state.sound ? '1' : '0'); } catch {}
});
try { state.sound = localStorage.getItem('fx-panel.sound') === '1'; $('#bell').classList.toggle('on', state.sound); } catch {}

// ---------- transcript ----------
// The parent stores each subagent's answer as a tool_result. One-off agents are matched by task text
// (normalized, prefix only: the sidebar prompt is truncated); named agents by name, keeping every round.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
let cachedResults = { id: null, byTask: new Map(), byAgent: new Map() };
function resultsByTask(parent) { return cachedResults.id === parent.id ? cachedResults.byTask : new Map(); }
function resultsByAgent(parent) { return cachedResults.id === parent.id ? cachedResults.byAgent : new Map(); }
async function refreshResults(parent) {
  if (!parent?.children?.length) return;
  const events = await (await fetch(`/api/sessions/${parent.id}/events`)).json();
  const byTask = new Map(); const byAgent = new Map();
  for (const ev of events) {
    if (ev.kind !== 'tool_call' || ev.name !== 'subagent' || !ev.result) continue;
    const req = ev.args?.request ?? {};
    let text = ev.result.preview;
    try { const j = JSON.parse(text); text = j.result ?? text; } catch {}
    if (req.agent) {
      if (!byAgent.has(req.agent)) byAgent.set(req.agent, []);
      byAgent.get(req.agent).push({ message: req.message ?? '', text });
    }
    const task = req.task ?? req.message;
    if (task) byTask.set(norm(task), text);
  }
  cachedResults = { id: parent.id, byTask, byAgent };
}
function answerFor(parent, c, child) {
  if (c?.name) { const rounds = resultsByAgent(parent).get(c.name) ?? []; return rounds.length ? rounds.at(-1).text : null; }
  return resultsByTask(parent).get(norm(c?.task ?? child?.firstPrompt ?? '')) ?? null;
}

// Board: one compact row per subagent. Click goes to that subagent's view.
function agentsBoard(parent, { selectedId = null, compact = false } = {}) {
  if (!parent?.children?.length) return '';
  const rows = parent.children.map((c) => {
    const child = sessionById(c.id);
    const st = child?.state ?? 'done';
    const elapsed = c.phase === 'running' && c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) + 's' : child?.usage.wallMs ? Math.round(child.usage.wallMs / 1000) + 's' : '';
    const res = answerFor(parent, c, child);
    const sel = c.id === selectedId;
    return `<a class="agent ${st} ${sel ? 'selected' : ''} ${compact ? 'compact' : ''}" href="#" data-child="${c.id}">
      <div class="agent-head"><span class="st ${st}"><i></i></span><span class="agent-name">${c.name ? '🧵 ' + esc(c.name) : esc((c.task ?? child?.firstPrompt ?? c.id).slice(0, 90))}</span><span class="agent-elapsed">${elapsed}</span></div>
      ${!compact ? (res ? `<div class="agent-answer">${esc(res.slice(0, 160))}${res.length > 160 ? '…' : ''}</div>` : c.phase === 'running' ? '<div class="agent-answer muted">working, no answer yet</div>' : '') : ''}
    </a>`;
  });
  const title = `${parent.children.length} subagent${parent.children.length === 1 ? '' : 's'}`;
  return `<div class="board ${compact ? 'compact' : ''}"><div class="board-title">${title}</div>${rows.join('')}</div>`;
}

const convoShown = new Set();

$('#transcript').addEventListener('click', (e) => {
  const toggle = e.target.closest('a[data-show-convo], a[data-hide-convo]');
  if (toggle) {
    e.preventDefault();
    const id = toggle.dataset.showConvo ?? toggle.dataset.hideConvo;
    toggle.dataset.showConvo ? convoShown.add(id) : convoShown.delete(id);
    lastTranscriptKey = ''; return loadTranscript(id);
  }
  const link = e.target.closest('a[data-child], a[data-goto]');
  if (!link) return;
  e.preventDefault();
  selectSession(link.dataset.child ?? link.dataset.goto);
});

// ---------- search ----------
const terminalOpenFor = (s) => Boolean(s?.terminal && state.tabs.get(s.terminal) && !state.tabs.get(s.terminal).closed);
function renderSearch(s, events, q, terminalOpen) {
  const hits = [];
  events.forEach((ev, i) => {
    const text = ev.kind === 'user' || ev.kind === 'assistant' ? ev.text : ev.kind === 'tool_call' ? `${ev.name} ${briefArgs(ev.args)} ${ev.result?.preview ?? ''}` : '';
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) return;
    const start = Math.max(0, at - 60);
    const snippet = (start > 0 ? '…' : '') + text.slice(start, at) + '<mark>' + esc(text.slice(at, at + q.length)) + '</mark>' + esc(text.slice(at + q.length, at + q.length + 90)) + (text.length > at + q.length + 90 ? '…' : '');
    hits.push({ i, ev, snippet: esc(text.slice(start, at)) + snippet.slice(esc(text.slice(start, at)).length) });
  });
  const who = (ev) => ev.kind === 'user' ? 'you' : ev.kind === 'assistant' ? 'fx' : ev.name;
  const body = $('#transcript-body');
  body.innerHTML = `<div class="section-title">${hits.length} match${hits.length === 1 ? '' : 'es'}${terminalOpen ? ' · click one to jump there in the terminal' : ''}</div>` +
    (hits.map((h) => `<div class="hit" data-hit="${h.i}"><div class="who">${esc(who(h.ev))}</div><div class="snippet">${h.snippet}</div></div>`).join('') || '<p class="muted">Nothing found.</p>');
  body.dataset.hits = JSON.stringify(hits.map((h) => ({ i: h.i, text: (h.ev.text ?? briefArgs(h.ev.args) ?? '').toString() })));
}
async function jumpInTerminal(s, query, again = false) {
  if (!terminalOpenFor(s)) return;
  const r = await post(`/api/terminals/${encodeURIComponent(s.terminal)}/search`, { query, again });
  $('#search-done').classList.remove('hidden');
  const t = state.tabs.get(s.terminal); if (t) t.term.focus();
  return r;
}
$('#search').addEventListener('input', debounce(() => { lastTranscriptKey = ''; if (state.selected) loadTranscript(state.selected); }, 150));
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') jumpInTerminal(sessionById(state.selected), $('#search').value.trim()); if (e.key === 'Escape') { $('#search').value = ''; lastTranscriptKey = ''; loadTranscript(state.selected); } });
$('#search-prev').addEventListener('click', () => jumpInTerminal(sessionById(state.selected), $('#search').value.trim(), true));
$('#search-done').addEventListener('click', async () => { const s = sessionById(state.selected); if (s?.terminal) await post(`/api/terminals/${encodeURIComponent(s.terminal)}/search-cancel`); $('#search-done').classList.add('hidden'); });
$('#transcript-body').addEventListener('click', (e) => {
  const hit = e.target.closest('.hit');
  if (!hit) return;
  const s = sessionById(state.selected);
  const q = $('#search').value.trim();
  hit.classList.toggle('open');
  if (hit.classList.contains('open') && !hit.querySelector('.full')) {
    const hits = JSON.parse($('#transcript-body').dataset.hits || '[]');
    const h = hits.find((x) => String(x.i) === hit.dataset.hit);
    if (h) { const d = document.createElement('div'); d.className = 'full'; d.textContent = h.text; hit.appendChild(d); }
  }
  jumpInTerminal(s, q);
});

let lastTranscriptKey = '';
let lastEventCount = { id: null, n: 0 };
async function loadTranscript(id, quiet = false) {
  const s = sessionById(id);
  if (!s) return;
  const parent = s.parentId ? sessionById(s.parentId) : s;
  const isChild = Boolean(s.parentId);
  if (parent?.children?.length && (cachedResults.id !== parent.id || parent.children.some((c) => c.phase === 'running'))) await refreshResults(parent);
  const events = await (await fetch(`/api/sessions/${id}/events`)).json();
  if (state.selected !== id) return; // selection changed while we were fetching: drop this render
  const termOpenKey = Boolean(s.terminal && state.tabs.get(s.terminal) && !state.tabs.get(s.terminal).closed);
  const key = id + ':' + events.length + ':' + (s.updatedAt ?? 0) + ':' + (parent?.children ?? []).map((c) => c.phase).join(',') + ':' + termOpenKey + ':' + Math.floor(Date.now() / 5000);
  if (quiet && key === lastTranscriptKey) return;
  lastTranscriptKey = key;

  // Header: breadcrumb for subagents so you always know where you are and how to go back.
  $('#transcript-title').innerHTML = isChild
    ? `<a href="#" class="crumb" data-goto="${parent.id}">${esc(displayTitle(parent))}</a><span class="crumb-sep">›</span>${esc(displayTitle(s))}`
    : esc(displayTitle(s));
  $('#transcript-meta').innerHTML = `
    <span>${esc(s.provider)} / ${esc(s.model)}</span>
    ${s.usage.input + s.usage.output ? `<span>${fmtTokens(s.usage.input)} in · ${fmtTokens(s.usage.output)} out · ${fmtTokens(s.usage.cacheRead)} cache</span><span>${s.usage.cost ? '$' + s.usage.cost.toFixed(4) : 'subscription'}</span><span>${(s.usage.wallMs / 1000).toFixed(0)}s</span>` : '<span>tokens billed to parent</span>'}
    <span title="${esc(s.workspace)}">${esc(shortPath(s.workspace))}</span>`;

  const html = [];
  $('#search-row').classList.remove('hidden');
  const q = $('#search').value.trim().toLowerCase();
  if (q) {
    renderSearch(s, events, q, terminalOpenFor(s));
    return;
  }
  if (isChild) {
    // Subagent view: what it gave back to the parent first, then how it got there.
    const c = parent.children.find((x) => x.id === id);
    const rounds = c?.name ? (resultsByAgent(parent).get(c.name) ?? []) : [];
    const res = rounds.length ? null : answerFor(parent, c, s);
    html.push(agentsBoard(parent, { selectedId: id, compact: true }));
    html.push(`<section class="answer">
      <div class="section-title">${rounds.length > 1 ? `${rounds.length} answers returned to the parent` : 'answer returned to the parent'}</div>
      ${rounds.length ? rounds.map((r, i) => `<div class="round"><div class="round-q">${rounds.length > 1 ? `round ${i + 1} · ` : ''}${esc(r.message.slice(0, 200))}${r.message.length > 200 ? '…' : ''}</div><div class="answer-text">${esc(r.text)}</div></div>`).join('')
        : res ? `<div class="answer-text">${esc(res)}</div>`
        : c?.phase === 'running' ? '<div class="muted">still working</div>'
        : parent.state === 'working' ? '<div class="muted">available when the parent finishes its turn</div>'
        : '<div class="muted">no answer recorded</div>'}
    </section>
    <div class="section-title">its conversation</div>`);
  } else if (parent.children?.length) {
    html.push(agentsBoard(parent));
  }
  // With the terminal open you are already reading the conversation there: keep this column to what the
  // terminal does not show (subagents, tokens) unless you ask for it.
  const terminalOpen = Boolean(s.terminal && state.tabs.get(s.terminal) && !state.tabs.get(s.terminal).closed);
  const showConvo = isChild || !terminalOpen || convoShown.has(id);
  if (!isChild) {
    html.push(showConvo
      ? `<div class="section-title">conversation${terminalOpen ? ` · <a href="#" data-hide-convo="${id}">hide</a>` : ''}</div>`
      : `<div class="section-title"><a href="#" data-show-convo="${id}">show conversation</a></div>`);
  }
  for (const ev of showConvo ? events : []) {
    if (!isChild && ev.kind === 'tool_call' && ev.name === 'subagent' && parent.children?.length) continue; // already in the board
    if (ev.kind === 'user') html.push(`<div class="msg user"><div class="who">${isChild ? 'task from parent' : 'you'}</div><div class="text">${esc(ev.text)}</div></div>`);
    else if (ev.kind === 'assistant') html.push(`<div class="msg assistant"><div class="who">${isChild ? (s.subagent?.name ? '🧵 ' + esc(s.subagent.name) : 'subagent') : 'fx'}</div><div class="text">${esc(ev.text)}</div></div>`);
    else if (ev.kind === 'tool_call') {
      const st = ev.result?.status ?? 'pending';
      const isSub = ev.name === 'subagent';
      html.push(`<details class="tool ${st}">
        <summary><span class="dot"></span><span class="name">${isSub ? '🧵 ' : ''}${esc(ev.name)}</span><span class="brief">${esc(briefArgs(ev.args))}</span></summary>
        <pre class="label">args</pre><pre>${esc(typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args, null, 2))}</pre>
        ${ev.result ? `<pre class="label">result · ${st} · ${ev.result.bytes} bytes</pre><pre>${esc(ev.result.preview)}</pre>` : ''}
      </details>`);
    } else if (ev.kind === 'turn_completed') html.push('<hr class="turn-sep" />');
    else if (ev.kind === 'interrupted') html.push('<div class="interrupted">■ cancelled</div>');
    else if (ev.kind === 'raw') html.push(`<div class="msg"><div class="who">event</div><div class="text muted">${esc(ev.text)}</div></div>`);
  }
  const body = $('#transcript-body');
  const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.innerHTML = html.join('') || '<p class="muted">Empty session.</p>';
  // Scroll: top when you switch sessions; stay pinned to the end only if you were already there.
  const grew = lastEventCount.id === id && events.length > lastEventCount.n;
  if (lastEventCount.id !== id) body.scrollTop = 0;
  else if (grew && wasAtBottom) body.scrollTop = body.scrollHeight;
  lastEventCount = { id, n: events.length };
}

const transcriptToggle = $('#toggle-transcript');
function setTranscript(visible) {
  document.body.classList.toggle('no-transcript', !visible);
  transcriptToggle.textContent = visible ? '⇥' : '⇤';
  transcriptToggle.title = visible ? 'Hide transcript' : 'Show transcript';
  try { localStorage.setItem('fox.transcript', visible ? '1' : '0'); } catch {}
  requestAnimationFrame(() => safeFit(state.tabs.get(state.activeTab)));
}
transcriptToggle.addEventListener('click', () => setTranscript(document.body.classList.contains('no-transcript')));
$('#close-transcript').addEventListener('click', () => setTranscript(false));
let initialTranscript = false;
try { initialTranscript = localStorage.getItem('fox.transcript') === '1'; } catch {}
setTranscript(initialTranscript);

// ---------- boot ----------
// Deep links: ?session=<id> selects a session and shows its transcript; ?open=<id> also opens its terminal tab.
(async () => {
  await refresh();
  const q = new URLSearchParams(location.search);
  const openId = q.get('open');
  const selId = q.get('session') ?? openId;
  // Restore the last active tab first; a deep link then wins over it.
  let lastActive = null;
  try { lastActive = localStorage.getItem('fox.active'); } catch {}
  const restore = state.terminals.find((t) => t.name === lastActive && state.pinned.has(t.name)) ?? state.terminals.find((t) => state.pinned.has(t.name));
  if (restore && !openId) activateTab(restore.name);
  if (openId && sessionById(openId)) await openSession(openId);
  if (selId && sessionById(selId)) { setTranscript(true); selectSession(selId); }
  state.pollTimer = setInterval(async () => {
    await refresh();
    if (state.selected) loadTranscript(state.selected, true);
  }, 3000);
})();
