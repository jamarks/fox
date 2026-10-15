const $ = (id) => document.getElementById(id);
let sessions = [], active = null, searchTimer = null, searchVersion = 0, pendingText = null, sending = false;
const title = (s) => s.customName || s.title || 'Untitled session';
const project = (s) => s.workspace?.split('/').filter(Boolean).pop() || 'Unknown project';
function card(name, info, excerpt, onClick) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'card';
  for (const [cls, value] of [['title', name], ['meta', info], ['excerpt', excerpt]]) {
    if (!value) continue;
    const span = document.createElement('span'); span.className = cls; span.textContent = value; button.append(span);
  }
  button.addEventListener('click', onClick); return button;
}
async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function renderSessions() {
  const root = $('sessions'); root.replaceChildren();
  const visible = sessions.filter((s) => !s.archived && !s.parentId);
  const groups = new Map();
  for (const s of visible) {
    const name = project(s);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(s);
  }
  for (const [name, list] of groups) {
    const heading = document.createElement('h2'); heading.className = 'group-title'; heading.textContent = name; root.append(heading);
    for (const s of list) root.append(card(title(s), s.latestReply ? 'Latest answer' : 'Session', s.latestReply?.text, () => openSession(s.id)));
  }
  $('notice').textContent = visible.length ? `${visible.length} sessions · updating automatically` : 'No sessions yet.';
}
async function refresh() {
  try {
    sessions = (await get('/api/overview')).sessions;
    const selected = sessions.find((s) => s.id === active);
    if (active) document.title = selected ? `${title(selected)} · fox` : 'fox';
    if (!$('query').value.trim()) renderSessions();
  }
  catch { $('notice').textContent = 'Could not load sessions. Check that fox is still running on your Mac.'; }
}
async function openSession(id, index, update = false) {
  active = id;
  const s = sessions.find((item) => item.id === id);
  if (!update) {
    pendingText = null;
    $('send-status').textContent = '';
    $('home').hidden = true; $('detail').hidden = false;
    $('detail-title').textContent = s ? title(s) : 'Session';
    document.title = s ? `${title(s)} · fox` : 'fox';
    $('detail-project').textContent = s ? project(s) : '';
  }
  const root = $('messages');
  try {
    const events = await get(`/api/sessions/${encodeURIComponent(id)}/events`);
    if (active !== id) return;
    // Only follow new messages when the reader was already at the bottom.
    const follow = !update || document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 100;
    if (pendingText && events.some((ev) => ev.kind === 'user' && ev.text === pendingText)) {
      pendingText = null;
      $('send-status').textContent = 'Message received by fx.';
    }
    root.replaceChildren();
    for (const [i, event] of events.entries()) {
      if (!event.text.trim()) continue;
      const item = document.createElement('article'); item.className = `message ${event.kind}`;
      const label = document.createElement('div'); label.className = 'message-label'; label.textContent = event.kind === 'user' ? 'You' : 'fx';
      const text = document.createElement('p'); text.className = 'message-text'; text.textContent = event.text;
      item.append(label, text); root.append(item);
      if (i === index) item.dataset.target = 'true';
    }
    if (pendingText) {
      const item = document.createElement('article'); item.className = 'message user pending';
      const label = document.createElement('div'); label.className = 'message-label'; label.textContent = 'You · sending';
      const text = document.createElement('p'); text.className = 'message-text'; text.textContent = pendingText;
      item.append(label, text); root.append(item);
    }
    if (!root.children.length) root.textContent = 'No messages yet.';
    if (follow) requestAnimationFrame(() => (root.querySelector('[data-target]') || root.lastElementChild)?.scrollIntoView({ block: 'end' }));
  } catch { if (!update) root.textContent = 'Could not load this conversation.'; }
  if (!update) window.scrollTo(0, 0);
}
$('back').addEventListener('click', () => { active = null; document.title = 'fox'; pendingText = null; $('detail').hidden = true; $('home').hidden = false; window.scrollTo(0, 0); });
$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = active, field = $('message'), text = field.value.trim();
  if (!id || !text || sending) return;
  sending = true; $('send').disabled = true; $('send-status').textContent = 'Sending…';
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (active === id) {
      field.value = ''; pendingText = text;
      $('send-status').textContent = 'Sent. Waiting for fx to finish its turn…';
      await openSession(id, undefined, true);
    }
  } catch (error) { $('send-status').textContent = error.message; }
  finally { sending = false; $('send').disabled = false; }
});
setInterval(() => { if (active && !sending) openSession(active, undefined, true); }, 4000);
$('query').addEventListener('input', () => {
  const q = $('query').value.trim(), version = ++searchVersion;
  clearTimeout(searchTimer); $('results').replaceChildren(); $('sessions').hidden = Boolean(q);
  if (!q) { renderSessions(); return; }
  searchTimer = setTimeout(async () => {
    try {
      const hits = await get(`/api/search?q=${encodeURIComponent(q)}`);
      if (version !== searchVersion) return;
      $('notice').textContent = hits.length ? `${hits.length} results` : 'No results.';
      for (const hit of hits) {
        const s = sessions.find((item) => item.id === hit.id);
        $('results').append(card(s ? title(s) : 'Session', `${s ? project(s) : ''} · ${hit.kind}`, hit.text, () => openSession(hit.id, hit.messageIndex)));
      }
    } catch { if (version === searchVersion) $('notice').textContent = 'Could not search sessions.'; }
  }, 200);
});
refresh(); setInterval(refresh, 10000);
