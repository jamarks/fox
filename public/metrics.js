const status = document.querySelector('#metrics-status');
const table = document.querySelector('.metrics-table-wrap');
const buttons = [...document.querySelectorAll('[data-days]')];
let request = 0;

async function loadMetrics(days) {
  const id = ++request;
  for (const button of buttons) button.setAttribute('aria-pressed', String(Number(button.dataset.days) === days));
  table.hidden = true;
  document.querySelector('#metrics-agents-wrap').hidden = true;
  document.querySelector('#metrics-range').textContent = '';
  status.textContent = 'Loading…';
  try {
    const response = await fetch(`/api/metrics?days=${days}`);
    if (!response.ok) throw new Error('Metrics unavailable');
    const data = await response.json();
    if (id !== request) return;
    const date = (ms) => new Date(ms).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
    document.querySelector('#metrics-range').textContent = `${date(data.start)} – ${date(data.end)} vs. ${date(data.previousStart)} – ${date(data.start)}`;
    const rows = document.querySelector('#metrics-rows');
    rows.replaceChildren();
    for (const [key, label] of [['sessions', 'Sessions created'], ['prompts', 'User messages'], ['completed', 'Completed turns']]) {
      const current = data.current[key], previous = data.previous[key];
      const delta = current - previous;
      // A zero baseline has no meaningful percentage change.
      const change = previous === 0 ? (current === 0 ? '0%' : 'New') : `${delta > 0 ? '+' : ''}${(delta / previous * 100).toFixed(1)}%`;
      const row = document.createElement('tr');
      for (const [i, value] of [label, current.toLocaleString('en'), previous.toLocaleString('en'), change].entries()) {
        const cell = document.createElement(i === 0 ? 'th' : 'td');
        if (i === 0) cell.scope = 'row';
        cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    // Per agent, only when more than one was used: with fx alone it repeats the table above.
    const agents = (data.byAgent ?? []).filter((a) => Object.values(a.current).some(Boolean) || Object.values(a.previous).some(Boolean));
    const agentRows = document.querySelector('#metrics-agents');
    agentRows.replaceChildren(...agents.map((a) => {
      const row = document.createElement('tr');
      for (const [i, value] of [a.agent, a.current.sessions, a.current.prompts, a.current.completed].entries()) {
        const cell = document.createElement(i === 0 ? 'th' : 'td');
        if (i === 0) cell.scope = 'row';
        cell.textContent = typeof value === 'number' ? value.toLocaleString('en') : value;
        row.append(cell);
      }
      return row;
    }));
    document.querySelector('#metrics-agents-wrap').hidden = agents.length < 2;
    status.textContent = Object.values(data.current).some(Boolean) || Object.values(data.previous).some(Boolean) ? '' : 'No activity in either period.';
    table.hidden = false;
  } catch {
    if (id === request) status.textContent = 'Could not load metrics. Select a period to retry.';
  }
}

for (const button of buttons) button.addEventListener('click', () => loadMetrics(Number(button.dataset.days)));
loadMetrics(7);
