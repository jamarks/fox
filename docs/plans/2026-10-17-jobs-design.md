# Jobs: scripts on a schedule

Built from the handoff in `2026-10-16-cloud-only-hetzner.md` (section "Handoff — scheduled jobs"), with the owner's choices of 2026-10-17.

## What a job is

A script (`.py`, `.mjs`/`.js`, `.sh`, or any executable) in a folder, usually a workspace, with a schedule. Inside, the script does what it needs, including `fx ask` one or more times; for fox it is always a script. Keep as much as possible deterministic: when there is nothing to do, the script ends without calling fx.

The script prints `FOX_SUMMARY: <one line>` to say what the run did, `FOX_LINK: <label> <url>` for things to open (up to 5, shown as buttons), and writes any report to `$FOX_JOB_OUTPUT`. Every run keeps its log (stdout and stderr), start, end, duration, status and those files; the last 50 runs per job.

## Schedules (no cron syntax)

`schedule.mjs`: every N hours inside a daily window on some days, once a day at a time on some days (weekly is that with fewer days), or once. Times are local to an IANA zone (the browser's by default), so they hold across daylight saving changes; a time skipped by spring-forward moves an hour on, a repeated one runs once. Times missed while the runner was down are skipped, never caught up in a burst.

## Runner apart from fox

`jobs.mjs` keeps definitions in `<state>/jobs.json` and runs in `<state>/jobs/<id>/runs/`. On a server the runner is its own service (`fox-jobs.service`, `bin/fox-jobs.mjs`, `FOX_JOBS_RUNNER=external` for fox), so a fox deploy (which a job may itself trigger by pushing to `release`) never kills a job mid-run. After a deploy, `fox-update` leaves `jobs/restart-requested`; the runner exits when idle and systemd starts it on the new version. On a laptop the runner lives inside fox.

- One job at a time; a due job queues behind the one running. Run now goes through the same queue.
- Each run has a time limit (30 minutes by default, up to 240) that stops its whole process group.
- Scripts start by extension with arguments as a list, never through a shell string. They run as the fox user, with its permissions: path checks are not a sandbox.
- A run left running by a crash or a kill is marked interrupted, never assumed done.
- No automatic retries.

## In fox

Sidebar section Jobs: a dot with the last result (green ok, red failed, orange breathing while running, hollow gray paused or never ran), the next run ("in 37 min", "Mon 09:00") and the schedule in words. Clicking opens the job in the center: Run now, Pause, Edit, and the runs, each with its summary and duration; clicking a run shows its files and log. The editor builds the schedule with buttons and draws it on a 24-hour line with the next runs written out.

## First job

Linear bug fixing: every 2 hours, Monday to Friday 09:00 to 19:00. Only issues labeled `agent-ok`. With none, the script ends without calling fx. Otherwise, one issue per run, in its own copy of the repo; fx fixes, runs the tests and checks the change; it pushes to `release` for fox (decided by the owner) or `staging` for orchestra, and comments in Linear what changed. A Linear API key is stored on the server, never in chat. The owner writes a markdown file describing what lives in Linear (what is fox, what is orchestra) for the job to give fx.
