"""foxjob: what fox jobs written in Python share (fox puts this folder on PYTHONPATH for every job).

A job is a script fox runs on a schedule (see docs/jobs.md). It talks to fox with two kinds of lines,
`FOX_SUMMARY: <one line>` and `FOX_LINK: <label> <url>`, and writes files for you to $FOX_JOB_OUTPUT.

The main piece is propose_change(): fx makes a change in a clean copy of a repo, the job checks it itself (tests,
size) and opens a pull request. A person merges it. fx never commits, pushes or merges, and nothing here ever
pushes to the base branch; publish_merged() then moves a deploy branch forward only to what was merged.

Stdlib only, plus git, gh and fx on PATH.
"""
import json, os, re, subprocess, time
from dataclasses import dataclass, field
from pathlib import Path

RUN_ID = os.environ.get("FOX_JOB_RUN_ID", "manual")
WORK = Path(os.environ.get("FOXJOB_WORK", "~/.cache/fox-jobs")).expanduser()
GIT_BASE = os.environ.get("FOXJOB_GIT_BASE", "https://github.com/")  # tests point this at local repos
RETRY_WAIT = int(os.environ.get("FOXJOB_RETRY_WAIT", "60"))
_report, _linked = [], set()

# What the job starts (tests, fx) must not inherit fox's own settings (its port, its state, its auth).
CHILD_ENV = {k: v for k, v in os.environ.items()
             if not (k.startswith("FOX_") and not k.startswith("FOX_JOB_") and k != "FOX_DEFAULT_TZ") and k != "PORT"}


class Failure(Exception):
    """A step that did not work; `reason` is one line for people, `detail` the output behind it."""
    def __init__(self, reason, detail=""):
        super().__init__(reason)
        self.reason, self.detail = reason, detail


def output_dir():
    out = Path(os.environ.get("FOX_JOB_OUTPUT") or "/tmp/fox-job-out")
    out.mkdir(parents=True, exist_ok=True)
    return out


def log(*parts):
    print(*parts, flush=True)
    _report.append(" ".join(str(p) for p in parts))


def summary(text):
    print("FOX_SUMMARY: " + " ".join(str(text).split())[:300], flush=True)


def link(label, url):
    """A button on this run in fox, for something to open: a PR to review, what was published. Once per URL."""
    if url and url not in _linked:
        _linked.add(url)
        print(f"FOX_LINK: {label} {url}", flush=True)


def write_report(title):
    (output_dir() / "report.md").write_text(f"# {title}\n\n" + "\n".join(
        f"- {l}" if "\n" not in l else f"\n```\n{l}\n```\n" for l in _report) + "\n")


