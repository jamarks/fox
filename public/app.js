// fx-panel frontend: sidebar (sessions + states), tmux-backed terminals (xterm over WebSocket), transcript.

const $ = (sel) => document.querySelector(sel);
const state = {
  sessions: [], terminals: [], selected: null,
  tabs: new Map(), // tmux name -> { term, fit, ws, wrap, label, closed }
  activeTab: null, pollTimer: null, prevStates: new Map(), prevChildResults: new Map(), prevReplyTurns: new Map(), sound: false,
  renaming: null, // keep the inline editor mounted while overview polling updates the rest of the UI
  pinned: new Set(), // tmux names pinned as tabs; restored after reload. Everything else is a preview or runs unseen.
  preview: null,     // the one unpinned terminal currently shown; replaced when you click another session
  mosaic: false, mosaicIds: [], // selected sessions, including sleeping ones; tiles never connect to /pty
};
try { state.mosaicIds = JSON.parse(localStorage.getItem('fox.mosaic') ?? '[]').filter((id) => typeof id === 'string').slice(0, 4); } catch {}
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
const shortPath = (p) => (p ?? '').replace(/^\/(?:Users|home)\/[^/]+/, '~'); // macOS and Linux homes
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
// The browser tab names what is in front: a page (Skills, Jobs…) over the session it covers.

