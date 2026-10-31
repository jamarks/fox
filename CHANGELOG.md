# Changelog

What changed in fox, newest first: one line per merged pull request. Written by a job from the pull requests; edit the PR title to change a line.

## 2026-10-31

- Live checks on what fx changed: lint and type errors next to its files ([#72](https://github.com/jamarks/fox/pull/72))
- Open a large tool result from its exact transcript call ([#70](https://github.com/jamarks/fox/pull/70))
- Surface unread subagent results as they land ([#68](https://github.com/jamarks/fox/pull/68))
- Expose new fx settings as opt-in controls ([#71](https://github.com/jamarks/fox/pull/71))
- Focus the sidebar on one workspace ([#67](https://github.com/jamarks/fox/pull/67))
- Show the live model after a session switches models ([#66](https://github.com/jamarks/fox/pull/66))

## 2026-10-29

- Keep root metadata writes out of the build tree ([#65](https://github.com/jamarks/fox/pull/65))

## 2026-10-28

- Serialize fx settings updates to preserve explicit overrides ([#63](https://github.com/jamarks/fox/pull/63))
- Reject publication roots that resolve outside allowed directories ([#62](https://github.com/jamarks/fox/pull/62))
- Do not label an existing checkout as a different repo ([#61](https://github.com/jamarks/fox/pull/61))
- Expose new fx settings as opt-in controls ([#60](https://github.com/jamarks/fox/pull/60))
- Block workspace deletion when repos contain ignored files ([#59](https://github.com/jamarks/fox/pull/59))
- Show the conversation that changed a pull request ([#53](https://github.com/jamarks/fox/pull/53))

## 2026-10-26

- Preserve in-flight passkey challenges under load ([#58](https://github.com/jamarks/fox/pull/58))
- Keep static app files inside their published directory ([#57](https://github.com/jamarks/fox/pull/57))
- Preserve ignored local files during automatic fast-forward ([#56](https://github.com/jamarks/fox/pull/56))
- Expire terminal sockets for restored sessions ([#55](https://github.com/jamarks/fox/pull/55))

## 2026-10-25

- Companion repos: compare real paths on both sides (tests fail on macOS) ([#44](https://github.com/jamarks/fox/pull/44))
- Expose new fx settings as opt-in controls ([#52](https://github.com/jamarks/fox/pull/52))

## 2026-10-24

- Workspaces show their jobs and open PRs: counted under each one, one click filters Jobs or Pull requests ([#51](https://github.com/jamarks/fox/pull/51))
- Record the exact inputs behind every job run ([#46](https://github.com/jamarks/fox/pull/46))
- Expose new fx settings as opt-in controls ([#49](https://github.com/jamarks/fox/pull/49))
- Keep an editable next-message draft per session ([#47](https://github.com/jamarks/fox/pull/47))
- Show token footprint for a parent and its subagents ([#45](https://github.com/jamarks/fox/pull/45))

## 2026-10-23

- Expose new fx settings as opt-in controls ([#43](https://github.com/jamarks/fox/pull/43))

## 2026-10-22

- Insert installed fx skills from a small shelf ([#39](https://github.com/jamarks/fox/pull/39))
- Skills for fx: see, install and remove them from Settings ([#35](https://github.com/jamarks/fox/pull/35))
- Branch menu: solid over the sky theme, long names on one line ([#40](https://github.com/jamarks/fox/pull/40))
- Switch a workspace repo's branch from the sidebar, and get back to main safely ([#37](https://github.com/jamarks/fox/pull/37))
- Expose new fx settings as opt-in controls ([#38](https://github.com/jamarks/fox/pull/38))
- The fox winks at a new reply and yawns when all is quiet ([#36](https://github.com/jamarks/fox/pull/36))

## 2026-10-21

- Pull requests: Later pauses a PR without losing it, Resume brings it back ([#34](https://github.com/jamarks/fox/pull/34))
- Choose explicit companion repos for a new fx session ([#31](https://github.com/jamarks/fox/pull/31))
- Right column steps aside when nothing is open ([#33](https://github.com/jamarks/fox/pull/33))
- Waking a session hides the terminal behind the notice ([#30](https://github.com/jamarks/fox/pull/30))
- Opening a sleeping session shows at once ([#29](https://github.com/jamarks/fox/pull/29))
- Right column steps aside on Jobs, Pull requests, Settings and the mosaic ([#28](https://github.com/jamarks/fox/pull/28))
- Expose new fx settings as opt-in controls ([#27](https://github.com/jamarks/fox/pull/27))
- Check provider headroom before launching a swarm ([#26](https://github.com/jamarks/fox/pull/26))

## 2026-10-20

- Choose model effort and speed without changing defaults ([#25](https://github.com/jamarks/fox/pull/25))
- Show where a swarm actually spent its time ([#24](https://github.com/jamarks/fox/pull/24))

## 2026-10-19

- Fix Mosaic navigation, refresh and sleeping sessions ([#23](https://github.com/jamarks/fox/pull/23))
- Mosaic: lighter layout, even spacing, formatted replies ([#20](https://github.com/jamarks/fox/pull/20))
- Mosaic: show the live bottom of each terminal, not old scrollback ([#19](https://github.com/jamarks/fox/pull/19))
- Show PR loading state and all history by creation date ([#18](https://github.com/jamarks/fox/pull/18))
- Browse merged pull request history from the sidebar ([#17](https://github.com/jamarks/fox/pull/17))
- Watch several live fx sessions in one quiet mosaic ([#14](https://github.com/jamarks/fox/pull/14))
- Use broom icon for memory cleanup ([#13](https://github.com/jamarks/fox/pull/13))

## 2026-10-18

- Running version in the sidebar footer ([#12](https://github.com/jamarks/fox/pull/12))
- README: TL;DR and what's new; detail in docs/ ([#11](https://github.com/jamarks/fox/pull/11))
- Model per job, URLs for every page, no stale waking overlay ([#10](https://github.com/jamarks/fox/pull/10))
- Docs: deploy branch chosen in Settings, fox-update every minute ([#8](https://github.com/jamarks/fox/pull/8))
- Sidebar footer in one line, cleaner cards, jobs list with last run, merged mark on PR links ([#9](https://github.com/jamarks/fox/pull/9))
- Steer named subagents from their result rows ([#7](https://github.com/jamarks/fox/pull/7))
- Foxjob: retry once when the provider drops fx's answer ([#6](https://github.com/jamarks/fox/pull/6))
- Security hardening, jobs from fx wait for approval, pinned install, deploy branch in Settings ([#5](https://github.com/jamarks/fox/pull/5))
- Foxjob: a job picks fx's model and effort ([#4](https://github.com/jamarks/fox/pull/4))
- Docs: merging a PR publishes it ([#3](https://github.com/jamarks/fox/pull/3))
- Expose new fx settings as opt-in controls ([#2](https://github.com/jamarks/fox/pull/2))

## 2026-10-17

- Añadir una página sencilla de métricas comparativas en Fox ([#1](https://github.com/jamarks/fox/pull/1))
