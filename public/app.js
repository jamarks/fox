// fx-panel frontend: sidebar (sessions + states), tmux-backed terminals (xterm over WebSocket), transcript.

const $ = (sel) => document.querySelector(sel);
const state = {
  sessions: [], terminals: [], selected: null,
  tabs: new Map(), // tmux name -> { term, fit, ws, wrap, label, closed }
  activeTab: null, pollTimer: null, prevStates: new Map(), sound: false,
  renaming: null, // keep the inline editor mounted while overview polling updates the rest of the UI
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
const displayTitle = (s) => s.customName || (s.subagent ? (s.subagent.name ? s.subagent.name : (s.subagent.task ?? s.firstPrompt ?? '').slice(0, 60) || s.title) : s.title);
function updatePageTitle() {
  const viewingSession = !mobileLayout.matches || document.body.dataset.mobileView !== 'sessions';
  const name = viewingSession && sessionById(state.selected) ? displayTitle(sessionById(state.selected))?.trim() : '';
  document.title = name ? `${name} · fox` : 'fox';
}
const post = (path, body, method = 'POST') => fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const showArchived = { value: false };
let groupOrder = [];
try { groupOrder = JSON.parse(localStorage.getItem('fox.groupOrder') ?? '[]'); } catch {}
const saveGroupOrder = () => { try { localStorage.setItem('fox.groupOrder', JSON.stringify(groupOrder)); } catch {} };
const collapsed = new Set();
try { for (const g of JSON.parse(localStorage.getItem('fox.collapsed') ?? '[]')) collapsed.add(g); } catch {}
const saveCollapsed = () => { try { localStorage.setItem('fox.collapsed', JSON.stringify([...collapsed])); } catch {} };
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const ICON = {
  // subagents: one line branching into three, drawn in the current text color
  threads: '<svg class="threads" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h4M6.5 8c2 0 2-4 4-4h3M6.5 8h7M6.5 8c2 0 2 4 4 4h3"/><circle cx="2.5" cy="8" r="1.3" fill="currentColor" stroke="none"/></svg>',
  github: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
  git: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="6" r="1.5"/><path d="M4 5v6M12 7.5c0 2-8 1-8 3.5"/></svg>',
  archive: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="3" rx=".6"/><path d="M2.5 5.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-7M6.5 8.5h3"/></svg>',
  restore: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/></svg>',
  pin: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2l4.5 4.5-2.3.6-2.6 2.6.3 2.9-1.7 1.7L4.6 11 2 13.6M4.6 11l-1.9-1.9 1.7-1.7 2.9.3 2.6-2.6.6-2.3"/></svg>',
  rename: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/></svg>',
};
// Vendor badge for a model id: two letters on the vendor's color. Works for "vendor/model" ids and bare names.
const VENDORS = [
  [/^openai\/|^gpt-|^o[1-9]/, 'OA', '#10a37f', 'OpenAI'], [/^google\/|gemini|gemma/, 'G', '#4285f4', 'Google'], [/^anthropic\/|claude/, 'A', '#d97757', 'Anthropic'],
  [/^deepseek/, 'DS', '#a78bfa', 'DeepSeek'], [/^meta\/|llama/, 'M', '#22b8cf', 'Meta'], [/^(x|space)ai\/|grok/, 'X', '#444a57', 'xAI'],
  [/^mistral/, 'Mi', '#ff7000', 'Mistral'], [/^amazon\/|nova/, 'Am', '#ff9900', 'Amazon'], [/^alibaba\/|qwen/, 'Q', '#6b4cff', 'Alibaba'],
  [/^moonshot|kimi/, 'K', '#3b3b3b', 'Moonshot'], [/^xiaomi\/|mimo/, 'Xm', '#ff6900', 'Xiaomi'], [/^perplexity/, 'P', '#20808d', 'Perplexity'],
  [/^cohere/, 'Co', '#39594d', 'Cohere'], [/^zai\/|^z-ai|glm/, 'Z', '#2d5bff', 'Z.ai'], [/^minimax/, 'Mm', '#e0372f', 'MiniMax'],
];
function vendorOf(model) { const m = String(model ?? '').toLowerCase(); return VENDORS.find(([re]) => re.test(m)); }
function modelBadge(model) {
  if (!model) return '';
  const v = vendorOf(model);
  const [, , color, name] = v ?? [null, '?', '#555', 'unknown vendor'];
  return `<span class="vendor" style="background:${color}">${esc(name)}</span>`;
}
// "openai/gpt-5.2" → "gpt-5.2" once the vendor pill says who makes it.
// Who pays: a subscription (codex, grok) or the pay-per-use Vercel AI Gateway. Shown next to the model.
const providerLabel = (p) => ({ gateway: 'Vercel AI Gateway (pay per use)', codex: 'ChatGPT subscription', grok: 'Grok subscription' })[p] ?? (p || 'unknown provider');
const providerTag = (p) => !p ? '' : p === 'gateway' ? '<span class="prov gw">▲ gateway</span>' : `<span class="prov">${esc(p)}</span>`;
const modelShort = (model) => String(model ?? '').replace(/^[a-z0-9-]+\//i, '');
const STATE_LABEL = { working: 'working', ready: 'waiting', needs_input: 'needs input', external: 'other terminal', done: 'done', idle: '' };
const STATE_ORDER = { needs_input: 0, working: 1, ready: 2, external: 3, done: 4, idle: 5 };

// ---------- data ----------
async function refresh() {
  const { sessions, terminals, repos } = await (await fetch('/api/overview')).json();
  state.sessions = sessions;
  state.terminals = terminals;
  state.repos = repos ?? {};
  updatePageTitle();
  detectTransitions();
  renderSessions();
  renderSummary();
  renderReplyInbox();
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

// ---------- unread replies ----------
let inboxSeen = null;
function renderReplyInbox() {
  if (!inboxSeen) {
    // A browser can load new JS while an older server is still running. Wait for its new overview shape.
    if (state.sessions.length && !state.sessions.some((s) => Object.hasOwn(s, 'latestReply'))) return;
    try { inboxSeen = JSON.parse(localStorage.getItem('fox.inbox.seen')); } catch {}
    if (!inboxSeen || typeof inboxSeen !== 'object' || Array.isArray(inboxSeen)) {
      // First visit: don't flood the inbox with all the old conversations.
      inboxSeen = Object.fromEntries(state.sessions.filter((s) => s.latestReply).map((s) => [s.id, s.latestReply.turn]));
      saveInboxSeen();
    }
  }
  const unread = state.sessions.filter((s) => !s.parentId && !s.archived && s.latestReply && s.latestReply.turn > (inboxSeen[s.id] ?? 0))
    .sort((a, b) => (b.latestReply.at ?? b.updatedAt ?? 0) - (a.latestReply.at ?? a.updatedAt ?? 0));
  const root = $('#reply-inbox'), list = $('#reply-inbox-list'), toggle = $('#reply-inbox-toggle');
  root.classList.toggle('hidden', !unread.length);
  if (!unread.length) { list.classList.add('hidden'); toggle.setAttribute('aria-expanded', 'false'); return; }
  $('#reply-inbox-count').textContent = unread.length;
  $('#reply-inbox-label').textContent = unread.length === 1 ? 'new reply' : 'new replies';
  list.innerHTML = unread.map((s) => `<button type="button" class="reply-inbox-item" data-reply="${esc(s.id)}">
    <span class="inbox-title">${esc(displayTitle(s))}<small>${esc(shortPath(s.workspace))} · ${esc(fmtTime(s.latestReply.at))}</small></span>
    <span class="inbox-excerpt">${esc(s.latestReply.text)}</span>
  </button>`).join('');
}
function saveInboxSeen() { try { localStorage.setItem('fox.inbox.seen', JSON.stringify(inboxSeen)); } catch {} }
function markReplyRead(id) {
  const turn = sessionById(id)?.latestReply?.turn;
  if (!turn || !inboxSeen || turn <= (inboxSeen[id] ?? 0)) return;
  inboxSeen[id] = turn;
  saveInboxSeen();
  renderReplyInbox();
}
$('#reply-inbox-toggle').addEventListener('click', () => {
  const list = $('#reply-inbox-list');
  list.classList.toggle('hidden');
  $('#reply-inbox-toggle').setAttribute('aria-expanded', String(!list.classList.contains('hidden')));
});
$('#reply-inbox-list').addEventListener('click', (e) => {
  const item = e.target.closest('[data-reply]');
  if (!item) return;
  const s = sessionById(item.dataset.reply);
  if (!s?.latestReply) return;
  globalMessage = { id: s.id, index: s.latestReply.messageIndex };
  convoShown.add(s.id);
  setTranscript(true);
  selectSession(s.id); // selecting the result marks it read, without starting fx
});

// ---------- sidebar ----------
function renderSummary() {
  const live = state.sessions.filter((s) => s.terminal && !s.archived);
  const count = (st) => live.filter((s) => s.state === st).length;
  const parts = [];
  // Only what needs attention: waiting is the normal state and is not worth a line.
  if (count('needs_input')) parts.push(`<span class="st needs_input">${count('needs_input')} need input</span>`);
  if (count('working')) parts.push(`<span class="st working" title="${count('working')} working"><i></i>${count('working')}</span>`);
  const subs = state.sessions.filter((s) => s.subagent?.phase === 'running').length;
  if (subs) parts.push(`<span class="st working">${ICON.threads} ${subs} subagent${subs === 1 ? '' : 's'}</span>`);
  // Always rendered, even empty, so the list below never jumps when activity starts or stops.
  $('#summary').innerHTML = parts.join('') || '<span class="muted">quiet</span>';
}

function renderSessions() {
  if (state.renaming) return; // replacing the sidebar would blur the input and save prematurely
  const active = state.sessions.filter((s) => !s.archived && !s.parentId);
  const archived = state.sessions.filter((s) => s.archived && !s.parentId);
  const groups = new Map();
  for (const s of active) {
    if (!groups.has(s.workspace)) groups.set(s.workspace, []);
    groups.get(s.workspace).push(s);
  }
  const root = $('#session-groups');
  root.innerHTML = '';
  // Stable order: manual order (drag the project header) first, then alphabetical. Never by activity,
  // so nothing jumps around when you pick a session; the state dots say what is busy.
  const rank = (ws) => { const i = groupOrder.indexOf(ws); return i < 0 ? Infinity : i; };
  const ordered = [...groups.entries()].sort((a, b) => (rank(a[0]) - rank(b[0])) || a[0].localeCompare(b[0]));
  for (const [ws, list] of ordered) {
    list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)); // newest first, and it stays put
    const g = document.createElement('div');
    const isCollapsed = collapsed.has(ws);
    g.className = 'group' + (isCollapsed ? ' collapsed' : '');
    g.dataset.ws = ws;
    const repo = state.repos?.[ws];
    // GitHub remote: owner/repo as a link. Plain git: just the branch (and the repo root if the workspace is a subfolder).
    const gitLine = repo ? `<div class="git" title="${esc(repo.remote || 'git repo without a remote: add one (git remote add origin …) and this becomes a link')}">${repo.url ? `<a href="${esc(repo.url)}" target="_blank" rel="noopener" title="Open ${esc(repo.repo)} on GitHub">${ICON.github}${esc(repo.repo)}</a>` : `<span>${ICON.git}${repo.root !== ws ? esc(shortPath(repo.root)) : 'no remote'}</span>`}${repo.branch ? `<span class="branch">${esc(repo.branch)}</span>` : ''}${repo.changed ? `<span class="changed" title="${repo.changed} changed file${repo.changed === 1 ? '' : 's'}">±${repo.changed}</span>` : ''}</div>` : '';
    g.innerHTML = `<h3 draggable="true" title="Drag to reorder projects"><span class="caret" data-toggle-group="${esc(ws)}">${isCollapsed ? '▸' : '▾'}</span><span class="gname" data-toggle-group="${esc(ws)}" title="${esc(ws)}">${esc(shortPath(ws))}</span><span class="gcount">${list.length}</span><button class="icon" data-new="${esc(ws)}" title="New session in this folder">+</button></h3>${isCollapsed ? '' : gitLine}`;
    if (!isCollapsed) list.forEach((s, i) => g.appendChild(sessionCard(s, i + 1)));
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

function sessionCard(s, index = null) {
  const el = document.createElement('div');
  // "shown": the session whose terminal is on screen right now. "active": the one the right column describes.
  const shownTerm = state.terminals.find((x) => x.name === state.activeTab);
  const shown = Boolean(shownTerm && shownTerm.resume === s.id && state.tabs.get(shownTerm.name) && !state.tabs.get(shownTerm.name).closed);
  el.className = `session state-${s.state}` + (s.id === state.selected ? ' active' : '') + (shown ? ' shown' : '') + (s.archived ? ' is-archived' : '');
  el.dataset.id = s.id;
  // Sidebar state as a dot: green and still when fx waits for you, orange and breathing while it works.
  // Only needs-input (and another terminal) still say it in words; no process, nothing.
  const quiet = s.state === 'ready' || s.state === 'working';
  const stateHtml = s.state !== 'idle' ? `<span class="st ${s.state}" title="${s.state === 'external' ? 'open in another terminal; fx allows one process per session' : STATE_LABEL[s.state]}"><i></i>${quiet ? '' : STATE_LABEL[s.state]}</span>` : '';
  el.innerHTML = `
    ${index ? `<span class="idx">${index}</span>` : ''}
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
      <span class="model mono" title="${esc(s.model ?? '')} via ${esc(providerLabel(s.provider))}">${esc(modelShort(s.model))}${providerTag(s.provider)}</span>
      <span>${fmtTime(s.updatedAt)}</span>
    </div>
    ${childrenHtml(s)}`;
  return el;
}

function childrenHtml(parent) {
  // The sidebar only counts subagents; the list with answers lives in the right column.
  const kids = (parent.children ?? []).filter((c) => !c.failure && (c.name || c.task || sessionById(c.id)?.firstPrompt));
  if (!kids.length) return '';
  const working = kids.filter((c) => c.phase === 'running').length;
  const waiting = kids.filter((c) => c.phase === 'idle').length;
  const parts = [`${kids.length} subagent${kids.length === 1 ? '' : 's'}`];
  if (working) parts.push(`<span class="st working" title="${working} working"><i></i>${working}</span>`);
  if (waiting) parts.push(`<span class="st ready"><i></i>${waiting} waiting</span>`);
  return `<div class="children-count" data-child="${kids[0].id}" title="open the subagent board">${ICON.threads} ${parts.join(' · ')}</div>`;
}

// Drag a project header to reorder groups.
let dragWs = null;
$('#session-groups').addEventListener('dragstart', (e) => {
  const g = e.target.closest('.group'); if (!g || !e.target.closest('h3')) return;
  dragWs = g.dataset.ws; g.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
});
$('#session-groups').addEventListener('dragover', (e) => {
  const g = e.target.closest('.group'); if (!g || !dragWs || g.dataset.ws === dragWs) return;
  e.preventDefault();
  const r = g.getBoundingClientRect();
  g.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
  g.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
});
$('#session-groups').addEventListener('dragleave', (e) => { const g = e.target.closest('.group'); if (g) g.classList.remove('drop-before', 'drop-after'); });
$('#session-groups').addEventListener('drop', (e) => {
  const g = e.target.closest('.group'); if (!g || !dragWs) return;
  e.preventDefault();
  const before = g.classList.contains('drop-before');
  const current = [...document.querySelectorAll('#session-groups .group:not(.archived)')].map((x) => x.dataset.ws).filter(Boolean);
  const order = current.filter((w) => w !== dragWs);
  const at = order.indexOf(g.dataset.ws) + (before ? 0 : 1);
  order.splice(at, 0, dragWs);
  groupOrder = order; saveGroupOrder();
  dragWs = null; renderSessions();
});
$('#session-groups').addEventListener('dragend', () => { dragWs = null; document.querySelectorAll('.group').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after')); });

$('#session-groups').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const d = btn?.dataset ?? {};
  if (d.new) return newSessionSheet(d.new);
  if (d.pin) return setPinned(d.pin, !state.pinned.has(d.pin));
  if (d.rename) return renameInline(d.rename);
  if (d.archive) {
    const s = sessionById(d.archive);
    if (s?.terminal) {
      // An idle fx loses nothing when stopped (the session is on disk); only ask when it is mid-task.
      const busy = s.state === 'working' || s.state === 'needs_input';
      if (busy && !confirm(s.state === 'working' ? 'fx is working in this session. Stop it and archive?' : 'fx is waiting for your answer in this session. Stop it and archive?')) return;
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
  const count = e.target.closest('.children-count');
  if (count) { e.stopPropagation(); setTranscript(true); return selectSession(count.closest('.session').dataset.id); }
  const card = e.target.closest('.session');
  if (card) openSession(card.dataset.id);
});

// Click on a session: focus its tab if open, attach to its tmux terminal if running, otherwise start one.
async function openSession(id) {
  const s = sessionById(id);
  if (!s) return;
  if (s.terminal && state.tabs.has(s.terminal) && !state.tabs.get(s.terminal).closed) { activateTab(s.terminal); return selectSession(id); }
  if (s.terminal) { const t = state.terminals.find((x) => x.name === s.terminal); if (t) { attachTab(t, { user: true }); return selectSession(id); } }
  if (s.archived || s.state === 'external') { selectSession(id); if (mobileLayout.matches) showMobileView('read'); return; }
  await openTerminal({ cwd: s.workspace, resume: id });
}

function selectSession(id) {
  state.selected = id;
  updatePageTitle();
  markReplyRead(id);
  renderSessions();
  loadTranscript(id);
  syncUrl();
}

async function renameInline(id) {
  const s = sessionById(id);
  const titleEl = document.querySelector(`.session[data-id="${id}"] .title`);
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = displayTitle(s);
  state.renaming = input;
  titleEl.replaceWith(input);
  input.focus(); input.select();
  let settled = false;
  const done = async (save) => {
    if (settled) return; settled = true;
    try {
      if (save && input.value.trim() !== displayTitle(s)) {
        await post(`/api/sessions/${id}/rename`, { name: input.value.trim() === s.title ? '' : input.value });
      }
    } finally {
      if (state.renaming === input) {
        state.renaming = null;
        await refresh();
        if (state.selected === id) loadTranscript(id);
      }
    }
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
  if (r.ok) newSessionSheet(r.path);
});
$('#keys').addEventListener('click', () => showShortcuts());
// Shift-click or right-click the folder icon to type a path instead of using the native picker.
$('#pick-folder').addEventListener('contextmenu', (e) => { e.preventDefault(); $('#new-session').classList.toggle('hidden'); $('#new-cwd').focus(); });
$('#pick-folder').addEventListener('click', async (e) => {
  if (e.shiftKey) { $('#new-session').classList.toggle('hidden'); $('#new-cwd').focus(); return; }
  const btn = $('#pick-folder');
  btn.disabled = true;
  try {
    const r = await post('/api/pick-folder');
    if (r.path) newSessionSheet(r.path);
    else if (r.error) { $('#new-session').classList.remove('hidden'); $('#new-cwd-hint').textContent = r.error; $('#new-cwd-hint').className = 'hint err'; }
  } finally { btn.disabled = false; }
});

// ---------- terminals (tmux attach over WebSocket) ----------
const dictationButton = $('#dictation');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const pill = $('#dictation-pill');
let pillTimer = null;
// Voice level for the mic orb: a second, silent look at the mic (Chrome shares the permission with speech
// recognition). Sets --lvl (0..1) on the button; its rings grow with your voice.
const meter = { stream: null, ctx: null, raf: 0 };
async function startMeter() {
  if (meter.stream || !navigator.mediaDevices?.getUserMedia) return;
  try {
    meter.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!dictation.active) return stopMeter();
    meter.ctx = new AudioContext();
    const analyser = meter.ctx.createAnalyser();
    analyser.fftSize = 512;
    meter.ctx.createMediaStreamSource(meter.stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let smooth = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0; for (const v of data) sum += ((v - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / data.length) * 6);
      smooth = smooth * 0.7 + level * 0.3;
      dictationButton.style.setProperty('--lvl', smooth.toFixed(3));
      meter.raf = requestAnimationFrame(tick);
    };
    dictationButton.classList.add('metered');
    tick();
  } catch { stopMeter(); } // no meter is fine: the orb keeps breathing on its own
}
function stopMeter() {
  cancelAnimationFrame(meter.raf);
  meter.stream?.getTracks().forEach((t) => t.stop());
  meter.ctx?.close().catch(() => {});
  meter.stream = meter.ctx = null;
  dictationButton.classList.remove('metered');
  dictationButton.style.removeProperty('--lvl');
}
// The pill floats over the terminal while you speak: what Chrome hears, final words bright, the rest muted.
function showPill({ phase, message, live, pushToTalk }) {
  clearTimeout(pillTimer);
  const listening = phase === 'listening' || phase === 'stopping';
  pill.classList.toggle('hidden', !listening && phase !== 'error');
  pill.classList.toggle('error', phase === 'error');
  if (phase === 'error') {
    pill.querySelector('.dict-final').textContent = message;
    pill.querySelector('.dict-interim').textContent = '';
    pill.querySelector('.dict-hint').textContent = '';
    pillTimer = setTimeout(() => pill.classList.add('hidden'), 3500);
    return;
  }
  if (!listening) return;
  if (live) {
    // Keep the latest words in view: if it does not fit, trim from the start until it does.
    const finalEl = pill.querySelector('.dict-final'), interimEl = pill.querySelector('.dict-interim'), box = pill.querySelector('.dict-text');
    const render = (cut) => {
      const f = live.final.slice(Math.min(cut, live.final.length)), i = live.interim.slice(Math.max(0, cut - live.final.length));
      finalEl.textContent = cut && f ? '…' + f : f;
      interimEl.textContent = cut && !f ? '…' + i : i;
    };
    let cut = 0;
    render(0);
    while (box.scrollWidth > box.clientWidth + 1 && cut < live.final.length + live.interim.length) { cut += 3; render(cut); }
    pill.dataset.live = '1';
  } else if (!pill.dataset.live) { // nothing heard yet
    pill.querySelector('.dict-final').textContent = '';
    pill.querySelector('.dict-interim').textContent = 'Listening…';
  }
  pill.querySelector('.dict-hint').textContent = pushToTalk ? 'release ⌥D' : '↵ send · esc';
}
const dictation = createDictationController(SpeechRecognition, {
  language: () => navigator.language || 'en-US',
  // The words land in fx's own input; Enter is pressed only when you asked to send.
  send: (name, text, { submit = false } = {}) => {
    const tab = state.tabs.get(name);
    if (state.activeTab !== name || !tab || tab.closed || tab.ws?.readyState !== WebSocket.OPEN) return false;
    tab.ws.send(JSON.stringify({ type: 'input', data: text + (submit ? '\r' : '') }));
    tab.term.focus();
    return true;
  },
  update: (st) => {
    const listening = st.phase === 'listening' || st.phase === 'stopping';
    dictationButton.classList.toggle('listening', listening);
    dictationButton.setAttribute('aria-label', listening ? 'Stop dictation' : 'Start dictation');
    dictationButton.title = listening ? 'Stop: the words go to fx\'s input (Enter sends, Esc discards)' : 'Dictate to the active terminal (hold ⌥D)';
    if (listening) startMeter(); else { stopMeter(); delete pill.dataset.live; }
    showPill(st);
  },
});
function updateDictationAvailability() {
  const tab = state.tabs.get(state.activeTab);
  dictationButton.disabled = !SpeechRecognition || !tab || tab.closed || tab.ws?.readyState !== WebSocket.OPEN;
  if (!SpeechRecognition) dictationButton.title = 'Dictation needs Chrome';
  else if (!tab) dictationButton.title = 'Open a terminal to dictate';
}
dictationButton.addEventListener('click', () => {
  if (dictation.active) dictation.stop();
  else if (!dictationButton.disabled) dictation.start(state.activeTab);
});
updateDictationAvailability();
async function openTerminal({ cwd, resume, provider, model }) {
  const t = await post('/api/terminals', { cwd, resume, provider, model });
  if (t.error) { alert(t.error); return; }
  await refresh();
  attachTab(t);
  if (t.resume) selectSession(t.resume);
}

function terminalFontFamily() {
  return mobileLayout.matches ? '"Source Code Pro", ui-monospace, "SF Mono", Menlo, monospace' : 'ui-monospace, "SF Mono", Menlo, monospace';
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
    cursorBlink: true, fontSize, fontFamily: terminalFontFamily(), scrollback: 5000, allowTransparency: true,
    theme: state.palette ? { background: state.palette.sky ? 'rgba(0,0,0,0)' : state.palette.bg, foreground: state.palette.text, cursor: state.palette.cursor, selectionBackground: state.palette.sel } : undefined,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  // On phones, a deliberate tap on the terminal opens the software keyboard via xterm's input.
  // Do not focus on tab activation: that would pop up the keyboard just by opening a session.
  wrap.addEventListener('click', () => { if (mobileLayout.matches) term.focus(); });
  state.tabs.set(t.name, { name: t.name, term, fit, ws: null, wrap, closed: false, ready: false });
  if (mobileLayout.matches) document.fonts.load(`${fontSize}px "Source Code Pro"`).then(() => {
    const tab = state.tabs.get(t.name);
    if (tab && !tab.closed) { term.options.fontFamily = terminalFontFamily(); tab.settled = null; safeFit(tab); }
  }).catch(() => {});
  renderTabs();
  if (activate) activateTab(t.name); // connects lazily, at the measured size
}

// Connect a tab's WebSocket once it is visible and measured, so tmux draws once at the right size.
function connectTab(tab) {
  if (!tab?.term || tab.ws || tab.closed) return; // preview tabs have no terminal
  const { term, wrap } = tab;
  if (term.cols < 20 || term.rows < 5) { setTimeout(() => { safeFit(tab); connectTab(tab); }, 100); return; } // wait for a real layout
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProtocol}//${location.host}/pty?name=${encodeURIComponent(tab.name)}&cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = 'arraybuffer';
  tab.ws = ws;
  let reveal = null;
  ws.onmessage = (ev) => {
    term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    if (!tab.ready) { clearTimeout(reveal); reveal = setTimeout(() => { tab.ready = true; wrap.classList.remove('warming'); }, 120); }
  };
  ws.onopen = updateDictationAvailability;
  ws.onclose = () => { if (state.activeTab === tab.name) dictation.cancel(); tab.closed = true; wrap.classList.remove('warming'); renderTabs(); };
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
    if (tab.kind === 'view') { root.appendChild(viewTabEl(name, tab)); continue; }
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
  const active = state.tabs.get(state.activeTab);
  $('#mobile-terminal-title').textContent = !active ? 'Terminal' : active.kind === 'view' ? active.label : tabLabel(state.activeTab);
  $('#empty-state').style.display = state.tabs.size ? 'none' : 'flex';
  updateDictationAvailability();
}

// Keep the address bar in sync so a refresh (or a bookmark) lands on the same session.
function syncUrl() {
  const t = state.terminals.find((x) => x.name === state.activeTab);
  const sel = state.selected;
  const q = new URLSearchParams();
  if (t?.resume) q.set('open', t.resume);
  if (sel && sel !== t?.resume) q.set('session', sel);
  const url = q.toString() ? `?${q}` : location.pathname;
  if (location.search !== (q.toString() ? `?${q}` : '')) history.replaceState(null, '', url);
}
function activateTab(name) {
  if (state.activeTab !== name) dictation.cancel();
  state.activeTab = name;
  try { localStorage.setItem('fox.active', name); } catch {}
  for (const [n, t] of state.tabs) t.wrap.classList.toggle('active', n === name);
  renderTabs();
  const t = state.tabs.get(name);
  if (t) { if (mobileLayout.matches) showMobileView('terminal'); safeFit(t); connectTab(t); if (!mobileLayout.matches) t.term?.focus(); }
  const term = state.terminals.find((x) => x.name === name);
  if (t?.kind === 'view') { checkView(t); if (state.selected !== t.sessionId) selectSession(t.sessionId); }
  else if (term?.resume) selectSession(term.resume); else renderSessions();
  syncUrl();
}

function closeTab(name) {
  if (state.activeTab === name) dictation.cancel();
  if (state.preview === name) state.preview = null;
  const t = state.tabs.get(name);
  if (!t) return;
  try { t.ws?.close(); } catch {}
  t.term?.dispose();
  t.wrap.remove();
  state.tabs.delete(name);
  if (state.activeTab === name) state.activeTab = [...state.tabs.keys()].pop() ?? null;
  if (state.activeTab) activateTab(state.activeTab); else { renderTabs(); syncUrl(); }
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
  if (!t?.term || t.closed || !t.wrap.classList.contains('active')) return;
  const dims = t.fit.proposeDimensions();
  // Tiny proposals mean the box has no real layout yet (hidden column, mid-render): never apply them,
  // they would shrink the shared tmux window for every attached client.
  if (!dims || dims.cols < 20 || dims.rows < 5) return;
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

// ---------- drop files on the terminal ----------
// Small text files are pasted inline; anything else is saved by the server and its path is pasted
// (fx turns a pasted image path into an image attachment).
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|env|csv|tsv|log|xml|html?|css|scss|[cm]?[jt]sx?|py|rb|go|rs|zig|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|graphql|diff|patch|lua|ex|exs|vue|svelte)$/i;
const TEXT_INLINE_MAX = 200 * 1024;
const isInlineText = (f) => f.size <= TEXT_INLINE_MAX && (f.type.startsWith('text/') || /json|xml|javascript|yaml/.test(f.type) || TEXT_EXT.test(f.name));

async function dropFiles(files) {
  const tab = state.tabs.get(state.activeTab);
  if (!tab?.ws || tab.ws.readyState !== 1) return;
  const parts = [];
  for (const f of files) {
    if (isInlineText(f)) {
      const text = await f.text();
      if (!text.includes('\u0000')) { parts.push(`${f.name}:\n${text}`); continue; }
    }
    const r = await fetch(`/api/drop?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.path) parts.push(j.path); else alert(`${f.name}: ${j.error || 'upload failed'}`);
  }
  if (!parts.length) return;
  tab.term.paste(parts.join(' ') + ' ');
  tab.term.focus();
}

{
  const zone = $('#terminals');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  zone.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; zone.classList.add('dropping'); });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('dropping'); } });
  zone.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  zone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; zone.classList.remove('dropping');
    dropFiles([...e.dataTransfer.files]);
  });
}
// A file dropped anywhere else must not make the browser navigate to it.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

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
// The parent stores each subagent's answer as a tool_result. Results and children appear in the same order,
// so one-off agents are matched by normalized task text *in sequence* (three identical tasks get three
// different answers); named agents by name, keeping every round.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
let cachedResults = { id: null, key: '', runs: [], byAgent: new Map(), assigned: new Map() };
// fx writes the answers into the parent when its turn ends, after the children finish: re-read on any parent change.
const resultsKey = (parent) => `${parent.id}:${parent.updatedAt ?? 0}:${parent.turns ?? 0}:${parent.lastKind ?? ""}:${parent.children.map((c) => c.phase).join(',')}`;
function resultsByAgent(parent) { return cachedResults.id === parent.id ? cachedResults.byAgent : new Map(); }
async function refreshResults(parent) {
  if (!parent?.children?.length) return;
  const events = await (await fetch(`/api/sessions/${parent.id}/events`)).json();
  const runs = []; const byAgent = new Map();
  for (const ev of events) {
    if (ev.kind !== 'tool_call' || ev.name !== 'subagent' || !ev.result) continue;
    const req = ev.args?.request ?? {};
    let text = ev.result.preview;
    try { const j = JSON.parse(text); text = j.result ?? text; } catch {}
    if (req.agent) { if (!byAgent.has(req.agent)) byAgent.set(req.agent, []); byAgent.get(req.agent).push({ message: req.message ?? '', text }); }
    else if (req.task) runs.push({ task: norm(req.task), text, used: false });
  }
  // Walk the one-off children in order and give each the first unused result with the same task.
  const assigned = new Map();
  for (const c of parent.children) {
    if (c.name) continue;
    const task = norm(c.task ?? sessionById(c.id)?.firstPrompt ?? '');
    const r = runs.find((x) => !x.used && x.task === task);
    if (r) { r.used = true; assigned.set(c.id, r.text); }
  }
  cachedResults = { id: parent.id, key: resultsKey(parent), runs, byAgent, assigned };
}
function answerFor(parent, c) {
  if (cachedResults.id !== parent.id) return null;
  if (c?.name) { const rounds = cachedResults.byAgent.get(c.name) ?? []; return rounds.length ? rounds.at(-1).text : null; }
  return cachedResults.assigned.get(c.id) ?? null;
}

// Board: subagents grouped by task, so the same task on several models reads as a comparison.
// Click a row to read its whole answer in place; bad answers are flagged.
const expandedAgents = new Set();
let agentsCollapsed = false;
try { agentsCollapsed = localStorage.getItem('fox.agentsCollapsed') === '1'; } catch {}
let lastChildShown = null;
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm'; };
const vendorDot = (model) => { const v = vendorOf(model); return `<span class="vdot" style="background:${v?.[2] ?? 'var(--muted)'}" title="${esc(v?.[3] ?? 'unknown vendor')}"></span>`; };
// What went wrong with an answer, if anything: weak models often print a tool call instead of making it.
function answerFlag(c, text, parentBusy) {
  if (c.failure) return ['failed', 'err'];
  if (c.phase === 'running') return null;
  if (!text?.trim() && c.outcome === 'cancelled') return ['cancelled', 'muted'];
  if (!text?.trim()) return parentBusy ? null : ['no answer', 'muted']; // answers are saved when the parent's turn ends
  if (/^\s*(?:\/\/[^\n]*\n\s*)*[a-z_][a-z0-9_.]*\(\s*[a-z_]+\s*=/i.test(text) || /^\s*\{\s*"(name|tool|function)"\s*:/.test(text)) return ["didn't run tools", 'warn'];
  if (/^\s*(lo siento|sorry)/i.test(text) || /\b(no (?:puedo|pude|puede|es posible)|no se puede|i can(?:no|')t|i couldn't|i'm (?:not able|unable)|i am unable|unable to)\b/i.test(text.slice(0, 160))) return ["couldn't", 'err'];
  return null;
}
function agentsBoard(parent, { selectedId = null } = {}) {
  if (!parent?.children?.length) return '';
  const groups = new Map();
  parent.children.forEach((c, i) => {
    const child = sessionById(c.id);
    const task = c.task ?? child?.firstPrompt ?? '';
    const key = c.name ? 'agent:' + c.name : norm(task) || 'none:' + c.id;
    if (!groups.has(key)) groups.set(key, { name: c.name, task, items: [] });
    groups.get(key).items.push({ c, i, child });
  });
  const parentBusy = parent.state === 'working' || parent.children.some((c) => c.phase === 'running');
  const row = ({ c, i, child }, single) => {
    const model = child?.model ?? null;
    const answer = answerFor(parent, c);
    // Cancelled before answering: show what it had started to write, flagged as cancelled.
    const res = answer ?? (c.outcome === 'cancelled' ? child?.partial ?? null : null);
    const flag = !answer && res ? ['cancelled', 'muted'] : answerFlag(c, res, parentBusy);
    const task = c.task ?? child?.firstPrompt ?? '';
    const elapsed = c.phase === 'running' && c.startedAt ? fmtDur(Date.now() - c.startedAt) : child?.usage.wallMs ? fmtDur(child.usage.wallMs) : '';
    const open = expandedAgents.has(c.id);
    const head = `<div class="agent-head"><span class="idx">${i + 1}</span>${model ? vendorDot(model) : ''}<span class="agent-name">${model ? esc(modelShort(model)) : 'failed to start'}</span>${c.phase === 'running' ? '<span class="st working"><i></i></span>' : ''}${flag ? `<span class="flag ${flag[1]}">${flag[0]}</span>` : ''}<span class="agent-elapsed">${elapsed}</span></div>`;
    const failure = c.failure ? (typeof c.failure === 'string' ? c.failure : (c.failure.message ?? c.failure.reason ?? JSON.stringify(c.failure))) : '';
    // Open: the whole answer it returned to the parent (every round for a named agent), or why there is none.
    const rounds = c.name ? (cachedResults.id === parent.id ? cachedResults.byAgent.get(c.name) ?? [] : []) : [];
    const note = c.phase === 'running' ? 'working…'
      : !answer && c.outcome === 'cancelled' ? 'cancelled before answering' + (res ? ', it had started to write:' : '')
      : !res && parentBusy ? 'the answer arrives when the parent finishes its turn'
      : !res ? 'no answer recorded' : '';
    // Closed rows are one line; everything else (its own task, the answer, why there is none) opens on click.
    const taskLine = single && task ? `<div class="agent-note">task · ${esc(task.slice(0, 300))}${task.length > 300 ? '…' : ''}</div>` : '';
    const body = !open ? ''
      : failure ? `${taskLine}<div class="agent-answer err">${esc(failure)}</div>`
      : `${taskLine}${note ? `<div class="agent-note">${note}</div>` : ''}${rounds.length > 1
          ? rounds.map((r, k) => `<div class="agent-note">round ${k + 1} · ${esc(r.message.slice(0, 160))}</div><div class="agent-answer">${esc(r.text)}</div>`).join('')
          : res ? `<div class="agent-answer">${esc(res)}</div>` : ''}`;
    const selected = c.id === selectedId;
    return `<div class="agent ${open ? 'open' : ''} ${selected ? 'selected' : ''}" data-agent="${c.id}" title="${open ? '' : esc(task)}">${head}${body}${open && !selected ? `<a class="agent-open" href="#" data-child="${c.id}">its conversation →</a>` : ''}</div>`;
  };
  // A header only where it says something: the same task on several models, or a named agent.
  const html = [...groups.values()].map((g) => {
    if (g.items.length === 1 && !g.name) return `<div class="agroup">${row(g.items[0], true)}</div>`;
    const label = g.name ? `${ICON.threads} ${esc(g.name)}` : esc(g.task || 'no task');
    const count = g.items.length > 1 ? `<span class="agroup-n">${g.items.length} models</span>` : '';
    return `<div class="agroup"><div class="agroup-task" title="${esc(g.task)}"><span>${label}</span>${count}</div>${g.items.map((it) => row(it, false)).join('')}</div>`;
  });
  const n = parent.children.length;
  const title = `${n} subagent${n === 1 ? '' : 's'}${groups.size > 1 && groups.size < n ? ` · ${groups.size} tasks` : ''}`;
  const head = `<a href="#" class="section-title fold ${agentsCollapsed ? 'closed' : ''}" data-toggle-agents>${title}</a>`;
  return agentsCollapsed ? head : `${head}<div class="board">${html.join('')}</div>`;
}

const convoShown = new Set();

// ---------- files open as tabs next to the terminal (fx's terminal cannot show them) ----------
// One rule: click a file and it opens in the middle, shown the way its type reads best: pages and images
// render (sandboxed by the server), Markdown is formatted, JSON is indented, CSV is a table, code is
// highlighted. Anything with a preview can flip to its source. Every file tab reloads when fx changes it.
const VIEWABLE = /\.(html?|svg|png|jpe?g|gif|webp)$/i;      // rendered by the browser from the server
const FORMATTED = /\.(md|markdown|json|csv|tsv)$/i;         // rendered here from the file's text
const hasPreview = (path) => VIEWABLE.test(path) || FORMATTED.test(path);
const canView = (f) => f.exists && VIEWABLE.test(f.path);
const viewUrl = (id, path) => `/api/sessions/${encodeURIComponent(id)}/preview?path=${encodeURIComponent(path)}`;
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';
// HTML loads through a /view/ link that also serves its CSS, JS and images; other files come straight.
const IS_HTML = /\.html?$/i;
async function pageSrc(sessionId, path) {
  if (!IS_HTML.test(path)) return viewUrl(sessionId, path);
  const j = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/view-url?path=${encodeURIComponent(path)}`).then((r) => r.json()).catch(() => ({}));
  return j.url ?? viewUrl(sessionId, path);
}
const defaultMode = (f) => (hasPreview(f.path) ? 'page' : 'source');
const extOf = (path) => (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
// Markdown and highlighting libraries load the first time a file needs them.
const libs = {};
const loadLib = (src) => (libs[src] ??= new Promise((ok, fail) => { const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = fail; document.head.appendChild(el); }));
const HLJS_LANG = { mjs: 'javascript', cjs: 'javascript', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', htm: 'xml', html: 'xml', svg: 'xml', zig: 'zig' };
async function highlight(text, ext) {
  try {
    await loadLib('/vendor/hljs/highlight.min.js');
    const lang = HLJS_LANG[ext] ?? ext;
    if (window.hljs?.getLanguage(lang)) return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {}
  return esc(text);
}
// A single file tab: opening another file replaces what it shows.
const VIEW_TAB = 'view';
function openView(sessionId, path, mode = 'page') {
  let tab = state.tabs.get(VIEW_TAB);
  if (!tab) {
    const wrap = document.createElement('div');
    wrap.className = 'term-wrap view-wrap';
    $('#terminals').appendChild(wrap);
    tab = { name: VIEW_TAB, kind: 'view', wrap, closed: false };
    state.tabs.set(VIEW_TAB, tab);
  }
  if (tab.path !== path || tab.sessionId !== sessionId) Object.assign(tab, { sessionId, path, label: path.split('/').pop(), etag: null, mode: null });
  setViewMode(tab, hasPreview(path) ? mode : 'source');
  activateTab(VIEW_TAB);
}
function setViewMode(tab, mode) {
  if (tab.mode === mode) return;
  tab.mode = mode;
  const toggle = hasPreview(tab.path) && !/\.(png|jpe?g|gif|webp)$/i.test(tab.path)
    ? `<div class="view-mode">${['page', 'source'].map((m) => `<button type="button" data-view-mode="${m}" class="${m === mode ? 'on' : ''}">${m === 'page' ? 'preview' : 'source'}</button>`).join('')}</div>` : '';
  const framed = mode === 'page' && VIEWABLE.test(tab.path);
  tab.wrap.classList.toggle('source', !framed);
  tab.wrap.innerHTML = toggle + (framed
    ? `<iframe sandbox="${SANDBOX}" title="${esc(tab.label)}"></iframe>`
    : '<div class="code-view"><div class="code-note">loading…</div></div>');
  tab.wrap.querySelectorAll('[data-view-mode]').forEach((b) => b.addEventListener('click', () => setViewMode(tab, b.dataset.viewMode)));
  if (framed) pageSrc(tab.sessionId, tab.path).then((src) => { const f = tab.wrap.querySelector('iframe'); if (f && tab.mode === mode) f.src = src; });
  else loadSource(tab);
}
// Text-based tabs: fetch the file and show it as its type reads best (or as plain source).
async function loadSource(tab) {
  const box = tab.wrap.querySelector('.code-view');
  if (!box) return;
  const j = await fetch(`/api/sessions/${encodeURIComponent(tab.sessionId)}/file?path=${encodeURIComponent(tab.path)}`).then((r) => r.json()).catch(() => ({ error: 'not available' }));
  if (j.text === undefined) { box.innerHTML = `<div class="code-note">${j.binary ? 'Binary file. Use ↗ in the files list to open it.' : j.tooLarge ? `Too large to show here (${Math.round(j.size / 1024)} KB). Use ↗ to open it.` : esc(j.error ?? 'not available')}</div>`; return; }
  const top = box.scrollTop, ext = extOf(tab.path), text = j.text;
  let html = null;
  if (tab.mode === 'page' && /^(md|markdown)$/.test(ext)) html = await markdownView(text);
  else if (tab.mode === 'page' && ext === 'json') {
    try { html = codeBlock(await highlight(JSON.stringify(JSON.parse(text), null, 2), 'json')); }
    catch { html = `<div class="code-note">Not valid JSON, showing it as written.</div>` + codeBlock(await highlight(text, 'json')); }
  } else if (tab.mode === 'page' && /^(csv|tsv)$/.test(ext)) html = tableView(text, ext === 'tsv' ? '\t' : ',');
  else html = codeBlock(await highlight(text, ext));
  box.innerHTML = html;
  box.classList.toggle('doc', tab.mode === 'page' && /^(md|markdown)$/.test(ext));
  box.scrollTop = top; // a reload keeps your place
}
// Highlighted code with a separate line-number gutter, so multi-line tokens stay intact.
function codeBlock(html) {
  const lines = html.split('\n').length;
  return `<div class="code-grid"><pre class="code-gutter" aria-hidden="true">${Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</pre><pre class="code-body hljs">${html}</pre></div>`;
}
// Markdown, formatted. marked's HTML is not trusted: it is shown in a frame with no scripts and no access
// to fox, styled with the current theme.
async function markdownView(text) {
  try { await loadLib('/vendor/marked/marked.umd.js'); } catch { return codeBlock(await highlight(text, 'markdown')); }
  const doc = document.createElement('template');
  doc.innerHTML = marked.parse(text, { gfm: true });
  for (const code of doc.content.querySelectorAll('pre code')) {
    const lang = (code.className.match(/language-([\w-]+)/)?.[1] ?? '').toLowerCase();
    code.innerHTML = lang ? await highlight(code.textContent, lang) : esc(code.textContent);
    code.classList.add('hljs');
  }
  const css = getComputedStyle(document.body), v = (n) => css.getPropertyValue(n).trim();
  const page = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>
    :root{color-scheme:dark;--bg:${v('--bg').startsWith('rgba') ? '#0b0d14' : v('--bg')};--text:${v('--text')};--muted:${v('--muted')};--border:${v('--border')};--panel:${v('--panel-2')};--accent:${v('--accent')};--ok:${v('--ok')};--warn:${v('--warn')};--err:${v('--err')};}
    ${MD_CSS}</style><article>${doc.innerHTML}</article>`;
  return `<iframe class="doc-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(page)}"></iframe>`;
}
const MD_CSS = `html{background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  body{margin:0}article{max-width:760px;margin:0 auto;padding:36px 32px 64px}
  h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .6em;letter-spacing:-.01em}h1{font-size:2em;margin-top:.2em}h2{font-size:1.45em;padding-bottom:.3em;border-bottom:1px solid var(--border)}h3{font-size:1.15em}
  p,ul,ol,blockquote,table,pre{margin:0 0 1em}a{color:var(--accent)}li{margin:.25em 0}hr{border:0;border-top:1px solid var(--border);margin:2em 0}
  code{font:.88em ui-monospace,"SF Mono",Menlo,monospace;background:var(--panel);padding:.15em .4em;border-radius:5px}
  pre{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px;overflow:auto}pre code{background:none;padding:0;font-size:13px;line-height:1.55}
  blockquote{border-left:3px solid var(--accent);padding:.2em 1em;color:var(--muted)}
  table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--border);padding:6px 12px;text-align:left}th{background:var(--panel)}
  img{max-width:100%}input[type=checkbox]{margin-right:.5em}
  .hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:var(--accent)}.hljs-string,.hljs-attr-value{color:var(--ok)}.hljs-number,.hljs-literal{color:var(--warn)}.hljs-comment,.hljs-quote{color:var(--muted);font-style:italic}.hljs-title,.hljs-attr,.hljs-property{color:var(--err)}`;
// CSV or TSV as a table (quoted fields with commas and newlines handled; first row is the header).
function tableView(text, sep) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const shown = rows.slice(0, 2001), [head = [], ...body] = shown;
  return `<div class="table-view"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>${rows.length > shown.length ? `<div class="code-note">Showing the first 2000 rows of ${rows.length - 1}.</div>` : ''}</div>`;
}
function viewTabEl(name, tab) {
  const el = document.createElement('div');
  el.className = 'tab view' + (name === state.activeTab ? ' active' : '');
  el.title = tab.path;
  el.innerHTML = `<span class="view-icon">${hasPreview(tab.path) ? '◫' : '{}'}</span><span class="tab-label">${esc(tab.label)}</span><span class="close" data-close="1" title="Close">×</span>`;
  el.addEventListener('click', (e) => { if (e.target.dataset.close) closeTab(name); else activateTab(name); });
  return el;
}
// Live reload: the active file tab asks for the file's ETag (mtime + size) and reloads when it changes.
async function checkView(tab) {
  if (!tab || tab.kind !== 'view' || document.hidden) return;
  try {
    const r = await fetch(viewUrl(tab.sessionId, tab.path), { method: 'HEAD' });
    const etag = r.ok ? r.headers.get('etag') : null;
    if (tab.etag && etag && etag !== tab.etag) {
      if (tab.mode === 'page' && VIEWABLE.test(tab.path)) { const f = tab.wrap.querySelector('iframe'); if (f) f.src = await pageSrc(tab.sessionId, tab.path); }
      else loadSource(tab);
    }
    if (etag) tab.etag = etag;
  } catch {}
}
setInterval(() => checkView(state.tabs.get(state.activeTab)), 1500);

// The card lives outside the re-rendered body so its thumbnail is not reloaded on every poll.
let artifactKey = '';
const fmtAgo = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : fmtTime(ms); };
function renderArtifactCard(id, files) {
  const slot = $('#artifact-slot');
  // Only what fx created (write_file): an edited or mentioned page is usually part of an app, not a result.
  const f = (files ?? []).filter((x) => x.action === 'write' && canView(x)).sort((a, b) => b.mtime - a.mtime)[0];
  const key = f ? `${id}:${f.path}:${f.mtime}` : '';
  if (!f) { slot.classList.add('hidden'); slot.innerHTML = ''; artifactKey = ''; return; }
  slot.classList.remove('hidden');
  const fresh = Date.now() - f.mtime < 10 * 60000;
  const name = f.rel.split('/').pop(), dir = f.rel.slice(0, f.rel.length - name.length).replace(/\/$/, '');
  if (key !== artifactKey) {
    artifactKey = key;
    const isImage = !/\.html?$/i.test(f.path);
    slot.innerHTML = `<div class="art-card" data-view-file="${esc(f.path)}" title="Open as a tab next to the terminal">
      <div class="art-thumb">${isImage ? `<img src="${viewUrl(id, f.path)}" alt="">` : `<iframe sandbox="${SANDBOX}" tabindex="-1" aria-hidden="true"></iframe>`}</div>
      <div class="art-meta"><span class="art-name">${fresh ? '<span class="art-new">●</span>' : ''}${esc(name)}</span>${dir ? `<span class="art-dir">${esc(dir)}</span>` : ''}<span class="art-ago" data-mtime="${f.mtime}"></span><a href="#" class="art-full" data-full-view="${esc(f.path)}" title="Full screen in a new browser tab">↗</a></div>
    </div>`;
  }
  const thumb = slot.querySelector('.art-thumb iframe');
  if (thumb && !thumb.src) pageSrc(id, f.path).then((src) => { if (artifactKey === key) thumb.src = src; });
  slot.querySelector('.art-ago').textContent = fmtAgo(f.mtime);
  slot.querySelector('.art-new')?.classList.toggle('hidden', !fresh);
}

// ---------- files the session touched ----------
let filesCollapsed = false;
try { filesCollapsed = localStorage.getItem('fox.filesCollapsed') === '1'; } catch {}
function fileRow(f) {
  const kids = f.by.filter((b) => b > 0).map((b) => '#' + b);
  const subs = kids.join(' ');
  // Name first so a narrow column still tells files apart; the folder follows, muted.
  const name = f.rel.split('/').pop(), dir = f.rel.slice(0, f.rel.length - name.length);
  const kind = hasPreview(f.path) ? '◫' : '{}';
  const target = f.exists ? `data-view-file="${esc(f.path)}" data-view-mode="${defaultMode(f)}" title="Open in the middle"` : '';
  return `<div class="file ${f.exists ? '' : 'missing'}" ${target}>
    <div class="file-head"><span class="file-kind" aria-hidden="true">${kind}</span><span class="file-path" title="${esc(f.path)}"><span class="file-name">${esc(name)}</span>${dir ? `<span class="file-dir">${esc(dir.replace(/\/$/, ''))}</span>` : ''}</span>${subs ? `<span class="file-by" title="by subagent ${subs}">${kids[0]}${kids.length > 1 ? ' +' + (kids.length - 1) : ''}</span>` : ''}${f.exists ? `<a href="#" class="file-open" data-open-file="${esc(f.path)}" title="Open with the default app">↗</a>` : '<span class="file-by">deleted</span>'}</div>
  </div>`;
}
// What the session made or changed, newest change first. Files it only read are left out.
function filesSection(id, files) {
  const shown = (files ?? []).filter((f) => f.action !== 'read').sort((a, b) => b.mtime - a.mtime);
  if (!shown.length) return '';
  const head = `<a href="#" class="section-title fold ${filesCollapsed ? 'closed' : ''}" data-toggle-files>files <span class="fold-n">${shown.length}</span></a>`;
  return filesCollapsed ? head : `${head}<div class="files">${shown.map(fileRow).join('')}</div>`;
}
$('#transcript').addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open-file]');
  if (opener) { e.preventDefault(); return post(`/api/sessions/${state.selected}/open-file`, { path: opener.dataset.openFile }); }
  const full = e.target.closest('[data-full-view]');
  if (full) {
    e.preventDefault();
    const win = window.open('about:blank', '_blank'); // opened now, filled once the link arrives (popup blockers)
    pageSrc(state.selected, full.dataset.fullView).then((src) => { if (win) { win.opener = null; win.location = src; } });
    return;
  }
  const viewer = e.target.closest('[data-view-file]');
  if (viewer) { e.preventDefault(); return openView(state.selected, viewer.dataset.viewFile, viewer.dataset.viewMode || 'page'); }
  if (e.target.closest('[data-toggle-agents]')) {
    e.preventDefault(); agentsCollapsed = !agentsCollapsed;
    try { localStorage.setItem('fox.agentsCollapsed', agentsCollapsed ? '1' : '0'); } catch {}
    lastTranscriptKey = ''; return loadTranscript(state.selected, true);
  }
  if (e.target.closest('[data-toggle-files]')) {
    e.preventDefault(); filesCollapsed = !filesCollapsed;
    try { localStorage.setItem('fox.filesCollapsed', filesCollapsed ? '1' : '0'); } catch {}
    lastTranscriptKey = ''; return loadTranscript(state.selected, true);
  }
  const toggle = e.target.closest('a[data-hide-convo]');
  if (toggle) {
    e.preventDefault();
    const id = toggle.dataset.hideConvo;
    convoShown.delete(id);
    lastTranscriptKey = ''; return loadTranscript(id);
  }
  const link = e.target.closest('a[data-child], a[data-goto]');
  if (link) { e.preventDefault(); return selectSession(link.dataset.child ?? link.dataset.goto); }
  const row = e.target.closest('[data-agent]');
  if (!row || getSelection().toString()) return; // selecting answer text must not collapse it
  const id = row.dataset.agent;
  expandedAgents.has(id) ? expandedAgents.delete(id) : expandedAgents.add(id);
  lastTranscriptKey = ''; loadTranscript(state.selected, true);
});

// ---------- global search ----------
const globalSearch = $('#global-search');
const globalQuery = $('#global-search-query');
const globalResults = $('#global-search-results');
let globalHits = [], globalActive = 0, globalRequest = 0, globalTimer;
let globalMessage = null;
function openGlobalSearch() {
  globalSearch.classList.remove('hidden');
  globalQuery.value = '';
  globalHits = []; globalActive = 0;
  globalResults.innerHTML = '<div class="global-search-empty">Search session names and messages across all projects</div>';
  globalQuery.focus();
}
function closeGlobalSearch() {
  globalSearch.classList.add('hidden');
  clearTimeout(globalTimer);
  globalRequest++; // discard responses from the previous query/opening
}
function markedMatch(text, query) {
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return at < 0 ? esc(text) : esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, at + query.length)) + '</mark>' + esc(text.slice(at + query.length));
}
function renderGlobalHits() {
  const q = globalQuery.value.trim();
  globalResults.innerHTML = globalHits.map((hit, i) => {
    const s = sessionById(hit.id);
    if (!s) return '';
    const label = hit.kind === 'name' ? 'session' : hit.kind === 'user' ? 'you' : 'fx';
    return `<button type="button" role="option" aria-selected="${i === globalActive}" class="global-search-result${i === globalActive ? ' active' : ''}" data-result="${i}">
      <div class="gs-context"><strong>${esc(displayTitle(s))}</strong><span>· ${esc(shortPath(s.workspace))}${s.archived ? ' · archived' : ''}${s.parentId ? ' · subagent' : ''}</span></div>
      <div class="gs-text">${esc(label)} · ${markedMatch(hit.text, q)}</div>
    </button>`;
  }).join('') || '<div class="global-search-empty">No matches</div>';
  globalResults.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}
async function queryGlobalSearch() {
  const q = globalQuery.value.trim();
  const request = ++globalRequest;
  if (!q) { globalHits = []; globalResults.innerHTML = '<div class="global-search-empty">Search session names and messages across all projects</div>'; return; }
  globalResults.innerHTML = '<div class="global-search-empty">Searching…</div>';
  try {
    const response = await fetch('/api/search?q=' + encodeURIComponent(q));
    if (!response.ok) throw new Error('search failed');
    const results = await response.json();
    if (request !== globalRequest || globalSearch.classList.contains('hidden')) return;
    globalHits = results.filter((hit) => sessionById(hit.id));
    globalActive = 0;
    renderGlobalHits();
  } catch {
    if (request === globalRequest) globalResults.innerHTML = '<div class="global-search-empty">Could not search sessions. Try again.</div>';
  }
}
function chooseGlobalHit(hit) {
  if (!hit) return;
  closeGlobalSearch();
  if (hit.kind !== 'name') {
    globalMessage = { id: hit.id, index: hit.messageIndex };
    convoShown.add(hit.id); // display transcript even when its terminal is open
  } else globalMessage = null;
  setTranscript(true);
  selectSession(hit.id); // do not resume archived/idle sessions
}
$('#global-search-open').addEventListener('click', openGlobalSearch);
globalSearch.addEventListener('click', (e) => { if (e.target === globalSearch) closeGlobalSearch(); });
globalResults.addEventListener('click', (e) => chooseGlobalHit(globalHits[Number(e.target.closest('[data-result]')?.dataset.result)]));
globalQuery.addEventListener('input', () => {
  clearTimeout(globalTimer);
  ++globalRequest;
  globalTimer = setTimeout(queryGlobalSearch, 160);
});
globalQuery.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); closeGlobalSearch(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!globalHits.length) return;
    globalActive = (globalActive + (e.key === 'ArrowDown' ? 1 : -1) + globalHits.length) % globalHits.length;
    renderGlobalHits();
  }
  if (e.key === 'Enter') { e.preventDefault(); chooseGlobalHit(globalHits[globalActive]); }
});

let lastTranscriptKey = '';
let lastEventCount = { id: null, n: 0 };
async function loadTranscript(id, quiet = false) {
  const s = sessionById(id);
  if (!s) return;
  const parent = s.parentId ? sessionById(s.parentId) : s;
  const isChild = Boolean(s.parentId);
  if (parent?.children?.length && (cachedResults.key !== resultsKey(parent) || parent.children.some((c) => c.phase === 'running'))) await refreshResults(parent);
  const [events, files] = await Promise.all([fetch(`/api/sessions/${id}/events`).then((r) => r.json()), fetch(`/api/sessions/${id}/files`).then((r) => r.json()).catch(() => [])]);
  if (state.selected !== id) return; // selection changed while we were fetching: drop this render
  const termOpenKey = Boolean(s.terminal && state.tabs.get(s.terminal) && !state.tabs.get(s.terminal).closed);
  const key = id + ':' + events.length + ':' + (s.updatedAt ?? 0) + ':' + (parent?.children ?? []).map((c) => c.phase).join(',') + ':' + termOpenKey + ':' + Math.floor(Date.now() / 5000);
  if (quiet && key === lastTranscriptKey) return;
  lastTranscriptKey = key;

  // No title on a desktop: the session is highlighted on the left. A subagent gets a way back to its parent;
  // on a phone, where the list is another screen, the name and model stay.
  $('#transcript-title').innerHTML = isChild
    ? `<a href="#" class="crumb" data-goto="${parent.id}">← ${esc(displayTitle(parent))}</a>`
    : mobileLayout.matches ? esc(displayTitle(s)) : '';
  const u = s.usage;
  const tokens = u.input + u.output ? `${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${fmtTokens(u.cacheRead)} cache` : '';
  $('#transcript-meta').innerHTML = `<span title="${esc([tokens, s.workspace].filter(Boolean).join('\n'))}">${s.model ? vendorDot(s.model) + esc(modelShort(s.model)) : ''}${s.provider ? ` · <span title="${esc(providerLabel(s.provider))}">${s.provider === 'gateway' ? '▲ gateway' : esc(s.provider)}</span>` : ''}${u.wallMs ? ' · ' + fmtDur(u.wallMs) : ''}${isChild ? ' · billed to parent' : u.cost ? ' · $' + u.cost.toFixed(2) : ''}</span>`;

  const html = [];
  // Desktop keeps its detail-first column; phones lead with the readable conversation.
  if (!mobileLayout.matches) html.push(filesSection(id, files));
  if (isChild) {
    if (lastChildShown !== id) { expandedAgents.add(id); lastChildShown = id; } // arrive with its answer open
    if (!mobileLayout.matches) html.push(agentsBoard(parent, { selectedId: id }), '<div class="section-title">its conversation</div>');
  } else if (parent.children?.length && !mobileLayout.matches) html.push(agentsBoard(parent));
  // The conversation lives in the terminal. This column shows it only for a subagent (it has no terminal)
  // or when global search or the replies inbox pointed at one message.
  const showConvo = isChild || convoShown.has(id) || mobileLayout.matches;
  if (mobileLayout.matches) html.push('<div class="section-title">conversation</div>');
  else if (!isChild && showConvo) html.push(`<div class="section-title">conversation · <a href="#" data-hide-convo="${id}">hide</a></div>`);
  let messageIndex = 0;
  for (const ev of showConvo ? events : []) {
    if (mobileLayout.matches && ev.kind !== 'user' && ev.kind !== 'assistant') continue;
    if (!isChild && ev.kind === 'tool_call' && ev.name === 'subagent' && parent.children?.length) continue; // already in the board
    const match = globalMessage?.id === id && globalMessage.index === messageIndex;
    if (ev.kind === 'user') html.push(`<div class="msg user${match ? ' global-match' : ''}" data-message="${messageIndex++}"><div class="who">${isChild ? 'task from parent' : 'you'}</div><div class="text">${esc(ev.text)}</div></div>`);
    else if (ev.kind === 'assistant' && !ev.text?.trim()) continue; // a turn step with only tool calls
    else if (ev.kind === 'assistant') html.push(`<div class="msg assistant${match ? ' global-match' : ''}" data-message="${messageIndex++}"><div class="who">${isChild ? (s.subagent?.name ? ICON.threads + ' ' + esc(s.subagent.name) : 'subagent') : 'fx'}</div><div class="text">${esc(ev.text)}</div></div>`);
    else if (ev.kind === 'tool_call') {
      const st = ev.result?.status ?? 'pending';
      const isSub = ev.name === 'subagent';
      html.push(`<details class="tool ${st}">
        <summary><span class="dot"></span><span class="name">${isSub ? ICON.threads + ' ' : ''}${esc(ev.name)}</span><span class="brief">${esc(briefArgs(ev.args))}</span></summary>
        <pre class="label">args</pre><pre>${esc(typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args, null, 2))}</pre>
        ${ev.result ? `<pre class="label">result · ${st} · ${ev.result.bytes} bytes</pre><pre>${esc(ev.result.preview)}</pre>` : ''}
      </details>`);
    } else if (ev.kind === 'turn_completed') html.push('<hr class="turn-sep" />');
    else if (ev.kind === 'interrupted') html.push(`<div class="interrupted">■ cancelled</div>${ev.partial ? `<div class="msg assistant"><div class="text muted">${esc(ev.partial)}</div></div>` : ''}`);
    else if (ev.kind === 'raw') html.push(`<div class="msg"><div class="who">event</div><div class="text muted">${esc(ev.text)}</div></div>`);
  }
  if (mobileLayout.matches) {
    if (parent.children?.length) html.push(agentsBoard(parent, isChild ? { selectedId: id } : {}));
    html.push(filesSection(id, files));
  }
  renderArtifactCard(id, files);
  // On a session change the column follows its content: nothing to show closes it; something to show
  // brings back what you chose last. Within a session it never moves by itself.
  if (id !== columnSessionId && !mobileLayout.matches) {
    columnSessionId = id;
    const empty = !html.join('').trim() && $('#artifact-slot').classList.contains('hidden');
    let wanted = false;
    try { wanted = localStorage.getItem('fox.transcript') === '1'; } catch {}
    setTranscript(!empty && wanted, { save: false });
  }
  const body = $('#transcript-body');
  const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.innerHTML = html.join('');
  // Scroll: top when you switch sessions; stay pinned to the end only if you were already there.
  const grew = lastEventCount.id === id && events.length > lastEventCount.n;
  if (lastEventCount.id !== id) body.scrollTop = 0;
  else if (grew && wasAtBottom) body.scrollTop = body.scrollHeight;
  lastEventCount = { id, n: events.length };
  if (globalMessage?.id === id) {
    const target = body.querySelector(`.msg[data-message="${globalMessage.index}"]`);
    if (target && !globalMessage.scrolled) { target.scrollIntoView({ block: 'center' }); globalMessage.scrolled = true; }
  }
}

const transcriptToggle = $('#toggle-transcript');
let columnSessionId = null; // the session the right column last adjusted itself for
// save: false for automatic changes, so your own choice (⇥ or ×) is what comes back.
function setTranscript(visible, { save = true } = {}) {
  document.body.classList.toggle('no-transcript', !visible);
  transcriptToggle.textContent = visible ? '⇥' : '⇤';
  transcriptToggle.title = visible ? 'Hide the right column' : 'Show the right column';
  if (save) try { localStorage.setItem('fox.transcript', visible ? '1' : '0'); } catch {}
  requestAnimationFrame(() => safeFit(state.tabs.get(state.activeTab)));
}
transcriptToggle.addEventListener('click', () => { setTranscript(mobileLayout.matches || document.body.classList.contains('no-transcript')); if (mobileLayout.matches) showMobileView('read'); });
$('#close-transcript').addEventListener('click', () => { setTranscript(false); if (mobileLayout.matches) showMobileView('terminal'); });
let initialTranscript = false;
try { initialTranscript = localStorage.getItem('fox.transcript') === '1'; } catch {}
setTranscript(initialTranscript);

// ---------- resizable columns ----------
(() => {
  const root = document.body; // --left/--right are declared on body; setting them on :root would be overridden
  const load = (k, d) => { try { return Number(localStorage.getItem(k)) || d; } catch { return d; } };
  const apply = () => { root.style.setProperty('--left', load('fox.left', 300) + 'px'); root.style.setProperty('--right', load('fox.right', 380) + 'px'); };
  apply();
  const drag = (el, compute, key) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('dragging'); document.body.classList.add('resizing');
      const move = (ev) => { const v = compute(ev.clientX); root.style.setProperty(key === 'fox.left' ? '--left' : '--right', v + 'px'); try { localStorage.setItem(key, String(v)); } catch {} };
      const up = () => { el.classList.remove('dragging'); document.body.classList.remove('resizing'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); fitActive(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
  };
  drag($('#rs-left'), (x) => Math.min(640, Math.max(220, x)), 'fox.left');
  drag($('#rs-right'), (x) => Math.min(900, Math.max(280, window.innerWidth - x)), 'fox.right');
})();

// ---------- themes ----------
// Palettes. "sky" adds the star field.
const PALETTES = {
  dark:    { bg: '#0f1115', panel: '#161920', panel2: '#1d2129', border: '#262b36', text: '#e6e8ee', muted: '#8b93a7', accent: '#7aa2f7', ok: '#9ece6a', err: '#f7768e', warn: '#e0af68', cursor: '#7aa2f7', sel: '#2a3550' },
  dusk:    { bg: '#1b1530', panel: '#241c40', panel2: '#2e2452', border: '#45396f', text: '#f1e9ff', muted: '#a99cc9', accent: '#ff9f6b', ok: '#7ee8a2', err: '#ff6b8a', warn: '#ffd36b', cursor: '#ff9f6b', sel: '#3d3270' },
  terracotta: { bg: '#2a1510', panel: '#33190f', panel2: '#3f2014', border: '#5c3222', text: '#fbe9d9', muted: '#cfa48a', accent: '#ffb000', ok: '#9fd36b', err: '#ff6a5a', warn: '#ffc857', cursor: '#ffb000', sel: '#5a2e1c' },
  copper:  { bg: '#171a1f', panel: '#1d2127', panel2: '#252a32', border: '#3a414c', text: '#f2ece4', muted: '#9aa3ad', accent: '#e0875a', ok: '#8fd18b', err: '#f27f73', warn: '#e8b35b', cursor: '#e0875a', sel: '#3a3f4a' },
  plum:    { bg: '#241421', panel: '#2c1a2a', panel2: '#382236', border: '#573a55', text: '#fdeaf4', muted: '#c69ab8', accent: '#ff9e3d', ok: '#9be6a3', err: '#ff6680', warn: '#ffd36b', cursor: '#ff9e3d', sel: '#4e2d4b' },
  mauve:   { bg: '#2b2230', panel: '#352a3b', panel2: '#413449', border: '#5f4e6a', text: '#f8f0ff', muted: '#b8a7c7', accent: '#ffb86b', ok: '#a8e6a8', err: '#ff7b94', warn: '#ffd98a', cursor: '#ffb86b', sel: '#5a4a66' },
};
// Sky: the dark palette with translucent panels over a slowly drifting star field (real constellations).
const SKY = { bg: 'rgba(7,9,18,0)', panel: 'rgba(13,16,28,0.55)', panel2: 'rgba(22,26,42,0.62)', border: '#2a3147', text: '#e3e8f5', muted: '#8a93ad', accent: '#9ab4ff', ok: '#9ee0a0', err: '#ff7b94', warn: '#ffd27a', cursor: '#9ab4ff', sel: '#2b3b66', sky: true };
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mixPal = (A, B, t) => Object.fromEntries(Object.keys(A).map((k) => [k, rgb2hex(hex2rgb(A[k]).map((v, i) => v + (hex2rgb(B[k])[i] - v) * t))]));
function applyPalette(p) {
  const r = document.documentElement.style;
  r.setProperty('--bg', p.bg); r.setProperty('--panel', p.panel); r.setProperty('--panel-2', p.panel2); r.setProperty('--border', p.border);
  r.setProperty('--text', p.text); r.setProperty('--muted', p.muted); r.setProperty('--accent', p.accent);
  r.setProperty('--ok', p.ok); r.setProperty('--err', p.err); r.setProperty('--warn', p.warn);
  const termBg = p.sky ? 'rgba(0,0,0,0)' : p.bg;
  for (const t of state.tabs.values()) if (t.term) t.term.options.theme = { background: termBg, foreground: p.text, cursor: p.cursor, selectionBackground: p.sel };
  state.palette = p;
  document.body.classList.toggle('night', Boolean(p.sky));
  p.sky ? sky.start() : sky.stop();
}
function applyTheme() {
  const mode = $('#theme').value;
  applyPalette(mode === 'sky' ? SKY : PALETTES[mode] ?? PALETTES.dark);
}

// ---------- star field ----------
// Bright stars with real coordinates (RA in hours, Dec in degrees, visual magnitude) and the usual
// constellation lines. Projected equirectangular; the whole sky drifts west like the real one, only faster.
const STARS = {
  // Orion
  bet: [5.92, 7.41, 0.5], rig: [5.24, -8.20, 0.1], bel: [5.42, 6.35, 1.6], sai: [5.80, -9.67, 2.1], aln: [5.68, -1.94, 1.7], ani: [5.60, -1.20, 1.7], min: [5.53, -0.30, 2.2],
  // Ursa Major
  dub: [11.06, 61.75, 1.8], mer: [11.03, 56.38, 2.4], phe: [11.90, 53.69, 2.4], meg: [12.26, 57.03, 3.3], ali: [12.90, 55.96, 1.8], miz: [13.40, 54.93, 2.2], alk: [13.79, 49.31, 1.9],
  // Cassiopeia
  cap: [0.15, 59.15, 2.3], sch: [0.68, 56.54, 2.2], gca: [0.95, 60.72, 2.5], ruc: [1.43, 60.24, 2.7], seg: [1.91, 63.67, 3.4],
  // Scorpius
  ant: [16.49, -26.43, 1.0], sha: [17.56, -37.10, 1.6], sar: [17.62, -43.00, 1.9], dsc: [16.00, -22.62, 2.3], gra: [16.09, -19.80, 2.6], psc: [15.98, -26.11, 2.9], esc: [16.84, -34.29, 2.3], les: [17.51, -37.30, 2.7],
  // Cygnus
  den: [20.69, 45.28, 1.3], sad: [20.37, 40.26, 2.2], gie: [20.77, 33.97, 2.5], dcy: [19.75, 45.13, 2.9], alb: [19.51, 27.96, 3.1],
  // Lyra
  veg: [18.62, 38.78, 0.0], she: [18.83, 33.36, 3.5], sul: [18.98, 32.69, 3.2], dly: [18.90, 36.90, 4.3], zly: [18.75, 37.60, 4.3],
  // Leo
  reg: [10.14, 11.97, 1.4], dnb: [11.82, 14.57, 2.1], alg: [10.33, 19.84, 2.0], zos: [11.24, 20.52, 2.6], che: [11.24, 15.43, 3.3], adh: [10.28, 23.42, 3.4], ras: [9.88, 26.00, 3.9], eta: [10.12, 16.76, 3.5],
  // Taurus
  ald: [4.60, 16.51, 0.9], eln: [5.44, 28.61, 1.7], zta: [5.63, 21.14, 3.0], ple: [3.79, 24.10, 1.6],
  // Canis Major
  sir: [6.75, -16.72, -1.5], adr: [6.98, -28.97, 1.5], wez: [7.14, -26.39, 1.8], mir: [6.38, -17.96, 2.0], alu: [7.40, -29.30, 2.5],
  // Gemini
  cas: [7.58, 31.89, 1.6], pol: [7.76, 28.03, 1.1], alh: [6.63, 16.40, 1.9], tej: [6.38, 22.51, 2.9], meb: [6.73, 25.13, 3.0], was: [7.34, 21.98, 3.5],
  // Crux and the south
  acr: [12.44, -63.10, 0.8], mim: [12.80, -59.69, 1.3], gac: [12.52, -57.11, 1.6], dcr: [12.25, -58.75, 2.8], can: [6.40, -52.70, -0.7], ace: [14.66, -60.83, -0.3], had: [14.06, -60.37, 0.6], fom: [22.96, -29.62, 1.2],
  // Loose bright ones
  arc: [14.26, 19.18, 0.0], cpl: [5.28, 45.99, 0.1], alt: [19.85, 8.87, 0.8], spi: [13.42, -11.16, 1.0], pro: [7.66, 5.22, 0.4], mif: [3.41, 49.86, 1.8], alo: [3.14, 40.96, 2.1], pla: [2.53, 89.26, 2.0],
};
const LINES = [
  ['bet','bel'],['bet','aln'],['bel','min'],['min','ani'],['ani','aln'],['aln','sai'],['min','rig'],['rig','sai'],
  ['dub','mer'],['mer','phe'],['phe','meg'],['meg','dub'],['meg','ali'],['ali','miz'],['miz','alk'],
  ['cap','sch'],['sch','gca'],['gca','ruc'],['ruc','seg'],
  ['gra','dsc'],['dsc','psc'],['dsc','ant'],['ant','esc'],['esc','sar'],['sar','sha'],['sha','les'],
  ['den','sad'],['sad','gie'],['sad','dcy'],['sad','alb'],
  ['veg','zly'],['zly','she'],['she','sul'],['sul','dly'],['dly','zly'],
  ['reg','eta'],['eta','alg'],['alg','adh'],['adh','ras'],['alg','zos'],['zos','dnb'],['dnb','che'],['che','reg'],
  ['ald','eln'],['ald','zta'],
  ['sir','mir'],['sir','wez'],['wez','adr'],['wez','alu'],
  ['cas','meb'],['meb','tej'],['pol','was'],['was','alh'],
  ['acr','gac'],['mim','dcr'],['ace','had'],
];
const sky = (() => {
  const canvas = $('#sky');
  let raf = null, faint = null, last = 0;
  const rnd = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  function ensureFaint() {
    if (faint) return;
    const r = rnd(42); faint = [];
    for (let i = 0; i < 700; i++) faint.push([r() * 24, (r() * 2 - 1) * 90, 3.5 + r() * 2.5, r() * Math.PI * 2]);
  }
  function draw(now) {
    if (now - last < 50) { raf = requestAnimationFrame(draw); return; } // ~20 fps is plenty for a drift
    last = now;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#070912'; ctx.fillRect(0, 0, W, H);
    // One full turn of the sky every 8 minutes: slow, but you can see it drift. The screen shows ~15 hours of RA.
    const shift = (now / 1000 / 480) * 24;
    const span = 15; // hours of RA across the screen
    const proj = ([ra, dec]) => {
      let x = (((ra - shift) % 24) + 24) % 24; // 0..24
      if (x > span + 2) x -= 24; // wrap so things leaving on the left re-enter on the right
      return [W - (x / span) * W, ((90 - dec) / 180) * H * 1.25 - H * 0.12];
    };
    ensureFaint();
    const t = now / 1000;
    for (const [ra, dec, mag, ph] of faint) {
      const [x, y] = proj([ra, dec]); if (x < -5 || x > W + 5 || y < -5 || y > H + 5) continue;
      const a = 0.25 + 0.15 * Math.sin(t * 0.8 + ph);
      ctx.fillStyle = `rgba(200,210,255,${a * (6.5 - mag) / 3})`; ctx.fillRect(x, y, 1, 1);
    }
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(154,180,255,0.16)';
    for (const [p, q] of LINES) {
      const [x1, y1] = proj(STARS[p]), [x2, y2] = proj(STARS[q]);
      if (Math.abs(x1 - x2) > W) continue; // wrapped pair
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    for (const [key, [ra, dec, mag]] of Object.entries(STARS)) {
      const [x, y] = proj([ra, dec]); if (x < -5 || x > W + 5 || y < -5 || y > H + 5) continue;
      const r = Math.max(0.8, 2.6 - mag * 0.55);
      const a = 0.55 + 0.25 * Math.sin(t * 1.3 + key.charCodeAt(0));
      ctx.fillStyle = `rgba(226,232,255,${a})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (mag < 0.6) { ctx.fillStyle = 'rgba(154,180,255,0.12)'; ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill(); }
    }
    raf = requestAnimationFrame(draw);
  }
  return { start() { if (!raf) raf = requestAnimationFrame(draw); }, stop() { if (raf) cancelAnimationFrame(raf); raf = null; } };
})();
$('#theme').addEventListener('change', () => { try { localStorage.setItem('fox.theme', $('#theme').value); } catch {} applyTheme(); });
// Theme dots in the settings menu: one per palette (its panel color with its accent), the current one ringed.
function renderThemeDots() {
  $('#theme-dots').innerHTML = THEME_ORDER.map((t) => {
    const p = t === 'sky' ? { panel: '#0b0d14', accent: SKY.accent } : PALETTES[t];
    return `<button type="button" class="theme-dot ${$('#theme').value === t ? 'on' : ''}" data-theme="${t}" title="${t}" aria-label="${t} theme" style="background:conic-gradient(${p.accent} 0 50%, ${p.panel} 0)"></button>`;
  }).join('');
}
$('#theme-dots').addEventListener('click', (e) => {
  const dot = e.target.closest('[data-theme]');
  if (!dot) return;
  $('#theme').value = dot.dataset.theme;
  $('#theme').dispatchEvent(new Event('change'));
});
$('#theme').addEventListener('change', renderThemeDots);
// Settings menu: theme, notifications, phone pairing, shortcuts. Closes on outside click or Esc.
const settingsMenu = $('#settings-menu');
function setSettingsMenu(open) { settingsMenu.classList.toggle('hidden', !open); $('#settings').setAttribute('aria-expanded', String(open)); if (open) renderThemeDots(); }
$('#settings').addEventListener('click', (e) => { e.stopPropagation(); setSettingsMenu(settingsMenu.classList.contains('hidden')); });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) setSettingsMenu(false); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSettingsMenu(false); });
$('#keys').addEventListener('click', () => setSettingsMenu(false));
$('#pair-phone').addEventListener('click', () => setSettingsMenu(false));
const THEME_ORDER = ['dark', 'dusk', 'mauve', 'terracotta', 'copper', 'plum', 'sky'];
try { const saved = localStorage.getItem('fox.theme'); $('#theme').value = saved === 'night' ? 'sky' : THEME_ORDER.includes(saved) ? saved : 'dark'; } catch {}
applyTheme();
function cycleTheme(step = 1) {
  const i = THEME_ORDER.indexOf($('#theme').value);
  $('#theme').value = THEME_ORDER[(i + step + THEME_ORDER.length) % THEME_ORDER.length];
  $('#theme').dispatchEvent(new Event('change'));
}