function updatePageTitle() {
  const page = document.querySelector('.page-view:not(.hidden)')?.getAttribute('aria-label'); // each page names itself
  const viewingSession = !mobileLayout.matches || document.body.dataset.mobileView !== 'sessions';
  const name = page ?? (viewingSession && sessionById(state.selected) ? displayTitle(sessionById(state.selected))?.trim() : '');
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
  [/^openai\/|^gpt-|^o[1-9]/, 'OA', '#10a37f', 'OpenAI'], [/^google\/|gemini|gemma/, 'G', '#4285f4', 'Google'], [/^anthropic\/|claude|^(opus|sonnet|haiku|fable)\b/, 'A', '#d97757', 'Anthropic'],
  [/^deepseek/, 'DS', '#a78bfa', 'DeepSeek'], [/^meta\/|llama/, 'M', '#22b8cf', 'Meta'], [/^(x|space)ai\/|grok/, 'X', '#444a57', 'xAI'],
  [/^mistral/, 'Mi', '#ff7000', 'Mistral'], [/^amazon\/|nova/, 'Am', '#ff9900', 'Amazon'], [/^alibaba\/|qwen/, 'Q', '#6b4cff', 'Alibaba'],
  [/^moonshot|kimi/, 'K', '#3b3b3b', 'Moonshot'], [/^xiaomi\/|mimo/, 'Xm', '#ff6900', 'Xiaomi'], [/^perplexity/, 'P', '#20808d', 'Perplexity'],
  [/^cohere/, 'Co', '#39594d', 'Cohere'], [/^zai\/|^z-ai|glm/, 'Z', '#2d5bff', 'Z.ai'], [/^minimax/, 'Mm', '#e0372f', 'MiniMax'],
];
// The agent that runs a session (fx, Claude Code…), for the words that name it.
const agentName = (s) => s?.harnessLabel ?? 'fx';
function vendorOf(model) { const m = String(model ?? '').toLowerCase(); return VENDORS.find(([re]) => re.test(m)); }
function modelBadge(model) {
  if (!model) return '';
  const v = vendorOf(model);
  const [, , color, name] = v ?? [null, '?', '#555', 'unknown vendor'];
  return `<span class="vendor" style="background:${color}">${esc(name)}</span>`;
}
// "openai/gpt-5.2" → "gpt-5.2" once the vendor pill says who makes it.
// Who pays: a subscription (codex, grok) or the pay-per-use Vercel AI Gateway. Shown next to the model.
const providerLabel = (p) => ({ gateway: 'Vercel AI Gateway (pay per use)', codex: 'ChatGPT subscription', grok: 'Grok subscription', claude: 'Claude Code (your Claude sign-in)' })[p] ?? (p || 'unknown provider');
const providerTag = (p) => !p ? '' : p === 'gateway' ? '<span class="prov gw">▲ gateway</span>' : `<span class="prov">${esc(p)}</span>`;
const modelShort = (model) => String(model ?? '').replace(/^[a-z0-9-]+\//i, '');
const STATE_LABEL = { working: 'working', ready: 'waiting', needs_input: 'needs input', external: 'other terminal', done: 'done', idle: '' };
const STATE_ORDER = { needs_input: 0, working: 1, ready: 2, external: 3, done: 4, idle: 5 };

// ---------- data ----------
async function refresh() {
  const { sessions, terminals, repos, workspaces } = await (await fetch('/api/overview')).json();
  state.sessions = sessions;
  if (sessions.some((s) => s.state === 'working')) foxMotion.busy = Date.now();
  state.workspaces = workspaces ?? [];
  state.terminals = terminals;
  state.repos = repos ?? {};
  updatePageTitle();
  renderReplyInbox(); // seed seen markers before deciding whether a transition is new
  detectTransitions();
  renderSessions();
  renderSummary();
  syncTabsWithTerminals();
  renderNextDraft();
  if (state.mosaic) renderMosaic();
}

function detectTransitions() {
  const firstPoll = !state.prevStates.size;
  const parentsWithResults = new Set();
  for (const s of state.sessions) {
    if (!s.parentId) continue;
    const marker = s.childCompletion?.marker ?? null;
    const prev = state.prevChildResults.get(s.id);
    if (!firstPoll && marker && marker !== prev && marker !== inboxSeen?.[`child:${s.id}`] && !s.archived && !sessionById(s.parentId)?.archived) {
      parentsWithResults.add(s.parentId);
      notify(`${displayTitle(s)}: ${s.childCompletion.failed ? 'failed' : 'done'}`, s.childCompletion.text);
    }
    state.prevChildResults.set(s.id, marker);
  }
  for (const s of state.sessions) {
    const prev = state.prevStates.get(s.id);
    if (prev && prev !== s.state && (s.state === 'ready' || s.state === 'needs_input') && prev === 'working' && !s.parentId && !parentsWithResults.has(s.id)) {
      notify(`${displayTitle(s)}: ${STATE_LABEL[s.state]}`, s.firstPrompt);
    }
    state.prevStates.set(s.id, s.state);
    if (!s.parentId) state.prevReplyTurns.set(s.id, s.latestReply?.turn ?? 0);
  }
}

// ---------- the fox's gestures ----------
const FOX_YAWN_IDLE = 10 * 60_000, FOX_YAWN_AGAIN = 20 * 60_000;
const foxMotion = { last: {}, activity: Date.now(), busy: 0, yawned: 0, timer: null };
function foxGesture(name) {
  const fox = document.querySelector('.brand .fox');
  if (!fox || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (Date.now() - (foxMotion.last[name] ?? 0) < 4000) return false; // several replies at once: one wink
  foxMotion.last[name] = Date.now();
  clearTimeout(foxMotion.timer);
  fox.classList.remove('wink', 'yawn'); void fox.getBoundingClientRect(); fox.classList.add(name);
  foxMotion.timer = setTimeout(() => fox.classList.remove(name), name === 'yawn' ? 2700 : 800);
  return true;
}
// Quiet means no session working and no input or new reply in fox since `idleSince`.
function foxShouldYawn({ now, idleSince, yawned }) {
  if (now - idleSince < FOX_YAWN_IDLE) return false;
  return !yawned || yawned < idleSince || now - yawned >= FOX_YAWN_AGAIN;
}
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, () => { foxMotion.activity = Date.now(); }, { passive: true, capture: true });
setInterval(() => {
  const now = Date.now();
  if (state.sessions.some((s) => s.state === 'working')) foxMotion.busy = now;
  if (foxShouldYawn({ now, idleSince: Math.max(foxMotion.activity, foxMotion.busy), yawned: foxMotion.yawned }) && foxGesture('yawn')) foxMotion.yawned = now;
}, 30_000);

// ---------- unread replies ----------
let inboxSeen = null;
let winkKeys = null; // unread replies at the last render, to tell a new one
function renderReplyInbox() {
  if (!inboxSeen) {
    // A browser can load new JS while an older server is still running. Wait for its new overview shape.
    if (state.sessions.length && !state.sessions.some((s) => Object.hasOwn(s, 'latestReply'))) return;
    try { inboxSeen = JSON.parse(localStorage.getItem('fox.inbox.seen')); } catch {}
    if (!inboxSeen || typeof inboxSeen !== 'object' || Array.isArray(inboxSeen)) {
      // First visit: don't flood the inbox with all the old conversations.
      inboxSeen = Object.fromEntries(state.sessions.filter((s) => !s.parentId && s.latestReply).map((s) => [s.id, s.latestReply.turn]));
    }
    if (!inboxSeen['@children']) {
      // Migrate existing browsers too: old child results are history, not a burst of new alerts.
      for (const s of state.sessions.filter((s) => s.parentId)) {
        const marker = s.childCompletion?.marker ?? (s.latestReply ? `turn:${s.latestReply.turn}` : null);
        if (marker) inboxSeen[`child:${s.id}`] = marker;
      }
      inboxSeen['@children'] = true;
      saveInboxSeen();
    }
  }
  // A parent reply saved in the same poll as its child's result is the same handoff, not two alerts.
  for (const child of state.sessions.filter((s) => s.parentId && s.childCompletion && !s.archived)) {
    const result = child.childCompletion, parent = sessionById(child.parentId);
    if (!parent?.latestReply || parent.archived || state.prevChildResults.get(child.id) === result.marker
      || result.marker === inboxSeen[`child:${child.id}`] || parent.latestReply.turn <= (state.prevReplyTurns.get(parent.id) ?? parent.latestReply.turn)
      || !result.at || !parent.latestReply.at || parent.latestReply.at < result.at) continue;
    inboxSeen[parent.id] = parent.latestReply.turn;
    saveInboxSeen();
  }
  const unread = state.sessions.filter((s) => !s.archived && (!s.parentId
    ? s.latestReply && s.latestReply.turn > (inboxSeen[s.id] ?? 0)
    : !sessionById(s.parentId)?.archived && s.childCompletion && s.childCompletion.marker !== inboxSeen[`child:${s.id}`]))
    .sort((a, b) => (b.childCompletion?.at ?? b.latestReply?.at ?? b.updatedAt ?? 0) - (a.childCompletion?.at ?? a.latestReply?.at ?? a.updatedAt ?? 0));
  // A reply that was not unread on the last render is new: the fox winks (not on the first render, not for old ones).
  const keys = unread.map((s) => s.parentId ? `${s.id}:${s.childCompletion.marker}` : `${s.id}:${s.latestReply.turn}`);
  if (winkKeys && keys.some((k) => !winkKeys.has(k))) {
    foxMotion.activity = Date.now();
    foxGesture('wink');
  }
  winkKeys = new Set(keys);
  const root = $('#reply-inbox'), list = $('#reply-inbox-list'), toggle = $('#reply-inbox-toggle');
  root.classList.toggle('hidden', !unread.length);
  if (!unread.length) { list.classList.add('hidden'); toggle.setAttribute('aria-expanded', 'false'); return; }
  $('#reply-inbox-count').textContent = unread.length;
  $('#reply-inbox-label').textContent = unread.length === 1 ? 'new reply' : 'new replies';
  list.innerHTML = unread.map((s) => {
    const result = s.parentId ? s.childCompletion : s.latestReply;
    const parent = s.parentId && sessionById(s.parentId);
    return `<button type="button" class="reply-inbox-item${s.parentId ? ' child-result' : ''}" data-reply="${esc(s.id)}">
    <span class="inbox-title">${s.parentId ? '<span class="inbox-child-icon">' + ICON.threads + '</span>' : ''}${esc(displayTitle(s))}${result.failed ? ' <span class="flag err">failed</span>' : ''}<small>${esc(parent ? displayTitle(parent) : shortPath(s.workspace))} · ${esc(fmtTime(result.at))}</small></span>
    <span class="inbox-excerpt">${esc(result.text)}</span>
  </button>`;
  }).join('');
}
function saveInboxSeen() { try { localStorage.setItem('fox.inbox.seen', JSON.stringify(inboxSeen)); } catch {} }
function markReplyRead(id) {
  const s = sessionById(id);
  const key = s?.parentId ? `child:${id}` : id;
  const marker = s?.parentId ? s.childCompletion?.marker : s?.latestReply?.turn;
  if (!marker || !inboxSeen || (s?.parentId ? marker === inboxSeen[key] : marker <= (inboxSeen[key] ?? 0))) return;
  inboxSeen[key] = marker;
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
  const result = s?.parentId ? s.childCompletion : s?.latestReply;
  if (!result) return;
  if (s.parentId) {
    // Children have no terminal: select their saved conversation without waking or attaching to the parent.
    globalMessage = result.messageIndex == null ? null : { id: s.id, index: result.messageIndex };
    convoShown.add(s.id);
    closePages();
    setTranscript(true);
    selectSession(s.id);
    if (mobileLayout.matches) showMobileView('read');
    return;
  }
  // On a phone the answer is read where you reply: straight to the session's terminal.
  if (mobileLayout.matches) return openSession(s.id);
  // On a computer: the answer in the right column, scrolled to, and the session's terminal in the center
  // (woken up if it was asleep), the same as clicking the session. Selecting marks the reply read.
  globalMessage = { id: s.id, index: result.messageIndex };
  convoShown.add(s.id);
  closePages(); // the answer shows in the right column, which an open page hides
  setTranscript(true);
  selectSession(s.id);
  openSession(s.id);
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
  // Only when something is going on: nothing working and nothing waiting needs no line.
  $('#summary').innerHTML = parts.join('');
  $('#summary').classList.toggle('hidden', !parts.length);
}

// ---------- workspaces: folders made of GitHub repos ----------
const workspaceFor = (path) => (state.workspaces ?? []).find((w) => path === w.dir || String(path ?? '').startsWith(w.dir + '/'));
// One repo of a workspace: its folder, branch and what needs attention (uncommitted, behind, ahead, clone state).
function wsRepoLine(r, wsId = null) {
  const stateHtml = r.status === 'cloning' ? '<span class="ws-state">cloning…</span>'
    : r.status === 'missing' ? '<span class="ws-state">waiting to clone</span>'
    : r.status === 'error' ? `<span class="ws-state err" title="${esc(r.error ?? '')}">${r.error === 'Checkout origin does not match this repo.' ? 'origin mismatch' : 'clone failed'}</span>`
    : `<span class="ws-state ${r.changed ? 'warn' : ''}">${[r.changed ? `±${r.changed}` : '', r.behind ? `↓${r.behind}` : '', r.ahead ? `↑${r.ahead}` : ''].filter(Boolean).join(' ')}</span>`;
  // The branch is the workspace copy's, shared by its sessions: a button to change it (branches.mjs) when fox knows the workspace.
  const off = r.branch && r.default && r.branch !== r.default;
  const branch = !r.branch ? '' : wsId && r.status === 'ready'
    ? `<button type="button" class="ws-branch${off ? ' off' : ''}" data-branch-ws="${esc(wsId)}" data-branch-dir="${esc(r.dir)}" title="${esc(r.branch)}: change the branch of this workspace's ${esc(r.dir)} (all its sessions use it)">${esc(r.branch)}</button>`
    : `<span class="ws-branch">${esc(r.branch)}</span>`;
  return `<div class="ws-line" title="${esc(r.owner)}/${esc(r.name)}"><span>${esc(r.dir)}</span>${branch}${stateHtml}</div>`;
}

// In the sidebar only the repos that need you show up (uncommitted, behind or ahead, cloning, failed, off their
// default branch); the repos chip under the workspace's name shows them all, to change a branch there too.
const wsShowAll = new Set(); // workspaces whose repo lines are all shown, this page only
function wsRepoSummary(wsp) {
  const open = wsShowAll.has(wsp.id);
  const shown = wsp.repos.filter((r) => open || r.status !== 'ready' || r.changed || r.behind || r.ahead || (r.branch && r.default && r.branch !== r.default));
  return shown.length ? `<div class="ws-repos-line">${shown.map((r) => wsRepoLine(r, wsp.id)).join('')}</div>` : '';
}


// Jobs use their named workspace when scripts live elsewhere (e.g. a jobs repo); otherwise their folder's.
// Pull requests belong to the workspace containing their repo.
const workspaceNamed = (name) => (state.workspaces ?? []).find((w) => w.name === name);
const jobWorkspace = (j) => j.workspace ? workspaceNamed(j.workspace) : workspaceFor(j.cwd);
const prWorkspace = (p) => (state.workspaces ?? []).find((w) => w.repos.some((r) => `${r.owner}/${r.name}`.toLowerCase() === String(p.repo).toLowerCase()));
// Jobs or Pull requests narrowed to one workspace (its name), from the counts under it in the sidebar.
const wsFilter = () => workspaceNamed(state.wsFilter);
// Pull request and job marks for the chips below (outline, like the mockup they come from).
const PR_MARK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M11 6h5a2 2 0 0 1 2 2v8"/><path d="M14 9l-3-3 3-3"/></svg>';
const CLOCK_MARK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
// Under a workspace's name: one quiet line with its repos, jobs and open PRs (a mark and a number each), then, only
// when something needs you, the notices: PRs to merge or to look at, jobs that failed or wait for your OK.
// The repos chip shows every repo and its branch; the others open Jobs or Pull requests narrowed to this workspace.
function wsSummaryLine(wsp) {
  const jobs = (state.jobs ?? []).filter((j) => jobWorkspace(j) === wsp).length, prs = (state.prs?.prs ?? []).filter((p) => prWorkspace(p) === wsp).length;
  const n = wsp.repos.length, open = wsShowAll.has(wsp.id), s = (k) => k === 1 ? '' : 's';
  const html = (n ? `<button type="button" class="ws-chip${open ? ' on' : ''}" data-ws-all="${esc(wsp.id)}" title="${open ? 'Hide' : 'Show'} its ${n} repo${s(n)} and their branches">${GITHUB_MARK}${n}</button>` : '')
    + (jobs ? `<button type="button" class="ws-chip" data-ws-jobs="${esc(wsp.name)}" title="${jobs} job${s(jobs)}">${CLOCK_MARK}${jobs}</button>` : '')
    + (prs ? `<button type="button" class="ws-chip" data-ws-prs="${esc(wsp.name)}" title="${prs} open pull request${s(prs)}">${PR_MARK}${prs}</button>` : '');
  return html ? `<div class="ws-work">${html}</div>` : '';
}
function wsWorkLine(wsp) {
  const jobs = (state.jobs ?? []).filter((j) => jobWorkspace(j) === wsp), prs = (state.prs?.prs ?? []).filter((p) => prWorkspace(p) === wsp);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const chip = (n, text, kind, attr, title) => n ? `<button type="button" class="ws-chip ${kind}" ${attr}="${esc(wsp.name)}" title="${title}">${attr === 'data-ws-prs' ? PR_MARK : CLOCK_MARK}${text}</button>` : '';
  const ready = prs.filter((p) => p.ready).length;
  const needYou = prs.filter((p) => !p.ready && (p.checks === 'failing' || p.review?.verdict === 'needs-you')).length;
  const failed = jobs.filter((j) => BAD.includes(jobState(j))).length;
  const approve = jobs.filter((j) => j.pendingApproval).length;
  const html = chip(ready, `${ready} ready to merge`, 'ok', 'data-ws-prs', `${plural(ready, 'pull request', 'pull requests')}: checks pass and the review is good`)
    + chip(needYou, `${needYou} need${needYou === 1 ? 's' : ''} you`, 'warn', 'data-ws-prs', `${plural(needYou, 'pull request', 'pull requests')}: failing checks, or the review asks for you`)
    + chip(failed, plural(failed, 'job failed', 'jobs failed'), 'warn', 'data-ws-jobs', 'Its last run did not go well')
    + chip(approve, plural(approve, 'job to approve', 'jobs to approve'), 'warn', 'data-ws-jobs', 'Added from a terminal; it waits for your OK before it runs');
  return html ? `<div class="ws-work">${html}</div>` : '';
}

function renderSessions() {
  if (state.renaming) return; // replacing the sidebar would blur the input and save prematurely
  const active = state.sessions.filter((s) => !s.archived && !s.parentId);
  const archived = state.sessions.filter((s) => s.archived && !s.parentId);
  const groups = new Map();
  // Sessions inside a workspace folder group under the workspace; workspaces show even before their first session.
  for (const w of state.workspaces ?? []) groups.set(w.dir, []);
  for (const s of active) {
    const key = workspaceFor(s.workspace)?.dir ?? s.workspace;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const root = $('#session-groups');
  root.innerHTML = '';
  // Stable order: manual order (drag the project header) first, then alphabetical. Never by activity,
  // so nothing jumps around when you pick a session; the state dots say what is busy.
  const rank = (ws) => { const i = groupOrder.indexOf(ws); return i < 0 ? Infinity : i; };
  const ordered = [...groups.entries()].sort((a, b) => (rank(a[0]) - rank(b[0])) || a[0].localeCompare(b[0]));
  // Every group reads the same: its folder's name with a capital letter (the folder itself keeps its own).
  const groupName = (n) => n ? n[0].toLocaleUpperCase() + n.slice(1) : n;
  for (const [ws, list] of ordered) {
    list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)); // newest first, and it stays put
    const g = document.createElement('div');
    const isCollapsed = collapsed.has(ws);
    g.className = 'group' + (isCollapsed ? ' collapsed' : '');
    g.dataset.ws = ws;
    const wsp = (state.workspaces ?? []).find((w) => w.dir === ws);
    if (wsp) {
      g.classList.add('workspace');
      g.innerHTML = `<h3 draggable="true" title="Drag to reorder"><span class="caret" data-toggle-group="${esc(ws)}">${isCollapsed ? '▸' : '▾'}</span><span class="gname" data-toggle-group="${esc(ws)}" title="${esc(shortPath(ws))}">${esc(groupName(wsp.name))}</span><span class="gcount" title="${list.length} session${list.length === 1 ? '' : 's'}">${list.length}</span><button class="icon" data-edit-ws="${esc(wsp.id)}" title="Edit workspace">${ICON.rename}</button><button class="icon" data-new="${esc(ws)}" title="New session in this workspace">+</button></h3>${isCollapsed ? '' : wsSummaryLine(wsp) + wsWorkLine(wsp) + wsRepoSummary(wsp)}`;
      if (!isCollapsed) list.forEach((s, i) => g.appendChild(sessionCard(s, i + 1)));
      root.appendChild(g);
      continue;
    }
    g.classList.add('folder'); // a folder that is not a workspace: same look, named by its folder (full path on hover)
    const repo = state.repos?.[ws];
    // GitHub remote: owner/repo as a link. Plain git: just the branch (and the repo root if the workspace is a subfolder).
    const gitLine = repo ? `<div class="git" title="${esc(repo.remote || 'git repo without a remote: add one (git remote add origin …) and this becomes a link')}">${repo.url ? `<a href="${esc(repo.url)}" target="_blank" rel="noopener" title="Open ${esc(repo.repo)} on GitHub">${ICON.github}${esc(repo.repo)}</a>` : `<span>${ICON.git}${repo.root !== ws ? esc(shortPath(repo.root)) : 'no remote'}</span>`}${repo.branch ? `<span class="branch">${esc(repo.branch)}</span>` : ''}${repo.changed ? `<span class="changed" title="${repo.changed} changed file${repo.changed === 1 ? '' : 's'}">±${repo.changed}</span>` : ''}</div>` : '';
    g.innerHTML = `<h3 draggable="true" title="Drag to reorder projects"><span class="caret" data-toggle-group="${esc(ws)}">${isCollapsed ? '▸' : '▾'}</span><span class="gname" data-toggle-group="${esc(ws)}" title="${esc(shortPath(ws))}">${esc(groupName(ws.split('/').filter(Boolean).pop() ?? ws))}</span><span class="gcount">${list.length}</span><button class="icon" data-new="${esc(ws)}" title="New session in this folder">+</button></h3>${isCollapsed ? '' : gitLine}`;
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
  const asleep = foxConfig.remote && s.state === 'idle' && !s.archived;
  const stateHtml = asleep ? '<span class="st asleep" title="Asleep: its tools are off to save memory. Opening it wakes it up in a few seconds." aria-label="asleep"><i></i></span>' : s.state !== 'idle' ? `<span class="st ${s.state}" title="${s.state === 'external' ? `open in another terminal; ${esc(agentName(s))} allows one process per session` : STATE_LABEL[s.state]}"><i></i>${quiet ? '' : STATE_LABEL[s.state]}</span>` : '';
  el.innerHTML = `
    ${index ? `<span class="idx">${index}</span>` : ''}
    <div class="row">
      <div class="title" title="${esc(s.title)}${s.firstPrompt ? '\n' + esc(s.firstPrompt) : ''}">${esc(displayTitle(s))}</div>
      <div class="actions">
        ${s.terminal ? `<button class="icon ${state.pinned.has(s.terminal) ? 'on' : ''}" data-pin="${esc(s.terminal)}" title="${state.pinned.has(s.terminal) ? 'Unpin tab' : 'Pin as tab'}">${ICON.pin}</button>` : ''}
        <button class="icon" data-rename="${esc(s.id)}" title="Rename">${ICON.rename}</button>
        <button class="icon" data-${s.archived ? 'unarchive' : 'archive'}="${esc(s.id)}" title="${s.archived ? 'Restore' : (s.terminal ? `Archive (stops ${esc(agentName(s))})` : 'Archive')}">${s.archived ? ICON.restore : ICON.archive}</button>
      </div>
    </div>
    <div class="sub">
      ${stateHtml}
      <span class="model mono" title="${esc(s.model ?? '')} via ${esc(providerLabel(s.provider))}">${esc(modelShort(s.model))}${providerTag(s.provider)}</span>
      <span>${fmtTime(s.updatedAt)}</span>
      ${s.resumedAfterRestart && Date.now() - s.resumedAfterRestart < 6 * 3600_000 ? `<span class="restarted" title="The server went down mid-turn; fox resumed this session ${esc(fmtTime(s.resumedAfterRestart))} and told it to continue">resumed after restart</span>` : ''}
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
  return `<div class="children-count" data-child="${esc(kids[0].id)}" title="open the subagent board">${ICON.threads} ${parts.join(' · ')}</div>`;
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
  if (d.editWs) return openWorkspaceDialog(d.editWs);
  if (d.branchWs) return openBranchMenu(btn, d.branchWs, d.branchDir);
  if (d.wsJobs) { state.wsFilter = d.wsJobs; return openJobs(); }
  if (d.wsPrs) { state.wsFilter = d.wsPrs; prFilter = 'open'; return openPrs(); }
  if (d.wsAll) { wsShowAll.has(d.wsAll) ? wsShowAll.delete(d.wsAll) : wsShowAll.add(d.wsAll); return renderSessions(); }
  if (d.pin) return setPinned(d.pin, !state.pinned.has(d.pin));
  if (d.rename) return renameInline(d.rename);
  if (d.archive) {
    const s = sessionById(d.archive);
    if (s?.terminal) {
      // An idle fx loses nothing when stopped (the session is on disk); only ask when it is mid-task.
      const busy = s.state === 'working' || s.state === 'needs_input';
      if (busy && !confirm(s.state === 'working' ? `${agentName(s)} is working in this session. Stop it and archive?` : `${agentName(s)} is waiting for your answer in this session. Stop it and archive?`)) return;
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

// Pages in the center (class page-view in index.html), each with how to close it. Going to a session, or opening
// another page, closes them all through closePages: listing pages by hand in each place is how one got left open
// (tests/pages.test.mjs checks every page-view has an entry here).
const PAGE_CLOSERS = {
  'settings-view': (o) => closeSettings(o),
  'job-view': (o) => { if (state.jobView) closeJob(o); },
  'pr-view': (o) => { if (state.prView) closePrs(o); },
  'skill-view': (o) => closeSkills(o),
  'app-view': (o) => closeApps(o),
};
function closePages({ except = null, sync = false } = {}) {
  for (const [id, close] of Object.entries(PAGE_CLOSERS)) if (id !== except) close({ sync });
}

// Click on a session: focus its tab if open, attach to its tmux terminal if running, otherwise start one.
async function openSession(id) {
  closePages();
  if (state.waking?.id !== id) state.waking = null; // the person moved on: the other session keeps waking, unseen
  const s = sessionById(id);
  if (!s) return;
  if (s.terminal && state.tabs.has(s.terminal) && !state.tabs.get(s.terminal).closed) { activateTab(s.terminal); return selectSession(id); }
  if (s.terminal) { const t = state.terminals.find((x) => x.name === s.terminal); if (t) { attachTab(t, { user: true }); return selectSession(id); } }
  if (s.archived || s.state === 'external') { selectSession(id); if (mobileLayout.matches) showMobileView('read'); return; }
  // No terminal: fx is not running for this session (it slept, or never ran here). Resuming takes a few seconds.
  const wake = state.waking = { id, title: displayTitle(s), since: Date.now() };
  // Show the choice at once: the session is selected and the center says it is waking, before fx is up. Keys stop
  // going to the terminal that was in front, so nothing typed meanwhile lands in another session.
  selectSession(id);
  document.activeElement?.blur?.();
  updateTermLoading();
  // Only the session still wanted takes the center when it is up; one the person left keeps running in tmux.
  try { await openTerminal({ cwd: s.workspace, resume: id }, () => state.waking === wake); }
  finally { if (state.waking === wake && !state.tabs.get(state.activeTab)) state.waking = null; updateTermLoading(); }
}

function termHasText(term) {
  const buf = term?.buffer.active;
  if (!buf) return false;
  for (let y = 0; y < buf.length; y++) if (buf.getLine(y)?.translateToString(true).trim()) return true;
  return false;
}
// The center while a terminal comes up. Waking a session shows at once and explains the wait; a plain
// (re)connection only shows if it takes more than a moment.
function updateTermLoading() {
  const box = $('#term-loading');
  const tab = state.tabs.get(state.activeTab);
  // Waking ends when fx has drawn something: tmux attaches at once and shows an empty pane until fx starts.
  if (state.waking && tab?.ready && termHasText(tab.term) && state.terminals.find((t) => t.name === tab.name)?.resume === state.waking.id) state.waking = null;
  // Waking covers the center as soon as it starts: it is what the person just chose. Choosing anything else (another
  // session or tab) cancels it in openSession and activateTab, so it never covers a terminal picked after it.
  const waking = state.waking;
  const connecting = !waking && tab && !tab.ready && !tab.closed && Date.now() - (tab.openedAt ?? 0) > 500;
  box.classList.toggle('hidden', !waking && !connecting);
  // The terminal behind steps out while a session wakes: with the sky theme the notice's background is see-through.
  $('#terminals').classList.toggle('waking', Boolean(waking));
  if (!waking && !connecting) return;
  const secs = (Date.now() - (waking?.since ?? tab.openedAt)) / 1000;
  $('#term-loading-title').textContent = waking ? `Waking up ${waking.title}` : (tab.attempts ? 'Reconnecting…' : 'Connecting…');
  $('#term-loading-hint').textContent = waking
    ? (secs < 20 ? `This session was asleep to save memory. ${agentName(sessionById(waking.id))} is resuming the conversation; it takes a few seconds.`
      : secs < 60 ? `Taking longer than usual: ${agentName(sessionById(waking.id))} is starting its tools.`
      : 'Still waking up. If nothing happens, open the session again.')
    : (tab.attempts ? `The connection dropped; trying again (${tab.attempts}).` : '');
}
setInterval(updateTermLoading, 500);

// With no terminal open and no session chosen, the right column (a session's files and subagents) has nothing to show:
// it steps aside like on the Jobs page, without touching the saved choice.
function syncNothingOpen() { document.body.classList.toggle('nothing-open', !state.tabs.size && !state.selected); }
function selectSession(id) {
  state.selected = id;
  renderNextDraft();
  syncNothingOpen();
  updatePageTitle();
  markReplyRead(id);
  renderSessions();
  loadTranscript(id);
  syncUrl();
}

async function renameInline(id) {
  const s = sessionById(id);
  const titleEl = document.querySelector(`.session[data-id="${CSS.escape(id)}"] .title`);
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

$('#keys').addEventListener('click', () => showShortcuts());
// ---------- terminals (tmux attach over WebSocket) ----------
const dictationButton = $('#dictation');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const pill = $('#dictation-pill');
let pillTimer = null;
// Voice level for the mic orb: a second, silent look at the mic (Chrome shares the permission with speech
// recognition). Sets --lvl (0..1) on the button; its rings grow with your voice.
// One request at a time: the status updates many times while you speak, and every mic stream opened has to be
// stopped, or the phone keeps showing the mic as in use. `gen` changes on every stop, so a request that
// resolves after it is closed at once.
const meter = { stream: null, ctx: null, raf: 0, starting: false, gen: 0 };
async function startMeter() {
  if (meter.stream || meter.starting || !navigator.mediaDevices?.getUserMedia) return;
  meter.starting = true;
  const gen = meter.gen;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    meter.starting = false;
    if (gen !== meter.gen || !dictation.active) { stream.getTracks().forEach((t) => t.stop()); if (dictation.active) startMeter(); return; }
    meter.stream = stream;
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
  } catch { meter.starting = false; stopMeter(); } // no meter is fine: the orb keeps breathing on its own
}
function stopMeter() {
  meter.gen++;
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
  dictationButton.disabled = state.mosaic || !SpeechRecognition || !tab || tab.closed || tab.ws?.readyState !== WebSocket.OPEN;
  if (!SpeechRecognition) dictationButton.title = 'Dictation needs Chrome';
  else if (!tab) dictationButton.title = 'Open a terminal to dictate';
}
dictationButton.addEventListener('click', () => {
  if (dictation.active) dictation.stop();
  else if (!dictationButton.disabled) dictation.start(state.activeTab);
});
updateDictationAvailability();
// Local-only drafts belong to parent session IDs, never to whichever terminal happens to be in front.
const DRAFT_LIMIT = 4000;
const draftKey = (id) => `fox.nextDraft.${id}`;
const draftBox = $('#next-draft'), draftText = $('#next-draft-text');
let draftSession = null, draftSaved = false;
function readNextDraft(id) {
  try { return (localStorage.getItem(draftKey(id)) ?? '').slice(0, DRAFT_LIMIT); } catch { return ''; }
}
function nextDraftTarget() {
  const s = sessionById(state.selected);
  if (!s || s.parentId || s.archived || s.state === 'external') return null;
  const terminal = state.terminals.find((t) => t.resume === s.id && t.name === s.terminal);
  const tab = terminal && state.tabs.get(terminal.name);
  return (s.state === 'ready' || s.state === 'needs_input') && state.activeTab === terminal?.name
    && !state.waking && tab?.ready && !tab.closed && tab.ws?.readyState === WebSocket.OPEN ? tab : null;
}
function renderNextDraft() {
  const s = sessionById(state.selected);
  const id = s && !s.parentId && !s.archived ? s.id : null;
  draftBox.classList.toggle('hidden', !id);
  if (id !== draftSession) {
    draftSession = id;
    draftText.value = id ? readNextDraft(id) : '';
    draftSaved = Boolean(draftText.value);
    draftBox.open = draftSaved;
    $('#next-draft-hint').textContent = 'Stored in this browser · Enter sends after insertion';
  }
  $('#next-draft-mark').textContent = draftSaved && draftText.value ? '· saved' : '';
  $('#next-draft-insert').disabled = !id || !draftText.value.trim() || !nextDraftTarget();
}
draftText.addEventListener('input', () => {
  const id = draftSession;
  if (!id) return;
  draftText.value = draftText.value.slice(0, DRAFT_LIMIT);
  try {
    if (draftText.value) localStorage.setItem(draftKey(id), draftText.value);
    else localStorage.removeItem(draftKey(id));
    draftSaved = Boolean(draftText.value);
    $('#next-draft-hint').textContent = 'Stored in this browser · Enter sends after insertion';
  } catch { draftSaved = false; $('#next-draft-hint').textContent = 'Could not save in this browser'; }
  renderNextDraft();
});
$('#next-draft-insert').addEventListener('click', () => {
  const id = draftSession, s = sessionById(id), tab = nextDraftTarget();
  if (!s || state.selected !== id || !tab || tab.name !== s.terminal) { renderNextDraft(); return; }
  // Terminal controls (including Enter) cannot be smuggled in via a stored or pasted draft.
  const text = draftText.value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, DRAFT_LIMIT);
  if (!text.trim()) return;
  tab.draftSent = false;
  tab.pastingDraft = true;
  let failed = false;
  try { tab.term.paste(text); }
  catch { failed = true; }
  finally { tab.pastingDraft = false; }
  if (failed || !tab.draftSent) { $('#next-draft-hint').textContent = 'Terminal not ready · draft kept'; renderNextDraft(); return; }
  // Only clear after the terminal's input handler accepted the paste onto its open socket.
  try { localStorage.removeItem(draftKey(id)); }
  catch { $('#next-draft-hint').textContent = 'Inserted · could not clear saved draft'; return; }
  draftText.value = '';
  draftSaved = false;
  $('#next-draft-hint').textContent = 'Inserted · press Enter in the terminal to send';
  renderNextDraft();
  tab.term.focus();
});
// Paste on a phone (see #pastesheet). The text goes in as a paste, like ⌘V: it waits in fx's input, nothing is sent.
function pasteIntoTerminal(text, target = state.activeTab) {
  const tab = state.tabs.get(target);
  if (!text || state.activeTab !== target || !tab || tab.closed || tab.ws?.readyState !== WebSocket.OPEN) { toast('Open a terminal to paste into'); return false; }
  tab.term.paste(text);
  return true;
}
let agentDraft = null;
let skillRequest = 0, shelfSkills = [], skillShelfCwd = null;
function skillCwd() {
  const terminal = state.terminals.find((t) => t.name === state.activeTab);
  if (terminal?.harness === 'fx') return terminal.cwd;
  if (terminal) return null;
  const selected = sessionById(state.selected);
  return selected && selected.harness === 'fx' ? selected.workspace : null;
}
function renderSkillShelf() {
  const q = $('#skill-search').value.trim().toLowerCase();
  const box = $('#skill-list'); box.replaceChildren();
  const matches = shelfSkills.filter((s) => `${s.name} ${s.description} ${s.source}`.toLowerCase().includes(q));
  if (!matches.length) { box.textContent = shelfSkills.length ? 'No matching skills' : 'No skills in this folder'; return; }
  for (const skill of matches) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'skill-row';
    const name = document.createElement('strong'); name.textContent = skill.name;
    const source = document.createElement('small'); source.textContent = skill.source;
    const description = document.createElement('span'); description.textContent = skill.description;
    row.append(name, source, description);
    row.addEventListener('click', () => {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(skill.name)) return;
      const draft = `Use the ${skill.name} skill to `;
      const active = state.terminals.find((t) => t.name === state.activeTab && t.harness === 'fx' && t.cwd === skillShelfCwd);
      if (active && pasteIntoTerminal(draft, active.name)) { closePasteSheet(); state.tabs.get(active.name)?.term.focus(); }
      else { $('#paste-hint').classList.remove('hidden'); $('#paste-hint').textContent = 'Open an fx terminal in this folder to insert the draft.'; }
    });
    box.appendChild(row);
  }
}
async function openSkillShelf() {
  const cwd = skillCwd();
  if (!cwd) { toast('Select an fx session to browse skills'); return; }
  agentDraft = null; skillShelfCwd = cwd;
  $('#paste-text').value = '';
  $('#paste-title').textContent = 'Skills'; $('#paste-hint').classList.remove('hidden');
  $('#paste-hint').textContent = `${shortPath(cwd)} · choose a skill to insert a draft (Enter sends)`;
  $('#paste-text').classList.add('hidden'); $('#pasteform button[type="submit"]').classList.add('hidden');
  $('#skill-shelf').classList.remove('hidden'); $('#skill-search').value = ''; shelfSkills = [];
  $('#skill-list').textContent = 'Loading skills…'; $('#pastesheet').classList.remove('hidden'); $('#skill-search').focus();
  const request = ++skillRequest;
  try {
    const response = await fetch(`/api/skill-shelf?cwd=${encodeURIComponent(cwd)}`);
    if (!response.ok) throw new Error('Could not load skills');
    const skills = await response.json();
    if (request !== skillRequest) return;
    shelfSkills = Array.isArray(skills) ? skills : [];
    renderSkillShelf();
  } catch { if (request === skillRequest) $('#skill-list').textContent = 'Could not load skills'; }
}
$('#skills').addEventListener('click', openSkillShelf);
$('#skill-search').addEventListener('input', renderSkillShelf);
function closePasteSheet() {
  ++skillRequest; skillShelfCwd = null;
  $('#pastesheet').classList.add('hidden'); $('#paste-text').value = ''; agentDraft = null;
  $('#skill-shelf').classList.add('hidden'); $('#paste-text').classList.remove('hidden');
  $('#pasteform button[type="submit"]').classList.remove('hidden');
  $('#paste-title').textContent = 'Paste'; $('#paste-hint').classList.add('hidden');
  $('#pasteform button[type="submit"]').textContent = 'Insert';
}
// A named agent belongs to one parent, even when another session has the same name.
function agentDraftParent(draft) {
  if (!draft?.name) return null;
  const parent = sessionById(draft.parentId);
  return parent && !parent.parentId && !parent.archived && parent.state !== 'external'
    && parent.children?.some((c) => c.id === draft.childId && c.name === draft.name) ? parent : null;
}
function agentParentTerminal(parent) {
  return state.terminals.find((t) => t.resume === parent.id && (!parent.terminal || t.name === parent.terminal));
}
function describeAgentDraft(parent) {
  const busy = parent.state === 'working';
  $('#paste-title').textContent = busy ? 'Steer' : 'Follow up';
  $('#paste-hint').classList.remove('hidden');
  $('#paste-hint').textContent = `To ${displayTitle(parent)} · ${agentDraft.name}. ${busy ? 'fx applies feedback after the current tool. ' : ''}Insert a single-line draft, then press Enter in the parent terminal to send.`;
  describeAgentDraftButton(parent);
}
function openAgentDraft(button) {
  const draft = { parentId: button.dataset.agentParent, childId: button.dataset.agentFollowup, name: button.dataset.agentName };
  const parent = agentDraftParent(draft);
  if (!parent) { toast('The named agent’s parent is unavailable'); return; }
  const row = button.closest('[data-agent]');
  const selection = getSelection();
  const anchor = selection.anchorNode;
  const answer = (anchor?.nodeType === 1 ? anchor : anchor?.parentElement)?.closest('.agent-answer');
  const excerpt = selection.rangeCount === 1 && row?.contains(answer) && answer?.contains(selection.focusNode) ? selection.toString().trim() : '';
  closePasteSheet(); agentDraft = draft;
  const name = /^[\w-]+$/.test(draft.name) ? draft.name : JSON.stringify(draft.name);
  $('#paste-text').value = `Tell ${name}: ${excerpt ? `Regarding “${excerpt}”, ` : ''}`;
  describeAgentDraft(parent);
  $('#pastesheet').classList.remove('hidden'); $('#paste-text').focus();
  $('#paste-text').setSelectionRange($('#paste-text').value.length, $('#paste-text').value.length);
}
async function insertAgentDraft() {
  const draft = agentDraft;
  const submit = $('#pasteform button[type="submit"]');
  const resume = submit.textContent === 'Resume parent';
  submit.disabled = true;
  try {
    await refresh(); // Resolve again: polling, another tab, or sleep may have changed the target.
    if (agentDraft !== draft) return;
    const parent = agentDraftParent(draft);
    if (!parent) { $('#paste-hint').textContent = 'The named agent’s parent is unavailable. Your draft is kept here.'; return; }
    describeAgentDraft(parent);
    const terminal = agentParentTerminal(parent);
    if (!terminal && !resume) { $('#paste-hint').textContent = 'Parent is asleep. Resume it to insert your draft.'; return; }
    await openSession(parent.id); // Only the parent may be focused or explicitly resumed.
    if (agentDraft !== draft) return;
    const current = agentDraftParent(draft);
    if (!current || !terminal || agentParentTerminal(current)?.name !== terminal.name) {
      $('#paste-hint').textContent = current ? 'Parent is resuming. Your draft is kept; insert when its terminal is ready.' : 'The parent disappeared. Your draft is kept here.';
      if (current) describeAgentDraftButton(current);
      return;
    }
    // Never send Enter, escape sequences, or other terminal control bytes from an excerpt or draft.
    const text = $('#paste-text').value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    if (state.waking?.id === current.id || !pasteIntoTerminal(text, terminal.name)) {
      $('#paste-hint').textContent = 'Parent terminal is not ready. Your draft is kept; try Insert again.'; return;
    }
    closePasteSheet(); state.tabs.get(terminal.name)?.term.focus();
  } catch {
    if (agentDraft === draft) $('#paste-hint').textContent = 'Could not open the parent terminal. Your draft is kept; try again.';
  } finally { submit.disabled = false; }
}
function describeAgentDraftButton(parent) {
  $('#pasteform button[type="submit"]').textContent = agentParentTerminal(parent) ? 'Insert into parent' : 'Resume parent';
}
$('#paste').addEventListener('click', async () => {
  if (agentDraft) { $('#pastesheet').classList.remove('hidden'); $('#paste-text').focus(); return; }
  closePasteSheet();
  try { const text = await navigator.clipboard?.readText?.(); if (text) return pasteIntoTerminal(text); } catch {} // iOS asks with its own Paste bubble
  $('#pastesheet').classList.remove('hidden');
  $('#paste-text').focus();
});
$('#pasteform').addEventListener('submit', (e) => { e.preventDefault(); if (!$('#skill-shelf').classList.contains('hidden')) return; if (agentDraft) { if (!$('#pasteform button[type="submit"]').disabled) void insertAgentDraft(); } else if (pasteIntoTerminal($('#paste-text').value)) closePasteSheet(); });
$('#paste-cancel').addEventListener('click', closePasteSheet);
$('#pastesheet').addEventListener('click', (e) => { if (e.target.id === 'pastesheet') closePasteSheet(); });
async function openTerminal({ cwd, resume, harness, provider, model, effort, speed, addDirs }, stillWanted = () => true) {
  const t = await post('/api/terminals', { cwd, resume, provider, model, effort, speed, ...(resume ? {} : { addDirs, harness }) });
  if (!stillWanted()) return refresh();
  if (t.error) { state.waking = null; updateTermLoading(); alert(t.error); return; }
  await refresh();
  if (!stillWanted()) return;
  if (!resume) {
    closePages();
  }
  attachTab(t);
  if (t.resume) selectSession(t.resume);
}

function terminalFontFamily() {
  return mobileLayout.matches ? '"Source Code Pro", ui-monospace, "SF Mono", Menlo, monospace' : 'ui-monospace, "SF Mono", Menlo, monospace';
}

// Links to a dev server fx started (http://localhost:5173/...). Locally they open as they are; on a server they
// open through its preview hostname (fox-5173.example.com, set with FOX_PREVIEW_URL), and only for the
// ports that have one. Anything else stays plain text.
let foxConfig = { preview: null, remote: false };
fetch('/api/config').then((r) => r.ok ? r.json() : null).then((c) => { if (c) { foxConfig = c; showVersion(c); } }).catch(() => {});
// "release 29772b0 · 17 Oct 14:02": the commit running now and when it was made; the full story on hover.
function showVersion({ version: v, startedAt }) {
  if (!v?.commit) return;
  const fmt = (ms) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  // Settings → Running in full; the sidebar's footer says it short (branch and commit), the rest on hover.
  const title = `${v.subject ?? ''}\ncommitted ${fmt(Date.parse(v.date))}${v.deployedAt ? `\ndeployed ${fmt(Date.parse(v.deployedAt))}` : ''}\nrunning since ${fmt(startedAt)}`;
  for (const [el, text] of [[$('#settings-version'), `${v.branch ?? 'fox'} ${v.commit.slice(0, 7)} · ${fmt(Date.parse(v.date))}`], [$('#footer-version'), `${v.branch ?? 'fox'} ${v.commit.slice(0, 7)}`]]) {
    el.textContent = text;
    el.title = title;
    if (v.repo) el.href = `https://github.com/${v.repo}/commit/${v.commit}`; else el.removeAttribute('href');
  }
}
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))?(\/[^\s'"<>)\]]*)?/g;
// Links to other sites. Opened from the iPhone Home Screen icon, a new tab would be iOS's in-app browser, which
// keeps no login, so every site asks again; x-safari-https:// (iOS 17+) hands the address to Safari instead.
const IOS_HOME_APP = navigator.standalone === true;
function openExternal(url) {
  if (IOS_HOME_APP) location.href = 'x-safari-' + url;
  else window.open(url, '_blank', 'noopener');
}
document.addEventListener('click', (e) => {
  if (!IOS_HOME_APP || e.defaultPrevented) return;
  const a = e.target.closest?.('a[href]');
  if (!a || !/^https?:/i.test(a.href) || new URL(a.href).origin === location.origin) return; // fox's own files stay in fox
  e.preventDefault();
  openExternal(a.href);
}, true);
const WEB_URL = /\bhttps?:\/\/[^\s'"<>)\]]+/g;
function previewUrl(raw, port, path) {
  if (!foxConfig.remote) return raw.replace('0.0.0.0', 'localhost');
  const p = foxConfig.preview;
  if (!p || !port || !p.ports.includes(Number(port))) return null;
  return p.url.replace('{port}', port) + (path || '/');
}
function localServerLinks(term) {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true), links = [];
      // Any other web address printed as text opens as is.
      for (const m of text.matchAll(WEB_URL)) {
        if (LOCAL_URL.test(m[0])) { LOCAL_URL.lastIndex = 0; continue; }
        const url = m[0].replace(/[.,;:!?]+$/, '');
        links.push({ text: url, range: { start: { x: m.index + 1, y }, end: { x: m.index + url.length, y } },
          decorations: { underline: true, pointerCursor: true }, activate: () => openExternal(url) });
      }
      for (const m of text.matchAll(LOCAL_URL)) {
        const url = previewUrl(m[0], m[1], m[2]);
        if (!url) continue;
        links.push({ text: m[0], range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
          decorations: { underline: true, pointerCursor: true }, activate: () => openExternal(url) });
      }
      callback(links.length ? links : undefined);
    },
  };
}

