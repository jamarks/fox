// Optional tools fox can give fx: MCP servers added to fx's own config with `fx mcp add`, only when the
// user clicks. Add an entry here to offer another one. `auth: 'oauth'` adds a "Sign in" step.
export const TOOLS = [
  {
    id: 'browser',
    name: 'playwright',
    label: 'Browser',
    description: 'Opens pages, clicks and takes screenshots, to check its own UI work',
    command: ['npx', '@playwright/mcp@latest'],
    match: /@playwright\/mcp/,
    cost: 'about 160 MB per session',
  },
  {
    id: 'devtools',
    name: 'devtools',
    label: 'Chrome DevTools',
    description: 'Console errors, network and performance of a page',
    command: ['npx', 'chrome-devtools-mcp@latest'],
    match: /chrome-devtools-mcp/,
    cost: 'about 160 MB per session',
  },
  {
    id: 'docs',
    name: 'docs',
    label: 'Library docs',
    description: 'Current docs for libraries and frameworks (Context7)',
    url: 'https://mcp.context7.com/mcp',
    match: /context7/,
  },
  {
    id: 'vercel',
    name: 'vercel',
    label: 'Vercel',
    description: 'Your projects, deployments and build logs',
    url: 'https://mcp.vercel.com',
    auth: 'oauth',
    match: /mcp\.vercel\.com/,
  },
];

// Arguments for `fx mcp ...add`: a local command, or a remote server over HTTP.
export function addArgs(tool) {
  return tool.url ? ['mcp', 'add', '--transport', 'http', tool.name, tool.url] : ['mcp', 'add', tool.name, ...tool.command];
}

// fx's entry for a tool: a server with its name, or any server running the same package or URL (set up by hand,
// or tuned on a server to skip npx). [name, entry] or null.
export function findServer(tool, config) {
  const servers = config?.mcp ?? {};
  if (servers[tool.name]) return [tool.name, servers[tool.name]];
  return Object.entries(servers).find(([, s]) => tool.match.test([].concat(s?.command ?? [], s?.args ?? [], s?.url ?? []).join(' '))) ?? null;
}
export const isInstalled = (tool, config) => Boolean(findServer(tool, config));
// Off keeps the entry with `enabled: false`, which fx skips, so turning it back on restores it exactly.
export const isEnabled = (tool, config) => findServer(tool, config)?.[1]?.enabled !== false;
export function withEnabled(config, tool, enabled) {
  const found = findServer(tool, config);
  if (!found) throw new Error('fx does not have this tool');
  return { ...config, mcp: { ...config.mcp, [found[0]]: { ...found[1], enabled } } };
}
