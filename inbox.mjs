// Extract a stable completed-turn marker and its last visible assistant message.
// An unfinished assistant message is never a new reply.
export function latestCompletedReply(raw) {
  let completed = 0, messageIndex = 0, currentAnswer = null, latest = null;
  for (const line of raw.split('\n')) {
    if (!line.includes('"user"') && !line.includes('"assistant"') && !line.includes('"turn_completed"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const ev = record.event ?? {};
    if (ev.user) { currentAnswer = null; messageIndex++; }
    else if (ev.assistant) {
      const text = ev.assistant.text;
      if (typeof text === 'string' && text.trim()) {
        currentAnswer = { text: text.replace(/\s+/g, ' ').trim().slice(0, 180), messageIndex };
        messageIndex++;
      }
    } else if (ev.turn_completed) {
      completed++;
      if (currentAnswer) latest = { ...currentAnswer, turn: completed, at: record.timestamp_ms ?? null };
      currentAnswer = null;
    }
  }
  return latest;
}

// A child result is only a saved turn or a recorded failure, never the assistant's live partial text.
// User-turn count distinguishes failed follow-up rounds even if no assistant answer was saved.
export function childCompletion(child, relation) {
  if (relation.phase === 'running') return null;
  const failure = relation.failure || (relation.outcome === 'failed' ? 'Subagent failed' : null);
  if (failure) {
    const text = typeof failure === 'string' ? failure : failure.message ?? failure.reason ?? 'Subagent failed';
    return { marker: `failed:${child.turns}`, failed: true, text: String(text).replace(/\s+/g, ' ').slice(0, 180), at: child.updatedAt ?? null, messageIndex: null };
  }
  const reply = child.latestReply;
  if (!reply) return null;
  return { ...reply, marker: `turn:${reply.turn}`, failed: false };
}

// The model of the newest reply: fx records it on each assistant event (provider_replay.source.model).
export function lastAnswerModel(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"provider_replay"')) continue;
    try { const m = JSON.parse(lines[i]).event?.assistant?.provider_replay?.source?.model; if (typeof m === 'string' && m) return m; } catch {}
  }
  return null;
}

// fx's footer shows the current model even when the latest turn is not yet on disk.
export function screenModel(screen) {
  // The first field is the fx mode/provider, not necessarily "auto".
  for (const line of screen.split('\n').reverse()) {
    const model = /^\s*[a-z][a-z0-9_-]*\s*·\s*([^·\n]+?)\s*·/i.exec(line)?.[1]?.trim();
    if (model) return model;
  }
  return null;
}
