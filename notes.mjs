// What fx should know about the fox it runs in: a block fox keeps in fx's personal instructions
// (~/.fx/AGENTS.md, which fx reads in every folder). Only the block between the markers is fox's; whatever
// you write around it stays untouched.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const JOBS_GUIDE = fileURLToPath(new URL('./docs/jobs.md', import.meta.url));

const START = '<!-- fox:start · written by fox; edits inside this block are replaced -->';
const END = '<!-- fox:end -->';

export function withFoxBlock(text, block) {
  const body = `${START}\n${block.trim()}\n${END}`;
  const s = text.indexOf(START), e = text.indexOf(END);
  if (s >= 0 && e > s) return text.slice(0, s) + body + text.slice(e + END.length);
  return (text.trim() ? text.replace(/\s*$/, '\n\n') : '') + body + '\n';
}

export async function ensureFoxNotes(file, block) {
  const current = await readFile(file, 'utf8').catch(() => '');
  const next = withFoxBlock(current, block);
  if (next === current) return false;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, next, { mode: 0o600 });
  await rename(tmp, file);
  return true;
}

// The block itself. `preview` is fox's preview config (null on a laptop).
export function foxNotes({ preview = null, apps = null } = {}) {
  const ports = preview?.ports ?? [3000, 3001, 4321, 5173, 8000, 8080];
  const example = preview ? preview.url.replace('{port}', String(ports.includes(5173) ? 5173 : ports[0])) : 'http://localhost:5173';
  return `## fox (the panel this session runs in)

### Dev servers
- Start dev servers in the background so the terminal stays yours, with their output in a log you can read (\`npm run dev > /tmp/dev-5173.log 2>&1 &\`), on one of these ports: ${ports.join(', ')}. Pass the port explicitly (\`--port 5173\`, and \`--strictPort\` for Vite). Stop the ones you only started to check your work.
- Check your own work with the browser tool at \`http://localhost:<port>\` (it runs on this machine): take a screenshot, read console errors, fix what you see before saying it works.
${preview ? `- The user is not on this machine: give them ${preview.url.replace('{port}', '<port>')} (for example ${example}), never localhost. Those links are private to them.` : '- The user is on this machine: give them the `http://localhost:<port>` link.'}${apps ? `\n- For something the user will keep using (a dashboard, an app), give it a name: \`fox-expose <name> <port>\` publishes it at ${apps.url.replace('{name}', '<name>')}, private to them like the previews; any port works, and \`fox-expose list\` shows what is published. Write the full address in your answer.` : ''}

### Repos
- Start with \`git pull\` in the repo you work in (fox fast-forwards clean checkouts when a session starts, not ones with work in progress), and read its AGENTS.md before proposing changes: what you remember of a project may be old.
- Changes that will be deployed go through a pull request the user merges. Never push to a branch that deploys.

### Scheduled jobs
fox runs scripts on a schedule on this machine ("jobs"); the user sees them on fox's Jobs page. Manage them with the \`fox-job\` command:
- \`fox-job list\` · \`fox-job runs <name>\` · \`fox-job log <name> [<run>]\`
- \`fox-job add <name> --script <path> [--cwd <dir>] (--every <hours> --from HH:MM --to HH:MM | --daily HH:MM | --once YYYY-MM-DD HH:MM) [--days mon-fri|sat,sun|mon,thu|all] [--tz Area/City] [--timeout <minutes>] [--paused] [-- <script arguments>]\`
- \`fox-job run <name>\` (now) · \`fox-job pause|resume <name>\` · \`fox-job remove <name>\`

Rules:
- Create, change or remove a job only when the user asks, and confirm the name, script and schedule with them before running \`fox-job add\`.
- A job is a script: keep it in the workspace (for example \`jobs/<name>.py\`) and commit it. Do as much as possible in plain code; when there is nothing to do, exit early without calling a model.
- Print \`FOX_SUMMARY: <one line>\` with what the run did; write reports or files for the user to \`$FOX_JOB_OUTPUT\`.
- To use a model inside a job, call \`fx ask --no-save --json "<prompt>"\` and read \`final_output\`. Validate what comes back; never run a model's output as shell commands.
- One job runs at a time, each with a time limit (\`--timeout\`, 30 minutes by default). Before each run fox fast-forwards the job's folder if it is a clean checkout, so a script pushed from another copy is what runs.
- How to write a job, and the Python helpers every job can import (\`import foxjob\`; \`foxjob.propose_change()\` for a job that changes code through a pull request): ${JOBS_GUIDE}. Read it before writing one.
- A job that changes code proposes a pull request (\`foxjob.propose_change\`); it never pushes to main or to a deploy branch.`;
}