def run(args, cwd, timeout=600, check=True):
    p = subprocess.run(args, cwd=cwd, env=CHILD_ENV, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise Failure(f"{' '.join(str(a) for a in args[:3])} failed (exit {p.returncode})", (p.stdout + p.stderr)[-3000:])
    return p.stdout.strip()


def git(*args, cwd, check=True):
    return run(["git", *args], cwd=cwd, check=check)


def sh(cmd, cwd, timeout=1200):
    """A shell command from the job's own config (setup, tests), never from a model's answer."""
    return run(["bash", "-lc", cmd], cwd=cwd, timeout=timeout)


def gh_json(args, cwd):
    return json.loads(run(["gh", *args], cwd=cwd) or "[]")


def checkout(repo):
    """The job's own copy of owner/name (never your working copy), fetched fresh."""
    owner, name = repo.split("/")
    path = WORK / f"{owner}__{name}"
    if not (path / ".git").exists():
        WORK.mkdir(parents=True, exist_ok=True)
        git("clone", "--quiet", f"{GIT_BASE}{repo}.git", str(path), cwd=WORK)
    git("fetch", "--quiet", "--prune", "origin", cwd=path)
    return path


def agent_rules(test, shots=None):
    shot = (f" Save one to three of those screenshots, the ones that show the change best, as PNG files named "
            f"screenshot-1.png, screenshot-2.png… in {shots}: the person reviewing sees them next to the pull request.") if shots else ""
    return f"""Rules:
- Work only in this repository folder. Do not commit, push, create branches or open pull requests: the job that started you does that after checking your work, and a person reviews it.
- Keep the change small and focused. If it needs a large change, a product decision the task does not answer, new dependencies, or secrets, change nothing and explain why.
- Follow AGENTS.md and the conventions of the code around you. Add or update tests for what you change.
- Run the tests (`{test}`) and make them pass.
- If the change shows in a UI, run it and look at it with the browser tool (screenshot, console errors) before you finish.{shot}
- End your answer with exactly one line like this, and nothing after it:
RESULT: {{"status": "done" or "skip", "summary": "<one sentence in the task's language: what you changed, or why you skipped>", "try": "<where a person sees or uses it: what to open or click, one or two sentences; empty if nothing shows>", "verified": "<how you checked it>"}}"""


def parse_result(final):
    m = re.search(r"^RESULT:\s*(\{.*\})\s*$", (final or "").strip(), re.M)
    if not m:
        raise Failure("fx did not end with a RESULT line", (final or "")[-1500:])
    try:
        result = json.loads(m.group(1))
    except json.JSONDecodeError:
        raise Failure("fx's RESULT line is not valid JSON", m.group(1))
    if result.get("status") not in ("done", "skip") or not isinstance(result.get("summary"), str):
        raise Failure("fx's RESULT does not say done or skip with a summary", m.group(1))
    return result


def ask_fx(prompt, cwd, timeout_min=25, model=None, effort=None):
    """fx works on its own (fx ask --auto) and answers with a RESULT line; its log and answer go to the output.

    model and effort pick them for this request (exact ids from `fx models --json`); without them fx uses its settings.
    A model or effort chosen for the job in fox (FOX_JOB_MODEL, FOX_JOB_EFFORT) wins over the script's own choice.
    """
    model = os.environ.get("FOX_JOB_MODEL") or model
    effort = os.environ.get("FOX_JOB_EFFORT") or effort
    log(f"fx working (up to {timeout_min} min{', ' + model if model else ''})…")
    pick = (["--model", model] if model else []) + (["--effort", effort] if effort else [])
    for attempt in (1, 2):
        p = subprocess.run(["fx", "ask", "--auto", "--no-save", "--json", *pick, "--", prompt], cwd=cwd, env=CHILD_ENV,
                           capture_output=True, text=True, timeout=timeout_min * 60)
        # A provider that drops the answer (fx prints provider_error and returns nothing) usually works a minute later.
        if attempt == 2 or "provider_error" not in p.stderr or _final(p.stdout):
            break
        log("the provider failed the answer; trying once more in a minute")
        time.sleep(RETRY_WAIT)
    (output_dir() / "fx-progress.log").write_text(p.stderr[-200_000:])
    try:
        final = json.loads(p.stdout).get("final_output") or ""
    except json.JSONDecodeError:
        raise Failure(f"fx did not answer in JSON (exit {p.returncode})", (p.stdout + p.stderr)[-2000:])
    (output_dir() / "fx-answer.md").write_text(final)
    return parse_result(final)


def _final(stdout):
    try:
        return json.loads(stdout).get("final_output") or ""
    except (json.JSONDecodeError, AttributeError):
        return ""


def count_lines(numstat):
    """Lines added plus removed in `git diff --numstat` output (binary files count as zero)."""
    return sum(int(a) + int(b) for a, b, _ in (l.split("\t", 2) for l in numstat.splitlines() if l.count("\t") >= 2)
               if a.isdigit() and b.isdigit())


def open_prs(repo, cwd, prefix="agent/"):
    return [pr for pr in gh_json(["pr", "list", "--repo", repo, "--state", "open", "--limit", "50",
                                  "--json", "number,headRefName,url,title"], cwd) if pr["headRefName"].startswith(prefix)]


def link_open_prs(repo, prefix="agent/"):
    """Every run shows the PRs still waiting for review, so merging is one click from fox."""
    try:
        for pr in open_prs(repo, checkout(repo), prefix):
            link(f"review #{pr['number']}", pr["url"])
    except Exception as e:
        log(f"could not list open PRs in {repo}: {e}")


@dataclass
class Proposal:
    status: str                      # opened · busy (too many PRs waiting) · exists (this branch has one) · dry-run
    summary: str = ""
    verified: str = ""
    url: str = ""
    files: int = 0
    lines: int = 0
    branch: str = ""
    notes: list = field(default_factory=list)


def propose_change(repo, *, branch, title, task, test, base="main", setup=None, max_lines=400, max_open=3,
                   prefix="agent/", timeout_min=25, body="", commit_message=None, dry=False, model=None, effort=None, why=""):
    """fx does `task` in a clean copy of `repo`; the job checks size and tests itself and opens a PR to `base`.

    commit_message may use {title} and {summary} (fx's one-line summary of what it did).
    why opens the PR's text: the problem the change solves, so a reviewer knows what it is about before what it does.
    fx is asked where to try it (the PR says so) and to save screenshots of a UI change to the run's files.

    Raises Failure when fx skips, changes nothing, goes over max_lines or the tests fail: nothing is pushed then.
    """
    path = checkout(repo)
    waiting = open_prs(repo, path, prefix)
    if len(waiting) >= max_open:
        log(f"{repo} already has {len(waiting)} PRs from jobs waiting for review; not starting another")
        return Proposal("busy")
    if any(pr["headRefName"] == branch for pr in waiting):
        log(f"{branch} already has an open PR")
        return Proposal("exists", branch=branch)
    start = f"origin/{base}"
    git("checkout", "--quiet", "-B", branch, start, cwd=path)
    git("reset", "--quiet", "--hard", start, cwd=path)
    git("clean", "-qfdx", cwd=path)
    if setup:
        sh(setup, path)
    result = ask_fx(f"{task.strip()}\n\n{agent_rules(test, shots=output_dir())}", path, timeout_min, model=model, effort=effort)
    log(f"fx says {result['status']}: {result['summary']}")
    if result["status"] == "skip":
        raise Failure("fx did not do it: " + result["summary"])
    if git("rev-parse", "HEAD", cwd=path) != git("rev-parse", start, cwd=path):
        git("reset", "--quiet", "--soft", start, cwd=path)  # fx committed anyway: one commit, made here
    git("add", "-A", cwd=path)
    numstat = git("diff", "--cached", "--numstat", start, cwd=path)
    if not numstat:
        raise Failure("fx said done but changed no files")
    lines, files = count_lines(numstat), len(numstat.splitlines())
    log(f"change: {files} files, {lines} lines")
    if lines > max_lines:
        raise Failure(f"the change is too big for this job ({lines} lines in {files} files)")
    (output_dir() / "change.diff").write_text(git("diff", "--cached", start, cwd=path))
    log(f"running the tests myself: {test}")
    sh(test, path)
    message = (commit_message or "{title}\n\n{summary}").replace("{title}", title).replace("{summary}", result["summary"])
    git("commit", "--quiet", "-m", message, cwd=path)
    tryit = str(result.get("try") or "").strip()
    pr_body = ((f"**Why:** {why.strip()}\n\n" if why.strip() else "")
               + f"{result['summary']}\n\n" + (f"**Try it:** {tryit}\n\n" if tryit else "")
               + f"**Verified:** {result.get('verified', '')}\n\n"
               f"**Change:** {files} files, {lines} lines. Tests pass (`{test}`), run by the job.\n\n"
               + (body.strip() + "\n\n" if body.strip() else "") + f"Made by a fox job ({RUN_ID}).")
    done = Proposal("dry-run", result["summary"], result.get("verified", ""), files=files, lines=lines, branch=branch)
    if dry:
        log(f"[dry-run] would push {branch} and open a PR to {base}")
        return done
    git("push", "--quiet", "--force", "origin", f"HEAD:refs/heads/{branch}", cwd=path)
    url = run(["gh", "pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body", pr_body], cwd=path)
    link(f"review #{url.rsplit('/', 1)[-1]}", url)
    done.status, done.url = "opened", url
    return done


def publish_merged(repo, *, base="main", publish="release", prefix="agent/", dry=False):
    """Moves `publish` forward to `base` (fast-forward only) when job PRs were merged into base and are not out yet.

    Returns those PRs (number, headRefName, url, title). Refuses when `publish` has commits base lacks.
    """
    path = checkout(repo)
    merged = gh_json(["pr", "list", "--repo", repo, "--state", "merged", "--base", base, "--limit", "20",
                      "--json", "number,headRefName,mergeCommit,url,title"], path)
    head_ref, pub_ref = f"origin/{base}", f"origin/{publish}"
    contains = lambda sha, ref: subprocess.run(["git", "merge-base", "--is-ancestor", sha, ref], cwd=path, capture_output=True).returncode == 0
    waiting = [pr for pr in merged if pr["headRefName"].startswith(prefix) and pr.get("mergeCommit") and not contains(pr["mergeCommit"]["oid"], pub_ref)]
    if not waiting:
        return []
    if not contains(pub_ref, head_ref):
        raise Failure(f"{publish} has commits that {base} does not; not publishing until that is fixed by hand")
    head = git("rev-parse", "--short", head_ref, cwd=path)
    if dry:
        log(f"[dry-run] would move {publish} to {base} ({head}) for {len(waiting)} merged PRs")
    else:
        git("push", "--quiet", "origin", f"{head_ref}:refs/heads/{publish}", cwd=path)
        log(f"published {base} ({head}) to {publish}: {', '.join('#' + str(p['number']) for p in waiting)}")
        link(f"{publish} {head}", f"https://github.com/{repo}/commit/{head}" if GIT_BASE.startswith("https://github.com") else head)
    for pr in waiting:
        pr["published"] = head
    return waiting