// Mac editing keys for fx's input line. The browser keeps Cmd and Option to itself, so they reach the terminal
// as the control keys fx understands (checked against fx: Ctrl-U kills to the start of the line, Ctrl-W the
// previous word, Ctrl-A/E go home/end, Alt-B/F move by word). Cmd+C/V/A and the rest stay with the browser.
const MAC_KEYS = { 'meta+Backspace': '\x15', 'alt+Backspace': '\x17', 'meta+ArrowLeft': '\x01', 'meta+ArrowRight': '\x05', 'alt+ArrowLeft': '\x1bb', 'alt+ArrowRight': '\x1bf' };
function macEditingKeys(term, name) {
  term.attachCustomKeyEventHandler((e) => {
    const mod = e.metaKey && !e.altKey && !e.ctrlKey ? 'meta' : e.altKey && !e.metaKey && !e.ctrlKey ? 'alt' : null;
    const seq = mod && MAC_KEYS[`${mod}+${e.key}`];
    if (!seq) return true;
    if (e.type === 'keydown') {
      const ws = state.tabs.get(name)?.ws;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: seq }));
    }
    e.preventDefault();
    return false;
  });
}
// Copy. Dragging selects in tmux (it owns the mouse) and, on release, tmux sends the text to the terminal with
// OSC 52, the standard "set the clipboard" sequence that xterm.js ignores by itself. fox puts it on your
// clipboard. Only writes are accepted: a request to read the clipboard ('?') is ignored.
function clipboardFromTmux(term) {
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!b64 || b64 === '?') return true;
    let text = '';
    try { text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return true; }
    if (text) navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Select with Option+drag and press Cmd+C to copy'));
    return true;
  });
}
function toast(text) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 1600);
}

// Touch scrolling. Phones send no wheel events, so a finger drag on the terminal did nothing for the terminal and
// pulled the page instead (pull-to-refresh reloaded fox). The scrollback lives in tmux, not in the browser:
// with tmux's mouse mode on, a drag becomes wheel events for tmux (its copy mode scrolls, and leaves on its own
// back at the bottom); otherwise it scrolls xterm's own buffer. A short tap still focuses (opens the keyboard).
function touchScroll(wrap, term, name) {
  let lastY = null, acc = 0, dragging = false;
  const lineHeight = () => wrap.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height || term.options.fontSize * 1.25;
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { lastY = null; return; }
    lastY = e.touches[0].clientY; acc = 0; dragging = false;
  }, { passive: true });
  wrap.addEventListener('touchmove', (e) => {
    if (lastY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    acc += lastY - y; lastY = y; // finger up: positive, towards newer output
    if (!dragging && Math.abs(acc) < 8) return;
    dragging = true;
    e.preventDefault(); // the page must not scroll or reload
    const lines = Math.trunc(acc / lineHeight());
    if (!lines) return;
    acc -= lines * lineHeight();
    scrollTerminal(name, term, lines);
  }, { passive: false });
  wrap.addEventListener('touchend', () => { lastY = null; }, { passive: true });
  wrap.addEventListener('click', (e) => { if (dragging) { e.stopImmediatePropagation(); dragging = false; } }, true); // a drag is not a tap
}
function scrollTerminal(name, term, lines) {
  const ws = state.tabs.get(name)?.ws;
  if (term.modes.mouseTrackingMode !== 'none' && ws?.readyState === 1) {
    const wheel = lines < 0 ? 64 : 65, at = `${Math.ceil(term.cols / 2)};${Math.ceil(term.rows / 2)}`;
    ws.send(JSON.stringify({ type: 'input', data: `\x1b[<${wheel};${at}M`.repeat(Math.min(Math.abs(lines), 12)) }));
  } else term.scrollLines(lines);
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
    macOptionClickForcesSelection: true, // Option-drag selects text for Cmd+C even while tmux owns the mouse
    // fx's hyperlinks (a word that carries an address): web addresses open in a new tab, nothing else opens.
    linkHandler: { activate: (e, uri) => { if (/^https?:\/\//i.test(uri)) openExternal(uri); } },
    theme: state.palette ? { background: state.palette.sky ? 'rgba(0,0,0,0)' : state.palette.bg, foreground: state.palette.text, cursor: state.palette.cursor, selectionBackground: state.palette.sel } : undefined,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.registerLinkProvider(localServerLinks(term));
  term.open(wrap);
  // On phones, a deliberate tap on the terminal opens the software keyboard via xterm's input.
  // Do not focus on tab activation: that would pop up the keyboard just by opening a session.
  wrap.addEventListener('click', () => { if (mobileLayout.matches) term.focus(); });
  touchScroll(wrap, term, t.name);
  macEditingKeys(term, t.name);
  clipboardFromTmux(term);
  state.tabs.set(t.name, { name: t.name, term, fit, ws: null, wrap, closed: false, ready: false, openedAt: Date.now() });
  if (mobileLayout.matches) document.fonts.load(`${fontSize}px "Source Code Pro"`).then(() => {
    const tab = state.tabs.get(t.name);
    if (tab && !tab.closed) { term.options.fontFamily = terminalFontFamily(); tab.settled = null; safeFit(tab); }
  }).catch(() => {});
  renderTabs();
  if (activate) activateTab(t.name); // connects lazily, at the measured size
}

// Connect a tab's WebSocket once it is visible and measured, so tmux draws once at the right size.
// A dropped connection (code 1006: the network, a proxy, a phone waking up) reconnects on its own: tmux keeps
// the session, so attaching again just redraws it. A clean close means the tmux session ended, and 4001 means
// the sign-in expired; neither retries.
const RECONNECT_DELAYS = [250, 600, 1200, 2500, 5000, 8000];
function connectTab(tab) {
  if (!tab?.term || tab.ws || tab.closed || state.tabs.get(tab.name) !== tab) return; // preview tabs have no terminal; closed tabs stay closed
  const { term, wrap } = tab;
  if (term.cols < 20 || term.rows < 5) { setTimeout(() => { safeFit(tab); connectTab(tab); }, 100); return; } // wait for a real layout
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProtocol}//${location.host}/pty?name=${encodeURIComponent(tab.name)}&cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = 'arraybuffer';
  tab.ws = ws;
  let reveal = null;
  ws.onmessage = (ev) => {
    term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    if (!tab.ready) { clearTimeout(reveal); reveal = setTimeout(() => { tab.ready = true; wrap.classList.remove('warming'); updateTermLoading(); renderNextDraft(); }, 120); }
  };
  ws.onopen = () => { tab.attempts = 0; updateDictationAvailability(); renderNextDraft(); };
  ws.onclose = (e) => {
    if (tab.ws !== ws) return; // replaced or closed by fox
    tab.ws = null;
    clearTimeout(reveal);
    tab.ready = false;
    renderNextDraft();
    if (tab.closed) return;
    const dropped = e.code === 1006 && (tab.attempts ?? 0) < RECONNECT_DELAYS.length && state.terminals.some((t) => t.name === tab.name);
    if (dropped) { const n = tab.attempts ?? 0; tab.attempts = n + 1; setTimeout(() => connectTab(tab), RECONNECT_DELAYS[n]); return; }
    if (state.activeTab === tab.name) dictation.cancel();
    tab.closed = true; wrap.classList.remove('warming'); renderTabs();
  };
  // Input and resize follow whichever socket is current; registered once per terminal.
  if (!tab.wired) {
    tab.wired = true;
    term.onData((data) => {
      if (tab.ws?.readyState !== WebSocket.OPEN) return;
      tab.ws.send(JSON.stringify({ type: 'input', data }));
      if (tab.pastingDraft) tab.draftSent = true;
    });
    term.onResize(() => tab.ws?.readyState === 1 && tab.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })));
  }
}

function tabLabel(name) {
  const t = state.terminals.find((x) => x.name === name);
  const s = t?.resume ? sessionById(t.resume) : null;
  return (s ? displayTitle(s) : 'new') + ' · ' + shortPath(t?.cwd ?? '').split('/').pop();
}

// The mosaic reads the overview and a short tmux screen capture. It never creates an xterm or a socket.
let mosaicCapture = 0;
let mosaicChoicesHtml = '';
const mosaicWakes = new Map(); // id -> waking or failed; overview polls must not start another resume
function wakeMosaicSession(s) {
  if (mosaicWakes.has(s.id)) return;
  mosaicWakes.set(s.id, 'waking');
  post('/api/terminals', { cwd: s.workspace, resume: s.id })
    .then((t) => { if (t.error) throw new Error(t.error); return refresh(); })
    .catch(() => { if (state.mosaicIds.includes(s.id)) { mosaicWakes.set(s.id, 'failed'); renderMosaic(); } });
}
function updateMosaicScreen(pre, text) {
  if (pre.textContent === text) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  const scroll = pre.scrollTop;
  pre.textContent = text;
  pre.scrollTop = atBottom ? pre.scrollHeight : scroll;
}
function renderMosaic() {
  if (!state.mosaic) return;
  const available = state.sessions.filter((s) => !s.archived && !s.parentId && (s.terminal || s.state === 'idle'));
  const ids = new Set(state.sessions.filter((s) => !s.archived && !s.parentId).map((s) => s.id));
  state.mosaicIds = state.mosaicIds.filter((id) => ids.has(id)).slice(0, 4);
  for (const id of mosaicWakes.keys()) if (!state.mosaicIds.includes(id)) mosaicWakes.delete(id);
  try { localStorage.setItem('fox.mosaic', JSON.stringify(state.mosaicIds)); } catch {}
  const choices = `<span>Watch · ${state.mosaicIds.length}/4</span>${available.filter((s) => !state.mosaicIds.includes(s.id)).map((s) => `<button type="button" data-add="${esc(s.id)}" ${state.mosaicIds.length === 4 ? 'disabled' : ''} title="Add ${esc(displayTitle(s))}">+ ${esc(displayTitle(s))}</button>`).join('')}`;
  if (choices !== mosaicChoicesHtml) { $('#mosaic-choices').innerHTML = choices; mosaicChoicesHtml = choices; }
  const tiles = $('#mosaic-tiles');
  tiles.dataset.count = String(state.mosaicIds.length);
  // Keep tiles mounted across overview polls so their screens and scroll positions do not flash or reset.
  const mounted = [...tiles.querySelectorAll('[data-tile]')];
  if (mounted.length !== state.mosaicIds.length || mounted.some((el, i) => el.dataset.tile !== state.mosaicIds[i])) {
    tiles.innerHTML = state.mosaicIds.length ? state.mosaicIds.map((id) => {
      const s = sessionById(id);
      return `<article class="mosaic-tile" data-tile="${esc(id)}"><header><span class="st ${esc(s.state)}" title="${esc(STATE_LABEL[s.state] ?? s.state)}"><i></i></span><strong title="${esc(displayTitle(s))}">${esc(displayTitle(s))}</strong><button type="button" data-remove="${esc(id)}" aria-label="Remove ${esc(displayTitle(s))} from mosaic" title="Remove">×</button></header><div class="mosaic-meta" title="${esc(s.workspace)}">${esc(shortPath(s.workspace))} · ${esc(modelShort(s.model) || 'model unknown')}</div><pre class="mosaic-screen" aria-label="Recent terminal output">${s.terminal ? 'Loading…' : 'Waking up…'}</pre><div class="mosaic-reply"><span>${s.latestReply ? 'Last reply' : 'Current turn'}</span><div class="md mosaic-reply-text">${renderMarkdown(s.latestReply?.text ?? (s.terminal && s.state === 'working' ? 'Working…' : 'No completed reply yet'))}</div></div><button type="button" class="mosaic-open" data-expand="${esc(id)}">Open terminal ↗</button></article>`;
    }).join('') : '<p class="mosaic-empty">Choose up to four sessions above to watch here.</p>';
  }
  for (const tile of tiles.querySelectorAll('[data-tile]')) {
    const s = sessionById(tile.dataset.tile);
    const title = displayTitle(s);
    const status = tile.querySelector('.st');
    status.className = `st ${!s.terminal && s.state === 'idle' ? 'asleep' : s.state}`;
    status.title = !s.terminal && s.state === 'idle' ? (mosaicWakes.get(s.id) === 'failed' ? 'Could not wake session' : 'Waking up') : (STATE_LABEL[s.state] ?? s.state);
    tile.querySelector('strong').textContent = title;
    tile.querySelector('strong').title = title;
    tile.querySelector('[data-remove]').setAttribute('aria-label', `Remove ${title} from mosaic`);
    const pre = tile.querySelector('pre');
    if (pre.dataset.terminal !== (s.terminal ?? '')) { pre.dataset.terminal = s.terminal ?? ''; pre.dataset.model = ''; }
    const meta = tile.querySelector('.mosaic-meta');
    meta.title = s.workspace ?? '';
    meta.textContent = `${shortPath(s.workspace)} · ${modelShort(pre.dataset.model || s.model) || 'model unknown'}`;
    const reply = tile.querySelector('.mosaic-reply');
    reply.querySelector('span').textContent = s.latestReply ? 'Last reply' : 'Current turn';
    const formatted = renderMarkdown(s.latestReply?.text ?? (s.terminal && s.state === 'working' ? 'Working…' : 'No completed reply yet'));
    if (reply.querySelector('.mosaic-reply-text').innerHTML !== formatted) reply.querySelector('.mosaic-reply-text').innerHTML = formatted;
    const capture = String(++mosaicCapture);
    pre.dataset.capture = capture;
    if (!s.terminal) {
      if (s.state === 'idle') {
        updateMosaicScreen(pre, mosaicWakes.get(s.id) === 'failed' ? 'Could not wake session. Reopen Mosaic to retry.' : 'Waking up…');
        wakeMosaicSession(s);
      } else updateMosaicScreen(pre, 'No live terminal');
      continue;
    }
    mosaicWakes.delete(s.id);
    fetch(`/api/terminals/${encodeURIComponent(s.terminal)}/snapshot`).then((r) => { if (!r.ok) throw new Error('capture unavailable'); return r.json(); })
      .then(({ text, model }) => {
        if (!pre.isConnected || pre.dataset.capture !== capture) return;
        updateMosaicScreen(pre, text.trim() || 'No terminal output yet');
        if (model) { pre.dataset.model = model; meta.textContent = `${shortPath(s.workspace)} · ${modelShort(model)}`; }
      })
      .catch(() => { if (pre.isConnected && pre.dataset.capture === capture) updateMosaicScreen(pre, 'Capture unavailable'); });
  }
}
function setMosaic(on) {
  state.mosaic = on;
  $('#mosaic').classList.toggle('hidden', !on);
  $('#terminals').classList.toggle('show-mosaic', on);
  $('#toggle-mosaic').setAttribute('aria-pressed', String(on));
  $('#toggle-mosaic').setAttribute('aria-label', on ? 'Show terminal' : 'Show session mosaic');
  if (on) {
    for (const [id, result] of mosaicWakes) if (result === 'failed') mosaicWakes.delete(id);
    renderMosaic();
    dictation.cancel();
  } else safeFit(state.tabs.get(state.activeTab));
  updateDictationAvailability();
}
$('#toggle-mosaic').addEventListener('click', () => setMosaic(!state.mosaic));
$('#mosaic').addEventListener('click', (e) => {
  const id = e.target.closest('[data-add], [data-remove], [data-expand]')?.dataset;
  if (!id) return;
  if (id.add && state.mosaicIds.length < 4 && !state.mosaicIds.includes(id.add)) state.mosaicIds.push(id.add);
  if (id.remove) state.mosaicIds = state.mosaicIds.filter((s) => s !== id.remove);
  if (id.expand) { setMosaic(false); openSession(id.expand); return; }
  renderMosaic();
});

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
      ? `<span class="close" data-close="${esc(name)}" title="Unpin and close (it keeps running)">×</span>`
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
  syncNothingOpen();
  updateDictationAvailability();
  renderNextDraft();
}

// Keep the address bar in sync so a refresh (or a bookmark) lands on the same place: the session, and the page over
// it (?view=settings, ?view=jobs, ?job=<id>&run=<id>, &edit=<id|new> for the job editor). Opening a page is a step in
// the browser's history (push), so Back and Forward move between them; following the open session only replaces.
let applyingUrl = false;
function syncUrl(push = false) {
  updatePageTitle();
  if (applyingUrl) return;
  const t = state.terminals.find((x) => x.name === state.activeTab);
  const sel = state.selected;
  const q = new URLSearchParams();
  if (settingsOpen()) q.set('view', 'settings');
  else if (state.prView) { q.set('view', 'prs'); if (state.prOpen) q.set('pr', state.prOpen); }
  else if (skillsOpen()) q.set('view', 'skills');
  else if (appsOpen()) q.set('view', 'apps');
  else if (state.jobView === 'list') q.set('view', 'jobs');
  else if (state.jobView) { q.set('job', state.jobView); if (state.openRun) q.set('run', state.openRun); }
  if ((state.prView || state.jobView === 'list') && state.wsFilter) q.set('ws', state.wsFilter);
  if (state.jobDialog) q.set('edit', state.jobDialog);
  if (t?.resume) q.set('open', t.resume);
  if (sel && sel !== t?.resume) q.set('session', sel);
  const search = q.toString() ? `?${q}` : '';
  if (location.search === search) return;
  history[push ? 'pushState' : 'replaceState'](null, '', search || location.pathname);
}
// Back, Forward, or a link: show the page the address names. The session part is left as it is.
async function applyUrl() {
  applyingUrl = true;
  try {
    const q = new URLSearchParams(location.search);
    const view = q.get('view'), job = q.get('job'), edit = q.get('edit');
    state.wsFilter = q.get('ws');
    if (view === 'settings') openSettings(); else closeSettings();
    if (view === 'prs') { state.prOpen = q.get('pr'); openPrs(); } else if (state.prView) closePrs();
    if (view === 'skills') openSkills(); else closeSkills();
    if (view === 'apps') openApps(); else closeApps({ sync: false });
    if (job) { openJob(job); state.openRun = q.get('run'); renderJobView(); }
    else if (view === 'jobs') openJobs();
    else if (state.jobView) closeJob();
    if (edit) { if (state.jobDialog !== edit) await openJobDialog(edit === 'new' ? null : edit); }
    else if (state.jobDialog) closeJobDialog();
  } finally { applyingUrl = false; updatePageTitle(); }
}
window.addEventListener('popstate', applyUrl);
function activateTab(name) {
  if (state.mosaic) setMosaic(false);
  if (state.activeTab !== name) dictation.cancel();
  if (state.waking && state.terminals.find((x) => x.name === name)?.resume !== state.waking.id) state.waking = null;
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
  t.closed = true; // no reconnect after this
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
  if (c?.answer) return c.answer; // a harness that keeps each subagent's answer on its row (Claude Code)
  if (cachedResults.id !== parent.id) return null;
  if (c?.name) { const rounds = cachedResults.byAgent.get(c.name) ?? []; return rounds.length ? rounds.at(-1).text : null; }
  return cachedResults.assigned.get(c.id) ?? null;
}

