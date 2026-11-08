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
  `cheapestModel` from claude2's modelInfo.ts.
- `server/contextStats.ts`: the Ctx popup's table, copied unchanged from claude2.
- `src/App.vue`: the tab strip; every tab's `Project` stays mounted (`v-show`). The Snips and
  gear (Settings) toggles are here, at the row's right end, one each for every tab; they share one
  column (`side`: "", "snips" or "settings"), the tab on show draws it, and picking a tab closes it.
- `src/components/Project.vue`: one tab. Owns its EventSource, the session list, the sidebar
  (new session +, Git; Clean, Trash; rename by long press, trash/restore, busy clocks; on the trash
  list Clean turns into a delete for good of the picked cards, picking in `src/pick.ts`), the divider
  drag (`--sidebar-width` on the root, shared by every tab, in localStorage), and passes the
  selected session to the pane. Picking a tab focuses its prompt box (the `active` prop).
- `src/components/Git.vue`: the Git button (label counts the changed files) and its `<dialog>`, a
  small VS Code Source Control: message, staged and changed files, Commit (= `add -A`, commit,
  push on the backend). "Describe changes" in its header (`describeChanges` action) sends the
  uncommitted diff and untracked files' text to `claude -p` on Opus 5.5 and puts its reply (at most
  2 short sentences) in the message box. Status is re-read only for the tab on show: on showing, window focus, and
  session events (a turn starting or ending).
- `src/components/Snips.vue`: claude2's Snips as a Monaco editor in a column right of the pane
  (Project's `with-snips` grid: half the width left of the sidebar, full height below the tabs). The one copy lives on claude2-stats (`/snips` on
  hahnca.com:7301), reached through the backend's `snips` action; read on open and window focus,
  saved 500ms after typing stops. Ctrl+Enter emits `insert` with the selection; Project hands it
  to Pane's exposed `appendPrompt`, which appends it to the draft and focuses the prompt box. With
  no selection it closes the Snips instead.
- `src/components/Settings.vue`: claude2's management pane in the Snips' column. Only its Quotas
  tab (the tab button does nothing yet), ported from claude2's `quotaHtml` nearly verbatim: graphs
  built by script, global styles under `.settings`, element ids `q-*` (one instance at a time).
  Asks the backend's `quota` (Update = force), `quotaSync` every 30s, `speechmatics` per month.
- `server/quota.ts`: claude2's QuotaService and its stats-server calls. The account's one history
  and the poll lease live on claude2-stats (hahnca.com:7301), shared with claude2's windows; local
  fallback files in `~/.claude3/quota-*.json`. No footer 95% alert, no reading after a turn.
- `src/components/Pane.vue`: claude2's conversation pane. History (bars and boxes) is built
  imperatively, as claude2 builds it; the dock (prompt box, "+", pill, stop, Ctx, stats; its "+" emits `new` to Project's newSession) is a
  template. Also the Ctx popup. The prompt box is a Monaco editor whose text is mirrored into the
  `draft` ref both ways. claude2's big prompt editor: Ctrl-Alt-click in the box or Ctrl-Alt-Z
  (the tab on show only, via the `active` prop) puts the box full height left of the history,
  per session in localStorage (`bigPrompt:<tab>:<session id>`); Ctrl-Alt-X there shows it
  rendered as markdown. A plain Enter outside the prompt box and the controls (claude2's
  `selectBottomBlock`) selects and opens the last block; pressed again it toggles that box.
- `src/monaco.ts` (+ `monaco.css`): claude2's Monaco setup (its webviews.ts `monacoScript` /
  `monacoStyle`), shared by the prompt box and the Snips: markdown only, the worker through Vite's
  `?worker`, the black theme, the user's VS Code keys (Ctrl-D delete line, ...), the line dots in
  the gutter, the list keys (Tab, Shift-Tab, Enter, Backspace, #) and untabbing. claude2's F1
  unbinding is left out (it was for VS Code).
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
- **New session.** "+" → `POST /api/new` makes an empty "New session" card and the
  pane opens it, as claude2 does. Empty sessions are scratch: "+", a card click, Clean and Trash
  sweep them (`discard`; the backend posts `removed`), sparing the one being opened and any
  holding unsent text (`Pane.drafted`).
- **A prompt.** Ctrl+Enter → `POST /api/prompt` → `submitPrompt` (an empty sessionId, the pane's
  draft after a trash or Clean, creates the session; a running session is stopped first unless the
  prompt can follow up a background wait) → `runTurn` stores the turn, posts `session`, names the
  session on its first prompt, and runs the CLI. Text and status go out as `delta` every 80ms.
  The result settles the turn (`markAnswer` puts the answer mark in), saves, posts `session`.
  Each session's unsent text is saved on every edit in localStorage (`draft:<tab>:<session id>`,
  '' for the new-session draft, removed on send), so it is back in its box after a reload and
  `Pane.drafted` still spares its session from the sweep. Separately, text a session switch or
  reload takes out of the box is kept (`clearedDraft`, `lostPrompt:<tab>`, one per tab, removed
  on send); Ctrl+Enter in an empty box puts it back.
