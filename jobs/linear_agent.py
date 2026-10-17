#!/usr/bin/env python3
"""Linear → fx → pull request: a fox job that takes one Linear issue labeled `agent-ok`, has fx do it in a clean
copy of its repo, checks the work itself (tests, size) and opens a pull request. A person merges it; on a later
run the job publishes what was merged (for fox: main → release, fast-forward only) and closes the issue.

Plain code wherever possible: with nothing to publish and nothing labeled, it ends without calling a model.
fx never commits, pushes or merges. Nothing reaches a release branch without a merged pull request.

Config (outside the repo, owned by the fox user): ~/.config/fox-jobs/linear-agent.json
{
  "label": "agent-ok", "maxDiffLines": 400, "fxTimeoutMin": 25, "maxOpenPRs": 3,
  "workspaces": [{
    "name": "fox", "keyFile": "~/.config/fox-jobs/linear-api-key-fox", "context": "~/.config/fox-jobs/context-fox.md",
    "repos": [{ "teams": ["FOX"], "repo": "jamarks/fox", "base": "main", "publish": "release",
                "setup": "npm ci --no-audit --no-fund --loglevel=error", "test": "npm test" }]
  }]
}
Stdlib only, plus git and gh. --dry-run does everything except pushing, opening PRs and writing to Linear.
"""
import json, os, re, subprocess, sys, urllib.request
from pathlib import Path

DRY = "--dry-run" in sys.argv
CONFIG = Path(os.environ.get("LINEAR_AGENT_CONFIG", "~/.config/fox-jobs/linear-agent.json")).expanduser()
OUT = Path(os.environ.get("FOX_JOB_OUTPUT") or "/tmp/linear-agent-out")
WORK = Path("~/.cache/fox-agent").expanduser()
RUN_ID = os.environ.get("FOX_JOB_RUN_ID", "manual")
OUT.mkdir(parents=True, exist_ok=True)
report = []
said = []


def log(*parts):
    print(*parts, flush=True)
    report.append(" ".join(str(p) for p in parts))


# Tools this job starts (tests, fx) must not inherit fox's own settings.
CHILD_ENV = {k: v for k, v in os.environ.items()
             if not (k.startswith("FOX_") and not k.startswith("FOX_JOB_") and k != "FOX_DEFAULT_TZ") and k != "PORT"}


class Failure(Exception):
    def __init__(self, reason, detail=""):
        super().__init__(reason)
        self.reason, self.detail = reason, detail


