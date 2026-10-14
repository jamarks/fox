// fx-panel frontend: sidebar (sessions + states), tmux-backed terminals (xterm over WebSocket), transcript.

const $ = (sel) => document.querySelector(sel);
const state = {
  sessions: [], terminals: [], selected: null,
  tabs: new Map(), // tmux name -> { term, fit, ws, wrap, label, closed }
  activeTab: null, pollTimer: null, prevStates: new Map(), sound: false,
  open: new Set(), // tmux names the user opened as tabs; restored after reload. Everything else runs unseen.
};
try { state.open = new Set(JSON.parse(localStorage.getItem('fox.open') ?? '[]')); } catch {}
const saveOpen = () => { try { localStorage.setItem('fox.open', JSON.stringify([...state.open])); } catch {} };

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
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

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
    g.className = 'group';
    g.innerHTML = `<h3><span title="${esc(ws)}">${esc(shortPath(ws))}</span><button class="icon" data-new="${esc(ws)}" title="New session in this folder">+</button></h3>`;
    for (const s of list) g.appendChild(sessionCard(s));
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
        ${s.terminal ? `<button class="icon" data-kill="${esc(s.terminal)}" title="Stop the fx process">■</button>` : ''}
        <button class="icon" data-rename="${s.id}" title="Rename">✎</button>
        <button class="icon" data-${s.archived ? 'unarchive' : 'archive'}="${s.id}" title="${s.archived ? 'Restore' : 'Archive'}">${s.archived ? '↩' : '⌫'}</button>
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
  if (d.rename) return renameInline(d.rename);
  if (d.kill) { if (confirm('Stop this fx process? The session stays saved.')) { await post(`/api/terminals/${encodeURIComponent(d.kill)}`, null, 'DELETE'); closeTab(d.kill); await refresh(); } return; }
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

// ---------- terminals (tmux attach over WebSocket) ----------
async function openTerminal({ cwd, resume }) {
  const t = await post('/api/terminals', { cwd, resume });
  if (t.error) { alert(t.error); return; }
  await refresh();
  attachTab(t, { user: true });
  if (t.resume) selectSession(t.resume);
}

