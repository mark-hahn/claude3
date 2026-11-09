# claude3 architecture

A browser page of tabs, one per project, each a claude2-style sidebar and conversation pane. It
is meant to replace the claude2 VS Code extension (/root/apps/claude2), whose code it ports. The
claude CLI runs headless (`-p`, stream-json in and out) under one backend per host: WSL, Windows,
and hahnca.com. The page usually runs from `./run` (vite, hot update, port 5310) in Firefox
on the laptop, and talks to each backend directly.

## Layout

- `shared/config.ts`: the `Tab` record of a project (id, label, host, path, open, the Files tree's roots), `FIRST_TABS`
  (what a backend starts from until it has its own list), each host's port/URL/bind address/allowed
  Host names/picker folder, and `ORIGINS`, the page origins the backends accept. Read by both
  sides; the deploy copies it with the server.
- `shared/types.ts`: sessions, turns, `RunningStatus`, the response marks (from claude2's
  types.ts), `ServerEvent` (one project's events) and `StreamEvent` (what the stream carries).
- `server/main.ts`: one backend, `node server/main.ts <wsl|win|srv>`. Stdlib `http` only. Project
  list, session store, the event stream, POST actions, `runTurn` (ported from claude2's
  extension.ts), and the built page from `dist/` (only the WSL deploy has one). Endpoints are
  listed at its top.
- `server/claudeCli.ts`: `ClaudeCliRunner`, claude2's runner nearly verbatim: spawns the CLI,
  parses its stream into the response text (tool lines with marks, details), stop by interrupt,
  follow-up into a background wait, titles, the model list, `contextUsage` for Ctx. Also
  `cheapestModel` from claude2's modelInfo.ts.
- `server/contextStats.ts`: the Ctx popup's table, copied unchanged from claude2.
- `server/files.ts`: the Files pane's actions (`fileActions`) and `POST /upload`: folder listings, a text file read and saved, new, rename, move, delete, and the Windows clipboard's files (PowerShell, scp for srv).
- `server/login.ts`: claude2's Re-Auth as steps the page drives: this host's `claude auth login`,
  its URL, the pasted code on its stdin, then `claude auth status` for who signed in.
- `src/App.vue`: the tab strip and the list of every project; open ones have a tab, sorted by name
  (`src/tabList.ts`, checked by `npm test`), and every project's `Project` stays mounted and laid out,
  closed ones too: all in one grid cell, those not on show `visibility:hidden` (`.offstage`), never `display:none` (see Gotchas). The Files, Snips and
  gear (Settings) toggles are here, at the row's right end, acting on the tab on show; they share one
  column, each tab with its own state (`sides[id]`: "", "files", "file", "snips" or "settings"), so it is as it was left when the tab comes back.
  Each tab's label has a dot: green with a session active, else light red when its Git or Run button
  is highlighted (`dirty` and `deployDue` come up through Project's `highlighted`), else none. Those
  two are re-read for every open project, on show or not; closed ones are skipped.
- `src/components/FolderPicker.vue`: the VS Code-style folder picker `<dialog>` on any host, fed by
  the backend's `folders`; used by the Tabs dialog and the Files pane. Its styles are Tabs.vue's, unscoped for that.
- `src/components/Files.vue`: the Files column: header rows and a tree of the tab's host, with
  `FileEditor.vue` in its place in file mode. Holds only what the backend last listed. Stays mounted while its tab is hidden; both stop polling then (`active`).
- `src/components/Tabs.vue`: the row's Tabs button and its `<dialog>`: host, Path (the folder picker), name
  and Create above the list of every project, where a click opens or closes one, a hold renames and
  ctrl-click deletes. It keeps no copy of the list: changes go to the backend and come back as a
  `projects` event. The dialog stays open after Create, with that project's tab on show behind it,
  and closes when a click opens a project (a failed open stays, showing its error); closing the dialog puts the cursor in the prompt box of the tab on show (`focusAsked`).
  The Files bar's Prj opens it with host, path and name filled in from the selected folder (`openWith`, reached through App's `newProjectAt` provide).
- `src/components/Project.vue`: one tab. Listens for its project's events, holds the session list, the sidebar
  (new session +, Git; Clean, Trash; rename by long press, trash/restore, busy clocks; on the trash
  list Clean turns into a delete for good of the picked cards, picking in `src/pick.ts`), the divider
  drag (`--sidebar-width` on the root, shared by every tab, in localStorage), and passes the
  selected session to the pane. Picking a tab focuses its prompt box (the `active` prop), and so does a click on the tab already on show (`focusAsked`) or on a card.
- `src/components/Git.vue`: the Git button (label counts the changed files) and its `<dialog>`, a
  small VS Code Source Control: message, staged and changed files, Commit (= `add -A`, commit,
  push on the backend). "Describe changes" in its header (`describeChanges` action) sends the
  uncommitted diff and untracked files' text to `claude -p` on Opus 5.5 and puts its reply (at most
  2 short sentences) in the message box. Status is re-read for every open project, on show or not: on showing, session events (a turn starting or ending),
  and every 2s while the page is visible. Every backend git call sets `GIT_OPTIONAL_LOCKS=0`, so the polling never holds the index lock against a real `git add`.
- `src/components/ReAuth.vue`: the sidebar's red Re-Auth button and its `<dialog>`, which walks
  every backend through a sign-in: a link to that host's sign-in page, the code box, Skip.
- `src/components/Snips.vue`: claude2's Snips as a Monaco editor in a column right of the pane
  (Project's `with-snips` grid: half the width left of the sidebar, full height below the tabs). The one copy lives on claude2-stats (`/snips` on
  hahnca.com:7301), reached through the backend's `snips` action; read on open and window focus,
  saved 500ms after typing stops. Each tab mounts its own the first time it opens them and after that only hides
  it (`shown` prop), so the cursor and selections last until the page reloads; its `shown` watcher does what a remount
  would (re-read while read-only, save at once, font size), and restores the scroll, since a hidden editor is 0x0. Ctrl+Enter hands the selection to the `addToPrompt` prop, Pane's
  exposed `appendPrompt`, which appends it to the draft and focuses the prompt box; if that took
  it, the selection is deleted from the Snips and the blank lines at or beside it come down to one
  (`src/blankLines.ts`; a trashed session's prompt takes nothing, so nothing is deleted and they stay open), then the
  Snips close, which saves at once. With no selection they just close.
- `src/components/Settings.vue`: claude2's management pane in the Snips' column. Only its Quotas
  tab (the tab button does nothing yet), ported from claude2's `quotaHtml` nearly verbatim: graphs
  built by script, global styles under `.settings`, element ids `q-*` looked up inside its own root (`byId`: one instance per tab with it open, polling only while on show).
  Asks the backend's `quota` (Update = force), `quotaSync` every 30s, `speechmatics` per month.
- `server/quota.ts`: claude2's QuotaService and its stats-server calls. The account's one history
  and the poll lease live on claude2-stats (hahnca.com:7301), shared with claude2's windows; local
  fallback files in `~/.claude3/quota-*.json`. No footer 95% alert, no reading after a turn.
- `src/components/Pane.vue`: claude2's conversation pane. History (bars and boxes) is built
  imperatively, as claude2 builds it; the dock (prompt box, pill, stop, Run, Cap, Ctx, stats) is a
  template. Also the Ctx popup and the image popup. The prompt box is a Monaco editor whose text is mirrored into the
  `draft` ref both ways. claude2's big prompt editor: Ctrl-Alt-click in the box or Ctrl-Alt-Z
  (the tab on show only, via the `active` prop) puts the box full height left of the history,
  per session in localStorage (`bigPrompt:<tab>:<session id>`); Ctrl-Alt-X there shows it
  rendered as markdown. A plain Enter outside the prompt box and the controls (claude2's
  `selectBottomBlock`) selects and opens the last block; pressed again it toggles that box.
- `server/capture.ts`: claude2's PowerShell screen shot, returned as a PNG data URI.
- `src/copy.ts`: every alt-click's copy, with its light-red flash.
- `src/waitingImages.ts`: unsent pictures per tab in IndexedDB. `src/cropRect.ts`: the crop's
  arithmetic, checked by `npm test`.
- `src/monaco.ts` (+ `monaco.css`): claude2's Monaco setup (its webviews.ts `monacoScript` /
  `monacoStyle`), shared by the prompt box and the Snips: markdown only, the worker through Vite's
  `?worker`, the black theme, the user's VS Code keys (Ctrl-D delete line, ...), the line dots in
  the gutter, the list keys (Tab, Shift-Tab, Enter, Backspace, #) and untabbing. claude2's F1
  unbinding is left out (it was for VS Code). Unlike claude2, Enter at the end of a heading (white space and a `- ` before
  its # come off) also opens a blank line above it and starts the item at the left edge (`headingEnter` in
  `src/blankLines.ts`, checked by `npm test`).
- `src/render.ts`: response text to box: answer text, tool groups and details, the markdown
  renderer. `src/render.check.mjs` is its self-check (`npm test`).
- `src/api.ts`: `post` (a project's backend), `postHost` (a backend, no project needed), and the
  one event stream per backend: `connect` opens them, `listen` is one project's share of its
  host's. A state that arrives before its `Project` is mounted is held for it.
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

- **Connect.** The page opens one `GET /events` on each backend. It starts with `projects` (the
  host's list), then a `state` (sessions, running statuses) per project; after that `session` (one
  session changed shape), `delta` (streamed text spliced at an offset, plus status), `removed` and
  `ceilings`, each marked with its project's id. EventSource reconnects by itself after a dropped
  connection and each reconnect starts over with the full list and states; a refused one
  (`api.ts`) is retried every 3s.
- **Projects.** The Tabs dialog calls `createProject`, `renameProject`, `openProject` or
  `deleteProject`; the backend rewrites `~/.claude3/projects.json` and sends `projects` to every
  page. App replaces that host's part of its list and caches the whole in localStorage
  (`claude3.tabs`), so a backend that is down still shows its tabs. A folder can be only one project
  (two would overwrite one sessions file; the backend refuses), and names are unique ignoring case
  (only the page sees all three hosts, so the page refuses). A project with a session running can't
  be closed or deleted (`refuseIfRunning`). Deleting removes its sessions file, images, debug
  records and run log; its folder and the CLI's transcripts stay. The tab on show closing moves to
  the next open one by name (`nextTab`).
- **New session.** "+" → `POST /api/new` makes an empty "New session" card and the
  pane opens it, as claude2 does. Empty sessions are scratch: "+", a card click, Clean and Trash
  sweep them (`discard`; the backend posts `removed`), sparing the one being opened and any
  holding unsent text (`Pane.drafted`). The tab on show always has a session open: with none
  (after Clean, trashing the last card, its session removed, first look at the tab, leaving the
  trash list with a trashed session open and no card to open instead), `ensureOpen`
  asks `open`, which shares any empty card or makes one. `open` never sweeps, or two pages on one
  project would sweep each other's card and open another, forever. `src/keepOpen.ts` queues it
  behind Clean's or a trash's request, which would otherwise catch the new card (`npm test`).
- **A prompt.** Ctrl+Enter → `POST /api/prompt` → `submitPrompt` (an empty sessionId, the pane's
  draft in the moment before `ensureOpen` has a session or if it failed, creates the session; a running session is stopped first unless the
  prompt can follow up a background wait) → `runTurn` stores the turn, posts `session`, names the
  session on its first prompt, and runs the CLI. Text and status go out as `delta` every 80ms.
  The result settles the turn (`markAnswer` puts the answer mark in), saves, posts `session`.
  Each session's unsent text is saved on every edit in localStorage (`draft:<tab>:<session id>`,
  '' for the new-session draft, removed on send), so it is back in its box after a reload and
  `Pane.drafted` still spares its session from the sweep. Separately, text a session switch or
  reload takes out of the box is kept (`clearedDraft`, `lostPrompt:<tab>`, one per tab, removed
  on send); Ctrl+Enter in an empty box puts it back.
- **Screen capture.** The footer's Cap → `POST /api/capture`, always on a laptop backend (a tab on
  srv asks WSL's), which runs PowerShell and answers a PNG data URI. Plain click minimizes the
  foreground window (the page's) for the shot; ctrl-click leaves it up; alt-click calls App's
  `onPreviousTab` (provide/inject) to show the previously shown claude3 tab for the shot and come
  back. Each picture waits on its session's next prompt as a stack of data URIs (the last is the
  picture, the rest its crops' undo), saved in IndexedDB, so a reload keeps it and the sweep
  spares its session (`Pane.drafted`). The icons are injected text in Monaco, kept out of the
  draft. On send the images go with `POST /api/prompt`; the tab's backend writes them to
  `~/.claude3/images/<session id>/`, appends a sentence per picture telling the CLI to read that
  file (`imageNote`, stripped for display by `typedPrompt`), and records the paths in `turn.images`.
  A bar's icon asks `image` for the file, read-only. Ctrl-click on an icon in the prompt box
  removes that waiting picture. A sent one is permanent in its session: no way to remove it
  short of deleting the session for good, which removes the folder.
- **Re-Auth.** A turn whose error matches `AUTH_FAILED` sets its host's flag (`~/.claude3/auth-needed`,
  sent as an `auth` stream event, held in `authNeeded` in `src/api.ts`). If the API never started
  answering, the turn is dropped and its prompt and pictures go back to the page (`returned`,
  `Pane.returnPrompt`); otherwise it keeps its text and shows the error. Any host's flag raises
  Re-Auth in every tab, and one click signs in on wsl, win and srv in turn, each with its own page
  and code: `login` gives the URL, `loginCode` sends the code, and `loginResult` is polled once a
  second (Firefox gives up on a response after 5 minutes). The poll also ends when the CLI's own
  browser tab finished the sign-in with no code. A sign-in or an answered turn clears that host's flag.
- **Deploy warning.** Before sending a prompt the pane asks `deployNeeded`: the project's
  `./deploy` (or `./run` when it has none) touches `.deployed` (gitignored) when it finishes, and
  any `git ls-files` file newer than it means a deploy is due; a `<dialog>` then asks Deploy
  (same as "r" below, the prompt stays unsent in the box), Continue or Cancel. No script or no
  stamp yet means no warning. The touch lines live in each project's own
  script (claude3, claude2, tv, finance on hahnca.com). A script can write paths into the stamp
  and then only those count: claude3's writes `server shared`, what `--if-stale` hashes, so
  docs and page-only edits don't ask for a deploy. The footer's Run button is highlighted
  while the same check finds files; it is re-read for every open project on showing, window focus,
  session events, and a ./run's result.
- **"r".** A prompt of just `r`, or the footer's Run button (ctrl-click for `v`), goes to `POST /api/run` instead of claude: the backend runs the
  project's `./run` and the page shows its output in a `<dialog>` (`.run-pop`) as it goes, asking `runResult` once a second (OK hides it, the result opens it again), the final text kept in sessionStorage until OK so a page reload doesn't lose it. It opens only on the tab on show, and a waiting result opens when its tab is picked: a modal `<dialog>` in a hidden tab would leave the whole page inert with nothing to see. `./run` leaves an already-running vite alone (hot update only); a prompt of just `v` does the same as `r` with RESTART_VITE=1, which makes claude3's `./run` restart vite (reloading the page). Sessions run in the backends and the page talks to them directly, not through vite, so a vite restart only reloads the page; the event stream reconnects with full state. On WSL it runs through `systemd-run`
  (`KillMode=process`), outside claude3.service's cgroup, so claude3's own `./run` restarting
  this backend kills neither the script nor the vite it leaves running. The page's request
  dies with the backend then, so the script's output and exit code go to
  `~/.claude3/run-<tab>.log` / `.status`, never a pipe back to the backend, and the page asks
  `runResult` once a second until they're there (resuming after a reload, via sessionStorage).
  `deploy` sends its own output through `tee`, so a caller's pipe vanishing can't fail an echo
  under its `set -e`.
- **Files.** The tree's root is `Tab.roots[Tab.rootIdx]` (kept in `projects.json`, `setRoots`, back
  through a `projects` event) or else the project folder. Back and Fwd only move the index; a new root drops the entries past it first. Open folders are per tab in localStorage
  (`filesOpen:<tab>`), and one selected row per root (`filesSelected:<tab>`), scrolled into view on a new root, on opening the column or leaving file mode, and when a key puts the focus on the tree (`focusTree`), but not on a mouse press, which would move the row being clicked. Every open folder is listed again every 2s, so outside
  changes appear. The keys (`keyDown`) work only while focus is in the tree's part of the column, outside its text boxes and
  the Path dialog; a selection out of sight counts as none for them. Ctrl-C puts the selection on the real
  Windows clipboard with `Set-Clipboard`, Ctrl-V reads `Get-Clipboard -Format FileDropList` and copies. Ctrl-X is a
  Ctrl-C remembered page-wide (`cut`, with the clipboard's name for it): if that is still all the clipboard holds, the next Ctrl-V
  in any tab moves it (`movePath` on its own host, else paste then `deletePath`). The clipboard is on the laptop, so a srv tab asks
  WSL's backend (`clipHost`), which carries the files with scp: fetched ones wait in
  `~/.claude3/clipboard/`, and for a paste it asks the srv backend's `freePath` for the name. Clashes on new,
  paste, move and drop take `name(<idx>).ext`; nothing is overwritten. Drops stream raw to `POST /upload`.
  The search box's Enter (Ctrl-Enter going backward) asks `findFile` for the next name after the last
  found, walked on the backend so closed folders count and skipping node_modules unless NM is
  ticked; the page opens the way to it and selects its row. Esc there moves focus to the tree.
  **File mode:** A header row shows the path after the host, as the tree's path row does. Ctrl-double-click on a `.md` shows it rendered and read-only in the editor's place (`renderMarkdown`, inside a `.pane` div for Pane.vue's global markdown styles), read again every 2s if its mtime changes. In the editor: saved 500ms after typing, and read again if the file's mtime changes, asked every 2s. With the last line in view it is in tail mode, the header's path yellow: the read is `waitFile`, which the backend answers on an `fs.watch` event or after 2s (where a watch can't see the change), and the view sticks to the bottom when text arrives. `saveFile`
  carries the mtime it read and is refused if the file has moved on; the editor then stops saving
  until Reload.
- **Delete for good.** Picked trashed cards → `POST /api/delete`, after a `window.confirm`. The
  backend takes only trashed ids, stops and awaits any run still going (its settling would post
  the session back), removes them and their debug records, and posts `removed`. The CLI's
  transcripts stay, as in claude2.
- **Session ↔ transcript.** A session id is the CLI session id; `--resume` or `--session-id` is
  picked by whether the transcript exists (claude2's rule). `/clear` swaps transcript files so the
  session keeps its id.
- **Storage.** `~/.claude3/projects.json` is each host's list of projects. `~/.claude3/windows.json` is each model's context window as the CLI last reported it (only a run's end reports it, so a run starts from this file). `~/.claude3/sessions/<project path as a file name>.json` on each host, outside the
  project folders, written whole through a temp file at turn start and end and on every change.
  `~/.claude3/<host>.log` is the backend's log; `~/.claude3/debug/` holds the runner's per-session
  spawn records.
- **Graft savings.** When a turn ends, `runTurn` prices graft's `<project>/graft/.cache/session/<id>.json`
  metrics into `session.graftSavedUsd`; the footer shows it only above $0.25.
- **Ponytail count.** `sendCeilings` runs `git grep` for `ponytail:` comments on connect and at each
  turn's end and sends a `ceilings` event. The footer shows `skips:ceilings` only when either is 0.

## Gotchas

- Backends run the `.ts` files as they are (Node type stripping). So: `.ts` extensions on every
  relative import, `import type` for types, and no TS-only runtime syntax (parameter properties,
  enums); `erasableSyntaxOnly` in `tsconfig.server.json` enforces it. Windows' node is 22.12,
  which still needs `--experimental-strip-types` (the deploy passes it).
- Every backend refuses a request whose Origin isn't in `ORIGINS` or whose Host isn't one of the
  host's own names: it runs claude with `bypassPermissions`, and any other website in the browser
  could otherwise drive it (DNS rebinding included). A new page origin has to go in `ORIGINS`.
- A project's `id` never changes, and everything stored for it goes by the id (backend map, run
  log, drafts, pictures, big-prompt flags), so a rename loses nothing. The six first projects' ids
  are their old labels, which is what their stored data was already under. Show `label`, key on `id`.
- One event stream per backend, not per project: each open stream holds a connection, browsers
  allow about 6 per server over HTTP/1.1, and closed projects stay mounted, so per-project streams
  would hang the page at a host's 6th project.
- Actions about the host (`folders`, `createProject`, `capture`, `snips`, the quota and login ones) come before
  `action`'s project lookup, so they work on a host with no projects.
- The page and backends change the stream format together. A page ahead of its backends shows
  every tab as "No answer" with POSTs still working, and picks up by itself after the deploy.
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
- A tab must never be hidden with `display:none` / `v-show`: the browser loses every scroll position in it, and the pane's ResizeObserver runs at 0x0, drops the box's height clamp and sends the box to its bottom on return. `.offstage` keeps it laid out.
- Vue runs a `flush: "post"` watcher on a prop before that update's `v-show` hook (Snips' column), and a pre-flush watcher before the update's patch, so what is being shown can't take focus there yet. Project's `focusPrompt` awaits `nextTick`.
- Session objects are plain (not reactive) and mutated in place as text streams in; `version`
  tells Vue the shape changed. A delta goes to `Pane.applyDelta`, which refills only the growing
  box, as claude2 does.
- Run settings are fixed in `server/main.ts` `LIMITS` (100 turns, bypassPermissions), copied from
  claude2's Settings pane; the Settings pane has no Settings tab yet. `MODEL`, `EFFORT` and
  `ADVISOR` beside it hard-wire every run; the page has no pickers and sends none of them.
- Chromium hands focus back after a mouse-closed `<dialog>` without the text box's caret, so
  typing goes nowhere; `src/main.ts` blurs and refocuses on every dialog's close. Monaco's own
  focus call doesn't help, since the textarea already has focus.
- Not ported yet from claude2: search, fork, pasted images, File, export, presets (M),
  Stats/Models/Instructions/Settings tabs, the git changes check, prompt
  suggestions, the restored prompt, arrow-key navigation, styled tooltips.
- claude2's per-host auth flag (`authNeeded.<remote>` in VS Code's globalState) can't be shared: it
  sits in VS Code's own database on the Windows side, out of hahnca.com's reach, and a running
  VS Code rewrites it from memory. Each app clears its own flag on its next answered turn.
- Snips stay read-only until the shared copy has been read, and a server answer of `null` (claude2
  never saved one there) keeps them so: nothing typed in claude3 may replace claude2's copy unseen.
- Monaco's `addCommand` keys are page-wide and every tab has its own editor, so editor keys are
  `addAction`s. Monaco is about 4MB of the built page. Its theme and `addKeybindingRules` are page-wide
  too: the Files editor is stock Monaco (plus word wrap and the line dots) but must use the `claude2` theme, and is kept out of the
  user's key rules, all but Ctrl-D, by its `stockEditor` context key. The ctrl-wheel font size of it and of the Snips is
  `addWheelZoom` in `monaco.ts`, each editor with its own remembered size, since Monaco's `mouseWheelZoom` is page-wide too.
- Every page element follows CLAUDE.md's display rules: font sizes 14–18px only (the one exception,
  at the user's asking, is the ctrl-wheel size of the Files editor and the Snips, which has no limits), text solid black
  or a colour, never grey. Monaco's markdown keeps the stock light theme's token colours (blue
  headings), and its one grey token is pinned to black in `monaco.ts`. A disabled button shows by its dashed grey
  border, a paused quota age by its background; only status icons (tab dot, card clocks) keep colour.
