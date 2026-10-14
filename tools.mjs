// Optional tools fox can give fx: MCP servers added to fx's own config with `fx mcp add`, only when the
// user clicks. Add an entry here to offer another one.
export const TOOLS = [
  {
    id: 'browser',
    name: 'playwright',
    label: 'Browser',
    description: 'Lets fx open pages, click and take screenshots, so it can check its own UI work. Uses its own Chrome profile, not yours.',
    command: ['npx', '@playwright/mcp@latest'],
    match: /@playwright\/mcp/,
  },
  {
    id: 'devtools',
    name: 'devtools',
    label: 'Chrome DevTools',
    description: 'Console errors, network requests and performance traces of a page, so fx can debug what the browser shows.',
    command: ['npx', 'chrome-devtools-mcp@latest'],
    match: /chrome-devtools-mcp/,
  },
  {
    id: 'docs',
    name: 'docs',
    label: 'Library docs',
    description: 'Current docs and examples for libraries and frameworks (Context7), so fx does not guess APIs. No account needed.',
    url: 'https://mcp.context7.com/mcp',
    match: /context7/,
  },
];

// Arguments for `fx mcp ...add`: a local command, or a remote server over HTTP.
export function addArgs(tool) {
  return tool.url ? ['mcp', 'add', '--transport', 'http', tool.name, tool.url] : ['mcp', 'add', tool.name, ...tool.command];
}

// A tool counts as installed when fx has a server with its name, or any server running the same package or URL.
export function isInstalled(tool, config) {
  const servers = config?.mcp ?? {};
  if (servers[tool.name]) return true;
  return Object.values(servers).some((s) => tool.match.test([].concat(s?.command ?? [], s?.args ?? [], s?.url ?? []).join(' ')));
}