function attachTab(t, { user = false } = {}) {
  if (user) { state.open.add(t.name); saveOpen(); }
  if (state.tabs.has(t.name) && !state.tabs.get(t.name).closed) return activateTab(t.name);
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap';
  $('#terminals').appendChild(wrap);
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', scrollback: 5000,
    theme: { background: '#0f1115', foreground: '#e6e8ee', cursor: '#7aa2f7', selectionBackground: '#2a3550' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  const ws = new WebSocket(`ws://${location.host}/pty?name=${encodeURIComponent(t.name)}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  ws.onclose = () => { const tab = state.tabs.get(t.name); if (tab) { tab.closed = true; renderTabs(); } };
  const sendResize = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  ws.onopen = () => { fit.fit(); sendResize(); };
  term.onData((data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data })));
  term.onResize(sendResize);
  state.tabs.set(t.name, { term, fit, ws, wrap, closed: false });
  renderTabs();
  activateTab(t.name);
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
    el.className = 'tab' + (name === state.activeTab ? ' active' : '');
    el.innerHTML = `<span class="st ${st}"><i></i></span><span>${esc(tabLabel(name))}</span><span class="close" data-close="${esc(name)}" title="Close tab (fx keeps running; click the session to reopen)">×</span>`;
    el.addEventListener('click', (e) => (e.target.dataset.close ? closeTab(name) : activateTab(name)));
    root.appendChild(el);
  }
  $('#empty-state').style.display = state.tabs.size ? 'none' : 'flex';
}

function activateTab(name) {
  state.activeTab = name;
  for (const [n, t] of state.tabs) t.wrap.classList.toggle('active', n === name);
  renderTabs();
  const t = state.tabs.get(name);
  if (t) requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
  const term = state.terminals.find((x) => x.name === name);
  if (term?.resume) selectSession(term.resume);
}

function closeTab(name) {
  state.open.delete(name); saveOpen();
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
  for (const name of [...state.open]) if (!names.has(name)) state.open.delete(name);
  saveOpen();
  for (const t of state.terminals) if (!state.tabs.has(t.name) && state.open.has(t.name)) attachTab(t);
  renderTabs();
}

window.addEventListener('resize', () => state.tabs.get(state.activeTab)?.fit.fit());

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
// The parent stores each subagent's answer as a tool_result; we link them by task text.
let cachedResults = { id: null, map: new Map() };
function resultsByTask(parent) {
  return cachedResults.id === parent.id ? cachedResults.map : new Map();
}
async function refreshResults(parent) {
  if (!parent?.children?.length) return;
  const events = await (await fetch(`/api/sessions/${parent.id}/events`)).json();
  const map = new Map();
  for (const ev of events) {
    if (ev.kind !== 'tool_call' || ev.name !== 'subagent' || !ev.result) continue;
    const task = ev.args?.request?.task ?? ev.args?.request?.message ?? '';
    let text = ev.result.preview;
    try { const j = JSON.parse(text); text = j.result ?? text; } catch {}
    if (task) map.set(task, text);
  }
  cachedResults = { id: parent.id, map };
}

// Board: shown only when a parent is selected. One compact row per subagent; click goes to that subagent's view.
function agentsBoard(parent, { selectedId = null, compact = false } = {}) {
  if (!parent?.children?.length) return '';
  const results = resultsByTask(parent);
  const rows = parent.children.map((c) => {
    const child = sessionById(c.id);
    const st = child?.state ?? 'done';
    const elapsed = c.phase === 'running' && c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) + 's' : child?.usage.wallMs ? Math.round(child.usage.wallMs / 1000) + 's' : '';
    const res = results.get(c.task ?? child?.firstPrompt ?? '');
    const sel = c.id === selectedId;
    return `<a class="agent ${st} ${sel ? 'selected' : ''} ${compact ? 'compact' : ''}" href="#" data-child="${c.id}">
      <div class="agent-head"><span class="st ${st}"><i></i></span><span class="agent-name">${c.name ? '🧵 ' + esc(c.name) : esc((c.task ?? child?.firstPrompt ?? c.id).slice(0, 90))}</span><span class="agent-elapsed">${elapsed}</span></div>
      ${!compact ? (res ? `<div class="agent-answer">${esc(res.slice(0, 160))}${res.length > 160 ? '…' : ''}</div>` : c.phase === 'running' ? '<div class="agent-answer muted">working, no answer yet</div>' : '') : ''}
    </a>`;
  });
  const title = compact
    ? `<a href="#" class="crumb" data-goto="${parent.id}">← ${esc(displayTitle(parent))}</a> · ${parent.children.length} subagents`
    : `${parent.children.length} subagent${parent.children.length === 1 ? '' : 's'} · click one to see its answer and conversation`;
  return `<div class="board ${compact ? 'compact' : ''}"><div class="board-title">${title}</div>${rows.join('')}</div>`;
}

$('#transcript').addEventListener('click', (e) => {
  const link = e.target.closest('a[data-child], a[data-goto]');
  if (!link) return;
  e.preventDefault();
  selectSession(link.dataset.child ?? link.dataset.goto);
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
  const key = id + ':' + events.length + ':' + (s.updatedAt ?? 0) + ':' + (parent?.children ?? []).map((c) => c.phase).join(',') + ':' + Math.floor(Date.now() / 5000);
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
  if (isChild) {
    // Subagent view: what it gave back to the parent first, then how it got there.
    const c = parent.children.find((x) => x.id === id);
    const res = resultsByTask(parent).get(c?.task ?? s.firstPrompt ?? '');
    html.push(agentsBoard(parent, { selectedId: id, compact: true }));
    html.push(`<section class="answer">
      <div class="section-title">answer returned to ${esc(displayTitle(parent))}</div>
      ${res ? `<div class="answer-text">${esc(res)}</div>` : c?.phase === 'running' ? '<div class="muted">still working, nothing returned yet</div>' : '<div class="muted">no answer recorded</div>'}
    </section>
    <div class="section-title">its own conversation: what it read, ran and wrote to get there</div>`);
  } else if (parent.children?.length) {
    html.push(agentsBoard(parent));
    html.push('<div class="section-title">main conversation</div>');
  }
  for (const ev of events) {
    if (ev.kind === 'user') html.push(`<div class="msg user"><div class="who">${isChild ? 'task from parent' : 'you'}</div><div class="text">${esc(ev.text)}</div></div>`);
    else if (ev.kind === 'assistant') html.push(`<div class="msg assistant"><div class="who">${isChild ? esc(displayTitle(s)) : 'fx'}</div><div class="text">${esc(ev.text)}</div></div>`);
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
  body.innerHTML = html.join('') || '<p class="muted">Empty session.</p>';
  // Scroll: top when you switch sessions, bottom only when new events arrive and "follow" is on.
  const grew = lastEventCount.id === id && events.length > lastEventCount.n;
  if (lastEventCount.id !== id) body.scrollTop = 0;
  else if (grew && $('#follow').checked) body.scrollTop = body.scrollHeight;
  lastEventCount = { id, n: events.length };
}

const transcriptToggle = $('#toggle-transcript');
function setTranscript(visible) {
  document.body.classList.toggle('no-transcript', !visible);
  transcriptToggle.textContent = visible ? '⇥' : '⇤';
  transcriptToggle.title = visible ? 'Hide transcript' : 'Show transcript';
  try { localStorage.setItem('fox.transcript', visible ? '1' : '0'); } catch {}
  requestAnimationFrame(() => state.tabs.get(state.activeTab)?.fit.fit());
}
transcriptToggle.addEventListener('click', () => setTranscript(document.body.classList.contains('no-transcript')));
let initialTranscript = false;
try { initialTranscript = localStorage.getItem('fox.transcript') === '1'; } catch {}
setTranscript(initialTranscript);

// ---------- boot ----------
// Deep links: ?session=<id> selects a session and shows its transcript; ?open=<id> also opens its terminal tab.
(async () => {
  await refresh();
  const q = new URLSearchParams(location.search);
  const openId = q.get('open');
  if (openId && sessionById(openId)) await openSession(openId);
  const selId = q.get('session') ?? openId;
  if (selId && sessionById(selId)) { setTranscript(true); selectSession(selId); }
  const first = state.terminals.find((t) => state.open.has(t.name));
  if (first && !openId) activateTab(first.name);
  state.pollTimer = setInterval(async () => {
    await refresh();
    if (state.selected) loadTranscript(state.selected, true);
  }, 3000);
})();