// ---------- terminal font size ----------
let fontSize = 13;
try { fontSize = Number(localStorage.getItem('fox.fontSize')) || 13; } catch {}
function setFontSize(px) {
  fontSize = Math.min(24, Math.max(9, px));
  try { localStorage.setItem('fox.fontSize', String(fontSize)); } catch {}
  for (const t of state.tabs.values()) { if (!t.term) continue; t.term.options.fontSize = fontSize; t.settled = null; }
  fitActive();
}

// ---------- new session sheet (folder + optional model) ----------
let modelsCatalog = null;
async function loadModels(force = false) {
  if (modelsCatalog && !force) return modelsCatalog;
  modelsCatalog = await (await fetch(force ? '/api/models/refresh' : '/api/models', { method: force ? 'POST' : 'GET' })).json();
  const sel = $('#ns-model');
  sel.innerHTML = `<option value="">fx default${modelsCatalog.default?.model ? ` (${esc(modelsCatalog.default.model)})` : ''}</option>`;
  // One group per provider; inside the Gateway, one sub-group per vendor so Grok sits under xAI, not under "s" for spacexai.
  const cmp = (x, y) => x.localeCompare(y, 'en', { numeric: true });
  for (const p of modelsCatalog.providers ?? []) {
    const byVendor = new Map();
    for (const id of p.models) {
      const v = vendorOf(id);
      const key = p.id === 'gateway' ? (v ? v[3] : (id.split('/')[0] || 'other')) : p.label;
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key).push(id);
    }
    for (const [vendor, ids] of [...byVendor.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      const g = document.createElement('optgroup'); g.label = p.id === 'gateway' ? `${p.label} · ${vendor}` : p.label;
      for (const id of ids.sort(cmp)) { const o = document.createElement('option'); o.value = `${p.id}|${id}`; o.textContent = p.id === 'gateway' ? modelShort(id) : id; g.appendChild(o); }
      sel.appendChild(g);
    }
  }
  try { const last = localStorage.getItem('fox.lastModel'); if (last && [...sel.options].some((o) => o.value === last)) sel.value = last; } catch {}
  updateNsBadge();
  return modelsCatalog;
}
function newSessionSheet(cwd) {
  $('#ns-folder').textContent = shortPath(cwd);
  $('#newsheet').dataset.cwd = cwd;
  $('#newsheet').classList.remove('hidden');
  loadModels().then(() => $('#ns-model').focus());
  loadTools();
}
// Tools for fx (MCP servers from fox's catalog): one chip each, ✓ when fx has it. Nothing is added without a click.
const toolChip = (t) => !t.installed ? `<button type="button" class="ns-chip" data-add-tool="${t.id}" title="${esc(t.description)}">+ ${esc(t.label)}</button>`
  : t.needsSignIn ? `<button type="button" class="ns-chip warn" data-signin-tool="${t.id}" title="${esc(t.description)} Opens the sign-in page in a new tab.">${esc(t.label)} · sign in</button>`
  : `<span class="ns-chip on" title="${esc(t.description)}">✓ ${esc(t.label)}</span>`;
