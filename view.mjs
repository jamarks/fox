// Preview links for pages fx made: /view/<token>/<file> serves the page and the CSS, JS, images and fonts
// next to it, so it renders as designed. The token is the key: random, short-lived, bound to one project
// folder. Pages run sandboxed (CSP sandbox, opaque origin): they cannot read fox's API or reach terminals.
import { randomBytes } from 'node:crypto';
import { dirname, extname, resolve, sep, basename } from 'node:path';

export const VIEW_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export function createViewTokens({ ttlMs = 2 * 60 * 60 * 1000, max = 200, now = () => Date.now() } = {}) {
  const tokens = new Map(); // token -> { root, base, file, expires }
  const byFile = new Map(); // root + file -> token, so reopening a page reuses its link
  return {
    // root: the project folder; file: the page, inside it. Returns the URL path to load.
    issue(root, file) {
      const key = root + '\0' + file;
      let token = byFile.get(key);
      const live = token && tokens.get(token);
      if (!live || live.expires <= now()) {
        token = randomBytes(18).toString('base64url');
        if (tokens.size >= max) { const [oldest] = tokens.keys(); byFile.delete(tokens.get(oldest).key); tokens.delete(oldest); }
        tokens.set(token, { root, base: dirname(file), file, key, expires: now() + ttlMs });
        byFile.set(key, token);
      } else live.expires = now() + ttlMs;
      return `/view/${token}/${encodeURIComponent(basename(file))}`;
    },
    // The files a request may read: next to the page first, then from the project root (for "/x" links).
    // Never outside the project, never hidden files or folders, only types a page loads.
    candidates(token, rest) {
      const entry = tokens.get(token);
      if (!entry || entry.expires <= now()) return null;
      let rel;
      try { rel = decodeURIComponent(rest); } catch { return []; }
      const parts = rel.split('/').filter(Boolean);
      if (!parts.length || parts.some((p) => p.startsWith('.') || p.includes('\\') || p.includes('\0'))) return [];
      if (!VIEW_TYPES[extname(rel).toLowerCase()]) return [];
      const inside = (p) => p === entry.root || p.startsWith(entry.root + sep);
      return [resolve(entry.base, ...parts), resolve(entry.root, ...parts)].filter((p, i, a) => inside(p) && a.indexOf(p) === i);
    },
  };
}

// Root-relative links ("/style.css") would leave the preview; point them at the same token instead.
export function rewriteRootLinks(text, token, type) {
  const to = `/view/${token}/`;
  if (type.startsWith('text/html')) return text.replace(/(\s(?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${to}`);
  if (type.startsWith('text/css')) return text.replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${to}`).replace(/@import\s+(["'])\/(?!\/)/gi, `@import $1${to}`);
  return text;
}
