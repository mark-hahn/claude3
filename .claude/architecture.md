# claude3 architecture

A browser page of tabs, one per project, each a claude2-style sidebar and conversation pane. It
is meant to replace the claude2 VS Code extension (/root/apps/claude2), whose code it ports. The
claude CLI runs headless (`-p`, stream-json in and out) under one backend per host: WSL, Windows,
and hahnca.com. The page usually runs from `./run` (vite, hot update, port 5310) in Edge
on the laptop, and talks to each backend directly.

## Layout

- `shared/config.ts`: the `Tab` record of a project (id, label, host, path, open, the Files tree's roots), `FIRST_TABS`
  (what a backend starts from until it has its own list), each host's port/URL/bind address/allowed
  Host names/picker folder/home folder (where a terminal added for the host starts), and `ORIGINS`, the page origins the backends accept. Read by both
  sides; the deploy copies it with the server.
- `shared/types.ts`: sessions, turns, `RunningStatus`, the response marks (from claude2's
  types.ts), `ServerEvent` (one project's events) and `StreamEvent` (what the stream carries).
- `server/main.ts`: one backend, `node server/main.ts <wsl|win|srv>`. Stdlib `http` only. Project
  list, session store, the event stream, POST actions, `runTurn` (ported from claude2's
  extension.ts), and the built page from `dist/` (only the WSL deploy has one). Endpoints are
  listed at its top.
- `server/claudeCli.ts`: `ClaudeCliRunner`, claude2's runner nearly verbatim: spawns the CLI,
  parses its stream into the response text (tool lines with marks, details), stop by interrupt,
  follow-up into a background wait, titles, the model list, `contextUsage` for the `ctx` action. Also
  `cheapestModel` from claude2's modelInfo.ts.
- `server/contextStats.ts`: the `ctx` action's table, copied unchanged from claude2. Nothing on the page asks for it since the footer's Ctx button and popup went.
- `server/files.ts`: the Files pane's actions (`fileActions`) and `POST /upload`: folder listings, a text file read and saved, new, rename, move, delete, and the Windows clipboard's files (PowerShell, scp for srv).
- `server/login.ts`: claude2's Re-Auth as steps the page drives: this host's `claude auth login`,
  its URL, the pasted code on its stdin, then `claude auth status` for who signed in.
- `src/App.vue`: the tab strip and the list of every project; open ones have a tab, sorted by name
  (`src/tabList.ts`, checked by `npm test`), ctrl-click on one closes its project (`openProject`), and every project's `Project` stays mounted and laid out,
  closed ones too: all in one grid cell, those not on show `visibility:hidden` (`.offstage`), never `display:none` (see Gotchas). The ? button (`src/keyHelp.ts`'s keys popup) and the Files, Log, Term, Snips and
  gear (Settings) toggles are here, at the row's right end, acting on the tab on show; they share one
  column, each tab with its own state (`sides[id]`: "", "files", "file", "git", "term", "snips" or "settings"), so it is as it was left when the tab comes back. With no project open only Snips and the gear work: App shows them itself, filling the page under the strip, with a stand-in tab (`NO_TAB`) naming the WSL backend, since both are host actions.
  Each tab's label has a dot: green with a session active, else light red when its Git or Run button
  is highlighted (`dirty` and `deployDue` come up through Project's `highlighted`), else none. Those
  two are re-read for every project, on show or not, closed ones too (their git status every 30s, not 2s), for the Tabs button: light red, with the same dot on each flagged name in its dialog, while any project is highlighted; light green instead (and a green dot) while any project has a session running (`busy`). Centered between the last tab and Files is the name of the selected session of the tab on show (`sessionName` up through Project).
- `src/components/FolderPicker.vue`: the VS Code-style folder picker `<dialog>` on any host, fed by
  the backend's `folders`; used by the Tabs dialog, the Files pane and the Term pane's Path. Its styles are Tabs.vue's, unscoped for that.
  It lists files after the folders (folders bold); they are disabled (no half-white cover) unless `files` (the footer's File), when it picks a file; `open` can take another host than the prop's. Its slot is left of the box (the Term pane's and the Files pane's host selectors, which call `open` again to move the open dialog to another host). Right of the box: `root` (lists the `project` prop's folder when on its host, else `HOSTS[host].home`; the Tabs dialog passes no project), Cancel, Ok.
- `src/components/Files.vue`: the Files column: header rows and a tree on any host, with
  `FileEditor.vue` in its place in file mode. Path's picker has a host selector left of its box (as the Term pane's: another host only moves it to `HOSTS[host].home`, nothing changes until Ok); Ok on another host's folder makes it a new root, kept in `tab.roots` as `<host>:<path>` (no path starts so: a drive letter is one letter; the tab's own host's roots stay bare paths, so the server's `setRoots` is unchanged). Everything the tree does (listing, new, rename, delete, info, clipboard, drop, the editor's reads and saves, Ctrl+Enter's attach, Prj) goes to the root's host (`treeHost`) through `postHost`, the file actions being the host's, not a project's; a file opened keeps its own host. The Git popup's `openPath` is always the tab's host. Selections are kept per root under `<host>:<path>` too. A click on the root's path row edits it in place; Enter checks the text with the host's `folders` and goes there as Path's pick does (`goTo`). Holds only what the backend last listed. Stays mounted while its tab is hidden; both stop polling then (`active`).
- `src/components/Tabs.vue`: the row's Tabs button (ctrl-click opens every closed project with a red or green dot, no dialog) and its `<dialog>`: host, Path (the folder picker), name
  and Create above the list of every project, where a click opens or closes one, a hold renames and
  ctrl-click deletes. It keeps no copy of the list: changes go to the backend and come back as a
  `projects` event. The dialog stays open after Create, with that project's tab on show behind it,
  and closes when a click opens a project (a failed open stays, showing its error); closing the dialog puts the cursor in the prompt box of the tab on show (`focusAsked`).
  The Files bar's Prj opens it with host, path and name filled in from the selected folder (`openWith`, reached through App's `newProjectAt` provide).
- `src/components/Project.vue`: one tab. Listens for its project's events, holds the session list, the tab row's + (new session) and Git buttons (each project teleports its pair into App's `.project-buttons` and hides it unless on show; deferred, since the row isn't in the document at first mount), the sidebar
  (Clean, Trash; rename by long press, trash/restore, busy clocks; on the trash
  list Clean turns into a delete for good of the picked cards, picking in `src/pick.ts`; while any session
  is running or waiting on a background task (`running`) Clean is disabled, its card has no 🗑, it is in every list
  (a search shows it with no tally, and lands on the first real match), and on the trash list it can't be picked (`pickable`), so it is never deleted), the divider
  drag (`--sidebar-width` on the root, shared by every tab, in localStorage), the side divider between pane and right column (there only while a column is open; `--side-share`, the column's fraction of what the sidebar leaves, likewise shared and saved; the grid gives the pane a `1fr` track (auto minimum: what its dock needs, the history being `contain: inline-size`) and the column `minmax(0, ...)`, so the column gives way whenever space runs short (drag, wider sidebar, narrower window) instead of covering the footer and box text, and the drag cuts the share back to the width the column got; the four columns draw no left border of their own), Ctrl-B or the tab strip's first button (`sidebarAsked`) (hides that tab's
  sidebar and divider; per tab, not saved, ignored on the trash list, reset when the project closes or opens), Ctrl-S (a new session, as "+"; on an empty card with no typing it goes back to the card before, sweeping the empty one, so it toggles), and passes the
  selected session to the pane. Picking a tab focuses its prompt box (the `active` prop), and so does a click on the tab already on show (`focusAsked`) or on a card.
- `src/components/Git.vue`: the Git button (label counts the changed files, disabled when the project's folder is in no git repo) and its `<dialog>`, which Ctrl-G opens and closes from anywhere on the page (window capture listener, so Monaco's go-to-line never sees it), a
  small VS Code Source Control: message, staged and changed files, Commit (= `add -A`, commit,
  push on the backend). File rows are picked with `src/pick.ts` (keys are the list's letter plus the path, since a file
  can be in both lists); Delete or Ctrl-Z in the list asks, then `revert` (`git clean -f` the untracked ones, `git restore
  --source=HEAD --staged --worktree` the rest plus a rename's old path, all as `:(top,literal)` pathspecs since status paths
  are from the repo's top), and the dialog stays open. With exactly one row picked the dialog widens to the window's right
  and bottom edges (`.wide`; the lists keep their place and width, so nothing moves under the mouse) and shows that file's
  diff in a read-only Monaco diff editor that lives only while its place does: left, the file in the last commit (`gitHead`
  action, `headText` in `server/gitGraph.ts`, a rename's under its old path); right, the file on disk (`readFile`), so it is
  what Commit would take whichever list the row is in. It follows both: the left is asked again when the newest commit
  changes, the right after every status read, with the mtime it knows. Up and Down in the list walk the rows. A
  click on a line number in the diff, in the old file's column or the new one's (in the one-column view the old column is
  still the old file's editor, narrowed to its margin), emits `openFile` with the file's full path (status sends `full` per
  file while the dialog is open, the project maybe being below the repo's top) and the line, an old line's being its place in
  the new file (`modifiedLine` in `src/diffLine.ts`, from Monaco's line changes; checked by `npm test`), and closes the
  dialog: Project's `openInFiles` puts the column on the Files tree (`showFiles` up to App) and calls Files' exposed
  `openPath`, which selects, reveals and opens it, the editor showing line numbers in place of its line dots with that line
  centered (`file.line`; centered a tick after mounting, the tree still sharing the column's height until then). AI in its header (`describeChanges` action) sends the
  uncommitted diff and untracked files' text to `claude -p` on Opus 5.5 and puts its reply (at most
  2 short sentences) in the message box. Left of it, Clr empties the box, and left of that ↓ puts the newest session's name in it, each click an older one, ↑ going back (Project's `sessionNames`: active sessions by `updatedAt`, "New session" skipped; Clr and opening the dialog start over). Up and Down in the box walk old messages as VS Code's does (`src/messageHistory.ts`, a port of its SCMInput, checked by `npm test`), but the list is the branch's last 100 messages from `git log`, not a store of its own. Above the box is the newest commit's subject, from the same log (`git` action with `log`, sent only while the dialog is open, so on its 2s poll); a click edits it in place and Enter amends and pushes (`reword` action, `rewordHead` in `server/gitGraph.ts`: fetch, refuse if the upstream has commits the branch lacks, `commit --amend --only` keeping the body and leaving staged files out, `push --force-with-lease`, and back to the old commit if the push fails). Status is re-read for every project, on show or not (a closed one's poll only every 30s): on showing, session events (a turn starting or ending),
  and every 2s while the page is visible. Every backend git call sets `GIT_OPTIONAL_LOCKS=0`, so the polling never holds the index lock against a real `git add`.
  Review mode (`openCommit`, exposed, which Project calls for a click on a Log pane line): the same popup on one commit, titled with its short hash and subject, with no buttons but Close, no message boxes and no revert, and not modal (`show()`, no gray cover, `closedby="closerequest"`, fixed over the panes at z-index 100; a diff still reaches the window's right edge, over the log, so it is closed before another commit is chosen) so the log stays usable: its commit's lines are highlighted (`reviewing`, exposed), a click on another line shows that commit. This is log view mode, the Log button red while it lasts (Project's `logView` up to App). A click on a diff line number opening the file parks it (`parked`: popup closed, review, picked row and cached diff kept) while the side pane stays on Files; the Log button bringing the log back reopens it as it was (`sideShown`, Project's watch on `side`, re-asking `same`). It ends (`endReview`) when the popup is closed by hand, the log closes, the side pane goes anywhere else, or on a tab or tab row toggle click other than Log (App's `logViewEnd` counter); the G button and Ctrl-G end a parked one before opening the usual popup. Its files come from the `gitCommit` action (`commitFiles` in `server/gitGraph.ts`: `diff-tree` against the first parent, a first commit's `--root`) as status entries with the letter in y, so they all fall in Changes; a row's diff is `gitHead` with a `rev`, the parent's file against the commit's, each read once. The commit's side also asks `same` (`git diff --quiet <commit> -- <file>`, so CRLF on win still counts as the same): only a file still as that commit left it shows line numbers (`numbered`), and a click on one opens it in Files as the usual popup does; any other has none. The status poll goes on under it, so the G label stays current.
- `src/components/GitGraph.vue`: the tab row Log button's pane, unrelated to the Git button's dialog: `git log --graph` (`gitGraph` action, newest 1000 commits, laid out by `server/gitGraph.ts`: no hash or star on show, a commit with branch or tag names has its message on a second line) as rows of text, on which ctrl-click copies a commit's full hash, alt-click its message (both `.exact`), and a plain click opens the Git popup's review of it, or moves the open one to it (`review` up to Project), re-read every 2s while on show. The button is disabled when the Git button's status finds no repo (`noRepo` up through Project).
- `src/components/Term.vue` + `server/term.ts`: the tab row Term button's pane, one to three terminals stacked in equal rows (Project's `terms`, kept in the page's memory, so a reload goes back to one: each a slot 0 to 2, the host its shell is on, which needn't be the tab's, and the folder it starts in; one `Term` each, a 1px black line above each header). The `+` left of each header's Path adds one on the project's host in the project's folder, right below it, in the lowest free slot; the Path dialog has a host selector left of its box (FolderPicker's slot; it opens on the terminal's own host at its shell's folder, and is off with three terminals). Another host chosen there only moves the picker to that host's home folder (`HOSTS[host].home`; `open` again, on the open dialog); nothing is done until Ok, when a folder on another host adds a terminal there starting in it, also right below, and one on the terminal's own host is the cd. The term actions are the host's, not a project's (`main.ts`, above the project lookup), keyed by the tab's id and the slot with the starting folder in every request, so any backend runs a shell for a tab it doesn't have. A terminal closes by its header's Close, or when its shell exits unless it is the only one (that one keeps its "press a key" line; `termRead` says `exited`): Term stops polling, emits `close`, and has the backend forget the shell (`termClose`, ending one still running, so a later `+` there starts afresh) once the read on its way is answered, since a read arriving after it would start the shell again. Project drops the slot and focuses a terminal that is left; closing the last one closes the pane and puts the list back to the project's own terminal. Each is VS Code's terminal in small: xterm.js (`@xterm/xterm`, fit addon, 1000 lines of scrollback, VS Code's light colours, greys included) on a node-pty pty in the project's folder, `bash` on WSL and srv, Git Bash (`GIT_BASH`, term.ts's, which main.ts's ./run uses too; ConPTY) on win. The backend keeps one pty per terminal (`<tab id>#<0-2>`, from the `term` every term action carries, so a tab can't have more than three on a host; one the page no longer shows keeps running, and comes back with its `+`) and the raw output's last 1000 lines (and at most 2M characters), so closing the pane, switching tabs or reloading loses nothing: a page with no or another shell id, or one fallen behind the buffer, gets the whole of it to replay (`reset`). The pane long-polls `termRead` (output past its offset, else after 2s), sends keys as typed through `termSend` one request at a time (keys typed meanwhile go together, so they stay in order), and its size through `termResize`. A header above it has the host and the shell's current folder in full, left of the buttons, search box and time while it fits on their row, else on a row of its own below them (flex `wrap-reverse`, the folder first), and in a column too narrow even for the buttons they wrap onto a second row of theirs above the folder's (in inline-block pieces that each end at a slash, so a long one wraps after a slash): each prompt sends it as OSC 7 with a bare path (through `~/.claude3/term.bashrc`, which sources `~/.bashrc` and then appends to `PROMPT_COMMAND`, since that file unsets it; Git Bash's sources `/etc/profile` first, as its login shell would, for PATH and the git prompt, and sends `cygpath -w`'s Windows path; Git Bash's also makes Enter (a readline macro: a `bind -x` rewrite, then accept-line) turn a line typed as `p <command>` into `powershell -NoProfile -Command '<command>'`, so PowerShell gets it as typed, and a line of just `p` into an interactive `powershell -NoLogo`; ConPTY passes the sequence through), so the replay brings it back too. At the buttons' right end, m:ss since the shell's last output or key (stopping at 59:59), counted by the backend (`termRead`'s `idle`, a span, not a time), so a reload keeps it. Left of it, Path opens FolderPicker at the shell's folder and, for a folder picked on the terminal's own host, types a cd to it (Ctrl-E Ctrl-U first, clearing a half-typed line; Git Bash takes the Windows path as is), a search box right of it (1.25 times Path's width, both set in the CSS) selects on Enter the last place its text is in the buffer, each Enter after that the one above and from the top one round to the bottom again (`src/termFind.ts`, checked in `render.check.mjs`: case ignored, a wrapped line read as one, the last hit being the selection; that select is kept off the clipboard, a hit out of view scrolled to the middle, the box red when there is none), Clr clears all but the prompt line (xterm's `clear()` on the page, and `termClear` cuts the backend's buffer to its last line, plus the last OSC 7 for the header, so a reload doesn't bring it back, and calls node-pty's `clear()`, as ConPTY would reprint the old screen), and Close, right of it, ends the terminal (below). Selecting text copies it (a double-click's word too), Ctrl-C with text selected copies it (else it goes to the shell), Ctrl-V is the browser's paste, and Ctrl-R and Ctrl-Shift-R are the browser's too, reloading the page (so bash's history search has no key); the page's own Ctrl-B, Ctrl-S, Ctrl-G and Ctrl-Alt keys still win (window capture). Timestamps (`STAMP` in `src/termFind.ts`, checked in `render.check.mjs`: dd-dd or dddd-dd, `-` or `/`, then hh:mm[:ss], any spaces between; or a capitalised month name, whole or three letters, and its day, perhaps a year and that time) are brown (#8b4513) xterm decorations (`allowProposedApi`), so the shell's own colours stay: after each write the lines it can have changed (from the screen's top before it) are matched again, each decoration on its own marker, disposed with it; none on the alternate screen. A shell that exits is started again by the next key. node-pty is loaded with `require` inside a try, so a host without it runs everything but the terminal. `term.check.mjs` (`npm test`) drives bash: folder, colours, Ctrl-C, replay, Clr, restart, a closed one starting afresh.
- `src/components/ReAuth.vue`: the sidebar's red Re-Auth button and its `<dialog>`, which walks
  every backend through a sign-in: a link to that host's sign-in page, the code box, Skip.
- `src/components/Snips.vue`: claude2's Snips as a Monaco editor in a column right of the pane
  (Project's `with-snips` grid: `--side-share`, half by default, of the width left of the sidebar, full height below the tabs). The one copy lives on claude-stats (`/snips`),
  reached through the backend's `snips` action; read on open and window focus,
  saved 500ms after typing stops. Each tab mounts its own the first time it opens them and after that only hides
  it (`shown` prop), so the cursor and selections last until the page reloads; its `shown` watcher does what a remount
  would (re-read while read-only, save at once, font size), and restores the scroll, since a hidden editor is 0x0. Ctrl+Enter with nothing selected types two bare newlines (no margin, no dash); with a selection it hands it to the `addToPrompt` prop, Pane's
  exposed `appendPrompt`, which appends it to the draft and focuses the prompt box, and sends it at once if the box was empty (no text, no pictures; a cancelled or failed send leaves it in the box); if that took
  it, the selection is deleted from the Snips and the blank lines at or beside it come down to one
  (`src/blankLines.ts`; a trashed session's prompt takes nothing, so nothing is deleted and they stay open), then the
  Snips close, which saves at once. With no selection they just close.
- `src/components/Settings.vue`: claude2's management pane in the Snips' column. Only its Quotas
  tab (the tab button does nothing yet), ported from claude2's `quotaHtml` nearly verbatim: graphs
  built by script, global styles under `.settings`, element ids `q-*` looked up inside its own root (`byId`: one instance per tab with it open, polling only while on show).
  Asks the backend's `quota` (Update = force), `quotaSync` every 30s, `speechmatics` per month.
- `server/quota.ts`: claude2's QuotaService and its stats-server calls. The account's one history
  and the poll lease live on claude-stats, one for all three backends; local
  fallback files in `~/.claude3/quota-*.json`. `sendQuota` in main.ts broadcasts each reading as a host-wide `quota` event
  (on stream connect, at each turn's end, after the Quotas pane's reading); the page keeps the newest from any host in
  `quotaUse` (`src/api.ts`), and every footer's `quotaSpend` (`shared/types.ts`) puts a red `$0.00` in place of the
  ponytail stat once a window not yet reset is at 95%, the month's extra-usage spend from 100%. The pane's Fable line (`modelScopedWindow`) adds up every weekly limit on a Fable model.
- `src/components/Pane.vue`: claude2's conversation pane. History (bars and boxes) is built
  imperatively, as claude2 builds it; the dock (prompt box, pill, stop, Cap, stats) is a
  template. Also the image popup. The prompt box is a Monaco editor whose text is mirrored into the
  `draft` ref both ways. claude2's big prompt editor: Ctrl-Alt-click in the box or Ctrl-Alt-Z
  (the tab on show only, via the `active` prop) puts the box full height left of the history,
  per session in localStorage (`bigPrompt:<tab>:<session id>`); Ctrl-Alt-X there shows it
  rendered as markdown. A plain Enter outside the prompt box and the controls (claude2's
  `selectBottomBlock`) selects and opens the last block; pressed again it toggles that box.
- `server/capture.ts`: claude2's PowerShell screen shot, returned as a PNG data URI.
- `src/copy.ts`: every alt-click's copy, with its light-red flash.
- `src/tooltip.ts` (`#tip` in `style.css`): every `title` on the page drawn as the page's own bubble, since a native one can't be sized. One delegated `mouseover`, nothing to add per element. A host's title sits in `data-tip` only while the mouse is on it. A manual popover, so it shows above modal `<dialog>`s.
- `src/keyHelp.ts` + `src/tip-text.txt` (`.help-pop` in `style.css`): middle-click on any item shows how it is used, in one modal `<dialog>` (`closedby="any"`, Close). Each `@name` line in the text file starts the block of the elements with that `data-help` (in templates, or `dataset.help` on what is built by script: bars, boxes, tool lines, code blocks, quota graphs); an element with none is display only and the middle-click does nothing. One window-capture listener takes every middle-button event (pointer, mouse, auxclick) ahead of Monaco's column select, xterm, Edge's autoscroll and the long presses, and shows on the release (a disabled button gets pointer events but no auxclick); only a link keeps its own. The tab strip's ? (left of the gear, `@mousedown.prevent` so focus stays put) shows the `global keys` block plus the block of the focused element's nearest `data-mode`, named on its first line and over its keys in light red (`.help-mode`). The text is a `?raw` import whose hot update swaps it in without a reload. What a line acts on, before a `: ` at a line's or sentence's start, is shown in blue (`ACTION`, `.help-key`). Tooltips keep what an item is; its click and key details live only in the text. `src/tipText.check.mjs` (`npm test`) fails on a name with no block or a block on no element (bound `:data-help` names are read from their quoted strings).
- `src/waitingImages.ts`: unsent pictures per tab in IndexedDB, and unsent files under `files:<tab>`. `src/cropRect.ts`: the crop's
  arithmetic, checked by `npm test`.
- `src/monaco.ts` (+ `monaco.css`): claude2's Monaco setup (its webviews.ts `monacoScript` /
  `monacoStyle`), shared by the prompt box and the Snips: markdown only, the worker through Vite's
  `?worker`, the black theme, the user's VS Code keys (Ctrl-D delete line, ...), the line dots in
  the gutter, the list keys (Tab, Shift-Tab, Enter, Backspace, #) and untabbing. Ctrl-J is an `addEditorAction`
  of its own, in every editor (`joinLines` in `src/blankLines.ts`, checked by `npm test`): trailing white space off
  the line, leading off the next, one space between, the caret left of it. claude2's F1
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
- `claude-stats/server.mjs`: the stats server, what the three backends share: the quota history and
  its poll lease, the Snips' text, the API key's spend claude2 recorded (`/checks`, nothing adds to it)
  and tv's Speechmatics spend (asked of tv-srvr on the same box). Plain node, no imports from the
  repo; endpoints at its top. On hahnca.com: pm2 `claude-stats`, port 7313 (`STATS_URL` in
  `shared/config.ts`), data in `~/.claude-stats/data.json`. It began as claude2's `claude2-stats`
  (port 7301, still there for claude2) and shares nothing with it; `test.mjs` is its check (`npm test`).
- `deploy`: every run first runs `src/tipText.check.mjs` and stops, deploying nothing, when it
  fails: its lines come as `!!` lines under `!! src/tipText.check.mjs failed:`, which makes the
  page's run-error dialog offer Fix it (`TIP_FAIL`, `fixTips` in Pane: the failure as a prompt to a
  new session, opened, as Set up does). `./deploy stats` copies `claude-stats/` to hahnca.com and starts it under pm2, with a
  version of its own (the folder's hash), so changing it restarts no backend; the first deploy copies
  claude2-stats' `data.json` as its starting data. For the backends it
  builds and copies `package.json server shared` (+ `dist` for WSL) to each host, plus node-pty's runtime parts (`copy_pty`: its `lib`, the Linux `pty.node` npm install built here, which hahnca.com's glibc 2.39 also runs, and the win32-x64 prebuilds without `.pdb`s, ~3MB; on Windows after the old backend is stopped, as it holds the DLLs), and
  sets up what keeps it running: systemd `claude3` on WSL, the `claude3` value of the HKCU Run
  key on Windows (at logon), pm2 `claude3` on hahnca.com. It stamps each copy with a `version` file, the hash of `server/`
  and `shared/`, which the backend answers at `GET /version`; `deploy --if-stale` redeploys only
  the hosts that don't answer with the repo's hash. The WSL deploy builds the page first, so a
  type error anywhere in `src/` fails it. A failed host leaves `.deployed` unstamped (the deploy
  warning stays up) and makes `deploy --if-stale`, and so `run`, exit 1. Only a run over every
  target stamps (`stamp`): `./deploy wsl` leaves the stamp alone, the other hosts maybe still
  being behind. The stamp's time is set back to when the script started, so a file saved while it
  ran still counts as undeployed.
- `skills/deployable/SKILL.md`: a Claude Code skill for every other project: how its `./run` must
  behave for the Run button on each host and how its deploy skips what is already there, including
  a new project about to get a skeleton. `deploy` copies `skills/` (rsync, merged, never
  `--delete`) into `~/.claude/skills` on wsl, win and srv on every run, stale or not. It restates
  `runScript`, `deployNeeded` and `deployCheck`: change it with them.
- `run`: stops this repo's vite if one is running (it holds port 5310), `deploy --if-stale`, then
  starts vite detached (`setsid nohup`, output in `vite.log`), waits for its ready line, and exits. So starting the page also restarts any backend whose
  server code changed, cutting that backend's running turns. Page-only changes never restart one.
  It exits 1 when a host failed or vite's ready line never came, so the page's error dialog shows it.
- At boot vite comes up from systemd `claude3-vite` (`/etc/systemd/system/claude3-vite.service`, by
  hand, not from `deploy`; output truncated into `vite.log`). It is `Restart=on-failure`, so
  RESTART_VITE's pkill is a clean stop it leaves alone, and `./run` starts its own detached vite then.
  WSL itself is started at Windows logon and kept up by the scheduled task "Start WSL Ubuntu at
  Logon" (`conhost.exe --headless wsl.exe ... --exec sleep infinity`, no delay, no time limit;
  changing it needs an elevated PowerShell): WSL stops a distro about 20s after the last wsl.exe
  attached to it exits, systemd services or not, so without the held `sleep` the backend and vite die.
- `server/stamp.ts`: the deploy stamp's rules that need no project to try (`stampProblem`: how a
  script must write `.deployed`; `stampTime`: when a stamp counts from), with `stamp.check.mjs`
  (`npm test`). `deployNeeded` and `deployCheck` in `main.ts` use them.

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
- **A search (claude2's).** Sidebar Enter → `searchText` in Project, a third list covering active and trashed sessions (trashed ones last), looking only
  at what a bar and a default box show (`matchCount` in `src/render.ts`). Project passes the text to the pane (`search` prop), opens
  the first card and calls `Pane.stepSearch`; a card click steps too. The pane walks its hits and paints the current one with the CSS
  highlight API, whose name is page-wide, so only the tab on show paints. Past its last hit it wraps to its first; only a click on another card changes session. The X, an empty Enter, a card's R, "+", Clean or Trash end it, and a trashed session it opened then leaves the pane.
- **A prompt.** Ctrl+Enter → `POST /api/prompt` → `submitPrompt` (an empty sessionId, the pane's
  draft in the moment before `ensureOpen` has a session or if it failed, creates the session; a running session is stopped first unless the
  prompt can follow up a background wait) → `runTurn` stores the turn, posts `session`, names the
  session on its first prompt, and runs the CLI. Text and status go out as `delta` every 80ms.
  The result settles the turn (`markAnswer` puts the answer mark in), saves, posts `session`.
  The checks before a send (deploy setup, deploy warning, commit warning) take a few round trips with the text still in the box, so `submit` lets one send through at a time (`sending`): a second Ctrl+Enter meanwhile does nothing.
  Each session's unsent text is saved on every edit in localStorage (`draft:<tab>:<session id>`,
  '' for the new-session draft, removed on send), so it is back in its box after a reload and
  `Pane.drafted` still spares its session from the sweep. Ctrl+Enter in an empty box (no text, no pictures) puts the last bar's prompt in it as ordinary draft text, and does nothing in a session with no prompt yet; edited, it sends as any prompt, but while it still matches the last prompt (trimmed) Ctrl+Enter only empties the box (`sendKey`). When the settling `session` event arrives and the page lacks focus
  (`document.hasFocus()`), Project shows a browser notification (a Windows toast) named for the project and beeps (`src/beep.ts`, Web Audio, one context for the page). Permission is asked on the first click after a load (`src/main.ts`); only `localhost`-style origins can have it, which `ORIGINS` already are.
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
- **File.** The footer's File (right of Cap) opens FolderPicker in file mode on the tab's host at
  the project folder; ctrl-click opens it on win at `C:\Users\mark`. Ctrl+Enter in the Files tree
  with exactly one row selected, a file, adds that one with no picker (Files' `attach` event,
  Project, Pane's exposed `attach`), and either way the focus ends in the prompt box. The pick goes to that host's
  `attachFile` (`server/files.ts`): over 20MB, or not a picture, PDF or UTF-8 text, is refused and the
  reason alerted. A picture (png/jpg/gif/webp/bmp, made a PNG by `asPng`) joins the prompt as a
  screenshot does; anything else waits per session as an `AttachedFile` with its bytes as a data URI,
  shown as a `<file>` mark after the image icons (the same decoration's `after`, which Monaco draws
  after its `before`). A click on a mark shows its details in a dialog, never the file; ctrl-click in
  the box removes it. On send the files ride with `POST /api/prompt`, whatever host they came from;
  the tab's backend copies each to `~/.claude3/files/<session id>/<uuid>/<name>`, appends a `fileNote`
  (stripped by `typedPrompt`) and records them in `turn.files`, so a bar draws the same marks. Kept,
  forked, returned on an expired login and deleted for good as pictures are.
- **Paste and drop.** Ctrl-V in the prompt box with files on the clipboard (a copied picture, or
  files copied in Explorer), or files dragged from Explorer onto anywhere in the pane, are added as
  File adds them (`addFiles`; `pasteFiles` and `dragFiles`, capture phase ahead of Monaco, which
  never sees a file drag): pictures through `addPictures`, PDFs and UTF-8 text as `<file>` marks,
  tested in the page by `pastedFile` with attachFile's rules. A page gets no path, so the name
  stands for it, host win. A clipboard that also has text pastes the text instead (Excel's cells
  carry a picture of them).
- **Re-Auth.** A turn whose error matches `AUTH_FAILED` sets its host's flag (`~/.claude3/auth-needed`,
  sent as an `auth` stream event, held in `authNeeded` in `src/api.ts`). If the API never started
  answering, the turn is dropped and its prompt and pictures go back to the page (`returned`,
  `Pane.returnPrompt`); otherwise it keeps its text and shows the error. Any host's flag raises
  Re-Auth in every tab, and one click signs in on wsl, win and srv in turn, each with its own page
  and code: `login` gives the URL, `loginCode` sends the code, and `loginResult` is polled once a
  second (Firefox gives up on a response after 5 minutes). The poll also ends when the CLI's own
  browser tab finished the sign-in with no code. A sign-in or an answered turn clears that host's flag.
- **CLI missing.** A `spawn claude` ENOENT (often an interrupted npm update leaving no `claude` link)
  rejects with a message starting `CLI_MISSING`; `runTurn` drops the turn and sends `returned` with a
  `notice`, which `Project.vue` shows in an alert.
  Each sign-in's CLI runs with `DEBUG=1` (its own log lands in `~/.claude/debug/`), everything it prints
  goes to the backend's log as `login ...` lines, and a pasted code gets 2 minutes before the CLI is stopped.
  A flag coming up opens every tab's hidden sidebar, where the button and its message are. To test it
  while signed in, ctrl-click the sidebar's session counts: `fakeAuthNeeded` raises the real flag on that tab's host
  (one host, as a real expiry is; a skipped host keeps its flag until a sign-in or an answered turn there).
- **Deploy warning.** Before sending a prompt the pane asks `deployNeeded`: the project's
  `./deploy` (or `./run` when it has none) touches `.deployed` (gitignored) when it finishes, and
  any `git ls-files` file newer than it means a deploy is due; a `<dialog>` then asks Deploy
  (same as "r" below, the prompt stays unsent in the box), Continue or Cancel. No script or no
  stamp yet, or no git repo (a new project), means no warning. The touch lines live in each project's own
  script (claude3, claude2, tv, finance on hahnca.com). A script can write paths into the stamp
  and then only those count (one git pathspec per line, so spaces work; written with
  `printf '%s\n'`, and deployCheck fails an `echo` into it): claude3's writes `SOURCES` from
  `./deploy` (`server shared claude-stats skills`), so docs and page-only edits don't ask for a deploy.
  Three more things count as changed. A file the stamp names on a line of its own, even one git
  ignores (an `.env`). A tracked file gone since the deploy, shown as `name (deleted)`: the backend
  keeps the list of tracked files a stamp covered when it first saw it (`stampFiles`,
  `~/.claude3/run-<tab>.files`). And a file saved while the deploy was running: a stamp written
  during the Run button's `./run` counts from that run's start (`stampTime`, from `run-<tab>.start`
  and the status file's time), which also flags, until the next Run, a file the deploy itself
  rewrote under the stamped paths (`npm install` and a lock file). A run whose output has the
  frozen line (`== sources frozen <epoch ms>`, `FROZEN_LINE`: it wrote its own sources before then
  and copies none until after; tv's unilog reconcile) counts from that line's time instead, read
  from `run-<tab>.log` by `lastRun`. A `./run` from a terminal keeps
  its stamp's own time; claude3's `deploy` back-dates its stamp itself. The tab row's R (Run) button is highlighted
  while the same check finds files; it is re-read for every project, open or closed, on showing, window focus,
  session events, and a ./run's result.
- **Deploy setup.** Before the deploy warning, a prompt in a project whose `Tab.deploySetup` (in its
  backend's `projects.json`) isn't "done" or "none" goes through `deploySetupOk` in Pane. With no
  flag it first asks the backend's `deployCheck` (`./run` there, parses, no CR, executable off
  Windows, not the skill's "nothing to deploy yet" stub, and paths written into `.deployed` by a
  redirect in it or `./deploy`, at any path; a bare `touch .deployed` is the old kind and fails, as does an `echo`: `stampProblem`). Passing sets
  "done" and the prompt goes on with no dialog; otherwise a `<dialog>` lists the problems, with Cancel as its Enter button (Set up starts a session that writes scripts, so it takes a click). Set up
  sends `SETUP_PROMPT` (use the deployable skill) to a new session and opens it (so the footer shows its
  status; the typed prompt's text moves into its box, unsent, and its own session's draft is emptied; once "started" the button reads "Set up again"), and sets
  "started"; Check runs `deployCheck` again and an alert gives the result; Not needed sets "none"
  and sends; Continue sends and leaves the flag. Set up, Check and Cancel leave the prompt in the
  box. With "started" the dialog comes with no check first, Check focused, except for a prompt to the setup session itself (its first prompt is `SETUP_PROMPT`), which just goes. The flag comes back to the page in a `projects` event.
  A `./run` (Run, "r", "v") asks the same first (`runScript`, `deploySetupOk("run")`), where Continue and Not needed start it; the deploy warning's Deploy skips the question, which its prompt already passed.
  A "done" project is checked again before each `./run` (not each prompt), and `deployCheck` drops the flag when it no longer passes, so a script broken since, or a rule the check gained, brings the question back.
- **Commit warning.** After the deploy check, a prompt to a session with turns asks `lastCommit`
  (HEAD's `%ct` and subject); HEAD newer than the last turn's `createdAt` opens a `<dialog>`:
  New session (the prompt starts one, as from the draft, and leaves the running one alone),
  Continue or Cancel. The Snips' auto-send into an empty box opens the same dialog whenever the session has turns, commit or not
  (`commitChoice(snips)`), since nobody looked at the conversation for it. The "/compact" auto-send (`keepDraft`) skips both checks.
  Either check failing (a stale backend answers "No such session.") shows an alert, then the prompt is sent.
- **"r".** A prompt of just `r`, or the tab row's R (Run) button, which Project teleports after G (Git) and which calls Pane's exposed `runScript` (ctrl-click for `v`), goes to `POST /api/run` instead of claude: the backend runs the
  project's `./run` and the page shows its output in a `<dialog>` (`.run-pop`) as it goes, asking `runResult` once a second (OK hides it, the result opens it again), the final text kept in sessionStorage until OK so a page reload doesn't lose it. Terminal colour codes are stripped from the output first (`plain`; pm2 prints them even into a file). A failed ./run (non-zero exit, or no result) also opens a red-bordered error dialog on top (`.run-error`): the failure line plus the output's `!!` lines, kept in sessionStorage (`runFail:`) until its OK. It opens only on the tab on show, and a waiting result opens when its tab is picked: a modal `<dialog>` in a hidden tab would leave the whole page inert with nothing to see. `./run` leaves an already-running vite alone (hot update only); a prompt of just `v` does the same as `r` with RESTART_VITE=1, which makes claude3's `./run` restart vite (reloading the page). Sessions run in the backends and the page talks to them directly, not through vite, so a vite restart only reloads the page; the event stream reconnects with full state. On win it runs as `bash ./run` inside Git Bash (`C:\Program Files\Git\bin\bash.exe -c`), since Windows can't start a script by its `#!` line (every project's `./run` is bash); on srv it is spawned directly, under `timeout`. On WSL it runs through `systemd-run`
  (`KillMode=process`), outside claude3.service's cgroup, so claude3's own `./run` restarting
  this backend kills neither the script nor the vite it leaves running. The page's request
  dies with the backend then, so the script's output and exit code go to
  `~/.claude3/run-<tab>.log` / `.status`, never a pipe back to the backend, and the page asks
  `runResult` once a second until they're there (resuming after a reload, via sessionStorage).
  `deploy` sends its own output through `tee`, so a caller's pipe vanishing can't fail an echo
  under its `set -e`.
  One `./run` per project at a time: the backend refuses a second while `run-<tab>.start` has no
  status file beside it (for a minute past the limit, should the end never get written), and the
  page's Run, with one going, only brings the live output back up (`runState`). The page names
  each run with an id, kept in the start file and answered by `runResult`: a request that never
  reached a backend (it was down) would otherwise show the previous run's result as its own.
  After 5 minutes coreutils' `timeout` (Git Bash's own on win, wrapped around `./run` on every
  host) stops the script and what it started, except what it detached with `setsid`; exit code
  124 reads as "stopped after 5 minutes". Killing the spawned child stopped nothing on WSL
  (systemd-run's client) or Windows (Git Bash's launcher).
- **Files.** The tree's root is `Tab.roots[Tab.rootIdx]` (kept in `projects.json`, `setRoots`, back
  through a `projects` event) or else the project folder. Back and Fwd only move the index; a new root drops the entries past it first. Up (left of Back, on the header's second row with Fwd and Collapse) makes the root's parent (`parentFolder` in `src/tabList.ts`) a new root, disabled at `/` or a drive's `C:\`. The bar wraps; the search box and NM wrap as one piece, only when a 5em box and NM no longer fit, the box filling the room left (`.files-find`). Open folders are per tab in localStorage
  (`filesOpen:<tab>`), and the selected rows per root (`filesSelected:<tab>`, a list; click, ctrl-click and shift-click as in `src/pick.ts`, except that a click on a folder only opens or closes it, so only ctrl-click selects a folder and a shift-click's run takes in files only; the path row ending in a yellow `*` for more than one), the first scrolled into view on a new root, on opening the column or leaving file mode, and when a key puts the focus on the tree (`focusTree`), but not on a mouse press, which would move the row being clicked. Every open folder is listed again every 2s, so outside
  changes appear. The keys (`keyDown`) work only while focus is in the tree's part of the column, outside its text boxes and
  the Path dialog. All but Delete need exactly one row selected and on show (so do New and Prj; Ctrl-click on New makes `new-dir` instead of `new-file`); Delete lists what it will remove below the root and refuses, in an alert, while any selected row is out of sight. Ctrl-C puts the selection on the real
  Windows clipboard with `Set-Clipboard`, Ctrl-V reads `Get-Clipboard -Format FileDropList` and copies. Ctrl-X is a
  Ctrl-C remembered page-wide (`cut`, with the clipboard's name for it): if that is still all the clipboard holds, the next Ctrl-V
  in any tab moves it (`movePath` on its own host, else paste then `deletePath`). The clipboard is on the laptop, so a srv tab asks
  WSL's backend (`clipHost`), which carries the files with scp: fetched ones wait in
  `~/.claude3/clipboard/`, and for a paste it asks the srv backend's `freePath` for the name. Clashes on new,
  paste, move and drop take `name(<idx>).ext`; nothing is overwritten. Drops stream raw to `POST /upload`.
  The search box's Enter (Ctrl-Enter going backward) asks `findFile` for the next name after the last
  found, walked on the backend so closed folders count and skipping node_modules unless NM is
  ticked; the page opens the way to it and selects its row. Esc there moves focus to the tree.
  A long press (650ms) on a row selects it and opens a `<dialog>` of all `fileInfo` says about it: lstat/stat, a link's target, a text file's line count, a folder's totals (walked for at most 2s, then marked partial). Times go to the page as ms so they show in its zone. The click ending the press does nothing else (`longPressed`).
  **File mode:** A header row shows the path after the host, as the tree's path row does. Ctrl-double-click on a `.md` shows it rendered and read-only in the editor's place (`renderMarkdown`, inside a `.pane` div for Pane.vue's global markdown styles), read again every 2s if its mtime changes. In the editor: saved 500ms after typing, and read again if the file's mtime changes, asked every 2s. With the last line in view it is in tail mode, the header's path yellow: the read is `waitFile`, which the backend answers on an `fs.watch` event or after 2s (where a watch can't see the change), and the view sticks to the bottom when text arrives. `saveFile`
  carries the mtime it read and is refused if the file has moved on; the editor then stops saving
  until Reload.
- **Delete for good.** Picked trashed cards → `POST /api/delete`, after a `window.confirm`. The
  backend takes only trashed ids with no run going (skips running ones), removes them and their
  debug records, and posts `removed`. The CLI's
  transcripts stay, as in claude2.
- **Fork (claude2's).** The mark leading each bar → `window.confirm` → `fork` action
  (`forkSession`), refused while the session runs. The whole session is copied as "<name> (2)"
  (then (3), ...) under a new id: every mention of the old id in it is swapped, the pictures' folder
  copied, and the CLI transcript copied with the id swapped (`copySessionTranscript`). Then, unless
  it was the last bar, the session keeps only the runs up to that bar and its transcript is cut at
  the next prompt (`truncateSessionTranscript`, old file kept as `.bak`). A transcript that couldn't
  be copied or cut comes back as `warning` and the page alerts it.
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
  turn's end and sends a `ceilings` event. The footer shows `skips:ceilings` only when either is 0, and never while the red quota spend has its place.

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
  claude2's Settings pane; the Settings pane has no Settings tab yet.
- A run's model, effort and advisor come from `modelChoice` in `shared/types.ts`, by the session's `bestModel` (the unlabeled box right of the footer's Cap, kept with the session by the `bestModel` action; its tooltip is the choice's `title`). The prompt doesn't carry them. The advisor has no effort setting anywhere: the CLI's `advisorModel` and the API's advisor tool take only a model.
- Chromium hands focus back after a mouse-closed `<dialog>` without the text box's caret, so
  typing goes nowhere; `src/main.ts` blurs and refocuses on every dialog's close. Monaco's own
  focus call doesn't help, since the textarea already has focus.
- Enter in any modal `<dialog>` presses its `autofocus` button, or its only button (`src/main.ts`,
  window capture, ahead of Pane's Enter), unless focus is on a button, input, textarea, select or link.
  A click on a dialog's text leaves focus on the body, where Pane's Enter would act behind the dialog.
- A new clickable or focusable item needs a `data-help` name (and a `data-mode` where it has keys of its own) with a block in `src/tip-text.txt`; `npm test` and every `./deploy` catch a mismatch. Names stay literal strings so the check can find them.
- Every modal `<dialog>` carries `closedby="any"`: a click on its gray backdrop closes it as Esc does
  (a `cancel` handler can refuse, as Git's does while committing; a press that starts inside and is let
  go outside doesn't count). Give a new dialog the attribute too. A non-modal one (the Git popup's review) must not have `any`: on a non-modal dialog it closes on any click outside.
- Errors nothing caught (Vue's `app.config.errorHandler`, window `error` and `unhandledrejection`)
  get a `window.alert` from `src/main.ts`, each message once per page load (a broken render repeats
  on every update). Window errors without an error object, like ResizeObserver's loop notice, are skipped.
- Not ported yet from claude2: export, presets (M),
  Stats/Models/Instructions/Settings tabs, the git changes check, prompt
  suggestions, arrow-key navigation.
- claude2's per-host auth flag (`authNeeded.<remote>` in VS Code's globalState) can't be shared: it
  sits in VS Code's own database on the Windows side, out of hahnca.com's reach, and a running
  VS Code rewrites it from memory. Each app clears its own flag on its next answered turn.
- Snips stay read-only until the saved copy has been read, so nothing typed early can replace it
  unseen; a read that fails keeps them so. A copy never saved reads as empty and editable.
- Monaco's `addCommand` keys are page-wide and every tab has its own editor, so editor keys are
  `addAction`s. Monaco is about 4MB of the built page. Its theme and `addKeybindingRules` are page-wide
  too: the Files editor is stock Monaco (plus word wrap and the line dots, coloured by the language Monaco infers from the file's name or `#!` line: every language's Monarch colouring is registered, loaded on first use, JSON as JavaScript, Vue as HTML, `.log` by a small Monarch language of its own, none of the worker-backed language services) but must use the `claude2` theme, and is kept out of the
  user's key rules, all but Ctrl-D and Ctrl-J, by its `stockEditor` context key. The ctrl-wheel font size of it and of the Snips is
  `addWheelZoom` in `monaco.ts`, each editor with its own remembered size, since Monaco's `mouseWheelZoom` is page-wide too.
  The Files tree (with its rendered markdown), the Log pane and the conversation history (`--pane-font-size`; the markdown's
  sizes are `1em` under it) aren't Monaco: `src/wheelZoom.ts` does the same with a remembered CSS variable on the root, one per pane.
  The Term pane sets xterm's own `fontSize` (`claude3.termFontSize`) and refits.
- Every page element follows CLAUDE.md's display rules: font sizes 14–18px only (the exceptions,
  at the user's asking, are the ctrl-wheel size of the Files pane, the Log pane, the Snips, the conversation history and the Term pane, which has no limits, the Term header's buttons, search box and time at 11.2px, and the 12px tooltip `#tip`), text solid black
  or a colour, never grey. Monaco's markdown and the Files editor's languages keep the stock light theme's token colours (blue
  headings), its other greys too (at the user's asking), and so does the Term pane (VS Code's light terminal colours, greys included); only html delimiters are pinned to black in `monaco.ts`. A disabled button keeps its enabled look under a 50% white
  overlay (`style.css`, at the user's asking, though it pales the label), a paused quota age by its background; only status icons (tab dot, card clocks) keep colour.
