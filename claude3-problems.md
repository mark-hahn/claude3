# claude3: problems with the instructions

Nothing else was changed. Each item gives my recommendation, so "ok to all" is a valid answer.

Checked so far: `/root/apps/claude3Wsl`, `C:\Users\mark\apps\claude3Win` and
`/root/dev/apps/claude3Srv` don't exist yet. The other six project folders do. Node is on all
three hosts (Windows: `C:\nvm4w\nodejs\node.exe`). The claude CLI is too (server:
`~/.local/bin/claude`, which isn't on the PATH of a non-login shell).

## 1. Monorepo vs. separate backend folders (contradiction)

The instructions say the monorepo *contains* claude3Wsl, claude3Win and claude3Srv. The tab list
puts them at `/root/apps/claude3Wsl`, `C:\Users\mark\apps\claude3Win` and
`/root/dev/apps/claude3Srv`, which are outside this repo. Which do you mean?

- a) The source lives in this repo, and a `deploy` script copies it to those three folders (the
  way `claude2-stats` gets to `/root/dev/apps/claude2-stats`). Then the `claude3 wsl/win/srv`
  tabs would be editing deployed copies, not the source.
- b) Those three folders are separate clones of this repo.

**Recommend (a).** Develop the backends from the `claude3` tab and drop the three backend tabs,
or keep them only to look at logs and config on each host.

## 2. Three backend apps should be one

All three backends do the same job: spawn the claude CLI in a project folder and stream the
output to the page. The Windows differences (`C:\` paths, `claude.exe`, how the transcript path
is built) come to a few `if` branches. Three copies would drift apart.

**Recommend:** one `server/` package in this repo. Each host gets its own small config file
with its port and the project folders it serves.

Also, "run in multiple projects" is ambiguous. It could mean one backend per host that serves
all of that host's projects (3 processes), or one backend per project (9 processes).
**Recommend: one per host.**

## 3. A tab served by its own backend

In the `claude3 wsl/win/srv` tabs, Claude would edit the backend that is running that same
conversation. Restarting the backend after an edit kills the CLI process mid-turn and cuts the
stream. Item 1(a) avoids this. If you want those tabs anyway, the CLI has to run detached and
survive a backend restart, which is more work. Which do you want?

## 4. How much of claude2 is "looks and behaves like claude2"?

claude2 is about 11.5k lines. Except for `claudeCli.ts`, nearly all of it uses the VS Code API:
`extension.ts` has 81 `vscode.` calls and `webviews.ts` has 79. Several features only make sense
inside VS Code, or need redesigning for a browser. I need a first-cut list.

**Recommend for v1:**
- Sidebar: session list (new, rename, trash, select).
- Pane: blocks (bar + box), streaming, ctrl-click tools view, alt-click copy, tool-line detail.
- Prompt box and footer: the nav row (status, stop, ctx) and the model row (model, effort,
  advisor).

**Defer:** Cap and Alt-Cap (they capture the VS Code window), File attach from the editor, the
Monaco prompt editor (a plain textarea first), the Instructions, Quota, Stats, Models, Settings
and Cap panes, search, fork, login/auth, the git changes check, and the big-prompt toggle.

## 5. Copy claude2's code or share it?

- a) Port once and let claude3 diverge. Every claude2 fix after that has to be ported by hand.
- b) Move claude2's VS Code-free core (`claudeCli.ts`, `types.ts`, `contextStats.ts`, parts of
  `modelInfo.ts`) into a module that both projects use. This means changes to claude2 too.
- c) claude3 eventually replaces claude2.

**Recommend (a) for now,** unless (c) is the real plan, in which case say so.

## 6. Are the sessions shared with claude2?

claude2 keeps its session list in VS Code workspaceState. On WSL that is inside Windows'
`state.vscdb`. Reading it from a backend is fragile, and if claude2 and claude3 both drive the
same CLI session at once, the transcript gets corrupted.

**Recommend:** claude3 keeps its own session list (a JSON file per project, on that project's
host), and its sessions are separate from claude2's.

## 7. Where the page is served from, and how it reaches the three hosts

I assume the page is opened in a browser on the Windows laptop, on the LAN. It has to reach:
- WSL: under NAT, Windows reaches WSL through localhost forwarding.
- Windows: localhost.
- hahnca.com: over the LAN.

**Recommend:**
- The WSL backend also serves the built SPA.
- The page talks to each backend directly, over SSE for streams and POST for commands.
- Each backend allows only the SPA's origin. Without that check, any website open in the same
  browser could drive Claude on these machines through localhost.
- Ports 7310 (wsl), 7311 (win) and 7312 (srv), unless you already have numbers in mind.

## 8. What starts each backend, and what keeps it running?

- Server: pm2, like `claude2-stats`. Its env needs `~/.local/bin` on the PATH.
- Windows: Task Scheduler at logon? Started by hand? Something else?
- WSL: the WSL VM shuts down when idle, which takes the backend with it. Should it run as a
  systemd service with WSL kept alive, or be started by hand?

**Recommend:** pm2 on the server, Task Scheduler at logon on Windows, and a systemd user
service on WSL. Each starts automatically.

## 9. CLAUDE.md and copilot-instructions.md are one action

claude2's `.github/copilot-instructions.md` is an exact copy of its CLAUDE.md, so this is one
file plus its mirror. Its "Conversation pane terminology" section talks about the VS Code
editor window, editor tabs and the management window. I'll rewrite that section for the
browser's tabs and columns once #4 is settled. The rest carries over as is.

## Assumptions I'll make unless you object

- The tab list is a fixed config file in the repo. There's no add-tab UI.
- Each tab has one conversation pane. Picking a session in the sidebar switches that pane.
  Other sessions keep running and show their status in the sidebar.
- Plain HTTP on the LAN, with no login (per claude2's CLAUDE.md), plus the origin check from #7.
- Vue 3 + Vite as already scaffolded, plain JS, and no new UI libraries.
