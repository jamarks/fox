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
  {
    // Sign in is OAuth. A Linear API key works too, without signing in: put it in an environment variable fx
    // sessions get (on a server, a root-only EnvironmentFile) and set "bearer_token_env" on this entry in fx's mcp.json.
    id: 'linear',
    name: 'linear',
    label: 'Linear',
    description: 'Read, create and move your Linear issues',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    match: /mcp\.linear\.app/,
  },
];

// Arguments for `fx mcp ...add`: a local command, or a remote server over HTTP.
export function addArgs(tool) {
  return tool.url ? ['mcp', 'add', '--transport', 'http', tool.name, tool.url] : ['mcp', 'add', tool.name, ...tool.command];
}

// A tool can be configured more than once, under its canonical name or aliases (including tuned commands).
export function findServers(tool, config) {
  return Object.entries(config?.mcp ?? {}).filter(([name, s]) => name === tool.name ||
    tool.match.test([].concat(s?.command ?? [], s?.args ?? [], s?.url ?? []).join(' ')));
}
// Keep the canonical entry first for callers that need one server (such as sign-in setup).
export function findServer(tool, config) {
  const matches = findServers(tool, config);
  return matches.find(([name]) => name === tool.name) ?? matches[0] ?? null;
}
export const isInstalled = (tool, config) => findServers(tool, config).length > 0;
// Off keeps entries with `enabled: false`, which fx skips, so turning them back on restores their setup.
export const isEnabled = (tool, config) => findServers(tool, config).some(([, s]) => s?.enabled !== false);
export function withEnabled(config, tool, enabled) {
  const matches = findServers(tool, config);
  if (!matches.length) throw new Error('fx does not have this tool');
  const mcp = { ...config.mcp };
  for (const [name, entry] of matches) mcp[name] = { ...entry, enabled };
  return { ...config, mcp };
}
