# Writing a fox job

A job is a script fox runs on a schedule. fox shows each run (status, a one-line summary, links, log, files) on the Jobs page. This guide is how to write one well; what *your* jobs do, and the rules for *your* repos, belong in the private repo where you keep them, next to the scripts.

## The contract

- **Where it lives.** A script inside a folder (usually a private repo of your own, for example `jobs/report.py`). fox runs it from that folder. Before each run fox fast-forwards the folder if it is a clean git checkout on its default branch, so a script you pushed from another copy is the one that runs.
- **How it starts.** By extension: `.py` with `python3`, `.sh` with `bash`, `.mjs`/`.js` with `node`; anything else is run as an executable. Arguments come from the job definition, never through a shell string.
- **What it tells fox.** Lines on its output:
  - `FOX_SUMMARY: <one line>`: what this run did. Shown in the list and on the run.
  - `FOX_LINK: <label> <url>`: a button on the run (up to 5, http(s) only), for what you should open: a pull request to review, a report, a deploy.
- **Files for you.** Write them to `$FOX_JOB_OUTPUT`; they are kept with the run.
- **Limits.** One job runs at a time, each with a time limit (30 minutes by default); past it fox stops the script and everything it started. The last 50 runs of each job are kept.
- **Environment.** `FOX_JOB_ID`, `FOX_JOB_NAME`, `FOX_JOB_RUN_ID`, `FOX_JOB_OUTPUT`, and `PYTHONPATH` with fox's helpers (below). Nothing of fox's own settings is meant for the job.

Create and manage jobs from the Jobs page or with `fox-job` (`fox-job --help`).

## Good jobs

- **Plain code first.** Check what there is to do with ordinary code (an API, git, a file) and exit early, with a summary, when there is nothing. Call a model only for the part that needs one.
- **Keys outside the repo.** Read them from files only the job's user can read (for example `~/.config/fox-jobs/<name>`), never from the repo, the job's arguments or its output.
- **Never run what a model says as a command.** Commands come from the script or its config; a model's answer is data to check.
- **Say what happened.** Always print a summary, also when nothing was done or something failed, and exit non-zero on a real failure so the run shows as failed.

## Jobs that change code: propose, never push

A job that changes a repo proposes the change as a pull request and a person merges it. `foxjob.propose_change()` does the whole round:

```python
import foxjob

def main():
    p = foxjob.propose_change(
        "owner/repo", branch="agent/update-deps", title="Update dependencies",
        task="Update the dependencies that have patch releases and fix what breaks.",
        test="npm test", setup="npm ci", max_lines=300)
    if p.status == "opened":
        foxjob.summary(f"PR {p.url.rsplit('/', 1)[-1]}: {p.summary}")
    else:
        foxjob.summary(f"no new PR ({p.status})")

try:
    main()
except foxjob.Failure as f:
    foxjob.log(f.detail)
    foxjob.summary(f"not done: {f.reason}")
    raise SystemExit(1)
```

What it does, in order: refuses when the repo already has `max_open` PRs from jobs waiting, takes the job's own clean copy of the repo (never your working copy), runs `setup`, asks fx to do `task` with fixed rules (no commits, small change, follow AGENTS.md, run the tests, end with a `RESULT` line), checks the size of the change against `max_lines`, runs `test` itself, commits, pushes the branch and opens the PR, and prints a `FOX_LINK` to it. When fx skips, changes nothing, goes over the size or the tests fail, it raises `foxjob.Failure` and nothing is pushed. `model=` and `effort=` pick fx's model and reasoning effort for that job (exact ids from `fx models --json`); without them fx uses its own settings. `ask_fx` takes the same two.

Other helpers in `foxjob` (`lib/python/foxjob.py`): `summary`, `link`, `log`, `write_report`, `output_dir`, `run`/`git`/`sh` (commands without fox's environment), `checkout`, `ask_fx` (fx with the `RESULT` convention), `link_open_prs` (a button for each PR still waiting, every run), and `publish_merged`: after you merge, it moves a deploy branch (for example `release`) forward to the base branch, fast-forward only, and returns the merged PRs so the job can close whatever they came from.

In fox's own repo, merging the pull request is what publishes it: a merge into `main` moves `release` forward (`.github/workflows/publish-merged.yml`). Other repos decide for themselves; `publish_merged` is there for the ones that publish from a branch.

Branch names start with `agent/` by default; `publish_merged` and `link_open_prs` only look at those, so your own PRs are never touched.
