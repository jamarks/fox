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

// The model of the newest reply: fx records it on each assistant event (provider_replay.source.model).
export function lastAnswerModel(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"provider_replay"')) continue;
    try { const m = JSON.parse(lines[i]).event?.assistant?.provider_replay?.source?.model; if (typeof m === 'string' && m) return m; } catch {}
  }
  return null;
}