async function loadTools() {
  const box = $('#ns-tools');
  let tools = [];
  try { tools = await (await fetch('/api/tools')).json(); } catch {}
  box.classList.toggle('hidden', !tools.length);
  box.innerHTML = `<label class="ns-label" title="Added to fx's own MCP config, so every fx session has them">Tools for fx</label><div class="ns-chips">${tools.map(toolChip).join('')}</div><div class="ns-tools-note muted"></div>`;
}
$('#ns-tools').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add-tool], [data-signin-tool]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.addTool ?? btn.dataset.signinTool, adding = Boolean(btn.dataset.addTool);
  const label = btn.textContent, note = $('#ns-tools .ns-tools-note');
  btn.disabled = true; btn.textContent = adding ? 'Adding…' : 'Opening…';
  const r = await fetch(`/api/tools/${id}/${adding ? 'add' : 'signin'}`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { btn.disabled = false; btn.textContent = label; note.textContent = j.error || (adding ? 'Could not add it.' : 'Could not start the sign-in.'); return; }
  if (adding) {
    const tool = Array.isArray(j) ? j.find((t) => t.id === id) : null;
    btn.outerHTML = toolChip(tool ?? { id, label: label.replace(/^\+ /, ''), description: btn.title, installed: true });
    if (!tool?.needsSignIn) note.textContent = 'New sessions have it.';
    return;
  }
  // fx waits for the provider's page to call back: open it in a tab, or offer a link if popups are blocked.
  const tab = window.open(j.url, '_blank');
  btn.textContent = 'Waiting for sign-in…';
  note.innerHTML = tab ? 'Finish the sign-in in the new tab.' : `Pop-up blocked: <a href="${esc(j.url)}" target="_blank" rel="noopener">open the sign-in page</a>.`;
  for (let i = 0; i < 150; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const st = await (await fetch(`/api/tools/${id}/signin`)).json().catch(() => ({}));
    if (st.status === 'done') { btn.outerHTML = `<span class="ns-chip on" title="${esc(btn.title)}">✓ ${esc(label.replace(/ · sign in$/, ''))}</span>`; note.textContent = 'Signed in. New sessions have it.'; return; }
    if (st.status === 'failed') { btn.disabled = false; btn.textContent = label; note.textContent = st.error || 'The sign-in did not finish.'; return; }
  }
});
function updateNsBadge() {
  const v = $('#ns-model').value;
  const [provider, model] = v ? v.split('|') : [modelsCatalog?.default?.provider, modelsCatalog?.default?.model];
  $('#ns-badge').innerHTML = modelBadge(model);
  $('#ns-prov').innerHTML = providerTag(provider); // who pays: subscription or Gateway
  $('#ns-prov').title = providerLabel(provider);
}
$('#ns-model').addEventListener('change', updateNsBadge);
$('#ns-cancel').addEventListener('click', () => $('#newsheet').classList.add('hidden'));
$('#newsheet').addEventListener('click', (e) => { if (e.target.id === 'newsheet') $('#newsheet').classList.add('hidden'); });
$('#newform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cwd = $('#newsheet').dataset.cwd;
  const v = $('#ns-model').value;
  try { localStorage.setItem('fox.lastModel', v); } catch {}
  const [provider, model] = v ? v.split('|') : [null, null];
  $('#newsheet').classList.add('hidden');
  await openTerminal({ cwd, provider, model });
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#newsheet').classList.contains('hidden')) $('#newsheet').classList.add('hidden'); });

// ---------- keyboard ----------
// ⌥ as the modifier: ⌘T and ⌘W belong to the browser. Captured on window before xterm sees them.
const SHORTCUTS = [
  ['⌥T', 'new session in the current project'],
  ['⌥W', 'close the current tab'],
  ['⌥] / ⌥[', 'next / previous tab'],
  ['⌥1…9', 'jump to tab'],
  ['⌥P', 'pin / unpin the current tab'],
  ['hold ⌥D', 'dictate; release to send to the active terminal'],
  ['⌥Space', 'search all sessions'],
  ['⌥\\', 'show / hide the right column'],
  ['⌥L / ⌥⇧L', 'next / previous theme'],
  ['⌥= / ⌥-', 'bigger / smaller terminal font'],
  ['⌥0', 'reset font size'],
  ['⌥?', 'this list'],
];
function currentWorkspace() {
  const t = state.terminals.find((x) => x.name === state.activeTab);
  if (t?.cwd) return t.cwd;
  const s = sessionById(state.selected);
  return s?.workspace ?? null;
}
function showShortcuts() {
  let el = $('#shortcuts');
  if (el) { el.remove(); return; }
  el = document.createElement('div'); el.id = 'shortcuts';
  el.innerHTML = `<div class="sheet"><div class="section-title">keyboard</div>${SHORTCUTS.map(([k, d]) => `<div class="kb"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}<div class="muted" style="margin-top:8px;font-size:11px">⌘T and ⌘W are reserved by the browser.</div></div>`;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}
let pushToTalkHeld = false;
// While dictating: Enter sends what you said, Esc throws it away. Captured before xterm sees the key.
window.addEventListener('keydown', (e) => {
  if (!dictation.active || pushToTalkHeld || e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); dictation.stop({ submit: true }); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dictation.cancel(); }
}, true);
window.addEventListener('keyup', (e) => {
  if (e.code !== 'KeyD' || !pushToTalkHeld) return;
  pushToTalkHeld = false;
  e.preventDefault();
  e.stopPropagation();
  dictation.stop();
}, true);
window.addEventListener('blur', () => {
  if (pushToTalkHeld) { pushToTalkHeld = false; dictation.cancel(); }
});
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.code === 'KeyD') {
    // Never hijack typed text or dialogs; xterm's helper textarea is the terminal itself.
    if ((e.target instanceof Element && e.target.closest('input, select, textarea:not(.xterm-helper-textarea), [contenteditable]')) ||
        document.querySelector('dialog[open], #newsheet:not(.hidden), #global-search:not(.hidden), #shortcuts')) return;
    if (dictationButton.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat && !pushToTalkHeld && !dictation.active) {
      pushToTalkHeld = true;
      dictation.start(state.activeTab, { pushToTalk: true });
    }
    return;
  }
  const tabs = [...state.tabs.keys()];
  const idx = tabs.indexOf(state.activeTab);
  const code = e.code; // physical key: Option changes e.key on macOS
  let handled = true;
  if (code === 'KeyT' || code === 'KeyN') { const ws = currentWorkspace(); if (ws) newSessionSheet(ws); else $('#pick-folder').click(); }
  else if (code === 'KeyW') { if (state.activeTab) closeTab(state.activeTab); }
  else if (code === 'BracketRight') { if (tabs.length) activateTab(tabs[(idx + 1) % tabs.length]); }
  else if (code === 'BracketLeft') { if (tabs.length) activateTab(tabs[(idx - 1 + tabs.length) % tabs.length]); }
  else if (/^Digit[1-9]$/.test(code)) { const n = Number(code.slice(5)) - 1; if (tabs[n]) activateTab(tabs[n]); }
  else if (code === 'KeyP') { if (state.activeTab) setPinned(state.activeTab, !state.pinned.has(state.activeTab)); }
  else if (code === 'Space') { globalSearch.classList.contains('hidden') ? openGlobalSearch() : closeGlobalSearch(); }
  else if (code === 'Backslash') { setTranscript(document.body.classList.contains('no-transcript')); }
  else if (code === 'KeyL') { cycleTheme(e.shiftKey ? -1 : 1); }
  else if (code === 'Equal' || code === 'NumpadAdd') { setFontSize(fontSize + 1); }
  else if (code === 'Minus' || code === 'NumpadSubtract') { setFontSize(fontSize - 1); }
  else if (code === 'Digit0') { setFontSize(13); }
  else if (code === 'Slash' || e.key === '?') { showShortcuts(); }
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);
// Escape closes the shortcuts sheet or leaves the search box.
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#shortcuts')) $('#shortcuts').remove(); });

// ---------- phone layout: the same live tmux terminal, one pane at a time ----------
const mobileLayout = matchMedia('(max-width: 1100px)');
function showMobileView(view) {
  if (!['sessions', 'terminal', 'read'].includes(view)) return;
  document.body.dataset.mobileView = view;
  updatePageTitle();
  for (const button of document.querySelectorAll('#mobile-nav button')) {
    if (button.dataset.mobileView === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (view === 'terminal') requestAnimationFrame(() => {
    const tab = state.tabs.get(state.activeTab);
    safeFit(tab);
    if (tab) connectTab(tab);
  });
}
showMobileView('sessions');
$('#mobile-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mobile-view]');
  if (!button) return;
  if (button.dataset.mobileView === 'read') setTranscript(true);
  showMobileView(button.dataset.mobileView);
});
function sizeMobileViewport() {
  if (!mobileLayout.matches) { document.body.style.removeProperty('--mobile-height'); return; }
  document.body.style.setProperty('--mobile-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
  fitActive();
}
sizeMobileViewport();
window.visualViewport?.addEventListener('resize', sizeMobileViewport);
mobileLayout.addEventListener('change', sizeMobileViewport);
mobileLayout.addEventListener('change', updatePageTitle);
mobileLayout.addEventListener('change', async () => {
  if (mobileLayout.matches) { try { await document.fonts.load(`${fontSize}px "Source Code Pro"`); } catch {} }
  for (const tab of state.tabs.values()) { if (!tab.term) continue; tab.term.options.fontFamily = terminalFontFamily(); tab.settled = null; }
  fitActive();
});
// ---------- local phone pairing ----------
const pairDialog = $('#pair-dialog');
let pairTimer = null, pairStarting = false;
if (!['127.0.0.1', 'localhost'].includes(location.hostname)) $('#pair-phone').classList.add('hidden');
const pairApi = async (path, data) => {
  const response = await fetch(path, data === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Pairing failed');
  return result;
};
async function showPairingState() {
  if (!pairDialog.open) return;
  try {
    const { enabled, tunnelUrl, pending, devices } = await pairApi('/api/pair/state');
    $('#pair-tunnel').textContent = tunnelUrl || (pairStarting ? 'Connecting to Cloudflare…' : 'Tunnel stopped');
    $('#pair-create').disabled = !enabled || pairStarting;
    $('#pair-stop').disabled = !tunnelUrl;
    if (!enabled) $('#pair-status').textContent = 'Restart fox with FOX_SHARE_PORT=4851 to enable remote pairing.';
    const waiting = $('#pair-pending'); waiting.replaceChildren();
    for (const item of pending) {
      const row = document.createElement('div'); row.className = 'pair-entry';
      const label = document.createElement('span'); label.textContent = `${item.name} · code ${item.code}`;
      row.append(label);
      for (const [text, approve] of [['Accept', true], ['Reject', false]]) {
        const button = document.createElement('button'); button.textContent = text;
        button.addEventListener('click', async () => { try { await pairApi('/api/pair/decision', { id: item.id, approve }); await showPairingState(); } catch (error) { $('#pair-status').textContent = error.message; } });
        row.append(button);
      }
      waiting.append(row);
    }
    if (!pending.length) waiting.textContent = 'No phone waiting.';
    const granted = $('#pair-devices'); granted.replaceChildren();
    for (const device of devices) {
      const row = document.createElement('div'); row.className = 'pair-entry';
      const label = document.createElement('span'); label.textContent = device.name;
      const revoke = document.createElement('button'); revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => { try { await pairApi('/api/pair/revoke', { id: device.id }); await showPairingState(); } catch (error) { $('#pair-status').textContent = error.message; } });
      row.append(label, revoke); granted.append(row);
    }
    if (!devices.length) granted.textContent = 'No paired devices.';
  } catch (error) { $('#pair-status').textContent = error.message; }
}
async function startPhonePairing() {
  if (pairStarting) return;
  pairStarting = true;
  $('#pair-status').textContent = '';
  $('#pair-offer').hidden = true;
  $('#pair-tunnel').textContent = 'Connecting to Cloudflare…';
  $('#pair-create').disabled = true;
  try {
    const { svg, url } = await pairApi('/api/pair/tunnel/start', {});
    $('#pair-tunnel').textContent = url;
    $('#pair-qr').src = 'data:image/svg+xml;base64,' + btoa(svg);
    $('#pair-offer').hidden = false;
    $('#pair-stop').disabled = false;
    $('#pair-status').textContent = 'Compare the six-digit code on both screens before accepting.';
  } catch (error) { $('#pair-status').textContent = error.message; }
  finally { pairStarting = false; await showPairingState(); }
}
$('#pair-phone').addEventListener('click', () => {
  pairDialog.showModal();
  showPairingState().then(startPhonePairing);
  pairTimer = setInterval(showPairingState, 2000);
});
$('#pair-close').addEventListener('click', () => pairDialog.close());
pairDialog.addEventListener('close', () => { clearInterval(pairTimer); pairTimer = null; });
$('#pair-create').addEventListener('click', startPhonePairing);
$('#pair-stop').addEventListener('click', async () => {
  try {
    await pairApi('/api/pair/tunnel/stop', {});
    $('#pair-offer').hidden = true;
    $('#pair-qr').removeAttribute('src');
    $('#pair-status').textContent = 'Sharing stopped. Paired devices must be approved again next time.';
    await showPairingState();
  } catch (error) { $('#pair-status').textContent = error.message; }
});

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
  // Respect the saved column state on refresh; only an explicit ?session= that differs from the open tab opens it.
  if (selId && sessionById(selId)) { if (q.get('session') && selId !== openId) setTranscript(true); selectSession(selId); if (mobileLayout.matches && q.get('session') && !openId) showMobileView('read'); }
  state.pollTimer = setInterval(async () => {
    await refresh();
    if (state.selected) loadTranscript(state.selected, true);
  }, 3000);
})();
