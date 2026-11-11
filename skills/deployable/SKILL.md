---
name: deployable
description: Give this project a ./run (and usually a ./deploy) that claude3's Run button can run, deploying only what changed. Use when asked to make a project deployable, set up its deploy or ./run for claude3, fix a deploy that redoes everything, or when starting a new or empty project (about to get a skeleton) that will be deployed.
---

# Make this project deployable from claude3's Run button

claude3 is the user's browser page; each tab is a project on one host. Its footer's **Run** button
(also a prompt of just `r`, and Deploy in its deploy warning) runs `./run` in the project folder,
on the tab's host. This skill says what claude3 expects of `./run` and how to make the deploy do
only what is needed. The source is `skills/deployable/SKILL.md` in the claude3 repo (WSL,
/root/apps/claude3), and claude3's `./deploy` copies it to every host; fix it there, not here.

**Don't run `./run` or `./deploy` yourself** (the user deploys). Check with `bash -n` and say what
the user should see when they press Run.

## What claude3 does

- **Runs `./run`** with no terminal and no stdin, one at a time per project (Run while one is
  going only brings its output back up). Exit 0 is success. Otherwise an error dialog shows the
  failure and every output line starting with `!!`. After **5 minutes** `timeout` stops the script
  and everything it started, except what it detached with `setsid`, and the run counts as failed.
  All output is shown, so print one short line per step.
- **The host decides how `./run` is started.** You run on the same machine as the tab's backend:
  - **wsl** (WSL on the laptop, `uname -r` has `microsoft`): `systemd-run` as a transient unit
    with `KillMode=process`, so what `./run` leaves running survives. `HOME=/root`,
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin`, with **no Windows
    directories**: to call `cmd.exe`, `powershell.exe` or `reg.exe`, add
    `PATH="$PATH:/mnt/c/Windows/System32:/mnt/c/Windows/System32/WindowsPowerShell/v1.0"`.
    Windows programs started from here run elevated.
  - **srv** (hahnca.com): spawned by claude3's backend, which runs under pm2. `HOME=/root`,
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin`.
  - **win** (Windows on the laptop): Git Bash (`C:\Program Files\Git\bin\bash.exe`) runs
    `bash ./run` under its own `timeout`, with the user's
    logon environment plus Git Bash's `/mingw64/bin` and `/usr/bin`. Not elevated. Git Bash has
    find, sort, xargs, sha1sum, ssh, scp, curl, nohup, node, npm and git, but **no rsync and no
    setsid**. Paths look like `/c/Users/mark/...`. **Line endings must be LF**: a CR in `./run`
    makes bash fail with `$'\r': command not found`.
- **Deploy warning and Run highlight.** Before each prompt claude3 looks for `./deploy` (else
  `./run`) and the stamp file `.deployed`. Any file `git ls-files --cached --others
  --exclude-standard` lists that is newer than the stamp means a deploy is due: the Run button is
  highlighted and a prompt asks Deploy / Continue / Cancel. If `.deployed` contains paths, one
  per line (relative to the project root; spaces and git globs are fine), only files under them
  count; an empty stamp counts every file, docs included. No script, no stamp, or no git repo: no warning.
  - A file named on a line of its own counts even if git ignores it (an `.env`). Under a folder
    or a glob, ignored files never count.
  - A tracked file deleted or renamed since the deploy counts too.
  - A stamp written while the Run button's `./run` is going counts from when that run
    **started**, so a file saved during the deploy still raises the warning. So does a file the
    deploy itself rewrites under the stamped paths (`npm install` and a lock file): the warning
    then stays up until the next Run. Keep what the deploy writes out of the stamped paths where
    you can.

## What to build

`./run` is the entry point. Put the deploy in `./deploy` and have `./run` call it (plus start a dev
server, if the project has one). A project with nothing but a deploy can use
`exec "$(dirname "$0")/deploy" "$@"` as its whole `./run`. Both are bash, `#!/usr/bin/env bash`,
executable (`chmod +x`).

1. **Find out what a deploy means here.** Read the project's CLAUDE.md, README, architecture note
   and any existing scripts (`deploy`, `run`, `*.cmd`, `*.ps1`, `ecosystem.config.cjs`,
   `package.json` scripts). List the **targets**: each place something is copied, installed or
   restarted. Keep what existing scripts do; don't delete the user's other scripts. If where or
   how it runs is unclear, ask rather than guess.