// Board: subagents grouped by task, so the same task on several models reads as a comparison.
// Click a row to read its whole answer in place; bad answers are flagged.
const expandedAgents = new Set();
let timelineOpen = false;
function timelineView(t, selectedId) {
  if (!t?.lanes?.length) return '<div class="timeline-empty">No timed intervals available for this turn.</div>';
  const width = Math.max(1, t.elapsed);
  const bars = (lane) => lane.intervals.map((span) => {
    const left = Math.max(0, (span.start - t.start) / width * 100);
    const size = Math.max(.5, (span.end - span.start) / width * 100);
    const label = `${span.kind === 'handoff' ? 'handoff' : span.kind === 'tool' ? span.label : 'agent'} · ${fmtDur(span.end - span.start)}${span.provisional ? ' · provisional' : ''}`;
    return `<span class="timeline-bar ${span.kind} ${span.provisional ? 'provisional' : ''}" style="left:${left}%;width:${Math.min(size, 100 - left)}%" title="${esc(label)}"></span>`;
  }).join('');
  return `<div class="timeline-summary">${t.pending ? 'Live · partial timing' : t.coarse ? 'Observed window · ≥' + fmtDur(t.elapsed) : 'Elapsed · ' + fmtDur(t.elapsed)}${t.chain.length ? ` <span title="Longest observed dependency path, not summed agent time">· path ${esc(t.chain.map((x) => x.label).join(' → ').slice(0, 100))} · ${fmtDur(t.chain.reduce((n, x) => n + x.ms, 0))}</span>` : ''}${t.coarse ? '<div class="timeline-empty">Event times are saved at turn end; parent/tool timing unavailable.</div>' : ''}</div>
    <div class="timeline-scale"><span>0</span><span>${fmtDur(t.elapsed)}${t.provisional ? ' · provisional' : ''}</span></div>
    ${t.lanes.map((lane) => `<div class="timeline-lane"><span class="timeline-name">${lane.id ? `<a href="#" data-child="${esc(lane.id)}" ${lane.id === selectedId ? 'aria-current="true"' : ''}>${esc(lane.label)} ↗</a>` : 'parent'}</span><span class="timeline-track">${bars(lane)}</span></div>`).join('')}
    ${t.omitted ? `<div class="timeline-empty">+${t.omitted} more agents not shown</div>` : ''}<div class="timeline-legend">agent <i class="timeline-swatch agent"></i> · tool <i class="timeline-swatch tool"></i> · handoff <i class="timeline-swatch handoff"></i></div>`;
}
function timelineSection(t, selectedId) {
  return `<a href="#" class="section-title fold ${timelineOpen ? '' : 'closed'}" data-toggle-timeline>turn timeline</a>${timelineOpen ? `<div class="timeline">${timelineView(t, selectedId)}</div>` : ''}`;
}
let agentsCollapsed = false;
try { agentsCollapsed = localStorage.getItem('fox.agentsCollapsed') === '1'; } catch {}
let familyUsageOpen = false;
function familyUsageLine(parent) {
  const usage = parent.familyUsage;
  if (!usage?.rows?.length) return '';
  const total = usage.tokens;
  const stale = usage.rows.some((r) => r.pending);
  const hint = [usage.missing ? `${usage.missing} without snapshot` : '', stale ? 'saved data may lag live work' : ''].filter(Boolean).join(' · ');
  return `<details class="family-usage" ${familyUsageOpen ? 'open' : ''}><summary data-toggle-family-usage>local ${usage.missing ? 'partial ' : ''}estimate · ${fmtTokens(total)} tokens${hint ? ` <span class="family-usage-hint">· ${hint}</span>` : ''}</summary>
    <div class="family-usage-rows">${usage.rows.map((r) => `<div class="family-usage-row"><span title="${esc(r.model ?? 'unknown model')}">${r.id === parent.id ? 'parent' : `child ${parent.children.findIndex((c) => c.id === r.id) + 1}`} · ${esc(r.model ? modelShort(r.model) : 'unknown model')}</span><span>${fmtTokens(r.tokens)} · ${total ? Math.round(r.tokens / total * 100) + '%' : '—'}${r.pending ? ' · saved' : ''}</span></div>`).join('')}
    <div class="family-usage-note">Saved session snapshots · input + output + cache read${usage.missing ? ' · shares of saved total' : ''}. Not provider spend or remaining quota.</div></div></details>`;
}
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
    return `<div class="agent ${open ? 'open' : ''} ${selected ? 'selected' : ''}" data-agent="${esc(c.id)}" title="${open ? '' : esc(task)}">${head}${body}${open && c.name ? `<button type="button" class="agent-open linkish" data-agent-followup="${esc(c.id)}" data-agent-parent="${esc(parent.id)}" data-agent-name="${esc(c.name)}">Follow up</button>` : ''}${open && !selected ? `<a class="agent-open" href="#" data-child="${esc(c.id)}">its conversation →</a>` : ''}</div>`;
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
  return agentsCollapsed ? head : `${head}<div class="board">${html.join('')}</div>${familyUsageLine(parent)}`;
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
  const page = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank"><style>
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
  if (e.target.closest('[data-toggle-family-usage]')) { familyUsageOpen = !familyUsageOpen; return; }
  if (e.target.closest('[data-toggle-agents]')) {
    e.preventDefault(); agentsCollapsed = !agentsCollapsed;
    try { localStorage.setItem('fox.agentsCollapsed', agentsCollapsed ? '1' : '0'); } catch {}
    lastTranscriptKey = ''; return loadTranscript(state.selected, true);
  }
  if (e.target.closest('[data-toggle-timeline]')) {
    e.preventDefault(); timelineOpen = !timelineOpen;
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
  const followup = e.target.closest('[data-agent-followup]');
  if (followup) { e.preventDefault(); return openAgentDraft(followup); }
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
// Messages are Markdown; a one-line preview reads better without the marks (**, `, #, table bars).
const plainSnippet = (text) => text.replace(/\*\*|__|`/g, '').replace(/^\s*(#{1,6}|>)\s*/gm, '').replace(/\s*\|\s*/g, ' · ').replace(/^ · | · $/g, '').replace(/\s+/g, ' ').trim();
function markedMatch(text, query) {
  text = plainSnippet(text);
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return at < 0 ? esc(text) : esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, at + query.length)) + '</mark>' + esc(text.slice(at + query.length));
}
function renderGlobalHits() {
  const q = globalQuery.value.trim();
  globalResults.innerHTML = globalHits.map((hit, i) => {
    const s = sessionById(hit.id);
    if (!s) return '';
    const label = hit.kind === 'name' ? 'session' : hit.kind === 'user' ? 'you' : agentName(s);
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
  closePages(); // the result shows in the right column, which an open page hides
  setTranscript(true);
  selectSession(hit.id); // do not resume archived/idle sessions
}
$('#global-search-open').addEventListener('click', openGlobalSearch);
globalSearch.addEventListener('click', (e) => { if (e.target === globalSearch) closeGlobalSearch(); });
$('#global-search-cancel').addEventListener('click', closeGlobalSearch);
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
  const [events, files, timing] = await Promise.all([fetch(`/api/sessions/${id}/events`).then((r) => r.json()), fetch(`/api/sessions/${id}/files`).then((r) => r.json()).catch(() => []), parent?.children?.length ? fetch(`/api/sessions/${id}/timeline`).then((r) => r.ok ? r.json() : null).catch(() => null) : null]);
  if (state.selected !== id) return; // selection changed while we were fetching: drop this render
  const termOpenKey = Boolean(s.terminal && state.tabs.get(s.terminal) && !state.tabs.get(s.terminal).closed);
  const key = id + ':' + events.length + ':' + (s.updatedAt ?? 0) + ':' + (parent?.children ?? []).map((c) => c.phase).join(',') + ':' + termOpenKey + ':' + Math.floor(Date.now() / 5000);
  if (quiet && key === lastTranscriptKey) return;
  lastTranscriptKey = key;

  // No title on a desktop: the session is highlighted on the left. A subagent gets a way back to its parent;
  // on a phone, where the list is another screen, the name and model stay.
  $('#transcript-title').innerHTML = isChild
    ? `<a href="#" class="crumb" data-goto="${esc(parent.id)}">← ${esc(displayTitle(parent))}</a>`
    : mobileLayout.matches ? esc(displayTitle(s)) : '';
  const u = s.usage;
  const tokens = u.input + u.output ? `${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${fmtTokens(u.cacheRead)} cache` : '';
  $('#transcript-meta').innerHTML = `<span title="${esc([tokens, s.workspace].filter(Boolean).join('\n'))}">${s.model ? vendorDot(s.model) + esc(modelShort(s.model)) : ''}${s.provider ? ` · <span title="${esc(providerLabel(s.provider))}">${s.provider === 'gateway' ? '▲ gateway' : esc(s.provider)}</span>` : ''}${u.wallMs ? ' · ' + fmtDur(u.wallMs) : ''}${isChild ? ' · billed to parent' : u.cost ? ' · $' + u.cost.toFixed(2) : ''}</span>`;

  const html = [];
  if (!isChild && s.addDirs?.length) html.push(`<div class="session-access"><div class="section-title">fx file access · chosen at launch</div><div class="session-access-path">${esc(s.workspace)}</div>${s.addDirs.map((dir) => `<div class="session-access-path">+ ${esc(dir)}</div>`).join('')}</div>`);
  // Desktop keeps its detail-first column; phones lead with the readable conversation.
  if (!mobileLayout.matches) html.push(filesSection(id, files));
  if (isChild) {
    if (lastChildShown !== id) { expandedAgents.add(id); lastChildShown = id; } // arrive with its answer open
    if (!mobileLayout.matches) html.push(agentsBoard(parent, { selectedId: id }), '<div class="section-title">its conversation</div>');
  } else if (parent.children?.length && !mobileLayout.matches) html.push(agentsBoard(parent), timelineSection(timing, id));
  if (isChild && !mobileLayout.matches) html.push(timelineSection(timing, id));
  // The conversation lives in the terminal. This column shows it only for a subagent (it has no terminal)
  // or when global search or the replies inbox pointed at one message.
  const showConvo = isChild || convoShown.has(id) || mobileLayout.matches;
  if (mobileLayout.matches) html.push('<div class="section-title">conversation</div>');
  else if (!isChild && showConvo) html.push(`<div class="section-title">conversation · <a href="#" data-hide-convo="${esc(id)}">hide</a></div>`);
  let messageIndex = 0;
  for (const ev of showConvo ? events : []) {
    if (mobileLayout.matches && ev.kind !== 'user' && ev.kind !== 'assistant') continue;
    if (!isChild && ev.kind === 'tool_call' && ev.name === 'subagent' && parent.children?.length) continue; // already in the board
    const match = globalMessage?.id === id && globalMessage.index === messageIndex;
    if (ev.kind === 'user') html.push(`<div class="msg user${match ? ' global-match' : ''}" data-message="${messageIndex++}"><div class="who">${isChild ? 'task from parent' : 'you'}</div><div class="text">${esc(ev.text)}</div></div>`);
    else if (ev.kind === 'assistant' && !ev.text?.trim()) continue; // a turn step with only tool calls
    else if (ev.kind === 'assistant') html.push(`<div class="msg assistant${match ? ' global-match' : ''}" data-message="${messageIndex++}"><div class="who">${isChild ? (s.subagent?.name ? ICON.threads + ' ' + esc(s.subagent.name) : 'subagent') : esc(agentName(s))}</div><div class="text md">${renderMarkdown(ev.text)}</div></div>`);
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
    if (parent.children?.length) html.push(agentsBoard(parent, isChild ? { selectedId: id } : {}), timelineSection(timing, id));
    html.push(filesSection(id, files));
  }
  renderArtifactCard(id, files);
  // On a session change the column follows its content: nothing to show closes it; something to show
  // brings back what you chose last. Within a session it never moves by itself.
  if (id !== columnSessionId && !mobileLayout.matches) {
    columnSessionId = id;
    const empty = !html.join('').trim() && $('#artifact-slot').classList.contains('hidden') && draftBox.classList.contains('hidden');
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
// Settings: a page in the center, like Jobs (the gear opens and closes it).
function openSettings() {
  closePages({ except: 'settings-view' });
  dictation.cancel();
  $('#settings-view').classList.remove('hidden');
  $('#settings').classList.add('active'); $('#settings').setAttribute('aria-expanded', 'true');
  renderSettingsNav();
  if (mobileLayout.matches) showMobileView('terminal');
  renderThemeDots();
  loadTools();
  loadFxSettings();
  loadDeploy();
  syncUrl(true);
}
// On a server: the branch fox-update deploys. release = merged pull requests; main = every push, fx's too.
const DEPLOY_SUB = { release: 'merged pull requests go live', main: 'every push goes live within a minute' };
function renderDeploy(d) {
  $('#settings-deploy').classList.toggle('hidden', !d?.available);
  renderSettingsNav();
  if (!d?.available) return;
  for (const b of document.querySelectorAll('#deploy-seg [data-deploy]')) b.classList.toggle('on', b.dataset.deploy === d.branch);
  $('#deploy-sub').textContent = DEPLOY_SUB[d.branch];
}
async function loadDeploy() { try { renderDeploy(await (await fetch('/api/deploy')).json()); } catch {} }
$('#deploy-seg').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-deploy]'); if (!b || b.classList.contains('on')) return;
  const r = await fetch('/api/deploy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: b.dataset.deploy }) });
  if (r.ok) renderDeploy(await r.json()); else toast('Could not change it');
});
// On a wide screen Settings keeps an index of its sections on the left, always there: a click scrolls to one, and
// scrolling marks where you are. All sections stay in one list, on a phone too (where the index is not shown).
// A section with nothing to show (Deploy off a server, Devices without pairing) is left out of the index.
let settingsSection = 'appearance';
const settingsGroups = () => [...document.querySelectorAll('#settings-view .set-group')]
  .filter((g) => !g.classList.contains('hidden') && [...g.children].some((c) => c.tagName !== 'H3' && !c.classList.contains('hidden')));
const settingsSectionShown = () => settingsOpen();
function renderSettingsNav() {
  const groups = settingsGroups();
  if (!groups.some((g) => g.dataset.set === settingsSection)) settingsSection = groups[0]?.dataset.set ?? 'appearance';
  $('#settings-nav').innerHTML = groups.map((g) => `<button type="button" class="${g.dataset.set === settingsSection ? 'on' : ''}" data-set-nav="${g.dataset.set}">${esc(g.dataset.name)}</button>`).join('');
  if (settingsSectionShown()) markFxSeen();
  requestAnimationFrame(fitSettingsEnd);
}
// Room after the last section, just enough for it to reach the top: otherwise a click on Tools or Server could not
// bring its title up (the list ends first) and the index would point at a section halfway down the page.
function fitSettingsEnd() {
  const pane = $('#settings-view .set-pane'), body = $('#settings-view .set-body'), last = settingsGroups().at(-1);
  pane.style.paddingBottom = !last || mobileLayout.matches || !settingsOpen() ? '' : `${Math.max(0, body.clientHeight - last.offsetHeight - 52)}px`;
}
window.addEventListener('resize', () => { if (settingsOpen()) fitSettingsEnd(); });
const markSettingsNav = () => { for (const b of $('#settings-nav').children) b.classList.toggle('on', b.dataset.setNav === settingsSection); };
$('#settings-nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-set-nav]'); if (!b) return;
  settingsSection = b.dataset.setNav; markSettingsNav();
  settingsJump = Date.now();
  document.querySelector(`#settings-view .set-group[data-set="${b.dataset.setNav}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
});
// Where you are: the last section whose top has passed the top of the list (the last one at the very bottom).
let settingsJump = 0;
$('#settings-view .set-body').addEventListener('scroll', (e) => {
  if (Date.now() - settingsJump < 700) return; // a click's smooth scroll keeps the section it chose
  const box = e.currentTarget, top = box.getBoundingClientRect().top + 24, groups = settingsGroups();
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
  const here = atEnd ? groups.at(-1) : groups.filter((g) => g.getBoundingClientRect().top <= top).at(-1) ?? groups[0];
  if (here && here.dataset.set !== settingsSection) { settingsSection = here.dataset.set; markSettingsNav(); }
}, { passive: true });
// sync: false when another page takes its place, so that opening it is one step in the history, not two.
function closeSettings({ sync = true } = {}) {
  if (!settingsOpen()) return;
  $('#settings-view').classList.add('hidden');
  requestAnimationFrame(fitActive); // the session's bar is back on a phone
  $('#settings').classList.remove('active'); $('#settings').setAttribute('aria-expanded', 'false');
  if (sync) syncUrl(true);
}
const settingsOpen = () => !$('#settings-view').classList.contains('hidden');
$('#settings').addEventListener('click', () => (settingsOpen() ? closeSettings() : openSettings()));
$('#settings-close').addEventListener('click', closeSettings);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsOpen() && !e.defaultPrevented) closeSettings(); });
// fx's own settings (see fxsettings.mjs). Seen state is browser-only, never activation.
const fxSettingsSeen = new Set();
try { for (const id of JSON.parse(localStorage.getItem('fox.fxSettingsSeen') ?? '[]')) fxSettingsSeen.add(id); } catch {}
// fx's newer options are one choice each: Default leaves fx's own value (fox writes nothing), On or Off writes
// it; a number is typed and saved with Enter, emptied (or Default) to give it back to fx. Older dots go once the
// section is shown. Explicit managed overrides keep their New label until dismissed, independently of activation.
function fxSettingRow(o) {
  const unseen = o.introduced && !fxSettingsSeen.has(`${o.key}:${o.introduced}`);
  const fresh = unseen ? (o.managedOverride ? `<span class="set-new-label">New</span> <button type="button" class="set-act" data-fx-seen="${o.key}:${o.introduced}">Mark as seen</button>` : '<span class="set-new" title="New"></span>') : '';
  const more = o.introduced ? ` · fx default: ${esc(o.upstreamDefault)}${o.documentation ? ` · <a href="${esc(o.documentation)}" target="_blank" rel="noopener noreferrer">docs</a>` : ''}` : '';
  const main = `<span class="set-main">${esc(o.label)}${fresh}<span class="set-sub">${esc(o.description)}${more}</span></span>`;
  if (o.managedOverride) return `<div class="set-row fx-override">${main}<div class="fx-override-controls"><label>Apply setting <button type="button" class="switch-btn ${o.applied ? 'on' : ''}" data-fx-key="${o.key}" data-fx-apply="${o.applied}" role="switch" aria-checked="${o.applied}" aria-label="Apply ${esc(o.label)}"><span class="switch"></span></button></label><label>Save prompts <button type="button" class="switch-btn ${o.value ? 'on' : ''}" data-fx-key="${o.key}" ${o.applied ? '' : 'disabled'} role="switch" aria-checked="${o.value}" aria-label="${esc(o.label)}"><span class="switch"></span></button></label><span class="set-sub">${o.applied ? 'Personal override applied.' : 'No fox override; fx defaults to on.'} Changes apply to new or resumed sessions.</span></div></div>`;
  if (o.type === 'integer') return `<div class="set-row">${main}<div class="set-num"><input type="number" min="${o.min}" max="${o.max}" step="1" value="${o.applied ? esc(o.value) : ''}" placeholder="fx default" aria-label="${esc(o.label)}" data-fx-num="${o.key}">${o.applied ? `<button type="button" class="set-act" data-fx-key="${o.key}" data-fx-tri="default" title="Give it back to fx">Default</button>` : ''}</div></div>`;
  if (o.type === 'bool' && o.introduced) {
    const now = !o.applied ? 'default' : o.value ? 'on' : 'off';
    return `<div class="set-row">${main}<div class="seg">${['default', 'on', 'off'].map((v) => `<button type="button" class="${v === now ? 'on' : ''}" data-fx-key="${o.key}" data-fx-tri="${v}">${v === 'default' ? 'Default' : v === 'on' ? 'On' : 'Off'}</button>`).join('')}</div></div>`;
  }
  if (o.type === 'bool') return `<div class="set-row">${main}<button type="button" class="switch-btn ${o.value ? 'on' : ''}" data-fx-key="${o.key}" role="switch" aria-checked="${o.value}" aria-label="${esc(o.label)}"><span class="switch"></span></button></div>`;
  return `<div class="set-row">${main}<div class="seg">${o.choices.map((c) => `<button type="button" class="${c === o.value ? 'on' : ''}" data-fx-key="${o.key}" data-fx-value="${c}">${c}</button>`).join('')}</div></div>`;
}
async function saveFxSetting(key, value, el) {
  if (el) el.disabled = true;
  try {
    const r = await fetch('/api/fx-settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'That did not work.');
    $('#settings-fx').innerHTML = j.map(fxSettingRow).join('');
    $('#settings-fx-note').textContent = 'New sessions use it; an open one picks it up when it is resumed.';
  } catch (err) { if (el) el.disabled = false; $('#settings-fx-note').textContent = err.message; }
}
async function loadFxSettings() {
  try {
    const list = await (await fetch('/api/fx-settings')).json();
    $('#settings-fx').innerHTML = list.map(fxSettingRow).join('');
    markFxSeen = () => { // once its section is on screen: the dots show this time, not the next
      for (const o of list) if (o.introduced && !o.managedOverride) fxSettingsSeen.add(`${o.key}:${o.introduced}`);
      try { localStorage.setItem('fox.fxSettingsSeen', JSON.stringify([...fxSettingsSeen])); } catch {}
    };
    if (settingsSectionShown()) markFxSeen();
  } catch {}
}
let markFxSeen = () => {};
$('#settings-fx').addEventListener('click', (e) => {
  const seen = e.target.closest('[data-fx-seen]');
  if (seen) {
    fxSettingsSeen.add(seen.dataset.fxSeen);
    try { localStorage.setItem('fox.fxSettingsSeen', JSON.stringify([...fxSettingsSeen])); } catch {}
    loadFxSettings();
    return;
  }
  const btn = e.target.closest('[data-fx-key]');
  if (!btn || btn.disabled || btn.classList.contains('on') && 'fxTri' in btn.dataset) return;
  const value = 'fxApply' in btn.dataset ? (btn.dataset.fxApply === 'true' ? null : false)
    : 'fxTri' in btn.dataset ? (btn.dataset.fxTri === 'default' ? null : btn.dataset.fxTri === 'on')
    : 'fxValue' in btn.dataset ? btn.dataset.fxValue : !btn.classList.contains('on');
  saveFxSetting(btn.dataset.fxKey, value, btn);
});
// A number saves when you leave the field or press Enter; empty gives it back to fx.
$('#settings-fx').addEventListener('change', (e) => {
  const input = e.target.closest('[data-fx-num]'); if (!input) return;
  if (input.value.trim() && !input.reportValidity()) { $('#settings-fx-note').textContent = 'Enter a whole number in range.'; return; }
  saveFxSetting(input.dataset.fxNum, input.value.trim() ? Number(input.value) : null, input);
});
$('#settings-fx').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-fx-num]')) e.target.blur(); });
// Tools (MCP servers from fox's catalog), for every session of fx and, when installed, of Claude Code. For fx: a switch for the ones fx has (off keeps the
// setup, fx skips it), Add for the rest, Sign in when one needs it. Nothing changes without a tap.
// With Claude Code installed, each tool has a switch per agent, named; with fx alone it reads as before.
function toolRow(t) {
  const sub = [esc(t.description), t.cost && (t.enabled || t.claude?.enabled) ? esc(t.cost) : ''].filter(Boolean).join(' · ');
  const main = `<span class="set-main">${esc(t.label)}<span class="set-sub">${sub}</span></span>`;
  const named = (label, html) => t.claude ? `<span class="tool-agent">${label}${html}</span>` : html;
  const fx = !t.installed ? `<button type="button" class="set-act" data-add-tool="${t.id}">Add${t.claude ? ' to fx' : ''}</button>`
    : (t.enabled && t.needsSignIn ? `<button type="button" class="set-act warn" data-signin-tool="${t.id}">Sign in</button>` : '')
      + named('fx', `<button type="button" class="switch-btn ${t.enabled ? 'on' : ''}" data-toggle-tool="${t.id}" role="switch" aria-checked="${t.enabled}" aria-label="${esc(t.label)}${t.claude ? ' for fx' : ''}"><span class="switch"></span></button>`);
  const claude = t.claude ? named('Claude', `<button type="button" class="switch-btn ${t.claude.enabled ? 'on' : ''}" data-claude-tool="${t.id}" role="switch" aria-checked="${t.claude.enabled}" aria-label="${esc(t.label)} for Claude Code"><span class="switch"></span></button>`) : '';
  return `<div class="set-row">${main}${fx}${claude}</div>`;
}
async function loadTools() {
  let tools = [];
  try { tools = await (await fetch('/api/tools')).json(); } catch {}
  $('#settings-tools').innerHTML = tools.map(toolRow).join('');
}
$('#settings-tools').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add-tool], [data-signin-tool], [data-toggle-tool], [data-claude-tool]');
  if (!btn || btn.disabled) return;
  const note = $('#settings-tools-note');
  if (btn.dataset.claudeTool) {
    // Claude Code: on adds the server to its config, off removes it. It signs in to a tool itself.
    const on = !btn.classList.contains('on');
    btn.disabled = true; note.textContent = '';
    const r = await fetch(`/api/tools/${btn.dataset.claudeTool}/${on ? 'on' : 'off'}?agent=claude`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { btn.disabled = false; note.textContent = j.error || 'That did not work.'; return; }
    $('#settings-tools').innerHTML = j.map(toolRow).join('');
    const oauth = j.find((t) => t.id === btn.dataset.claudeTool)?.claude?.oauth;
    note.textContent = !on ? 'New Claude Code sessions start without it.' : oauth ? 'New Claude Code sessions have it. Sign in once with /mcp in one of them.' : 'New Claude Code sessions have it.';
    return;
  }
  const id = btn.dataset.addTool ?? btn.dataset.signinTool ?? btn.dataset.toggleTool;
  const action = btn.dataset.addTool ? 'add' : btn.dataset.signinTool ? 'signin' : btn.classList.contains('on') ? 'off' : 'on';
  btn.disabled = true; note.textContent = '';
  const r = await fetch(`/api/tools/${id}/${action}`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { btn.disabled = false; note.textContent = j.error || 'That did not work.'; return; }
  if (action !== 'signin') {
    $('#settings-tools').innerHTML = j.map(toolRow).join('');
    note.textContent = action === 'off' ? 'New sessions start without it; open ones keep it until they close.' : 'New sessions have it.';
    return;
  }
  // fx waits for the provider's page to call back: open it in a tab, or offer a link if popups are blocked.
  const tab = window.open(j.url, '_blank');
  btn.textContent = 'Waiting…';
  note.innerHTML = tab ? 'Finish the sign-in in the new tab.' : `Pop-up blocked: <a href="${esc(j.url)}" target="_blank" rel="noopener">open the sign-in page</a>.`;
  for (let i = 0; i < 150; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const st = await (await fetch(`/api/tools/${id}/signin`)).json().catch(() => ({}));
    if (st.status === 'done') { note.textContent = 'Signed in. New sessions have it.'; return loadTools(); }
    if (st.status === 'failed') { btn.disabled = false; btn.textContent = 'Sign in'; note.textContent = st.error || 'The sign-in did not finish.'; return; }
  }
});
// ---------- skills: a page of its own, like Jobs and Pull requests ----------
// Two tabs: Installed (what fx loads) and Browse (what can be installed). Browse lists Popular from skills.sh, a
// skills.sh search, or one repo; ticked skills, from any of them, are reviewed file by file before installing.
// Skills are instructions, not programs: nothing is copied before that review.
let skillCount = null, skillItems = [], skillSources = [], skillTab = null;
let skillView = 'popular', skillRows = null, skillViewMsg = '', skillScopes = [], skillScope = 'global';
// One skill open at a time in Browse: its key and what its panel shows (loading, the downloaded skill, or why not).
let skillOpen = null, skillPanel = null;
const skillCache = new Map();
async function skillApi(action, body) {
  const r = await fetch(`/api/skills/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'That did not work.'); return j;
}
function renderSkillsEntry() {
  const btn = $('#skills-entry');
  btn.classList.toggle('active', skillsOpen());
  btn.innerHTML = `<span class="jdot none"></span><span class="jtitle">Skills</span><span>${skillCount || ''}</span><span class="jnext">${skillCount === 0 ? 'none installed' : ''}</span>`;
}
async function loadSkills() {
  try {
    const r = await fetch('/api/skills'); if (!r.ok) throw new Error('Could not load skills.');
    const { items, sources, scopes } = await r.json();
    skillItems = items; skillSources = sources; skillCount = items.length; renderSkillsEntry();
    $('#skill-count').textContent = items.length;
    skillScopes = [{ id: 'global', name: 'Every workspace' }, ...scopes.map((s) => ({ id: s.id, name: `${s.name} workspace` }))];
    if (!skillScopes.some((s) => s.id === skillScope)) skillScope = 'global';
    // One group per place a skill applies: every workspace, or one workspace. Which folder it sits in (fx's,
    // Claude Code's…) is on hover; one line per skill, the full text is behind Read.
    const groups = new Map();
    for (const item of items) {
      const place = item.scope === 'global' ? 'Every workspace' : `${item.group.split(' · ')[0]} workspace`;
      if (!groups.has(place)) groups.set(place, []); groups.get(place).push(item);
    }
    $('#skills-list').innerHTML = items.length ? [...groups].map(([place, skills]) => `<div class="skill-group">${esc(place)} <span>${skills.length}</span></div>` + skills.map((s) => `<div class="skill-row" title="${esc(shortPath(s.path))}"><span class="skill-name">${esc(s.name)}</span><span class="skill-desc" title="${esc(s.description || '')}">${esc(s.description || 'No description')}</span>${s.source ? `<span class="skill-src">${esc(s.source)}</span>` : ''}<button type="button" class="set-act" data-skill-read="${esc(s.id)}">Read</button>${s.owned ? `<button type="button" class="set-act" data-skill-remove="${esc(s.id)}">Remove</button>` : ''}</div>`).join('')).join('') : '<div class="skill-empty">No skills installed. <button type="button" class="linkish" data-skill-tab="browse">Browse</button> to add some.</div>';
    if (!skillTab && skillsOpen()) showSkillTab(items.length ? 'installed' : 'browse');
    renderSkillChips(); if (skillRows) renderSkillPick();
  } catch (err) { $('#skill-note').textContent = err.message; }
}
function showSkillTab(tab) {
  skillTab = tab;
  for (const b of document.querySelectorAll('#skill-tabs [data-skill-tab]')) b.classList.toggle('on', b.dataset.skillTab === tab);
  $('#skill-installed').classList.toggle('hidden', tab !== 'installed');
  $('#skill-browse').classList.toggle('hidden', tab !== 'browse');
  $('#skill-note').textContent = '';
  if (tab === 'browse' && !skillRows && !skillViewMsg) openSkillView('popular');
}
// The chips say where the list comes from: Popular on skills.sh, a known repo, or one you type.
function renderSkillChips() {
  const other = !['popular', 'search', ...skillSources].includes(skillView);
  $('#skill-repos').innerHTML = `<button type="button" class="skill-chip${skillView === 'popular' ? ' on' : ''}" data-skill-view="popular">Popular</button>` +
    skillSources.map((src) => `<button type="button" class="skill-chip${skillView === src ? ' on' : ''}" data-skill-view="${esc(src)}">${esc(src)}</button>`).join('') +
    `<button type="button" class="skill-chip${other || !$('#skill-other').classList.contains('hidden') ? ' on' : ''}" data-skill-other>${other ? esc(skillView) : 'owner/repo…'}</button>`;
}
// Rows are { source, id, name, desc, installs, problem }: id is a folder from a repo's list or a skills.sh id.
async function openSkillView(view, q) {
  skillOpen = null; skillPanel = null;
  skillView = view; skillRows = null; skillViewMsg = view === 'search' ? 'Searching skills.sh…' : view === 'popular' ? 'Loading popular skills…' : 'Reading the repository…';
  if (view !== 'search') $('#skills-search').value = '';
  if (view === 'popular' || view === 'search' || skillSources.includes(view)) $('#skill-other').classList.add('hidden');
  renderSkillChips(); renderSkillPick();
  const key = view === 'search' ? `search:${q}` : view;
  try {
    let rows = skillCache.get(key);
    if (!rows) {
      const fromSh = (j) => j.skills.map((s) => ({ source: s.source, id: s.skill, name: s.name, desc: s.source, installs: s.installs }));
      rows = view === 'popular' ? fromSh(await (await fetch('/api/skills/popular')).json().then((j) => { if (j.error) throw new Error(j.error); return j; }))
        : view === 'search' ? fromSh(await skillApi('search', { q }))
        : (await skillApi('browse', { source: view })).skills.map((s) => ({ source: view, id: s.dir, name: s.name, desc: s.description, problem: s.problem }));
      skillCache.set(key, rows);
    }
    if (skillView !== view || (view === 'search' && $('#skills-search').value.trim() !== q)) return;
    skillRows = rows; skillViewMsg = rows.length ? '' : 'Nothing found.';
  } catch (err) { if (skillView === view) skillViewMsg = err.message; }
  renderSkillPick();
}
const fmtInstalls = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
// The list: a row per skill; clicking one opens it under the row. Opening downloads the whole skill from GitHub
// (SKILL.md and every file, shown in full), and Install copies exactly that: what you read is what gets installed.
const skillPlaceOf = (name) => skillItems.filter((i) => i.name === name).map((i) => i.scope);
function renderSkillPick() {
  $('#skill-pick').innerHTML = !skillRows ? `<div class="set-foot">${esc(skillViewMsg)}</div>` : skillRows.map((s) => {
    const key = `${s.source}|${s.id}`, open = skillOpen === key, installed = skillPlaceOf(s.name).length > 0;
    const meta = installed ? 'installed' : s.installs ? fmtInstalls(s.installs) : '';
    return `<button type="button" class="skill-row skill-pickrow${open ? ' open' : ''}" data-skill-open="${esc(key)}" aria-expanded="${open}"><span class="skill-caret" aria-hidden="true">›</span><span class="skill-name">${esc(s.name)}</span><span class="skill-desc${s.problem ? ' bad' : s.installs != null ? ' mono' : ''}" title="${esc(s.problem || s.desc || '')}">${esc(s.problem ? `Can't install: ${s.problem}` : s.desc || 'No description')}</span>${meta ? `<span class="skill-src">${esc(meta)}</span>` : ''}</button>${open ? skillPanelHtml(s) : ''}`;
  }).join('');
}
// skills.sh's security audits: one line that says how it went, the reviewers one by one underneath.
const AUDIT_HEAD = { pass: 'Passed the security audits on skills.sh', warn: 'Security audits on skills.sh: warnings', fail: 'Failed a security audit on skills.sh', unavailable: 'Not audited on skills.sh' };
function skillAuditHtml(a) {
  if (!a) return '';
  const counts = ['fail', 'warn', 'pass'].map((k) => [k, a.entries.filter((e) => e.status === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'pass' ? 'passed' : k === 'warn' ? `warning${n === 1 ? '' : 's'}` : 'failed'}`).join(' · ');
  const list = a.entries.map((e) => `<div class="audit-entry"><span class="audit-dot ${e.status}"></span><b>${esc(e.provider)}</b>${e.risk ? ` <span class="mono">${esc(e.risk.toLowerCase())}</span>` : ''}<span>${esc(e.summary)}</span>${e.at ? `<span class="mono">${esc(e.at)}</span>` : ''}</div>`).join('');
  return a.entries.length
    ? `<details class="skill-audit ${a.status}"><summary><span class="audit-dot ${a.status}"></span>${AUDIT_HEAD[a.status]} <span class="set-sub inline">${counts}</span></summary>${list}</details>`
    : `<div class="skill-audit unavailable"><span class="audit-dot unavailable"></span>${AUDIT_HEAD.unavailable}</div>`;
}
function skillPanelHtml(row) {
  const p = skillPanel;
  if (!p || p.state === 'loading') return '<div class="skill-review skill-detail"><span class="term-spinner" aria-hidden="true"></span> Loading the skill from GitHub…</div>';
  const s = p.skill, size = (files) => `${files.length} file${files.length === 1 ? '' : 's'} · ${Math.ceil(files.reduce((a, f) => a + f.size, 0) / 1024)} KB`;
  const files = s?.files ?? [];
  const head = `<p class="skill-about">${esc(s?.description || row.desc || '')}</p><div class="set-sub"><a href="https://github.com/${esc(row.source)}" target="_blank" rel="noopener">${esc(row.source)}</a>${files.length ? ` · ${size(files)}` : ''}${row.installs ? ` · ${fmtInstalls(row.installs)} installs on skills.sh` : ''}</div>`;
  const list = files.length ? `<details class="skill-files"><summary>Files</summary><div class="set-sub">${files.map((f) => `${esc(f.name)} <span class="mono">${f.size} B</span>`).join('<br>')}</div></details>` : '';
  const text = s?.text ? `<div class="md skill-text">${renderMarkdown(s.text)}</div>` : '';
  if (p.state === 'error') return `<div class="skill-review skill-detail">${head}${text}<div class="skill-why">Can't install: ${esc(p.error)}</div></div>`;
  const here = skillPlaceOf(s.name).includes(skillScope), risky = s.audit?.status === 'fail';
  return `<div class="skill-review skill-detail">${head}${skillAuditHtml(s.audit)}${list}${text}<div class="skill-install-row"><label>Install for <select data-skill-scope>${skillScopes.map((o) => `<option value="${esc(o.id)}"${o.id === skillScope ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>${here ? '<span class="skill-src">installed here</span>' : !p.token ? '' : `<button type="button" class="set-act skill-install${risky ? ' risky' : ''}" data-skill-install>${p.installing ? 'Installing…' : risky ? 'Install anyway' : 'Install'}</button>`}</div><div class="set-foot">${p.note ? esc(p.note) : 'Instructions from someone else: fx and Claude Code follow them, so read them first.'}</div></div>`;
}
async function openSkillRow(key) {
  if (skillOpen === key) { skillOpen = null; skillPanel = null; return renderSkillPick(); }
  const row = skillRows.find((s) => `${s.source}|${s.id}` === key); if (!row) return;
  skillOpen = key; skillPanel = { state: 'loading' }; renderSkillPick();
  try {
    const j = await skillApi('preview', { source: row.source, dirs: [row.id], scope: skillScope });
    if (skillOpen === key) skillPanel = { state: 'ready', token: j.token, skill: j.skills[0] };
  } catch (err) {
    // Not installable: still show what it is, when its SKILL.md can be read.
    const peek = await skillApi('peek', { source: row.source, dir: row.id }).catch(() => null);
    if (skillOpen === key) skillPanel = { state: 'error', error: err.message, skill: peek ? { text: peek.text, files: peek.files } : null };
  }
  if (skillOpen === key) renderSkillPick();
}
function skillsOpen() { return !$('#skill-view').classList.contains('hidden'); }
function openSkills() {
  if (skillsOpen()) return;
  closePages({ except: 'skill-view' });
  dictation.cancel();
  $('#skill-view').classList.remove('hidden');
  if (mobileLayout.matches) showMobileView('terminal');
  if (skillCount != null && !skillTab) showSkillTab(skillCount ? 'installed' : 'browse');
  renderSkillsEntry(); loadSkills();
  syncUrl(true);
}
function closeSkills({ sync = true } = {}) {
  if (!skillsOpen()) return;
  $('#skill-view').classList.add('hidden');
  renderSkillsEntry(); requestAnimationFrame(fitActive);
  if (sync) syncUrl(true);
}
$('#skills-entry').addEventListener('click', () => (skillsOpen() ? closeSkills() : openSkills()));
$('#skill-close').addEventListener('click', () => closeSkills());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && skillsOpen() && !e.defaultPrevented && !e.target.closest?.('input, select')) closeSkills(); });
$('#skill-view').addEventListener('click', (e) => { const t = e.target.closest('[data-skill-tab]'); if (t) showSkillTab(t.dataset.skillTab); });
$('#skill-repos').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-skill-view]');
  if (chip) return openSkillView(chip.dataset.skillView);
  if (!e.target.closest('[data-skill-other]')) return;
  $('#skill-other').classList.remove('hidden'); renderSkillChips(); $('#skill-source').focus();
});
$('#skill-other').addEventListener('submit', (e) => { e.preventDefault(); const src = $('#skill-source').value.trim(); if (src) openSkillView(src); });
let skillSearchTimer = 0;
$('#skills-search').addEventListener('input', () => {
  clearTimeout(skillSearchTimer);
  const q = $('#skills-search').value.trim();
  skillSearchTimer = setTimeout(() => (q.length >= 2 ? openSkillView('search', q) : !q && skillView === 'search' && openSkillView('popular')), 300);
});
$('#skill-pick').addEventListener('click', async (e) => {
  if (e.target.closest('a, select, details, .skill-audit')) return;
  const row = e.target.closest('[data-skill-open]');
  if (row) return openSkillRow(row.dataset.skillOpen);
  if (!e.target.closest('[data-skill-install]') || !skillPanel?.token || skillPanel.installing) return;
  const p = skillPanel, key = skillOpen;
  p.installing = true; renderSkillPick();
  try {
    const j = await skillApi('install', { token: p.token, scope: skillScope, confirmRisk: p.skill?.audit?.status === 'fail' });
    p.note = `Installed. New and resumed sessions of fx and Claude Code see ${j.installed.length === 1 ? 'it' : 'them'}.`;
  } catch (err) { p.note = /expired/i.test(err.message) ? 'This was open too long. Close it and open it again to install.' : err.message; }
  p.installing = false; p.token = null;
  await loadSkills();
  if (skillOpen === key) renderSkillPick();
});
$('#skill-pick').addEventListener('change', (e) => {
  if (!e.target.matches('[data-skill-scope]')) return;
  skillScope = e.target.value; renderSkillPick();
});
// Read opens the skill under its row; a second click closes it.
$('#skills-list').addEventListener('click', async (e) => {
  const read = e.target.closest('[data-skill-read]'), remove = e.target.closest('[data-skill-remove]');
  if (!read && !remove) return;
  const btn = read || remove, row = btn.closest('.skill-row');
  if (read && row.nextElementSibling?.classList.contains('skill-review')) { row.nextElementSibling.remove(); read.classList.remove('active'); return; }
  btn.disabled = true;
  try {
    if (read) {
      const j = await skillApi('read', { id: read.dataset.skillRead });
      row.insertAdjacentHTML('afterend', `<div class="skill-review"><span class="set-sub">${esc(shortPath(j.path))}${j.source ? ' · ' + esc(j.source) : ''}</span><div class="md skill-text">${renderMarkdown(j.text)}</div></div>`);
      read.classList.add('active');
    } else if (confirm('Remove this fox-installed skill? Any changes to its files will prevent removal.')) {
      await skillApi('remove', { id: remove.dataset.skillRemove });
      $('#skill-note').textContent = 'Removed. New and resumed sessions see the change.'; await loadSkills();
    }
  } catch (err) { $('#skill-note').textContent = err.message; } finally { btn.disabled = false; }
});
renderSkillsEntry(); loadSkills();
$('#sign-out').addEventListener('click', async () => {
  const response = await fetch('/api/auth/logout', { method: 'POST' });
  if (response.ok) location.replace('/');
});
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
const usageReports = new Map();
const money = (v) => '$' + Number(v).toFixed(2);
function renderNsUsage() {
  const [chosen] = nsSelection();
  const provider = chosen ?? modelsCatalog?.default?.provider;
  const report = usageReports.get(provider);
  const aged = report?.status === 'ready' && Date.now() - (report.fetchedAt ?? report.observedAt) >= 60_000;
  const state = $('#ns-usage-state'), box = $('#ns-usage-report');
  const supported = ['gateway', 'codex', 'grok'].includes(provider) && modelsCatalog?.providers?.some((p) => p.id === provider);
  $('#ns-usage-refresh').disabled = !supported || report?.status === 'loading';
  state.textContent = !provider ? '· choose a model' : !supported ? '· not available' : report?.status === 'loading' ? '· checking' : report?.status === 'stale' || aged ? '· stale' : report?.status === 'unavailable' ? '· unavailable' : report?.status === 'ready' ? '· observed' : '· not checked';
  state.classList.toggle('warn', report?.status === 'stale' || report?.status === 'unavailable' || aged);
  if (!supported) { box.textContent = provider ? 'No provider usage report for this connection.' : 'Choose a model provider to check usage.'; return; }
  if (!report?.data) { box.textContent = report?.status === 'loading' ? 'Checking…' : report?.status === 'unavailable' ? 'Usage unavailable. Try again later.' : 'Not checked'; return; }
  const d = report.data, lines = [];
  if (d.plan) lines.push(d.plan);
  if (d.budget) lines.push(`Budget ${money(d.budget.spent)} of ${money(d.budget.limit)}${d.budget.period ? ' · ' + d.budget.period : ''}`);
  if (d.spend != null) lines.push(`Today’s spend ${money(d.spend)}`);
  for (const w of d.limits ?? []) lines.push(`${w.name} · ${w.windowSeconds >= 86400 ? Math.round(w.windowSeconds / 86400) + 'd' : Math.round(w.windowSeconds / 3600) + 'h'} window · ${(100 - w.usedPercent).toFixed(1)}% remaining${w.resetsAt ? ' · resets ' + fmtTime(w.resetsAt) : ''}`);
  if (d.allowance) lines.push(`${(100 - d.allowance.usedPercent).toFixed(1)}% ${d.allowance.period ?? ''} allowance remaining${d.allowance.resetsAt ? ' · resets ' + fmtTime(d.allowance.resetsAt) : ''}`);
  if (d.credits != null) lines.push(`Credits ${d.credits}`);
  if (d.prepaidCents != null) lines.push(`Credits ${money(d.prepaidCents / 100)}`);
  if (d.onDemandCents != null) lines.push(`Pay as you go ${money(d.onDemandCents / 100)}${d.onDemandCapCents != null ? ' of ' + money(d.onDemandCapCents / 100) : ''}`);
  if (d.spendLimitReached) lines.push('Spend limit reached');
  lines.push(`Observed ${fmtTime(report.fetchedAt ?? report.observedAt)}${report.status === 'stale' ? ' · refresh failed; last-known report' : ''}`);
  box.replaceChildren(...lines.map((line) => { const item = document.createElement('span'); item.textContent = line; return item; }));
}
// The sheet can stay open past a report's TTL without any model change.
setInterval(() => { if (!$('#newsheet').classList.contains('hidden')) renderNsUsage(); }, 30_000);
$('#ns-usage-refresh').addEventListener('click', async () => {
  const [chosen] = nsSelection(), provider = chosen ?? modelsCatalog?.default?.provider;
  if (!provider) return;
  const old = usageReports.get(provider);
  usageReports.set(provider, { ...old, status: 'loading' }); renderNsUsage();
  try {
    const r = await fetch('/api/usage/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }) });
    usageReports.set(provider, r.ok ? await r.json() : old?.data ? { ...old, status: 'stale' } : { status: 'unavailable' });
  } catch { usageReports.set(provider, old?.data ? { ...old, status: 'stale' } : { status: 'unavailable' }); }
  renderNsUsage();
});
// Agents fox can start (fx, Claude Code…): only installed ones; the switch shows when there is a choice.
let harnessesCatalog = [{ id: 'fx', label: 'fx' }];
const nsHarness = () => $('#ns-agent').dataset.value || 'fx';
async function loadHarnesses() {
  try { harnessesCatalog = await (await fetch('/api/harnesses')).json(); } catch {}
  let chosen = 'fx';
  try { chosen = localStorage.getItem('fox.lastHarness') || 'fx'; } catch {}
  if (!harnessesCatalog.some((h) => h.id === chosen)) chosen = harnessesCatalog[0]?.id ?? 'fx';
  $('#ns-agent-row').classList.toggle('hidden', harnessesCatalog.length < 2);
  $('#ns-agent').innerHTML = harnessesCatalog.map((h) => `<button type="button" role="radio" data-harness="${esc(h.id)}">${esc(h.label)}</button>`).join('');
  return setNsHarness(chosen);
}
async function setNsHarness(id) {
  $('#ns-agent').dataset.value = id;
  $('#ns-claude-auth').classList.add('hidden');
  for (const b of $('#ns-agent').querySelectorAll('button')) { b.classList.toggle('on', b.dataset.harness === id); b.setAttribute('aria-checked', String(b.dataset.harness === id)); }
  if (id === 'fx') return loadModels();
  // Another harness: its own short model list, none of fx's provider, usage or speed options.
  const h = harnessesCatalog.find((x) => x.id === id);
  const sel = $('#ns-model');
  sel.innerHTML = `<option value="">${esc(h?.label ?? id)} default</option>` + (h?.models ?? []).map((m) => `<option value="${esc(id)}|${esc(m.id)}">${esc(m.name)}</option>`).join('');
  try { const last = localStorage.getItem(`fox.lastModel.${id}`); if (last && [...sel.options].some((o) => o.value === last)) sel.value = last; } catch {}
  for (const el of ['#ns-usage', '#ns-options', '#ns-auth']) $(el).classList.add('hidden');
  $('#ns-claude-auth').classList.toggle('hidden', id !== 'claude' || h?.signedIn !== false);
  updateNsBadge();
}
$('#ns-agent').addEventListener('click', (e) => { const b = e.target.closest('[data-harness]'); if (b) setNsHarness(b.dataset.harness).then(() => $('#ns-model').focus()); });
// Asked each time a sheet opens: the server answers from its cache and only lists again after an fx login.
async function loadModels(force = false) {
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
      for (const id of ids.sort(cmp)) { const o = document.createElement('option'); o.value = `${p.id}|${id}`; o.textContent = p.details?.find((m) => m.id === id)?.name || (p.id === 'gateway' ? modelShort(id) : id); g.appendChild(o); }
      sel.appendChild(g);
    }
  }
  $('#ns-auth').classList.toggle('hidden', (modelsCatalog.providers ?? []).length > 0);
  $('#ns-usage').classList.remove('hidden');
  try { const last = localStorage.getItem('fox.lastModel'); if (last && [...sel.options].some((o) => o.value === last)) sel.value = last; } catch {}
  updateNsBadge();
  renderNsUsage();
  return modelsCatalog;
}
function setNsCwd(cwd) {
  $('#newsheet').dataset.cwd = cwd;
  $('#ns-root-path').textContent = cwd;
  $('#ns-companions').classList.add('hidden');
  $('#ns-companion-list').replaceChildren();
  const wsp = workspaceFor(cwd);
  if (wsp && cwd === wsp.dir) { $('#ns-root-path').textContent = `${cwd} · includes every repo`; return; }
  // The server filters missing clones and symlinks; never infer access roots from sidebar data.
  if (wsp) fetch(`/api/companion-repos?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json()).then((repos) => {
    if ($('#newsheet').classList.contains('hidden') || $('#newsheet').dataset.cwd !== cwd || !Array.isArray(repos)) return;
    $('#ns-companions').classList.toggle('hidden', !repos.length);
    $('#ns-companion-list').innerHTML = repos.map((r) => `<label class="ns-companion"><input type="checkbox" value="${esc(r.dir)}"><span><strong>${esc(r.owner)}/${esc(r.name)}</strong><small>${esc(r.dir)}</small></span></label>`).join('');
  }).catch(() => {});
}
$('#ns-base').addEventListener('change', (e) => setNsCwd(e.target.value));
function newSessionSheet(cwd) {
  const wsp = workspaceFor(cwd);
  $('#ns-folder').textContent = wsp && cwd === wsp.dir ? wsp.name : shortPath(cwd);
  renderNsWorkspace(wsp);
  const base = $('#ns-base');
  base.classList.toggle('hidden', !wsp?.repos?.length);
  base.innerHTML = wsp ? `<option value="${esc(wsp.dir)}">Workspace root · all repos</option>${wsp.repos.filter((r) => r.status === 'ready').map((r) => `<option value="${esc(wsp.dir + '/' + r.dir)}">${esc(r.owner)}/${esc(r.name)}</option>`).join('')}` : '';
  if (wsp && ![...base.options].some((o) => o.value === cwd)) base.insertAdjacentHTML('afterbegin', `<option value="${esc(cwd)}">Current folder</option>`);
  if (wsp) base.value = cwd;
  $('#ns-usage').open = false;
  $('#newsheet').classList.remove('hidden');
  setNsCwd(cwd);
  // Fresh remote state for the repos, without merging anything: fetch, then show it.
  if (wsp) post(`/api/workspaces/${wsp.id}/fetch`).then(() => fetch('/api/workspaces')).then((r) => r.json()).then((list) => {
    state.workspaces = list;
    if (!$('#newsheet').classList.contains('hidden') && workspaceFor($('#newsheet').dataset.cwd)?.id === wsp.id) renderNsWorkspace(workspaceFor($('#newsheet').dataset.cwd));
  }).catch(() => {});
  loadHarnesses().then(() => $('#ns-model').focus());
}
// Workspace repos in the new-session sheet, and a warning when another session is working there.
function renderNsWorkspace(wsp) {
  const box = $('#ns-ws');
  box.classList.toggle('hidden', !wsp);
  if (!wsp) return (box.innerHTML = '');
  const busy = state.sessions.filter((s) => !s.archived && s.terminal && (s.state === 'working' || s.state === 'needs_input') && workspaceFor(s.workspace)?.id === wsp.id);
  box.innerHTML = `${busy.length ? `<div class="ws-busy">${busy.length === 1 ? 'Another session is working in this workspace' : `${busy.length} sessions are working in this workspace`}: they may edit the same files.</div>` : ''}`;
}
function nsSelection() {
  const v = $('#ns-model').value, at = v.indexOf('|');
  return at < 0 ? [null, null] : [v.slice(0, at), v.slice(at + 1)];
}
function updateNsBadge() {
  if (nsHarness() !== 'fx') {
    $('#ns-badge').innerHTML = modelBadge(nsSelection()[1] ?? 'claude');
    $('#ns-prov').innerHTML = ''; $('#ns-prov').title = '';
    return;
  }
  const [chosenProvider, chosenModel] = nsSelection();
  const provider = chosenProvider ?? modelsCatalog?.default?.provider, model = chosenModel ?? modelsCatalog?.default?.model;
  $('#ns-badge').innerHTML = modelBadge(model);
  $('#ns-prov').innerHTML = providerTag(provider); // who pays: subscription or Gateway
  $('#ns-prov').title = providerLabel(provider);
  renderNsUsage();
  const m = modelsCatalog?.providers?.find((p) => p.id === chosenProvider)?.details?.find((x) => x.id === chosenModel);
  const effort = $('#ns-effort'), speed = $('#ns-speed');
  effort.innerHTML = '<option value="">fx default</option>' + (m?.efforts ?? []).map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  speed.innerHTML = '<option value="default">fx default</option>' + (m?.fast ? '<option value="fast">Fast</option>' : '') + (m?.ultrafast ? '<option value="ultrafast">Ultrafast</option>' : '');
  $('#ns-options').classList.toggle('hidden', !m || (!m.efforts?.length && !m.fast && !m.ultrafast));
  $('#ns-speed-note').classList.add('hidden');
  effort.classList.toggle('hidden', !m?.efforts?.length);
  effort.previousElementSibling.classList.toggle('hidden', !m?.efforts?.length);
  speed.classList.toggle('hidden', !m?.fast && !m?.ultrafast);
  speed.previousElementSibling.classList.toggle('hidden', !m?.fast && !m?.ultrafast);
}
$('#ns-model').addEventListener('change', updateNsBadge);
$('#ns-speed').addEventListener('change', () => $('#ns-speed-note').classList.toggle('hidden', $('#ns-speed').value !== 'ultrafast'));
$('#ns-cancel').addEventListener('click', () => $('#newsheet').classList.add('hidden'));
$('#newsheet').addEventListener('click', (e) => { if (e.target.id === 'newsheet') $('#newsheet').classList.add('hidden'); });
$('#newform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cwd = $('#newsheet').dataset.cwd;
  const v = $('#ns-model').value, harness = nsHarness();
  try { localStorage.setItem(harness === 'fx' ? 'fox.lastModel' : `fox.lastModel.${harness}`, v); localStorage.setItem('fox.lastHarness', harness); } catch {}
  if (harness !== 'fx') {
    const addDirs = [...$('#ns-companion-list').querySelectorAll('input:checked')].map((input) => input.value);
    $('#newsheet').classList.add('hidden');
    return openTerminal({ cwd, harness, model: nsSelection()[1], addDirs });
  }
  const [provider, model] = nsSelection();
  const effort = provider ? $('#ns-effort').value || null : null;
  const speed = provider ? $('#ns-speed').value : null;
  const addDirs = [...$('#ns-companion-list').querySelectorAll('input:checked')].map((input) => input.value);
  $('#newsheet').classList.add('hidden');
  await openTerminal({ cwd, provider, model, effort, speed, addDirs });
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#newsheet').classList.contains('hidden')) $('#newsheet').classList.add('hidden'); });

// ---------- workspace dialog: one screen to start somewhere ----------
// New workspace: a name (also the folder) and, optionally, GitHub repos to clone; no repos is an empty folder.
// "Use an existing folder instead" opens fx in any folder you type (or pick in Finder on a Mac).
// Edit: add or remove repos (the name is the folder and stays), or delete the workspace.
const WS_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
// The GitHub mark next to each repo, so the list reads as "your GitHub repos" at a glance.
const GITHUB_MARK = '<svg class="gh-mark" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
// Names become folders, so they are written the way a folder name can be: as you type, "Mi Finanzas" turns into
// "mi-finanzas" (lowercase, no accents, spaces to dashes, nothing else).
const asFolderName = (v) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 63);
function folderNameInput(input) {
  input.addEventListener('input', () => {
    const v = asFolderName(input.value);
    if (v !== input.value) { input.value = v; input.setSelectionRange(v.length, v.length); }
  });
}
folderNameInput($('#ws-name'));
folderNameInput($('#jd-name'));
const repoKey = (r) => `${r.owner}/${r.name}`.toLowerCase();
const wsDlg = { mode: 'create', id: null, catalog: [], catalogError: null, loading: false, selected: new Map(), initial: new Set(), stage: 'pick', poll: 0, failedDir: null };
function wsView(view) { // 'create' | 'edit' | 'folder' | 'progress'
  $('#ws-create-fields').classList.toggle('hidden', view !== 'create');
  $('#ws-repo-fields').classList.toggle('hidden', view !== 'create' && view !== 'edit');
  $('#ws-folder-fields').classList.toggle('hidden', view !== 'folder');
  $('#ws-progress').classList.toggle('hidden', view !== 'progress');
  $('#ws-mode').classList.toggle('hidden', view !== 'create' && view !== 'folder');
  $('#ws-mode').textContent = view === 'folder' ? 'Create a workspace instead' : 'Use an existing folder instead';
  $('#ws-delete-open').classList.toggle('hidden', view !== 'edit');
  $('#ws-delete').classList.add('hidden');
  $('#ws-summary').classList.toggle('hidden', view === 'folder');
  $('#ws-submit').textContent = view === 'edit' ? 'Save' : view === 'folder' ? 'Open' : 'Create and open';
}
async function openWorkspaceDialog(id = null) {
  const wsp = id ? (state.workspaces ?? []).find((w) => w.id === id) : null;
  Object.assign(wsDlg, { mode: wsp ? 'edit' : 'create', id: wsp?.id ?? null, stage: 'pick', catalogError: null, failedDir: null });
  clearTimeout(wsDlg.poll);
  wsDlg.selected = new Map((wsp?.repos ?? []).map((r) => [repoKey(r), { owner: r.owner, name: r.name }]));
  wsDlg.initial = new Set(wsDlg.selected.keys());
  $('#ws-title').innerHTML = wsp ? `${esc(wsp.name)} <span class="ns-folder">${esc(shortPath(wsp.dir))}</span>` : 'New workspace';
  $('#ws-name').value = '';
  $('#ws-search').value = '';
  $('#ws-folder-path').value = ''; $('#ws-folder-hint').textContent = '';
  $('#ws-error').textContent = '';
  $('#ws-cancel').textContent = 'Cancel';
  $('#ws-submit').disabled = false;
  $('#ws-delete-path').textContent = wsp ? shortPath(wsp.dir) : '';
  $('#ws-finder').classList.toggle('hidden', foxConfig.remote);
  wsView(wsp ? 'edit' : 'create');
  $('#wsdialog').classList.remove('hidden');
  (wsp ? $('#ws-search') : $('#ws-name')).focus();
  if (!wsDlg.catalog.length) {
    wsDlg.loading = true; renderWsRepos();
    try {
      const r = await fetch('/api/repos'); const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not list your repos.');
      wsDlg.catalog = j;
    } catch (err) { wsDlg.catalogError = err.message; }
    wsDlg.loading = false;
  }
  renderWsRepos();
}
function renderWsRepos() {
  const box = $('#ws-repos');
  const raw = $('#ws-search').value.trim(), q = raw.toLowerCase();
  const known = new Set(wsDlg.catalog.flatMap((g) => g.repos.map(repoKey)));
  const row = (r, extra = '') => `<label class="ws-repo"><input type="checkbox" data-owner="${esc(r.owner)}" data-name="${esc(r.name)}" ${wsDlg.selected.has(repoKey(r)) ? 'checked' : ''}>${GITHUB_MARK}<span>${esc(r.name)}</span>${r.private ? '<span class="ws-lock" title="private">private</span>' : ''}${extra}</label>`;
  const matches = (r) => !q || repoKey(r).includes(q) || (r.description ?? '').toLowerCase().includes(q);
  let html = '';
  const extra = [...wsDlg.selected.values()].filter((r) => !known.has(repoKey(r)));
  if (extra.length) html += `<div class="ws-owner">Picked</div>${extra.map((r) => row(r, `<span class="ws-desc">${esc(r.owner)}</span>`)).join('')}`;
  const typed = raw.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (typed && !known.has(q) && !wsDlg.selected.has(q)) html += `<div class="ws-owner">Not in your list</div><label class="ws-repo"><input type="checkbox" data-owner="${esc(typed[1])}" data-name="${esc(typed[2])}"><span>${esc(typed[1])}/${esc(typed[2])}</span><span class="ws-desc">add by name</span></label>`;
  for (const g of wsDlg.catalog) {
    const repos = g.repos.filter(matches);
    if (repos.length) html += `<div class="ws-owner">${esc(g.owner)}</div>${repos.map((r) => row(r, r.description ? `<span class="ws-desc">${esc(r.description)}</span>` : '')).join('')}`;
  }
  if (!html) html = `<div class="ws-empty">${wsDlg.loading ? 'Loading your repos…' : wsDlg.catalogError ? esc(wsDlg.catalogError) + ' You can still type owner/repo.' : q ? 'No repo matches. Type owner/repo to add one by name.' : 'No repos found. Type owner/repo to add one by name.'}</div>`;
  box.innerHTML = html;
  updateWsSummary();
}
function updateWsSummary() {
  const n = wsDlg.selected.size, name = $('#ws-name').value.trim();
  const what = n ? `${n} repo${n === 1 ? '' : 's'}` : 'empty folder';
  $('#ws-summary').textContent = wsDlg.mode === 'create' ? `${name ? `~/workspaces/${name} · ` : ''}${what}` : what;
}
$('#ws-search').addEventListener('input', debounce(renderWsRepos, 120));
$('#ws-name').addEventListener('input', () => { $('#ws-error').textContent = ''; updateWsSummary(); });
$('#ws-repos').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
  const r = { owner: cb.dataset.owner, name: cb.dataset.name };
  cb.checked ? wsDlg.selected.set(repoKey(r), r) : wsDlg.selected.delete(repoKey(r));
  $('#ws-error').textContent = '';
  updateWsSummary();
});
$('#ws-mode').addEventListener('click', () => {
  const toFolder = wsDlg.mode !== 'folder';
  wsDlg.mode = toFolder ? 'folder' : 'create';
  $('#ws-error').textContent = '';
  wsView(wsDlg.mode);
  $(toFolder ? '#ws-folder-path' : '#ws-name').focus();
});
$('#ws-folder-path').addEventListener('input', debounce(async (e) => {
  const v = e.target.value.trim(), hint = $('#ws-folder-hint');
  if (!v) return (hint.textContent = '', hint.className = 'hint');
  const r = await (await fetch('/api/check-dir?path=' + encodeURIComponent(v))).json();
  hint.textContent = r.ok ? `✓ ${shortPath(r.path)}` : 'Folder not found';
  hint.className = 'hint ' + (r.ok ? 'ok' : 'err');
}, 250));
$('#ws-finder').addEventListener('click', async () => {
  const r = await post('/api/pick-folder');
  if (r.path) { $('#ws-folder-path').value = r.path; $('#ws-folder-path').dispatchEvent(new Event('input')); }
  else if (r.error) $('#ws-error').textContent = r.error;
});
const closeWorkspaceDialog = () => { clearTimeout(wsDlg.poll); $('#wsdialog').classList.add('hidden'); return refresh(); };
$('#ws-cancel').addEventListener('click', () => {
  const openAnyway = $('#ws-cancel').textContent === 'Open anyway' && wsDlg.failedDir;
  closeWorkspaceDialog();
  if (openAnyway) newSessionSheet(wsDlg.failedDir);
});
$('#wsdialog').addEventListener('click', (e) => { if (e.target.id === 'wsdialog') closeWorkspaceDialog(); });
$('#new-workspace').addEventListener('click', () => openWorkspaceDialog());
// Clone progress: one line per repo until every clone has finished; then open a session (new workspace) or close.
async function watchClones(id, { thenOpen }) {
  wsDlg.stage = 'progress';
  wsView('progress');
  $('#ws-submit').disabled = true; $('#ws-submit').textContent = 'Cloning…';
  const tick = async () => {
    let list = [];
    try { list = await (await fetch('/api/workspaces')).json(); } catch {}
    const w = list.find((x) => x.id === id);
    if (!w) { $('#ws-error').textContent = 'The workspace is gone.'; return; }
    state.workspaces = list;
    $('#ws-progress').innerHTML = w.repos.map((r) => wsRepoLine(r.status === 'ready' ? { ...r, changed: 0, ahead: 0, behind: 0 } : r).replace('<span class="ws-state "></span>', '<span class="ws-state ok">cloned</span>')).join('');
    if (w.repos.some((r) => r.status === 'cloning' || r.status === 'missing')) { wsDlg.poll = setTimeout(tick, 1200); return; }
    const failed = w.repos.filter((r) => r.status === 'error');
    if (!failed.length) {
      $('#wsdialog').classList.add('hidden'); refresh();
      if (thenOpen) newSessionSheet(w.dir);
      return;
    }
    $('#ws-error').textContent = `${failed.length === 1 ? 'One repo' : `${failed.length} repos`} could not be cloned (hover for the reason). The others are ready.`;
    Object.assign(wsDlg, { stage: 'failed', retryOpen: thenOpen, failedDir: w.dir });
    $('#ws-submit').disabled = false; $('#ws-submit').textContent = 'Retry';
    $('#ws-cancel').textContent = thenOpen ? 'Open anyway' : 'Close';
  };
  tick();
}
$('#wsform').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (wsDlg.stage === 'failed') { $('#ws-error').textContent = ''; $('#ws-cancel').textContent = 'Cancel'; await post(`/api/workspaces/${wsDlg.id}/retry`); return watchClones(wsDlg.id, { thenOpen: wsDlg.retryOpen }); }
  if (wsDlg.stage !== 'pick') return;
  if (wsDlg.mode === 'folder') {
    const v = $('#ws-folder-path').value.trim();
    if (!v) { $('#ws-error').textContent = 'Type the path of a folder.'; return $('#ws-folder-path').focus(); }
    const r = await (await fetch('/api/check-dir?path=' + encodeURIComponent(v))).json();
    if (!r.ok) { $('#ws-error').textContent = 'That folder does not exist.'; return; }
    $('#wsdialog').classList.add('hidden');
    return newSessionSheet(r.path);
  }
  const name = $('#ws-name').value.trim();
  if (wsDlg.mode === 'create' && !WS_NAME.test(name)) { $('#ws-error').textContent = 'Name it with lowercase letters, numbers, dots, dashes or underscores.'; return $('#ws-name').focus(); }
  $('#ws-submit').disabled = true;
  const body = wsDlg.mode === 'create'
    ? { name, repos: [...wsDlg.selected.values()] }
    : { add: [...wsDlg.selected].filter(([k]) => !wsDlg.initial.has(k)).map(([, r]) => r), remove: [...wsDlg.initial].filter((k) => !wsDlg.selected.has(k)).map((k) => { const [owner, n] = k.split('/'); return { owner, name: n }; }) };
  const r = await fetch(wsDlg.mode === 'create' ? '/api/workspaces' : `/api/workspaces/${wsDlg.id}`, { method: wsDlg.mode === 'create' ? 'POST' : 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#ws-submit').disabled = false; $('#ws-error').textContent = j.error || 'Could not save the workspace.'; return; }
  wsDlg.id = j.id;
  if (wsDlg.mode === 'create' && !body.repos.length) { await closeWorkspaceDialog(); return newSessionSheet(j.dir); }
  if (wsDlg.mode === 'create' || body.add.length) return watchClones(j.id, { thenOpen: wsDlg.mode === 'create' });
  closeWorkspaceDialog();
});
// Delete: two clear choices, no browser pop-up.
$('#ws-delete-open').addEventListener('click', () => { $('#ws-repo-fields').classList.add('hidden'); $('#ws-delete').classList.remove('hidden'); $('#ws-error').textContent = ''; });
$('#ws-delete-cancel').addEventListener('click', () => { $('#ws-delete').classList.add('hidden'); $('#ws-repo-fields').classList.remove('hidden'); });
async function deleteWorkspace(folder) {
  const r = await fetch(`/api/workspaces/${wsDlg.id}${folder ? '?folder=1' : ''}`, { method: 'DELETE' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#ws-error').textContent = j.error || 'Could not delete the workspace.'; return; }
  closeWorkspaceDialog();
}
$('#ws-remove-entry').addEventListener('click', () => deleteWorkspace(false));
$('#ws-delete-folder').addEventListener('click', () => deleteWorkspace(true));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#wsdialog').classList.contains('hidden')) closeWorkspaceDialog(); });

// ---------- jobs: a script on a schedule (see jobs.mjs) ----------
// One line in the sidebar ("Jobs · 3 · next Mon 09:00"); the list and each job open in the center.
state.jobs = []; state.jobView = null; // null: closed · 'list' · a job id
const runDur = (r) => r.endedAt ? jobDur(r.endedAt - r.startedAt) : jobDur(Date.now() - r.startedAt);
function jobDur(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`; }
function whenText(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date(), diff = ms - Date.now();
  if (diff > 0 && diff < 3600_000) return `in ${Math.max(1, Math.round(diff / 60_000))} min`;
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86400_000);
  return days === 0 ? `today ${hm}` : days === 1 ? `tomorrow ${hm}` : days === -1 ? `yesterday ${hm}` : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${hm}`;
}
const jobState = (j) => j.lastRun?.status === 'running' ? 'running' : !j.enabled ? 'paused' : j.lastRun?.status ?? 'none';
// Added from a terminal (fx, with fox-job): it waits for your OK before it ever runs.
const pausedText = (j) => j.pendingApproval ? 'needs your OK' : 'paused';
const BAD = ['failed', 'timeout', 'interrupted'];
// A pull request link says where it stands: ○ waiting for a merge, ✓ merged, struck through when closed unmerged.
const PR_TITLE = { open: 'Open: waiting for a merge', merged: 'Merged', closed: 'Closed without merging' };
const linkChips = (links = []) => links.filter((l) => /^https?:\/\//.test(l.url)).map((l) => `<a class="run-link${l.pr ? ' ' + l.pr : ''}" href="${esc(l.url)}" target="_blank" rel="noopener" data-link title="${esc(PR_TITLE[l.pr] ?? '')}">${esc(l.label)}</a>`).join('');
async function loadJobs() {
  try { state.jobs = await (await fetch('/api/jobs')).json(); } catch { return; }
  renderJobsEntry();
  renderSessions();
  if (state.jobView === 'list') renderJobList();
  else if (state.jobView) renderJobView();
}
function renderJobsEntry() {
  const jobs = state.jobs, btn = $('#jobs-entry');
  // The dot says what needs a look: one running, else one whose last run failed, else all fine.
  const worst = jobs.some((j) => jobState(j) === 'running') ? 'running' : jobs.some((j) => BAD.includes(jobState(j))) ? 'failed' : jobs.some((j) => jobState(j) === 'ok') ? 'ok' : 'none';
  const next = jobs.filter((j) => j.enabled && j.nextRun).map((j) => j.nextRun).sort((a, b) => a - b)[0];
  btn.classList.toggle('active', Boolean(state.jobView));
  btn.innerHTML = jobs.length
    ? `<span class="jdot ${worst}"></span><span class="jtitle">Jobs</span><span>${jobs.length}</span><span class="jnext">${worst === 'running' ? 'running' : next ? 'next ' + esc(whenText(next)) : ''}</span>`
    : '<span class="jdot none"></span><span class="jtitle">Jobs</span><span class="jnext">scripts on a schedule</span>';
}
function renderWsChip(el) {
  const w = wsFilter();
  el.classList.toggle('hidden', !w);
  el.textContent = w ? `${w.name} ×` : '';
}
function clearWsFilter() { state.wsFilter = null; if (state.prView) renderPrList(); if (state.jobView === 'list') renderJobList(); syncUrl(); }
function renderJobList() {
  const box = $('#job-list'), w = wsFilter();
  renderWsChip($('#job-ws'));
  const jobs = w ? state.jobs.filter((j) => jobWorkspace(j) === w) : state.jobs;
  const html = !state.jobs.length ? '<div class="jobs-none">No jobs yet. A job is a script on a schedule: New job to make one, or ask fx.</div>'
    : !jobs.length ? `<div class="jobs-none">No jobs for ${esc(w.name)}.</div>` : jobs.map((j) => {
    const st = jobState(j), r = j.lastRun;
    const right = st === 'running' ? `<span class="jnext running">running ${runDur(r)}</span>` : !j.enabled ? `<span class="jnext${j.pendingApproval ? ' approve' : ''}">${pausedText(j)}</span>` : `<span class="jnext">${esc(whenText(j.nextRun))}</span>`;
    // Last run: when, and whether it went well. The summary and its links live in the job's page.
    const last = r ? `<div class="jlast" title="${esc(r.summary ?? '')}"><span>last ${esc(whenText(r.startedAt))} · <b class="${r.status === 'running' ? '' : BAD.includes(r.status) ? 'bad' : 'ok'}">${r.status === 'running' ? 'running' : BAD.includes(r.status) ? 'failed' : 'ok'}</b></span></div>` : '<div class="jlast"><span>never ran</span></div>';
    return `<div class="jl-row" data-job="${j.id}" role="listitem"><span class="jdot ${st}"></span><span class="jname">${esc(j.name)}</span><span class="jwhen">${esc(j.scheduleText)}</span>${right}${last}</div>`;
  }).join('');
  if (html !== jobListHtml) { box.innerHTML = html; jobListHtml = html; } // polled: only when something changed
}
let jobListHtml = '';
$('#jobs-entry').addEventListener('click', () => { if (state.jobView) return closeJob(); state.wsFilter = null; openJobs(); });
$('#job-ws').addEventListener('click', clearWsFilter);
$('#job-list').addEventListener('click', (e) => { if (e.target.closest('[data-link]')) return; const row = e.target.closest('[data-job]'); if (row) openJob(row.dataset.job); });
function showJobView(mode) {
  closePages({ except: 'job-view' });
  dictation.cancel();
  $('#job-view').classList.remove('hidden');
  $('#job-view').dataset.mode = mode;
  if (mobileLayout.matches) showMobileView('terminal');
}
function openJobs() {
  state.jobView = 'list'; state.openRun = null;
  $('#job-name').textContent = 'Jobs';
  showJobView('list'); renderJobsEntry(); renderJobList();
  syncUrl(true);
}
function openJob(id) {
  state.jobView = id; state.openRun = null;
  showJobView('detail'); renderJobsEntry(); renderJobView();
  syncUrl(true);
}
function closeJob({ sync = true } = {}) { state.jobView = null; state.openRun = null; $('#job-view').classList.add('hidden'); renderJobsEntry(); requestAnimationFrame(fitActive); if (sync) syncUrl(true); }
$('#job-close').addEventListener('click', closeJob);
$('#job-back').addEventListener('click', openJobs);
$('#job-new').addEventListener('click', () => openJobDialog());
async function renderJobView() {
  const j = state.jobs.find((x) => x.id === state.jobView);
  if (!j) return openJobs();
  $('#job-name').textContent = j.name;
  $('#job-when').textContent = j.enabled ? j.scheduleText : `${j.scheduleText} · ${pausedText(j)}`;
  $('#job-pause').textContent = j.enabled ? 'Pause' : j.pendingApproval ? 'Approve' : 'Resume';
  $('#job-meta').textContent = `${shortPath(j.cwd)}/${j.script}${j.args?.length ? ' ' + j.args.join(' ') : ''} · ${j.tz} · ${j.model ? `${j.model}${j.effort ? ' ' + j.effort : ''} · ` : j.effort ? `effort ${j.effort} · ` : ''}stops after ${j.timeoutMin} min${j.enabled && j.nextRun ? ` · next ${whenText(j.nextRun)}` : ''}`;
  const runs = await (await fetch(`/api/jobs/${j.id}/runs`)).json().catch(() => []);
  if (state.jobView !== j.id) return;
  const box = $('#job-runs');
  const html = !runs.length ? '<div class="jobs-none">No runs yet. Run now to try it.</div>' : runs.map((r) => `<div class="run-row" data-run="${r.id}" role="listitem"><span class="jdot ${r.status}" title="${esc(r.status)}"></span><span class="rwhen">${esc(whenText(r.startedAt))}${r.reason === 'manual' ? ' · now' : ''}</span><span class="rsum ${BAD.includes(r.status) ? 'bad' : r.summary ? '' : 'quiet'}">${esc(r.summary ?? (r.status === 'running' ? 'running…' : r.status))}</span><span class="rlinks">${linkChips(r.links)}</span><span class="rdur">${runDur(r)}</span></div>${state.openRun === r.id ? '<div class="run-detail" id="run-detail"></div>' : ''}`).join('');
  // The page polls every few seconds: rebuild only when something changed, so an open log never blinks or jumps.
  if (html !== jobRunsHtml) { box.innerHTML = html; jobRunsHtml = html; }
  if (state.openRun) showRunDetail(j.id, runs.find((r) => r.id === state.openRun));
}
let jobRunsHtml = '';
const runDetails = new Map(); // run id -> { html, final }: a finished run's log is fetched once
// Logs are plain text; web addresses in them become links (escaped first, so nothing else turns into HTML).
const linkify = (text) => esc(text).replace(/https?:\/\/[^\s<>"'`)]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
async function showRunDetail(jobId, run) {
  const box = $('#run-detail'); if (!box || !run) return;
  const cached = runDetails.get(run.id);
  if (cached && box.innerHTML !== cached.html) box.innerHTML = cached.html; // at once, also right after a rebuild
  const details = await (await fetch(`/api/jobs/${jobId}/runs/${run.id}`)).json().catch(() => null);
  if (!details && cached?.final) return;
  const p = details?.provenance;
  const flag = (changed) => changed ? '<span class="run-changed">changed since run</span>' : '';
  const row = (label, value) => `<div class="run-input"><span>${label}</span><span>${value}</span></div>`;
  const inputs = p ? `<div class="run-inputs"><div class="run-input-title">Inputs at run start</div>
    ${row('Script', `<code>${esc(p.script)}</code> ${flag(details.scriptChanged)}`)}
    ${row('SHA-256', `<code>${esc(p.sha256 ?? 'unavailable')}</code>`)}
    ${row('Arguments', `<code>${esc(JSON.stringify(p.args ?? []))}</code>`)}
    ${row('Trigger', esc(p.trigger === 'manual' ? 'manual' : `scheduled${p.scheduledAt ? ' · ' + fmtTime(p.scheduledAt) : ''}`))}
    ${row('Schedule', `<code>${esc(JSON.stringify(p.schedule))}</code> · ${esc(p.tz ?? '')}`)}
    ${row('Model / effort', esc([p.model ?? 'default', p.effort ?? 'default'].join(' / ')))}
    ${row('fx', `<code>${esc(p.fxVersion ?? 'unavailable')}</code>`)}
    ${p.repos?.length ? p.repos.map((r) => row(`Repo ${esc(r.path)}`, `<code>${esc(r.head)}</code> ${r.dirty === null ? 'dirty unknown' : r.dirty ? 'dirty' : 'clean'} ${flag(details.reposChanged?.find((x) => x.path === r.path)?.changed)}`)).join('') : row('Repos', 'none found')}
  </div>` : '<div class="run-inputs muted">Inputs unavailable for this run.</div>';
  if (cached?.final && cached.inputs === inputs) return;
  const files = (run.outputs ?? []).map((o) => `<a href="/api/jobs/${jobId}/runs/${run.id}/files/${encodeURIComponent(o.name)}" target="_blank" rel="noopener">${esc(o.name)}</a>`).join('');
  const log = cached?.final ? cached.log : await (await fetch(`/api/jobs/${jobId}/runs/${run.id}/log`)).text().catch(() => null);
  if (log === null) return;
  const html = `${inputs}${files ? `<div class="run-files">${files}</div>` : ''}<pre>${log ? linkify(log) : '(no output)'}</pre>`;
  runDetails.set(run.id, { html, inputs, log, final: run.status !== 'running' });
  const now = $('#run-detail'); if (!now || state.openRun !== run.id || state.jobView !== jobId || now.innerHTML === html) return;
  // A running log grows: keep the reader where they were, or at the bottom if they were following it.
  const pre = now.querySelector('pre'), atEnd = pre && pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4, top = pre?.scrollTop ?? 0;
  now.innerHTML = html;
  const next = now.querySelector('pre'); if (next) next.scrollTop = atEnd ? next.scrollHeight : top;
}
$('#job-runs').addEventListener('click', (e) => {
  if (e.target.closest('[data-link]') || e.target.closest('.run-detail')) return;
  const row = e.target.closest('[data-run]'); if (!row) return;
  state.openRun = state.openRun === row.dataset.run ? null : row.dataset.run;
  renderJobView();
  syncUrl(true);
});
$('#job-run').addEventListener('click', async () => { await post(`/api/jobs/${state.jobView}/run`); toast('Starting…'); setTimeout(loadJobs, 1500); });
$('#job-pause').addEventListener('click', async () => {
  const j = state.jobs.find((x) => x.id === state.jobView); if (!j) return;
  await post(`/api/jobs/${j.id}`, { enabled: !j.enabled }, 'PATCH'); loadJobs();
});
$('#job-edit').addEventListener('click', () => openJobDialog(state.jobView));
loadJobs();
setInterval(loadJobs, 5000);

// ---------- pull requests: open work and merged history of the workspaces' repos ----------
// A row opens in place (the PR's text, its files, the review job's verdict). Merge and Close take two clicks: the
// first arms the button for a few seconds, so nothing that deploys or throws work away happens on a stray click.
const prKey = (p) => `${p.repo}#${p.number}`;
const prFiles = new Map();
const prActivity = new Map(), prActivityLoading = new Map();
let prFilter = 'open', prListHtml = '';
const prLimits = { merged: 50, all: 50 };
const prLoading = new Set(), prFailed = new Set();
async function loadPrs(force = false, filter = 'open') {
  prLoading.add(filter); prFailed.delete(filter);
  if (state.prView && prFilter === filter) renderPrList();
  const query = new URLSearchParams({ state: filter, ...(filter !== 'open' ? { limit: prLimits[filter] } : {}), ...(force ? { fresh: '' } : {}) });
  let ok = true;
  try {
    const response = await fetch(`/api/prs?${query}`);
    if (!response.ok) throw new Error('Could not load pull requests');
    const data = await response.json();
    if (filter === 'open') state.prs = data;
    else state[`${filter}Prs`] = data;
  } catch { ok = false; prFailed.add(filter); }
  prLoading.delete(filter);
  renderPrsEntry();
  if (filter === 'open') renderSessions();
  if (state.prView && prFilter === filter) renderPrList();
  return ok;
}
function renderPrsEntry() {
  const list = state.prs?.prs ?? [], ready = list.filter((p) => p.ready).length, btn = $('#prs-entry');
  btn.classList.remove('hidden');
  btn.classList.toggle('active', Boolean(state.prView));
  btn.innerHTML = `<span class="jdot ${ready ? 'ok' : list.length ? 'paused' : 'none'}"></span><span class="jtitle">Pull requests</span><span>${list.length || ''}</span><span class="jnext${ready ? ' ready' : ''}">${ready ? `${ready} ready` : list.length ? '' : 'none open'}</span>`;
}
const PR_REVIEW = { good: ['✓ reviewed', 'good'], fixed: ['✓ fixed by review', 'good'], 'needs-you': ['needs you', 'wait'], outdated: ['changed since review', 'wait'], reviewed: ['reviewed', ''] };
function prChip(p) {
  if (p.checks === 'failing') return '<span class="pr-chip bad">checks fail</span>';
  if (p.draft) return '<span class="pr-chip">paused</span>';
  if (!p.job) return '<span class="pr-chip">yours</span>';
  const [text, cls] = p.review ? PR_REVIEW[p.review.verdict] ?? PR_REVIEW.reviewed : ['not reviewed yet', 'wait'];
  return `<span class="pr-chip ${cls}">${text}</span>`;
}
// The PR's own text, formatted like fx's answers, without the job's footer lines (change size, made by…) and without
// terminal colour codes an agent pasted from its output (real ESC sequences, or written out as ^[[32m).
const ANSI = /(?:\x1b|\^\[)\[[0-9;]*m/g;
const prText = (body) => String(body ?? '').replace(ANSI, '').split(/\n\s*\n/).filter((para) => !/^(\*\*Change|Made by a fox job|Linear: |Merging publishes)/.test(para.trim())).join('\n\n').trim();
function renderPrList() {
  const data = (prFilter === 'open' ? state.prs : state[`${prFilter}Prs`]) ?? { prs: [], errors: [] }, box = $('#pr-list');
  for (const btn of $('#pr-filters').children) btn.classList.toggle('on', btn.dataset.prFilter === prFilter);
  $('#pr-more').classList.toggle('hidden', prFilter === 'open' || !data.hasMore);
  const w = wsFilter(), list = w ? data.prs.filter((p) => prWorkspace(p) === w) : data.prs;
  renderWsChip($('#pr-ws'));
  const repos = [...new Set(list.map((p) => p.repo))];
  $('#pr-repos').textContent = repos.length ? repos.join(' · ') : '';
  $('#pr-repos').classList.toggle('hidden', !repos.length);
  const rows = list.map((p) => {
    const key = prKey(p), open = state.prOpen === key;
    const status = String(p.state ?? (prFilter === 'merged' ? 'MERGED' : 'OPEN')).toLowerCase();
    const done = status !== 'open';
    const meta = [p.issue, p.repo.split('/')[1], ...(status === 'merged' && p.mergedAt ? [new Date(p.mergedAt).toLocaleDateString('en')] : [])].filter(Boolean).map(esc).join(' · ');
    const statusChip = prFilter === 'all' || done ? `<span class="pr-chip status ${status === 'merged' ? 'good' : ''}">${esc(status)}</span>` : prChip(p);
    const row = `<div class="pr-row${open ? ' open' : ''}${done ? ' done' : ''}${prFilter === 'all' ? ' all' : ''}" data-pr="${esc(key)}" role="listitem"><span class="jdot ${done ? status === 'merged' ? 'ok' : 'none' : p.ready ? 'ok' : p.checks === 'failing' ? 'failed' : 'paused'}"></span>`
      + `<span class="pt"><b>#${p.number}</b> ${esc(p.title.replace(/^[A-Z]+-\d+:\s*/, ''))} <span class="pm">· ${meta}</span></span>${statusChip}`
      + `<span class="plines"><span class="pr-add">+${p.additions}</span> <span class="pr-del">−${p.deletions}</span></span>`
      + (done ? '<span></span>' : p.draft
        ? `<span class="pr-acts"><button type="button" data-act="resume" title="Back to the queue: the review job looks at it again">Resume</button><button type="button" class="shut" data-act="close">Close</button></span>`
        : `<span class="pr-acts"><button type="button" class="merge" data-act="merge">Merge</button><button type="button" data-act="pause" title="Keep it for later: a draft, out of the agent's queue and the review job's">Later</button><button type="button" class="shut" data-act="close">Close</button></span>`) + '</div>';
    if (!open) return row;
    const files = prFiles.get(key);
    const filesHtml = files ? `<div class="pr-files">${files.map((x) => `<span class="pf" title="${esc(x.path)}">${esc(x.path)}</span><span class="pr-add">+${x.additions}</span><span class="pr-del">−${x.deletions}</span>`).join('')}</div>` : '<div class="muted">Loading files…</div>';
    const review = p.review ? `<div class="pr-review md ${esc(p.review.verdict)}"><b>fox review</b> ${renderMarkdown(p.review.text.replace(ANSI, ''))}</div>` : '';
    const text = prText(p.body);
    if (open && prActivity.has(key) && Date.now() - prActivity.get(key).at > (prActivity.get(key).errors?.length ? 15_000 : 60_000)) prActivity.delete(key);
    const activity = prActivity.get(key);
    const activityHtml = activity ? `<section class="pr-activity" aria-label="PR discussion"><div class="pr-activity-head"><b>Discussion</b><span>${activity.comments.length} ${activity.comments.length === 1 ? 'comment' : 'comments'}${activity.limited ? ' · first 100 per type' : ''}</span></div>
      ${activity.comments.length ? `<ol>${activity.comments.map((c) => {
        const url = /^https:\/\/github\.com\//.test(c.url ?? '') ? c.url : p.url;
        return `<li class="${c.afterVerdict ? 'after-verdict' : ''}"><div class="pr-comment-meta"><span class="pr-comment-kind">${c.type === 'job' ? 'fox review' : c.type === 'review' ? 'diff' : c.type === 'summary' ? 'review' : 'comment'}</span><b>${esc(c.author)}</b><time datetime="${esc(c.createdAt ?? '')}">${esc(c.createdAt ? fmtTime(c.createdAt) : 'unknown time')}</time>${c.afterVerdict ? '<span class="pr-comment-new">after review</span>' : ''}</div><a href="${esc(url)}" target="_blank" rel="noopener" class="pr-comment-body">${c.path ? `<span class="pr-comment-path">${esc(c.path)}</span> ` : ''}${esc(c.excerpt || '(no text)')} ↗</a></li>`;
      }).join('')}</ol>` : activity.errors?.length ? '' : '<div class="muted">No comments yet.</div>'}
      ${(activity.errors ?? []).map((e) => `<div class="pr-activity-error" role="status">Could not load ${e.type === 'review' ? 'diff' : e.type === 'summary' ? 'review' : 'PR'} comments: ${esc(e.error)}</div>`).join('')}
      </section>` : '<section class="pr-activity" aria-label="PR discussion"><b>Discussion</b><div class="muted">Loading comments…</div></section>';
    // What the job's run kept: the screenshots fx took of the change, and the run itself (log, files).
    const runUrl = p.run ? `/api/jobs/${encodeURIComponent(p.run.job)}/runs/${encodeURIComponent(p.run.run)}/files/` : '';
    // screenshot-option-a.png… are the alternatives fx mocked up; the others show what it built.
    const shotLabel = (n) => { const o = n.match(/^screenshot-option-([a-z0-9]+)\./i); return o ? `Option ${o[1].toUpperCase()}` : 'Built'; };
    const shots = p.run?.shots?.length ? `<div class="pr-shots">${p.run.shots.map((n) => `<figure><a href="${runUrl}${encodeURIComponent(n)}" target="_blank" rel="noopener"><img src="${runUrl}${encodeURIComponent(n)}" alt="${esc(n)}" loading="lazy" /></a><figcaption>${shotLabel(n)}</figcaption></figure>`).join('')}</div>` : '';
    return row + `<div class="pr-open">${text ? `<div class="pbody md">${renderMarkdown(text)}</div>` : ''}${shots}${filesHtml}${review}${activityHtml}`
      + `<div class="pr-links">${p.linear ? `<a class="pr-chip" href="${esc(p.linear)}" target="_blank" rel="noopener">${esc(p.issue ?? 'Linear')} ↗</a>` : ''}<a class="pr-chip" href="${esc(p.url)}" target="_blank" rel="noopener">GitHub ↗</a><a class="pr-chip" href="${esc(p.url)}/files" target="_blank" rel="noopener">diff ↗</a>${p.run ? `<a class="pr-chip" href="/?job=${encodeURIComponent(p.run.job)}&run=${encodeURIComponent(p.run.run)}">job run</a>` : ''}`
      + `${done ? '' : '<input class="pr-reason" placeholder="Why close it? Optional, it goes on the PR" maxlength="1000" />'}</div></div>`;
  });
  const errors = (data.errors ?? []).map((e) => `<div>${esc(e.repo)}: ${esc(e.error)}</div>`).join('');
  const empty = prLoading.has(prFilter) ? 'Loading pull requests…' : prFailed.has(prFilter) ? 'Could not load pull requests. Refresh to try again.' : `No ${prFilter} pull requests in ${w ? `${esc(w.name)}'s` : `your workspaces'`} repos.`;
  const html = (rows.join('') || `<div class="jobs-none" role="status">${empty}</div>`) + (errors ? `<div class="pr-errors">${errors}</div>` : '');
  // Polled: rebuild only when something changed, and never under someone typing why they close a PR.
  const typing = document.activeElement?.classList.contains('pr-reason') && box.contains(document.activeElement);
  if (html !== prListHtml && !typing) { box.innerHTML = html; prListHtml = html; }
  if (state.prOpen && !prFiles.has(state.prOpen)) loadPrFiles(state.prOpen);
  if (state.prOpen && !prActivity.has(state.prOpen) && !prActivityLoading.has(state.prOpen)) loadPrActivity(state.prOpen);
}
async function loadPrActivity(key, force = false) {
  const request = {};
  prActivityLoading.set(key, request);
  const [repo, n] = key.split('#');
  try {
    const response = await fetch(`/api/prs/${repo}/${n}/detail${force ? '?fresh' : ''}`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'GitHub unavailable');
    const detail = await response.json();
    if (prActivityLoading.get(key) === request) prActivity.set(key, { ...detail, at: Date.now() });
  } catch (err) {
    if (prActivityLoading.get(key) === request) prActivity.set(key, { at: Date.now(), comments: [], errors: [{ type: 'discussion', error: err.message }] });
  }
  if (prActivityLoading.get(key) !== request) return;
  prActivityLoading.delete(key);
  if (state.prView && state.prOpen === key) renderPrList();
}
async function loadPrFiles(key) {
  const [repo, n] = key.split('#');
  try { prFiles.set(key, await (await fetch(`/api/prs/${repo}/${n}/files`)).json()); } catch { prFiles.set(key, []); }
  if (state.prView && state.prOpen === key) renderPrList();
}
function openPrs() {
  closePages({ except: 'pr-view' });
  dictation.cancel();
  state.prView = true;
  $('#pr-view').classList.remove('hidden');
  if (mobileLayout.matches) showMobileView('terminal');
  renderPrsEntry(); loadPrs(true, prFilter);
  syncUrl(true);
}
function closePrs({ sync = true } = {}) {
  if (!state.prView) return;
  state.prView = false; state.prOpen = null;
  $('#pr-view').classList.add('hidden');
  renderPrsEntry(); requestAnimationFrame(fitActive);
  if (sync) syncUrl(true);
}
$('#prs-entry').addEventListener('click', () => { if (state.prView) return closePrs(); state.wsFilter = null; openPrs(); });
$('#pr-ws').addEventListener('click', clearWsFilter);
$('#pr-close').addEventListener('click', () => closePrs());
$('#pr-refresh').addEventListener('click', () => {
  prFiles.clear(); prActivity.clear(); prActivityLoading.clear();
  if (state.prOpen) loadPrActivity(state.prOpen, true);
  loadPrs(true, prFilter);
});
$('#pr-filters').addEventListener('click', (e) => {
  const filter = e.target.closest('[data-pr-filter]')?.dataset.prFilter;
  if (!filter || filter === prFilter) return;
  prFilter = filter; state.prOpen = null;
  loadPrs(false, filter);
});
$('#pr-more').addEventListener('click', async () => {
  const btn = $('#pr-more'); btn.disabled = true; btn.textContent = 'Loading…';
  const filter = prFilter;
  prLimits[filter] += 50;
  if (!await loadPrs(false, filter)) { prLimits[filter] -= 50; toast('Could not load more pull requests'); }
  btn.disabled = false; btn.textContent = 'Load more';
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.prView && !e.defaultPrevented && !e.target.closest?.('input')) closePrs(); });
$('#pr-list').addEventListener('click', async (e) => {
  if (e.target.closest('a, input')) return;
  const rowEl = e.target.closest('[data-pr]'); if (!rowEl) return;
  const key = rowEl.dataset.pr, btn = e.target.closest('[data-act]');
  if (!btn) { state.prOpen = state.prOpen === key ? null : key; renderPrList(); syncUrl(true); return; }
  const p = (prFilter === 'open' ? state.prs?.prs : state[`${prFilter}Prs`]?.prs)?.find((x) => prKey(x) === key);
  if (!p || p.state !== 'OPEN') return;
  const act = btn.dataset.act;
  // Later and Resume only switch the PR between ready and paused (a draft): undoable, so one click.
  if ((act === 'pause' || act === 'resume') && !btn.classList.contains('armed')) btn.classList.add('armed');
  if (!btn.classList.contains('armed')) {
    const unreviewed = act === 'merge' && p.job && (!p.review || p.review.verdict === 'outdated');
    btn.classList.add('armed'); btn.textContent = act === 'merge' ? (unreviewed ? 'Not reviewed yet. Merge?' : 'Merge?') : 'Close?';
    btn.title = act === 'merge' ? `Click again to merge #${p.number} into its base. It deploys if that branch is deployed.` : `Click again to close #${p.number} without merging.`;
    setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = act === 'merge' ? 'Merge' : 'Close'; } }, 4000);
    return;
  }
  btn.disabled = true; btn.textContent = { merge: 'Merging…', close: 'Closing…', pause: 'Pausing…', resume: 'Resuming…' }[act];
  const reason = act === 'close' ? ($('#pr-list .pr-open .pr-reason')?.value ?? '') : '';
  const [repo, n] = key.split('#');
  const r = await fetch(`/api/prs/${repo}/${n}/${act}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { toast(out.error || `Could not ${act} #${p.number}`); btn.disabled = false; btn.classList.remove('armed'); btn.textContent = { merge: 'Merge', close: 'Close', pause: 'Later', resume: 'Resume' }[act]; return; }
  toast({ merge: `Merged #${p.number}`, close: `Closed #${p.number}`, pause: `#${p.number} paused for later`, resume: `#${p.number} back in the queue` }[act]);
  if (state.prOpen === key) state.prOpen = null;
  prFiles.delete(key); prActivity.delete(key);
  await loadPrs(true, prFilter);
  if (prFilter !== 'open') loadPrs(true);
  syncUrl();
});
loadPrs();
setInterval(() => loadPrs(), 60_000);

// ---------- apps (named apps, see apps.mjs) ----------
// What is published at https://<name>.<domain>: a list like Jobs. A command app opens to its log.
let appOpen = null, appListHtml = '';
function appsOpen() { return !$('#app-view').classList.contains('hidden'); }
const APP_KIND = { dir: 'folder', cmd: 'command', port: 'port' };
const appDot = (a) => (a.status === 'up' ? 'ok' : a.status === 'down' ? 'failed' : 'paused');
async function loadApps() {
  try { state.apps = await (await fetch('/api/apps')).json(); } catch { return; }
  renderAppsEntry();
  if (appsOpen()) renderAppList();
}
function renderAppsEntry() {
  const d = state.apps, btn = $('#apps-entry');
  btn.classList.toggle('hidden', !d?.enabled);
  if (!d?.enabled) return;
  const apps = d.apps, down = apps.filter((a) => a.status === 'down').length, paused = apps.filter((a) => a.paused).length;
  btn.classList.toggle('active', appsOpen());
  btn.innerHTML = `<span class="jdot ${down ? 'failed' : apps.some((a) => a.status === 'up') ? 'ok' : 'none'}"></span><span class="jtitle">Apps</span><span>${apps.length || ''}</span><span class="jnext${down ? ' bad' : ''}">${down ? `${down} down` : paused ? `${paused} paused` : apps.length ? '' : 'none yet'}</span>`;
}
function appDetail(a) {
  return a.dir ? `serves the folder ${esc(shortPath(a.dir))}` : a.cmd ? `runs <code>${esc(a.cmd)}</code> in ${esc(shortPath(a.cwd))} on :${a.port}${a.restarts ? ` · started again ${a.restarts}×` : ''}` : `forwards to :${a.port}; something else keeps that server running`;
}
function renderAppList() {
  const apps = state.apps?.apps ?? [];
  $('#app-count').textContent = apps.length ? String(apps.length) : '';
  const html = !apps.length ? '<div class="jobs-none">Nothing published yet. Ask fx or Claude to publish a page or a tool, or run <code>fox-expose</code> on the server. Every app is private to you.</div>' : apps.map((a) => {
    const open = appOpen === a.name;
    return `<div class="app-row ${a.paused ? 'paused' : ''} ${open ? 'open' : ''}" data-app="${esc(a.name)}" role="listitem">
      <span class="jdot ${appDot(a)}" title="${esc(a.status)}"></span><span class="jname">${esc(a.name)}</span>
      <a class="app-url" href="${esc(a.url)}" target="_blank" rel="noopener" data-link>${esc(a.url.replace(/^https:\/\//, ''))}</a>
      <span class="app-kind">${APP_KIND[a.kind]}</span>
      <span class="app-actions">${a.paused ? '' : `<a class="app-act" href="${esc(a.url)}" target="_blank" rel="noopener" data-link title="Open">↗</a>`}<button type="button" class="app-act" data-app-act="${a.paused ? 'resume' : 'pause'}">${a.paused ? 'resume' : 'pause'}</button><button type="button" class="app-act" data-app-menu aria-label="More">⋯</button></span>
      ${open ? `<div class="app-detail"><div class="app-what">${a.status === 'down' ? '<b class="bad">Not answering.</b> ' : ''}${appDetail(a)}</div>${a.kind === 'cmd' ? '<pre class="app-log" id="app-log">loading…</pre>' : ''}</div>` : ''}
    </div>`;
  }).join('');
  if (html === appListHtml) return; // polled: rebuild only when something changed, so an open log does not jump
  appListHtml = html;
  $('#app-list').innerHTML = html;
  if (appOpen && apps.find((a) => a.name === appOpen)?.kind === 'cmd') loadAppLog(appOpen);
}
async function loadAppLog(name) {
  const j = await (await fetch(`/api/apps/${encodeURIComponent(name)}/log`)).json().catch(() => ({}));
  const box = $('#app-log');
  if (!box || appOpen !== name) return;
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.textContent = j.text?.trim() || 'Nothing printed yet.';
  if (atEnd) box.scrollTop = box.scrollHeight;
}
async function appAction(name, action) {
  const a = state.apps?.apps.find((x) => x.name === name);
  if (action === 'remove' && !confirm(`Remove ${name}? ${a?.url ?? ''} stops answering.${a?.kind === 'cmd' ? ' Its command stops.' : ''} The files stay where they are.`)) return;
  const r = await fetch(`/api/apps/${encodeURIComponent(name)}${action === 'remove' ? '' : '/' + action}`, { method: action === 'remove' ? 'DELETE' : 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || 'Could not do that');
  if (action === 'remove' && appOpen === name) appOpen = null;
  state.apps = j; renderAppsEntry(); renderAppList();
  toast(action === 'pause' ? `${name} paused` : action === 'resume' ? `${name} is back` : action === 'restart' ? `${name} restarting` : `${name} removed`);
}
function openApps() {
  if (appsOpen()) return;
  closePages({ except: 'app-view' });
  dictation.cancel();
  $('#app-view').classList.remove('hidden');
  if (mobileLayout.matches) showMobileView('terminal');
  appListHtml = ''; renderAppsEntry(); renderAppList(); loadApps();
  syncUrl(true);
}
function closeApps({ sync = true } = {}) {
  if (!appsOpen()) return;
  $('#app-view').classList.add('hidden');
  renderAppsEntry(); requestAnimationFrame(fitActive);
  if (sync) syncUrl(true);
}
$('#apps-entry').addEventListener('click', () => (appsOpen() ? closeApps() : openApps()));
$('#app-close').addEventListener('click', () => closeApps());
$('#app-list').addEventListener('click', (e) => {
  if (e.target.closest('[data-link]')) return;
  const row = e.target.closest('[data-app]');
  if (!row) return;
  const name = row.dataset.app, act = e.target.closest('[data-app-act]')?.dataset.appAct;
  if (act) return appAction(name, act);
  const menu = e.target.closest('[data-app-menu]');
  if (menu) {
    const a = state.apps.apps.find((x) => x.name === name);
    const items = [...(a?.kind === 'cmd' && !a.paused ? [['restart', 'Restart']] : []), ['remove', 'Remove']];
    return showAppMenu(menu, items, (choice) => appAction(name, choice));
  }
  appOpen = appOpen === name ? null : name;
  appListHtml = ''; renderAppList();
});
// A small menu next to ⋯ (closes on any other click or Esc).
function showAppMenu(anchor, items, pick) {
  document.querySelector('.app-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'app-menu';
  m.innerHTML = items.map(([k, label]) => `<button type="button" data-k="${k}" class="${k === 'remove' ? 'bad' : ''}">${label}</button>`).join('');
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 4}px`; m.style.left = `${Math.max(8, r.right - 140)}px`;
  document.body.appendChild(m);
  const close = () => { m.remove(); document.removeEventListener('click', away, true); };
  const away = (ev) => { if (!m.contains(ev.target)) close(); };
  m.addEventListener('click', (ev) => { const k = ev.target.closest('[data-k]')?.dataset.k; if (k) { close(); pick(k); } });
  setTimeout(() => document.addEventListener('click', away, true));
}
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.app-menu')) { document.querySelector('.app-menu').remove(); return; }
  if (appsOpen() && !e.defaultPrevented && !e.target.closest?.('input')) closeApps();
});
loadApps();
setInterval(() => { if (appsOpen() || document.visibilityState === 'visible') loadApps(); if (appsOpen() && appOpen) loadAppLog(appOpen); }, 8000);

// The editor: the schedule is built with buttons and drawn on a 24-hour line, with the next runs written out.
const jd = { id: null, kind: 'hours', days: new Set([1, 2, 3, 4, 5]) };
function jdSchedule() {
  const days = [...jd.days].sort();
  if (jd.kind === 'hours') return { kind: 'hours', every: Number($('#jd-every').value), from: $('#jd-from').value, to: $('#jd-to').value, days };
  if (jd.kind === 'daily') return { kind: 'daily', at: $('#jd-at').value, days };
  return { kind: 'once', date: $('#jd-date').value, at: $('#jd-once-at').value };
}
function jdRenderWhen() {
  for (const b of $('#jd-kind').children) b.classList.toggle('on', b.dataset.kind === jd.kind);
  for (const b of $('#jd-days').children) b.classList.toggle('on', jd.days.has(Number(b.dataset.day)));
  $('.jd-when').dataset.kind = jd.kind;
  $('#jd-days').classList.toggle('off', jd.kind === 'once');
  jdPreview();
}
const jdPreview = debounce(async () => {
  const s = jdSchedule(), strip = $('#jd-strip');
  const pct = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return ((h * 60 + m) / 1440) * 100; };
  let html = '';
  if (s.kind === 'hours' && s.every > 0) {
    html += `<div class="band" style="left:${pct(s.from)}%;width:${Math.max(0, pct(s.to) - pct(s.from))}%"></div>`;
    for (let t = pct(s.from); t <= pct(s.to) + 0.01; t += (s.every * 60 / 1440) * 100) html += `<div class="tick" style="left:${t}%"></div>`;
  } else if (s.at) html += `<div class="tick" style="left:${pct(s.at)}%"></div>`;
  strip.innerHTML = html;
  const r = await post('/api/jobs/preview', { schedule: s, tz: $('#jd-tz').value.trim() }).catch(() => ({}));
  $('#jd-next').textContent = r.error ? '' : r.next?.length ? `Next: ${r.next.map(whenText).join(' · ')}` : 'No upcoming runs.';
  $('#jd-summary').textContent = r.text ?? '';
  $('#jd-error').textContent = r.error ?? '';
}, 200);
$('#jd-kind').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) { jd.kind = b.dataset.kind; jdRenderWhen(); } });
$('#jd-days').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (!b) return; const d = Number(b.dataset.day); jd.days.has(d) ? jd.days.delete(d) : jd.days.add(d); jdRenderWhen(); });
for (const id of ['#jd-every', '#jd-from', '#jd-to', '#jd-at', '#jd-date', '#jd-once-at', '#jd-tz']) $(id).addEventListener('input', jdPreview);
async function jdLoadScripts(selected = '') {
  const cwd = jdCwd(), sel = $('#jd-script');
  const scripts = cwd ? await (await fetch('/api/jobs/scripts?cwd=' + encodeURIComponent(cwd))).json().catch(() => []) : [];
  sel.innerHTML = scripts.length ? scripts.map((x) => `<option ${x === selected ? 'selected' : ''}>${esc(x)}</option>`).join('') : '<option value="">No .py, .mjs, .js or .sh scripts here</option>';
  if (selected && !scripts.includes(selected)) sel.insertAdjacentHTML('afterbegin', `<option selected>${esc(selected)}</option>`);
}
// The models of fx's active provider: `fx ask` in a job uses that one (a Gateway id fails on a ChatGPT login), plus
// whatever the job already has, so editing never drops it.
async function jdModels(selected) {
  const sel = $('#jd-model');
  sel.innerHTML = `<option value="">script's choice</option>${selected ? `<option selected>${esc(selected)}</option>` : ''}`;
  const cat = await loadModels().catch(() => null);
  if (!cat) return;
  const cmp = (x, y) => x.localeCompare(y, 'en', { numeric: true });
  sel.innerHTML = '<option value="">script\'s choice</option>' + (cat.providers ?? []).filter((p) => !cat.default?.provider || p.id === cat.default.provider).map((p) =>
    `<optgroup label="${esc(p.label)}">${[...p.models].sort(cmp).map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}</optgroup>`).join('');
  if (selected && ![...sel.options].some((o) => o.value === selected)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(selected)}">${esc(selected)}</option>`);
  sel.value = selected;
}
const jdCwd = () => $('#jd-folder').value === '__other' ? $('#jd-cwd').value.trim() : $('#jd-folder').value;
$('#jd-folder').addEventListener('change', () => { $('#jd-cwd').classList.toggle('hidden', $('#jd-folder').value !== '__other'); jdLoadScripts(); });
$('#jd-cwd').addEventListener('input', debounce(() => jdLoadScripts(), 300));
async function openJobDialog(id = null) {
  const j = id ? state.jobs.find((x) => x.id === id) : null;
  jd.id = j?.id ?? null;
  state.jobDialog = j?.id ?? 'new';
  $('#jd-title').textContent = j ? `Edit ${j.name}` : 'New job';
  $('#jd-submit').textContent = j ? 'Save' : 'Create';
  $('#jd-delete-open').classList.toggle('hidden', !j);
  $('#jd-delete').classList.add('hidden');
  $('#jd-error').textContent = '';
  $('#jd-name').value = j?.name ?? '';
  const folders = (state.workspaces ?? []).map((w) => [w.dir, w.name]);
  const cwd = j?.cwd ?? folders[0]?.[0] ?? '';
  const known = folders.some(([d]) => d === cwd);
  $('#jd-folder').innerHTML = folders.map(([d, n]) => `<option value="${esc(d)}" ${d === cwd ? 'selected' : ''}>${esc(n)}</option>`).join('') + `<option value="__other" ${cwd && !known ? 'selected' : ''}>Other folder…</option>`;
  $('#jd-cwd').value = cwd && !known ? cwd : '';
  $('#jd-cwd').classList.toggle('hidden', !(cwd && !known) && folders.length > 0);
  if (!folders.length) $('#jd-folder').value = '__other';
  $('#jd-workspace').innerHTML = `<option value="">Its folder's</option>` + (state.workspaces ?? []).map((w) => `<option value="${esc(w.name)}">${esc(w.name)}</option>`).join('')
    + (j?.workspace && !workspaceNamed(j.workspace) ? `<option value="${esc(j.workspace)}">${esc(j.workspace)} (missing)</option>` : '');
  $('#jd-workspace').value = j?.workspace ?? '';
  $('#jd-args').value = (j?.args ?? []).join(' ');
  const s = j?.schedule ?? { kind: 'hours', every: 2, from: '09:00', to: '19:00', days: [1, 2, 3, 4, 5] };
  jd.kind = s.kind; jd.days = new Set(s.days ?? [1, 2, 3, 4, 5, 6, 7]);
  if (s.kind === 'hours') { $('#jd-every').value = s.every; $('#jd-from').value = s.from; $('#jd-to').value = s.to; }
  if (s.kind === 'daily') $('#jd-at').value = s.at;
  if (s.kind === 'once') { $('#jd-date').value = s.date; $('#jd-once-at').value = s.at; }
  if (!$('#jd-date').value) $('#jd-date').value = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  $('#jd-tz').value = j?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('#jd-timeout').value = j?.timeoutMin ?? 30;
  $('#jd-effort').value = j?.effort ?? '';
  jdModels(j?.model ?? '');
  $('#jobdialog').classList.remove('hidden');
  await jdLoadScripts(j?.script ?? '');
  jdRenderWhen();
  $('#jd-name').focus();
  syncUrl(true);
}
function closeJobDialog() {
  if (!state.jobDialog) return;
  state.jobDialog = null;
  $('#jobdialog').classList.add('hidden');
  syncUrl(true);
}
$('#jd-cancel').addEventListener('click', closeJobDialog);
$('#jobdialog').addEventListener('click', (e) => { if (e.target.id === 'jobdialog') closeJobDialog(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#jobdialog').classList.contains('hidden')) closeJobDialog(); });
$('#jobform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('#jd-name').value.trim(), cwd: jdCwd(), script: $('#jd-script').value, args: $('#jd-args').value.trim() ? $('#jd-args').value.trim().split(/\s+/) : [],
    schedule: jdSchedule(), tz: $('#jd-tz').value.trim(), timeoutMin: Number($('#jd-timeout').value),
    model: $('#jd-model').value, effort: $('#jd-effort').value, workspace: $('#jd-workspace').value };
  const r = await fetch(jd.id ? `/api/jobs/${jd.id}` : '/api/jobs', { method: jd.id ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#jd-error').textContent = j.error || 'Could not save the job.'; return; }
  closeJobDialog();
  await loadJobs();
  openJob(j.id);
});
$('#jd-delete-open').addEventListener('click', () => $('#jd-delete').classList.remove('hidden'));
$('#jd-delete-no').addEventListener('click', () => $('#jd-delete').classList.add('hidden'));
$('#jd-delete-yes').addEventListener('click', async () => {
  const r = await fetch(`/api/jobs/${jd.id}`, { method: 'DELETE' });
  if (!r.ok) { $('#jd-error').textContent = (await r.json().catch(() => ({}))).error || 'Could not delete the job.'; return; }
  closeJobDialog(); openJobs(); loadJobs();
});

// ---------- memory (servers): how full the machine is, and a way to free it ----------
const fmtGb = (mb) => (mb / 1024).toFixed(1);
let memHighPct = 85;
function showMemory(m) {
  $('#mem').classList.toggle('hidden', !m);
  $('#mem-free').classList.toggle('hidden', !m);
  if (!m) return;
  $('#mem-text').textContent = `${m.pct}% · ${fmtGb(m.usedMb)}/${fmtGb(m.totalMb)} GB`;
  $('#mem-fill').style.width = `${Math.min(100, m.pct)}%`;
  // Green while there is room, orange approaching the limit, red where fox starts freeing memory on its own.
  const high = memHighPct || 85;
  $('#mem').classList.remove('ok', 'warm', 'high');
  $('#mem').classList.add(m.pct >= high ? 'high' : m.pct >= high - 15 ? 'warm' : 'ok');
  $('#mem').title = `Memory in use on this machine (page cache counts as free). From ${high}% fox puts idle sessions to sleep on its own.`;
}
async function pollMemory() {
  try { const r = await (await fetch('/api/memory')).json(); if (r.highPct >= 0) memHighPct = r.highPct; showMemory(r.memory); } catch {}
}
pollMemory();
setInterval(pollMemory, 10_000);
$('#mem-free').addEventListener('click', async () => {
  const btn = $('#mem-free');
  if (btn.disabled) return;
  btn.disabled = true; // an icon now: what happened shows as a toast
  try {
    const r = await post('/api/memory/free');
    if (r.memory) showMemory(r.memory);
    toast(r.slept ? `Slept ${r.slept} · ${r.freedMb ? `${fmtGb(r.freedMb)} GB freed` : 'done'}` : 'Nothing idle to sleep');
    refresh();
  } catch { toast('Could not free memory'); }
  setTimeout(() => { btn.disabled = false; }, 4000);
});

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
  if (code === 'KeyT' || code === 'KeyN') { const ws = currentWorkspace(); if (ws) newSessionSheet(ws); else openWorkspaceDialog(); }
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
fetch('/api/auth/status').then((response) => response.ok ? response.json() : null).then((info) => {
  if (info?.registered) $('#pair-phone').classList.add('hidden');
  else if (!info) $('#sign-out').classList.add('hidden');
}).catch(() => {});
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

// ---------- a workspace repo's branch (branches.mjs): back to main, another branch, update, a new one ----------
// The copy is shared by every session in the workspace, so the server refuses while one works, and uncommitted work is
// only ever moved into a wip/ branch (after asking), never dropped.
let branchMenu = null;
function closeBranchMenu() { branchMenu?.remove(); branchMenu = null; }
async function openBranchMenu(anchor, wsId, dir) {
  closeBranchMenu();
  const menu = branchMenu = document.createElement('div');
  menu.className = 'branch-menu'; menu.setAttribute('role', 'menu');
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, innerWidth - 300)}px`; menu.style.top = `${r.bottom + 4}px`;
  menu.innerHTML = '<div class="bm-note">Loading branches…</div>';
  document.body.appendChild(menu);
  const base = `/api/workspaces/${encodeURIComponent(wsId)}/repos/${encodeURIComponent(dir)}`;
  const info = await (await fetch(`${base}/branches`)).json().catch(() => ({ error: 'Could not read the branches.' }));
  if (branchMenu !== menu) return;
  if (info.error) { menu.innerHTML = `<div class="bm-note err">${esc(info.error)}</div>`; return; }
  const others = info.branches.filter((b) => b.name !== info.current && b.name !== info.default).slice(0, 12);
  menu.innerHTML = `<div class="bm-head" title="${esc(info.current)}"><b>${esc(dir)}</b> <span>on</span> <span class="mono">${esc(info.current)}</span>${info.merged ? ' <span class="bm-tag">merged</span>' : ''}${info.dirty ? ` <span class="bm-tag warn">±${info.dirty}</span>` : ''}</div>`
    + `<div class="bm-note">Every session in this workspace uses this copy.</div>`
    + (info.current !== info.default ? `<button type="button" class="bm-main" data-to="${esc(info.default)}">Back to ${esc(info.default)}</button>` : `<button type="button" data-update>Update ${esc(info.default)}</button>`)
    + (others.length ? `<div class="bm-sub">Other branches</div>${others.map((b) => `<button type="button" data-to="${esc(b.name)}" title="${esc(b.name)}"><span class="mono">${esc(b.name)}</span><small>${esc(fmtAgo(b.at))}${b.local ? '' : ' · remote'}</small></button>`).join('')}` : '')
    + `<button type="button" data-new-branch>New branch…</button><div class="bm-msg" role="status"></div>`;
  const say = (html, cls = '') => { const m = menu.querySelector('.bm-msg'); m.className = `bm-msg ${cls}`; m.innerHTML = html; };
  const act = async (path, body, label) => {
    say(`${esc(label)}…`);
    const res = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (branchMenu !== menu) return;
    if (res.status === 409 && out.dirty && path === 'switch') {
      say(`${esc(out.error)}<div class="bm-row"><button type="button" class="bm-main" data-keep="${esc(body.branch)}">Keep them in a wip/ branch and switch</button><button type="button" data-cancel>Cancel</button></div>`, 'warn');
      return;
    }
    if (!res.ok) return say(esc(out.error || 'Could not do it.'), 'err');
    closeBranchMenu();
    toast([out.branch ? `On ${out.branch}` : 'Updated', out.update && out.update !== 'no upstream' ? out.update : '', out.kept ? `work kept in ${out.kept.name}${out.kept.pushed ? '' : ' (not pushed)'}` : ''].filter(Boolean).join(' · '));
    refresh();
  };
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.to) return act('switch', { branch: b.dataset.to }, `Switching to ${b.dataset.to}`);
    if (b.dataset.keep) return act('switch', { branch: b.dataset.keep, keep: true }, 'Keeping your work and switching');
    if (b.dataset.cancel !== undefined) return say('');
    if (b.dataset.update !== undefined) return act('update', {}, 'Updating');
    if (b.dataset.newBranch !== undefined) {
      say('<input class="bm-input" placeholder="new-branch-name" spellcheck="false" autocapitalize="none" />', '');
      const input = menu.querySelector('.bm-input'); input.focus();
      input.addEventListener('keydown', (k) => { if (k.key === 'Enter' && input.value.trim()) act('branch', { name: input.value.trim() }, `Creating ${input.value.trim()}`); if (k.key === 'Escape') closeBranchMenu(); });
    }
  });
}
document.addEventListener('pointerdown', (e) => { if (branchMenu && !branchMenu.contains(e.target) && !e.target.closest('[data-branch-ws]')) closeBranchMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && branchMenu) closeBranchMenu(); });

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
  if (q.get('view') || q.get('job') || q.get('edit')) { await loadJobs(); history.replaceState(null, '', '?' + q); await applyUrl(); }
  state.pollTimer = setInterval(async () => {
    await refresh();
    if (state.selected) loadTranscript(state.selected, true);
  }, 3000);
})();
