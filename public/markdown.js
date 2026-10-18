// fx's answers are Markdown. This turns the common parts (paragraphs, headings, lists, tables, quotes, code,
// bold, italics, links) into HTML for the Read view. Every piece of text is escaped first, so nothing in an
// answer becomes markup on its own; only http(s) links are made, and they open in a new tab.
function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const link = (url, label) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
  function inline(text) {
    // Code spans first, kept apart so nothing inside them is touched.
    return text.split(/(`[^`\n]+`)/).map((part, i) => {
      if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      const links = [];
      const keep = (html) => `\u0000${links.push(html) - 1}\u0000`;
      let s = esc(part)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => keep(link(url, label)))
        .replace(/https?:\/\/(?:(?!&(?:quot|lt|gt);)[^\s'`)\]])+/g, (m) => {
          const url = m.replace(/[.,;:!?]+$/, ''); // a sentence's own punctuation is not part of the address
          return keep(link(url, url)) + m.slice(url.length);
        })
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
      return s.replace(/\u0000(\d+)\u0000/g, (_, n) => links[n]);
    }).join('');
  }
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isRule(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const items = [];
      for (; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && /\d/.test(m[2]) === ordered) { items.push({ text: m[3], sub: m[1].length >= 2 }); continue; }
        if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].text += '\n' + lines[i].trim(); continue; }
        break;
      }
      i--;
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered ? parseInt(item[2], 10) : 1;
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map((it) => `<li${it.sub ? ' class="sub"' : ''}>${it.text.split('\n').map(inline).join('<br>')}</li>`).join('')}</${tag}>`);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('');
}