def run(args, cwd, timeout=600, check=True):
    p = subprocess.run(args, cwd=cwd, env=CHILD_ENV, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise Failure(f"{' '.join(args[:3])} failed (exit {p.returncode})", (p.stdout + p.stderr)[-3000:])
    return p.stdout.strip()


def git(*args, cwd, check=True):
    return run(["git", *args], cwd=cwd, check=check)


def sh(cmd, cwd, timeout=1200):
    """setup and test commands come from the config file, which only the fox user can write."""
    return run(["bash", "-lc", cmd], cwd=cwd, timeout=timeout)


class Linear:
    def __init__(self, key_file):
        self.key = Path(key_file).expanduser().read_text().strip()

    def gql(self, query, variables=None):
        req = urllib.request.Request("https://api.linear.app/graphql",
                                     data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                                     headers={"Authorization": self.key, "Content-Type": "application/json"})
        data = json.load(urllib.request.urlopen(req, timeout=30))
        if data.get("errors"):
            raise Failure("Linear: " + str(data["errors"][0].get("message")))
        return data["data"]

    FIELDS = """id identifier title description priority createdAt url
                state { id name type } labels { nodes { id name } }
                team { key states { nodes { id name type position } } }"""

    def labeled(self, label):
        q = f"""query($label: String!) {{ issues(first: 30, filter: {{ labels: {{ name: {{ eqIgnoreCase: $label }} }},
              state: {{ type: {{ nin: ["completed", "canceled"] }} }} }}) {{ nodes {{ {self.FIELDS} }} }} }}"""
        return self.gql(q, {"label": label})["issues"]["nodes"]

    def issue(self, identifier):
        return self.gql(f'query($id: String!) {{ issue(id: $id) {{ {self.FIELDS} }} }}', {"id": identifier})["issue"]

    def comment(self, issue, body):
        if DRY:
            return log(f"[dry-run] comment on {issue['identifier']}: {body[:200]}")
        self.gql("mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
                 {"input": {"issueId": issue["id"], "body": body}})

    def update(self, issue, **fields):
        if DRY:
            return log(f"[dry-run] update {issue['identifier']}: {fields}")
        self.gql("mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
                 {"id": issue["id"], "input": fields})


def state_id(issue, kind, prefer=None):
    states = sorted((s for s in issue["team"]["states"]["nodes"] if s["type"] == kind), key=lambda s: s["position"])
    if prefer:
        named = [s for s in states if s["name"].lower() == prefer.lower()]
        if named:
            return named[0]["id"]
    return states[0]["id"] if states else None


def checkout(rule):
    owner, name = rule["repo"].split("/")
    path = WORK / f"{owner}__{name}"
    if not (path / ".git").exists():
        WORK.mkdir(parents=True, exist_ok=True)
        git("clone", "--quiet", f"https://github.com/{rule['repo']}.git", str(path), cwd=WORK)
    git("fetch", "--quiet", "--prune", "origin", cwd=path)
    return path


def gh_json(args, cwd):
    return json.loads(run(["gh", *args], cwd=cwd) or "[]")


# 1. Publish what a person merged: agent PRs merged into the base branch move the publish branch forward.
def publish_merged(linear, rule):
    if not rule.get("publish"):
        return []
    path = checkout(rule)
    base, pub = f"origin/{rule['base']}", f"origin/{rule['publish']}"
    merged = gh_json(["pr", "list", "--repo", rule["repo"], "--state", "merged", "--base", rule["base"], "--limit", "20",
                      "--json", "number,headRefName,mergeCommit,url,title"], path)
    in_pub = lambda sha: subprocess.run(["git", "merge-base", "--is-ancestor", sha, pub], cwd=path, capture_output=True).returncode == 0
    waiting = [pr for pr in merged if pr["headRefName"].startswith("agent/") and pr.get("mergeCommit") and not in_pub(pr["mergeCommit"]["oid"])]
    if not waiting:
        return []
    if subprocess.run(["git", "merge-base", "--is-ancestor", pub, base], cwd=path, capture_output=True).returncode != 0:
        raise Failure(f"{rule['publish']} has commits that {rule['base']} does not; not publishing until that is fixed by hand")
    head = git("rev-parse", "--short", base, cwd=path)
    if DRY:
        log(f"[dry-run] would move {rule['publish']} to {rule['base']} ({head}) for {len(waiting)} merged PRs")
    else:
        git("push", "--quiet", "origin", f"{base}:refs/heads/{rule['publish']}", cwd=path)
        log(f"published {rule['base']} ({head}) to {rule['publish']}: {', '.join('#' + str(p['number']) for p in waiting)}")
    done = []
    for pr in waiting:
        m = re.match(r"agent/([a-z]+-\d+)", pr["headRefName"])
        if not m:
            continue
        issue = linear.issue(m.group(1).upper())
        if issue and issue["state"]["type"] != "completed":
            linear.comment(issue, f"🚀 Merged ([#{pr['number']}]({pr['url']})) and published to `{rule['publish']}` ({head}).")
            if state_id(issue, "completed"):
                linear.update(issue, stateId=state_id(issue, "completed"))
        done.append(f"{m.group(1).upper()} → {rule['publish']}")
    return done


def prompt_for(issue, context, rule):
    return f"""You are doing one issue from Linear in this repository. Nobody will answer questions while you work.

Issue {issue['identifier']}: {issue['title']}
{(issue.get('description') or '').strip()}

About this project:
{context.strip()}

Rules:
- Work only in this repository folder. Do not commit, push, create branches or open pull requests: the job that started you does that after checking your work, and a person reviews it.
- Keep the change small and focused on this issue. If it needs a large change, a product decision the issue does not answer, new dependencies, or secrets, change nothing and explain why.
- Follow AGENTS.md and the conventions of the code around you. Add or update tests for what you change.
- Run the tests (`{rule['test']}`) and make them pass.
- If the change shows in a UI, run it and look at it with the browser tool (screenshot, console errors) before you finish.
- End your answer with exactly one line like this, and nothing after it:
RESULT: {{"status": "done" or "skip", "summary": "<one sentence in the issue's language: what you changed, or why you skipped>", "verified": "<how you checked it>"}}"""


def ask_fx(prompt, cwd, timeout_min):
    log(f"fx working (up to {timeout_min} min)…")
    p = subprocess.run(["fx", "ask", "--auto", "--no-save", "--json", "--", prompt], cwd=cwd, env=CHILD_ENV,
                       capture_output=True, text=True, timeout=timeout_min * 60)
    (OUT / "fx-progress.log").write_text(p.stderr[-200_000:])
    try:
        final = json.loads(p.stdout).get("final_output") or ""
    except json.JSONDecodeError:
        raise Failure(f"fx did not answer in JSON (exit {p.returncode})", (p.stdout + p.stderr)[-2000:])
    (OUT / "fx-answer.md").write_text(final)
    m = re.search(r"^RESULT:\s*(\{.*\})\s*$", final.strip(), re.M)
    if not m:
        raise Failure("fx did not end with a RESULT line", final[-1500:])
    try:
        result = json.loads(m.group(1))
    except json.JSONDecodeError:
        raise Failure("fx's RESULT line is not valid JSON", m.group(1))
    if result.get("status") not in ("done", "skip") or not isinstance(result.get("summary"), str):
        raise Failure("fx's RESULT does not say done or skip with a summary", m.group(1))
    return result


# 2. Do one labeled issue and open a pull request for it.
def work_on(linear, issue, rule, context, cfg):
    path = checkout(rule)
    open_prs = gh_json(["pr", "list", "--repo", rule["repo"], "--state", "open", "--json", "headRefName"], path)
    if sum(pr["headRefName"].startswith("agent/") for pr in open_prs) >= cfg.get("maxOpenPRs", 3):
        log(f"{rule['repo']} already has {cfg.get('maxOpenPRs', 3)} agent PRs waiting for review; not starting another")
        return None
    slug = re.sub(r"[^a-z0-9]+", "-", issue["title"].lower()).strip("-")[:40]
    branch = f"agent/{issue['identifier'].lower()}-{slug}"
    if any(pr["headRefName"] == branch for pr in open_prs):
        log(f"{issue['identifier']} already has an open PR")
        return None
    if state_id(issue, "started"):
        linear.update(issue, stateId=state_id(issue, "started"))
    linear.comment(issue, f"🦊 fox agent took this issue (job run `{RUN_ID}`). It will open a pull request for review.")
    base = f"origin/{rule['base']}"
    git("checkout", "--quiet", "-B", branch, base, cwd=path)
    git("reset", "--quiet", "--hard", base, cwd=path)
    git("clean", "-qfdx", cwd=path)
    if rule.get("setup"):
        sh(rule["setup"], path)
    result = ask_fx(prompt_for(issue, context, rule), path, cfg.get("fxTimeoutMin", 25))
    log(f"fx says {result['status']}: {result['summary']}")
    if result["status"] == "skip":
        raise Failure("the agent did not do it: " + result["summary"])
    if git("rev-parse", "HEAD", cwd=path) != git("rev-parse", base, cwd=path):
        git("reset", "--quiet", "--soft", base, cwd=path)  # fx committed anyway: one commit, made here
    git("add", "-A", cwd=path)
    numstat = git("diff", "--cached", "--numstat", base, cwd=path)
    if not numstat:
        raise Failure("the agent said done but changed no files")
    lines = sum(int(a) + int(b) for a, b, _ in (l.split("\t", 2) for l in numstat.splitlines()) if a.isdigit() and b.isdigit())
    files = len(numstat.splitlines())
    log(f"change: {files} files, {lines} lines")
    if lines > cfg.get("maxDiffLines", 400):
        raise Failure(f"the change is too big for this job ({lines} lines in {files} files)")
    (OUT / "change.diff").write_text(git("diff", "--cached", base, cwd=path))
    log(f"running the tests myself: {rule['test']}")
    sh(rule["test"], path)
    git("commit", "--quiet", "-m", f"{issue['identifier']}: {issue['title']}\n\n{result['summary']}\n\nLinear: {issue['url']}", cwd=path)
    body = (f"{result['summary']}\n\n**Verified:** {result.get('verified', '')}\n\n"
            f"**Change:** {files} files, {lines} lines. Tests pass (`{rule['test']}`), run by the job.\n\n"
            f"Linear: {issue['url']}\n\nMade by the fox agent job ({RUN_ID}). "
            + (f"Merging publishes it to `{rule['publish']}` on the job's next run." if rule.get("publish") else ""))
    if DRY:
        log(f"[dry-run] would push {branch} and open a PR to {rule['base']}")
        return f"{issue['identifier']}: PR ready (dry run)"
    git("push", "--quiet", "--force", "origin", f"HEAD:refs/heads/{branch}", cwd=path)
    url = run(["gh", "pr", "create", "--repo", rule["repo"], "--base", rule["base"], "--head", branch,
               "--title", f"{issue['identifier']}: {issue['title']}", "--body", body], cwd=path)
    linear.comment(issue, f"👀 Pull request for review: {url}\n\n{result['summary']}\n\n**Verified:** {result.get('verified', '')}")
    if state_id(issue, "started", prefer="In Review"):
        linear.update(issue, stateId=state_id(issue, "started", prefer="In Review"))
    return f"{issue['identifier']} → PR {url.rsplit('/', 1)[-1]}: {result['summary']}"


def main():
    cfg = json.loads(CONFIG.read_text())
    label = cfg.get("label", "agent-ok")
    lines = []
    candidates = []
    for ws in cfg["workspaces"]:
        linear = Linear(ws["keyFile"])
        for rule in ws["repos"]:
            try:
                lines += publish_merged(linear, rule)
            except Failure as f:
                log(f"publishing {rule['repo']} skipped: {f.reason}")
        for issue in linear.labeled(label):
            rule = next((r for r in ws["repos"] if issue["team"]["key"] in r["teams"]), None)
            if rule:
                candidates.append((issue, rule, ws, linear))
            else:
                log(f"{issue['identifier']} has {label} but no repo is configured for team {issue['team']['key']}")
    if candidates:
        candidates.sort(key=lambda c: (c[0]["priority"] or 9, c[0]["createdAt"]))  # most urgent, then oldest
        issue, rule, ws, linear = candidates[0]
        log(f"taking {issue['identifier']}: {issue['title']} ({len(candidates)} labeled)")
        ctx = Path(ws.get("context", "")).expanduser()
        context = ctx.read_text() if ws.get("context") and ctx.exists() else ""
        try:
            done = work_on(linear, issue, rule, context, cfg)
            if done:
                lines.append(done)
        except Failure as f:
            log(f"no pull request: {f.reason}")
            if f.detail:
                log(f.detail)
            # Back where it was, without the label, with the reason: not retried every run.
            keep = [l["id"] for l in issue["labels"]["nodes"] if l["name"].lower() != label.lower()]
            try:
                linear.update(issue, stateId=issue["state"]["id"], labelIds=keep)
                linear.comment(issue, f"⚠️ The fox agent did not open a pull request (job run `{RUN_ID}`): {f.reason}.\n\n"
                                      + (f"```\n{f.detail[-1500:]}\n```\n\n" if f.detail else "")
                                      + f"Nothing was pushed. Add `{label}` again to retry.")
            except Exception as e:
                log(f"could not report to Linear: {e}")
            lines.append(f"{issue['identifier']} not done: {f.reason}")
    print("FOX_SUMMARY: " + (("[dry-run] " if DRY else "") + " · ".join(lines) if lines else f"nothing labeled {label}, nothing merged"), flush=True)
    (OUT / "report.md").write_text("# Linear agent run\n\n" + "\n".join(f"- {l}" if "\n" not in l else f"\n```\n{l}\n```\n" for l in report) + "\n")
    return 1 if any(" not done: " in l for l in lines) else 0


if __name__ == "__main__":
    sys.exit(main())
