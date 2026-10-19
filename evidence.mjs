// Summarize recorded executions, not the agent's description of them. Missing or truncated results stay unknown.
const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const shellAction = (ev) => /^(?:functions\.)?shell$/.test(ev.name ?? '') ? ev.args?.request?.action : null;
function payload(result) {
  if (!result) return null;
  for (const text of [result.detail, result.preview]) {
    if (typeof text !== 'string') continue;
    try { const value = object(JSON.parse(text)); if (value) return value; } catch {}
  }
  return null;
}
function exitOf(value) {
  const code = value?.exit_code;
  return Number.isInteger(code) && code >= 0 ? code : null;
}

export function summarizeEvidence(events) {
  const commands = [], files = [], handles = new Map();
  let cancellations = 0;
  for (const ev of events) {
    if (ev.kind === 'interrupted') {
      cancellations++;
      for (const command of commands) if (command.state === 'running') command.state = 'interrupted';
      continue;
    }
    if (ev.kind !== 'tool_call') continue;
    const action = shellAction(ev);
    const data = payload(ev.result);
    if (action === 'run' || action === 'interact') {
      const handle = typeof (data?.session_id ?? ev.args?.request?.session_id) === 'string' ? (data?.session_id ?? ev.args?.request?.session_id) : null;
      let item = action === 'interact' && handle ? handles.get(handle) : null;
      if (!item) {
        item = { command: action === 'run' ? String(ev.args?.request?.command ?? '') : '(interact)', exit: null, state: 'exit unknown', elapsedMs: 0, callIds: [] };
        commands.push(item);
      }
      item.callIds.push(ev.callId);
      if (ev.result?.artifact) item.artifact = ev.result.artifact;
      // An interact result may close a run. A still-running handle is never a successful exit.
      if (handle) handles.set(handle, item);
      const exit = exitOf(data);
      if (exit !== null) { item.exit = exit; item.state = exit === 0 ? 'exited' : 'failed'; }
      else if (data?.state === 'completed' && data?.signal) item.state = 'interrupted';
      else if (data?.state === 'completed' && data?.termination_indeterminate === false) item.state = 'exit unknown';
      else if (handle && item.exit === null) item.state = 'running';
      if (Number.isFinite(data?.duration_ms) && data.duration_ms >= 0) item.elapsedMs += data.duration_ms;
      continue;
    }
    if ((ev.name === 'edit_file' || ev.name === 'write_file') && ev.result?.status === 'success' && typeof ev.args?.path === 'string') {
      files.push({ path: ev.args.path, callId: ev.callId });
    }
  }
  return { commands, files, cancellations, counts: { commands: commands.length, failed: commands.filter((c) => c.state === 'failed').length, unknown: commands.filter((c) => c.exit === null).length } };
}
