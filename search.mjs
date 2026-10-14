import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const fileStamp = async (path) => { try { const s = await stat(path); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } };

// Cache only searchable text, not tool calls/results or artifact contents. Nothing is written to disk.
export function createSearchIndex(sessionsDir, loadState) {
  const cache = new Map();
  async function update() {
    const [ids, state] = await Promise.all([readdir(sessionsDir).catch(() => []), loadState()]);
    const valid = new Set(ids);
    for (const id of cache.keys()) if (!valid.has(id)) cache.delete(id);
    await Promise.all(ids.filter((id) => /^[A-Za-z0-9_-]{4,64}$/.test(id)).map(async (id) => {
      const dir = join(sessionsDir, id);
      const metaPath = join(dir, 'session.json');
      const eventsPath = join(dir, 'events.jsonl');
      const [metaStamp, eventsStamp] = await Promise.all([fileStamp(metaPath), fileStamp(eventsPath)]);
      const name = state.names[id] ?? '';
      const previous = cache.get(id);
      if (previous && previous.metaStamp === metaStamp && previous.eventsStamp === eventsStamp && previous.name === name) return;
      const meta = await readJson(metaPath);
      if (!meta) { cache.delete(id); return; }
      const messages = [];
      if (eventsStamp) {
        try {
          let messageIndex = 0;
          for (const line of (await readFile(eventsPath, 'utf8')).split('\n')) {
            if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
            try {
              const ev = JSON.parse(line).event ?? {};
              const kind = ev.user ? 'user' : ev.assistant ? 'assistant' : null;
              if (kind) {
                if (typeof ev[kind].text === 'string') messages.push({ index: messageIndex, kind, text: ev[kind].text });
                messageIndex++;
              }
            } catch { /* ignore incomplete JSONL records */ }
          }
        } catch { /* names remain searchable if events disappear during an update */ }
      }
      cache.set(id, { metaStamp, eventsStamp, name, title: meta.title ?? '(untitled)', updatedAt: meta.updated_at_ms ?? 0, messages });
    }));
  }
  return async function search(query) {
    const q = String(query ?? '').trim().slice(0, 200).toLocaleLowerCase();
    if (!q) return [];
    await update();
    const hits = [];
    for (const [id, entry] of cache) {
      if ([entry.name, entry.title].some((text) => text.toLocaleLowerCase().includes(q))) {
        hits.push({ id, kind: 'name', text: entry.name || entry.title, updatedAt: entry.updatedAt });
      }
      for (const message of entry.messages) {
        const at = message.text.toLocaleLowerCase().indexOf(q);
        if (at < 0) continue;
        const start = Math.max(0, at - 60), end = Math.min(message.text.length, at + q.length + 90);
        hits.push({ id, kind: message.kind, messageIndex: message.index,
          text: `${start ? '…' : ''}${message.text.slice(start, end).replace(/\s+/g, ' ')}${end < message.text.length ? '…' : ''}`,
          updatedAt: entry.updatedAt });
      }
    }
    return hits.sort((a, b) => (a.kind === 'name' ? 0 : 1) - (b.kind === 'name' ? 0 : 1) || b.updatedAt - a.updatedAt).slice(0, 40);
  };
}
