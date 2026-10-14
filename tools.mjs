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
];

// A tool counts as installed when fx has a server with its name, or any server running the same package.
export function isInstalled(tool, config) {
  const servers = config?.mcp ?? {};
  if (servers[tool.name]) return true;
  return Object.values(servers).some((s) => tool.match.test([].concat(s?.command ?? [], s?.args ?? [], s?.url ?? []).join(' ')));
}
