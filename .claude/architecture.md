# claude3 architecture

A browser page of tabs, one per project, each a claude2-style sidebar and conversation pane. It
is meant to replace the claude2 VS Code extension (/root/apps/claude2), whose code it ports. The
claude CLI runs headless (`-p`, stream-json in and out) under one backend per host: WSL, Windows,
and hahnca.com. The page usually runs from `./run` (vite, hot update, port 5310) in Firefox
on the laptop, and talks to each backend directly.

## Layout

- `shared/config.ts`: the tab list (label, host, project path), each host's port/URL/bind
  address/allowed Host names, and `ORIGINS`, the page origins the backends accept. Read by both
  sides; the deploy copies it with the server.
- `shared/types.ts`: sessions, turns, `RunningStatus`, the response marks (from claude2's
  types.ts), and `ServerEvent`, the event-stream protocol.
- `server/main.ts`: one backend, `node server/main.ts <wsl|win|srv>`. Stdlib `http` only. Session
  store, the event stream, POST actions, `runTurn` (ported from claude2's extension.ts), and the
  built page from `dist/` (only the WSL deploy has one). Endpoints are listed at its top.
- `server/claudeCli.ts`: `ClaudeCliRunner`, claude2's runner nearly verbatim: spawns the CLI,
  parses its stream into the response text (tool lines with marks, details), stop by interrupt,
  follow-up into a background wait, titles, the model list, `contextUsage` for Ctx. Also
  `advisorFor` / `cheapestModel` from claude2's modelInfo.ts.
- `server/contextStats.ts`: the Ctx popup's table, copied unchanged from claude2.
- `src/App.vue`: the tab strip; every tab's `Project` stays mounted (`v-show`). The Snips toggle
  is here, at the row's right end, one for every tab; the tab on show draws them (`snips` prop), and picking a tab closes them.
- `src/components/Project.vue`: one tab. Owns its EventSource, the session list, the sidebar
  (new session +, Git; Clean, Trash; rename by long press, trash/restore, busy clocks), the divider
  drag (`--sidebar-width` on the root, shared by every tab, in localStorage), and passes the
  selected session to the pane. Picking a tab focuses its prompt box (the `active` prop).
- `src/components/Git.vue`: the Git button (label counts the changed files) and its `<dialog>`, a
  small VS Code Source Control: message, staged and changed files, Commit (= `add -A`, commit,
  push on the backend). Status is re-read only for the tab on show: on showing, window focus, and
  session events (a turn starting or ending).
- `src/components/Snips.vue`: claude2's Snips as a textarea in a column right of the pane
  (Project's `with-snips` grid: half the width left of the sidebar, full height below the tabs). The one copy lives on claude2-stats (`/snips` on
  hahnca.com:7301), reached through the backend's `snips` action; read on open and window focus,
  saved 500ms after typing stops.
- `src/components/Pane.vue`: claude2's conversation pane. History (bars and boxes) is built
  imperatively, as claude2 builds it; the dock (prompt box, "+", pill, stop, Ctx, pickers, stats; its "+" emits `new` to Project's newSession) is a
  template. Also the Ctx popup.
- `src/render.ts`: response text to box: answer text, tool groups and details, the markdown
  renderer. `src/render.check.mjs` is its self-check (`npm test`).
- `src/api.ts`: `post` and `listen` against a tab's backend.
- `vite.config.ts`: besides the pinned ports, a dev-only plugin (copied from tv) that mirrors the
  page's console and uncaught errors to `vite-console.log` in the repo, emptied at each vite start.
- `public/manifest.webmanifest`: for the page installed as an Edge app (taskbar pin).
  `launch_handler` `focus-existing` makes a second launch focus the open window instead of
  opening another. Edge reads it at install: after changing it, uninstall and reinstall the app.
- `.vscode/settings.json`: forwards vite's 5310 silently, without VS Code's "Your application
  running on port 5310" toast.
- `deploy`: builds and copies `package.json server shared` (+ `dist` for WSL) to each host and
  sets up what keeps it running: systemd `claude3` on WSL, the `claude3` value of the HKCU Run
  key on Windows (at logon), pm2 `claude3` on hahnca.com. It stamps each copy with a `version` file, the hash of `server/`
  and `shared/`, which the backend answers at `GET /version`; `deploy --if-stale` redeploys only
  the hosts that don't answer with the repo's hash.
- `run`: stops this repo's vite if one is running (it holds port 5310), `deploy --if-stale`, then
  starts vite detached (`setsid nohup`, output in `vite.log`), waits for its ready line, and exits. So starting the page also restarts any backend whose
  server code changed, cutting that backend's running turns. Page-only changes never restart one.

## Main flows

- **Connect.** A tab opens `GET /events?tab=<label>` on its host's backend. The first event is the
  full state (sessions, running statuses, model list); then `session` (one session changed shape),
  `delta` (streamed text spliced at an offset, plus status), `models` and `removed`. EventSource reconnects by
  itself, and each reconnect starts with a full state again.
- **New session.** "+" → `POST /api/new` makes an empty "New session" card (blank picks) and the
  pane opens it, as claude2 does. Empty sessions are scratch: "+", a card click, Clean and Trash
  sweep them (`discard`; the backend posts `removed`), sparing the one being opened and any
  holding unsent text (`Pane.drafted`).
- **A prompt.** Ctrl+Enter → `POST /api/prompt` → `submitPrompt` (an empty sessionId, the pane's
  draft after a trash or Clean, creates the session; a running session is stopped first unless the
  prompt can follow up a background wait) → `runTurn` stores the turn, posts `session`, names the
  session on its first prompt, and runs the CLI. Text and status go out as `delta` every 80ms.
  The result settles the turn (`markAnswer` puts the answer mark in), saves, posts `session`.
  Text a session switch takes out of the prompt box is kept (`clearedDraft`); Ctrl+Enter in an
  empty box puts it back.
- **"r".** A prompt of just `r` goes to `POST /api/run` instead of claude: the backend runs the
  project's `./run` and the page shows its output in a `<dialog>` (`.run-pop`), its text kept in sessionStorage until OK so a page reload doesn't lose it. `./run` leaves an already-running vite alone (hot update only); a prompt of just `v` does the same as `r` with RESTART_VITE=1, which makes claude3's `./run` restart vite (reloading the page). Sessions run in the backends and the page talks to them directly, not through vite, so a vite restart only reloads the page; the event stream reconnects with full state. On WSL it runs through `systemd-run`
  (`KillMode=process`), outside claude3.service's cgroup, so claude3's own `./run` restarting
  this backend kills neither the script nor the vite it leaves running; the page's request
  dies with the backend then.
- **Session ↔ transcript.** A session id is the CLI session id; `--resume` or `--session-id` is
  picked by whether the transcript exists (claude2's rule). `/clear` swaps transcript files so the
  session keeps its id.
- **Storage.** `~/.claude3/sessions/<project path as a file name>.json` on each host, outside the
  project folders, written whole through a temp file at turn start and end and on every change.
  `~/.claude3/<host>.log` is the backend's log; `~/.claude3/debug/` holds the runner's per-session
  spawn records.

## Gotchas

- Backends run the `.ts` files as they are (Node type stripping). So: `.ts` extensions on every
  relative import, `import type` for types, and no TS-only runtime syntax (parameter properties,
  enums); `erasableSyntaxOnly` in `tsconfig.server.json` enforces it. Windows' node is 22.12,
  which still needs `--experimental-strip-types` (the deploy passes it).
- Every backend refuses a request whose Origin isn't in `ORIGINS` or whose Host isn't one of the
  host's own names: it runs claude with `bypassPermissions`, and any other website in the browser
  could otherwise drive it (DNS rebinding included). A new page origin has to go in `ORIGINS`.
- Vite's ports are pinned with strictPort (`vite.config.ts`): 5173 is the tv client's, and a vite
  that drifted to another port would be an origin the backends refuse.
- `npm run dev` does not type-check (Vite only strips types); run `npx vue-tsc -b` or
  `npm run build` to see type errors in the page and the server.
- The WSL backend lives as long as the WSL VM does: WSL shuts down when nothing holds it open. In
  practice VS Code's WSL window keeps it up.
- The CLI processes are children of the backend: restarting a backend cuts its running turns,
  which keep their text so far and are marked "The backend stopped during this response."
- Windows backend start-up: a logon-triggered scheduled task needs an admin prompt, so logon goes
  through the HKCU Run key instead. The deploy starts it with `powershell Start-Process conhost.exe
  --headless node.exe ...`, which outlives the deploy and WSL's interop, and shows no window.
  ponytail: `conhost --headless` is undocumented.
- `deploy` runs under `set -e`, and `powershell.exe -Command` exits 1 whenever its last command
  left an error, even one silenced with `-ErrorAction SilentlyContinue` (e.g.
  `Get-NetTCPConnection` on a free port). That aborted the Windows step before the start; such
  calls end with `; exit 0`.
- Windows writes the env key as `Path`; `childEnv` finds it case-insensitively before prepending
  `~/.local/bin`, where the CLI's installer puts it and where pm2/systemd shells leave it off.
- Pane history elements are built by script, so they get no Vue scope attribute: the pane's and
  sidebar's styles are global, prefixed `.pane` / `.sidebar`.
- Session objects are plain (not reactive) and mutated in place as text streams in; `version`
  tells Vue the shape changed. A delta goes to `Pane.applyDelta`, which refills only the growing
  box, as claude2 does.
- Run settings are fixed in `server/main.ts` `LIMITS` (100 turns, bypassPermissions), copied from
  claude2's Settings pane; there is no Settings pane yet.
- Not ported yet from claude2: search, fork, images/Cap, File, export, presets (M), Settings,
  Quota/Stats/Models/Instructions panes, login/auth, the git changes check, prompt
  suggestions, Monaco, the big prompt box, arrow-key navigation, styled tooltips.
- Snips stay read-only until the shared copy has been read, and a server answer of `null` (claude2
  never saved one there) keeps them so: nothing typed in claude3 may replace claude2's copy unseen.
- Every page element follows CLAUDE.md's display rules: font sizes 14–18px only, text solid black.