- **Deploy warning.** Before sending a prompt the pane asks `deployNeeded`: the project's
  `./deploy` (or `./run` when it has none) touches `.deployed` (gitignored) when it finishes, and
  any `git ls-files` file newer than it means a deploy is due; a `<dialog>` then asks Continue or
  Cancel. No script or no stamp yet means no warning. The touch lines live in each project's own
  script (claude3, claude2, tv, finance on hahnca.com).
- **"r".** A prompt of just `r`, or the footer's Run button (ctrl-click for `v`), goes to `POST /api/run` instead of claude: the backend runs the
  project's `./run` and the page shows its output in a `<dialog>` (`.run-pop`), its text kept in sessionStorage until OK so a page reload doesn't lose it. `./run` leaves an already-running vite alone (hot update only); a prompt of just `v` does the same as `r` with RESTART_VITE=1, which makes claude3's `./run` restart vite (reloading the page). Sessions run in the backends and the page talks to them directly, not through vite, so a vite restart only reloads the page; the event stream reconnects with full state. On WSL it runs through `systemd-run`
  (`KillMode=process`), outside claude3.service's cgroup, so claude3's own `./run` restarting
  this backend kills neither the script nor the vite it leaves running. The page's request
  dies with the backend then, so the script's output and exit code go to
  `~/.claude3/run-<tab>.log` / `.status`, never a pipe back to the backend, and the page asks
  `runResult` once a second until they're there (resuming after a reload, via sessionStorage).
  `deploy` sends its own output through `tee`, so a caller's pipe vanishing can't fail an echo
  under its `set -e`.
- **Delete for good.** Picked trashed cards → `POST /api/delete`, after a `window.confirm`. The
  backend takes only trashed ids, stops and awaits any run still going (its settling would post
  the session back), removes them and their debug records, and posts `removed`. The CLI's
  transcripts stay, as in claude2.
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
  through the HKCU Run key instead. The deploy opens a shortcut (`start.lnk`, `conhost.exe
  --headless node.exe ...`) through `explorer.exe`, which outlives the deploy and WSL's interop,
  shows no window, and is never elevated. Windows programs started under the WSL backend ("r",
  Claude's shell) run elevated, and a plain terminal gets Access Denied stopping a backend
  started that way. `runas /trustlevel:0x20000` does not drop the elevation.
  ponytail: `conhost --headless` is undocumented.
- `deploy` runs under `set -e`, and `powershell.exe -Command` exits 1 whenever its last command
  left an error, even one silenced with `-ErrorAction SilentlyContinue` (e.g.
  `Get-NetTCPConnection` on a free port). That aborted the Windows step before the start; such
  calls end with `; exit 0`.
- The WSL backend's systemd PATH has no Windows directories, and "r" runs `./deploy` under it, so
  `deploy` appends System32 and PowerShell's folder to PATH itself.
- Windows writes the env key as `Path`; `childEnv` finds it case-insensitively before prepending
  `~/.local/bin`, where the CLI's installer puts it and where pm2/systemd shells leave it off.
- Pane history elements are built by script, so they get no Vue scope attribute: the pane's and
  sidebar's styles are global, prefixed `.pane` / `.sidebar`.
- Session objects are plain (not reactive) and mutated in place as text streams in; `version`
  tells Vue the shape changed. A delta goes to `Pane.applyDelta`, which refills only the growing
  box, as claude2 does.
- Run settings are fixed in `server/main.ts` `LIMITS` (100 turns, bypassPermissions), copied from
  claude2's Settings pane; the Settings pane has no Settings tab yet. `MODEL`, `EFFORT` and
  `ADVISOR` beside it hard-wire every run; the page has no pickers and sends none of them.
- Not ported yet from claude2: search, fork, images/Cap, File, export, presets (M),
  Stats/Models/Instructions/Settings tabs, login/auth, the git changes check, prompt
  suggestions, the restored prompt, arrow-key navigation, styled tooltips.
- Snips stay read-only until the shared copy has been read, and a server answer of `null` (claude2
  never saved one there) keeps them so: nothing typed in claude3 may replace claude2's copy unseen.
- Monaco's `addCommand` keys are page-wide and every tab has its own editor, so editor keys are
  `addAction`s. Monaco is about 4MB of the built page.
- Every page element follows CLAUDE.md's display rules: font sizes 14–18px only, text solid black,
  Monaco's token colours included (`monaco.css`). A disabled button shows by its dashed grey
  border, a paused quota age by its background; only status icons (tab dot, card clocks) keep colour.