2. **Skip what is already there.** For each target:
   - Hash its inputs: `hashed() { find "$@" -type f -print0 | sort -z | xargs -0 sha1sum | sha1sum | cut -c1-12; }`.
     Leave build output, `node_modules` and anything the deploy itself writes out of the inputs.
   - Ask the target what it has: a `version` file written beside the deployed copy, or the
     running service answering `GET /version` (best, since it proves the new code is running).
   - Equal: print `== <target>: up to date (<hash>)` and move on. Build only if some target needs
     the build. Restart only what got new files.
   - Write the target's version only after its step has succeeded and been checked.
3. **Check every step.** After a restart, poll until the service answers with the new version
   (about 20 x 1s); after an install, check the installed thing is there. On failure print a `!!`
   line (and the last lines of the service's log) and exit non-zero. `set -euo pipefail`, and no
   `|| true` on a step that matters. Stopping at the first failure is fine: the skipping makes a
   re-run redo only what is left.
4. **Stamp at the end, on success only:** write the paths the deploy depends on into `.deployed`,
   one per line, e.g. `printf '%s\n' src server "my dir" package.json > .deployed` (not `echo`,
   which puts them all on one line, read as a single path). Stamp even when every step
   was skipped, so the warning clears. Add `.deployed` and any hash/version files the deploy keeps
   to `.gitignore`, and to the packaging ignore list if the project builds a package from the folder.
5. **End the output with** `trap 'echo; echo "====== ENDED ======"' EXIT` near the top of the
   script that runs last. A trap in `./run` is lost if `./run` `exec`s `./deploy`, so put it in
   `./deploy` then.
6. **Nothing interactive:** no prompts (`ssh -o BatchMode=yes`, `npm ci`, no `sudo` that asks), and
   no waiting on a process that stays running.
7. **Processes that keep running:** a service belongs under that host's own manager (pm2 on srv,
   systemd on wsl), restarted by the deploy, not left as a child of `./run`. A dev server that
   `./run` starts must be detached so `./run` can exit, with its output in a log:
   `setsid nohup <cmd> > dev.log 2>&1 < /dev/null &` on Linux. If one is already running, leave it
   (hot reload covers code changes); find it with `pgrep -f` on its absolute path. On win there
   is no setsid: use `nohup <cmd> > dev.log 2>&1 < /dev/null &`, and say that the user should
   check it survives a claude3 deploy (which restarts the win backend).
8. **Pick ports by looking** (`ss -ltn` on Linux, `netstat -ano` on Windows), and pin a dev
   server's port (vite: `strictPort`) so it can't drift.

## A new or empty project

When the folder is empty, or a skeleton (a template, `npm create ...`, a starter repo) is about to
be installed:

- **Skeleton first.** Generators often refuse a non-empty folder or offer to empty it (`--overwrite`,
  "Remove existing files"). Run the generator before writing `./run`, or generate into a temporary
  subfolder and move its files up. Never accept an option that empties the folder once `./run` and
  `./deploy` are in it.
- **If `./run` must come first,** make it a stub that works: print `== nothing to deploy yet` and
  exit 0, and write no `.deployed` (no stamp means no warning). Keep those exact words: claude3's
  Check looks for them and won't call the setup done while they are there. Fill in the targets
  once the skeleton is in, following the steps above.
- **Ask what isn't known yet:** which host the app runs on, how it is served (pm2 on srv, systemd
  on wsl, a Windows process), and its port.
- **Line endings and modes:** on win add a `.gitattributes` with `run text eol=lf` and
  `deploy text eol=lf`; on Linux `chmod +x run deploy`.
- **git:** the deploy warning needs a git repo. Creating one (`git init`) is the user's call: say
  so instead of doing it, unless they asked.
- Start `.gitignore` with `.deployed` and the deploy's own files, next to the skeleton's entries.

## Finish

- `bash -n run deploy`; on win also `grep -c $'\r' run deploy` (must be 0).
- Update the project's architecture note and CLAUDE.md where they describe deploying.
- claude3 asks before each prompt in this tab until its **Check** passes. Check reads `./run` and
  `./deploy` without running them: `./run` must exist, parse (`bash -n`), have no CR, be
  executable (except on win), not be the stub, and one of the two must write paths into the stamp
  with a redirect (`> .deployed`, at any path: `> "$dir/.deployed"` is fine). A bare
  `touch .deployed` doesn't count, and an `echo` into it fails. From then on the same check runs
  before every Run, and a script that stops passing brings the question back.
- Tell the user: pick Check in claude3's setup dialog (it comes up at the next prompt), then press
  Run. The first Run deploys everything once (nothing has been recorded yet), and a second Run with
  no changes should print only "up to date" lines.
