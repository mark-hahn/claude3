# Workspace Instructions (Read First)

## Rules

- **only use Font sizes between 14px and 18px inclusive.** Both bounds are real: smaller
  is unreadable on this screen, larger breaks the column.
- **only use Solid black text, never gray.** Gray for de-emphasis fails against these
  backgrounds. Colour other than gray is fine — it is the washed-out grays that
  are the problem, not colour as such.
- When asked to do a simple one-off action (generate a file, run a command), just do it and report completion in 1-2 lines.
- Don't produce research/investigation reports, format/byte-level breakdowns, or step-by-step narration of what you checked unless something went wrong or the user asked to see it.
- Save deep technical detail for when the user explicitly asks to understand or explain something.
- when modifying files use local changes and don't replace entire files because another copilot conversation might be changing the same file
- don't read doc files in ./doc unless i tell you to
- never do a `find / ...`, it is too slow
- when a claude or copilot chat is in ask mode instead of agent mode and i give you instructions that include writing or changing something that means i made a mistake -- stop and tell me to use agent mode
- don't clean up debug logging until i tell you to
- never do git commit, push, pop, or anything else that modifies git repo unless i tell you to
- you can do git reads without permission
- don't deploy anything -- i will deploy before i test (`./deploy` copies the backend to the three hosts and restarts it; `./run` does the same for any host whose server code is out of date)
- never turn on the advisor except through the footer's Advisor selector: no `/advisor` command
  (it writes `advisorModel` to the global ~/.claude/settings.json, reaching every session on the
  machine), no `advisorModel` in any settings file, no `--advisor` flag
- claude.md instructions are authorative and copilot-instructions.md should always be a copy of claude.md
- when i say to save a rule, add it to CLAUDE.md (and mirror it in .github/copilot-instructions.md)
- Architecture note: `.claude/architecture.md` (read for orientation; keep it current).
- alt-click in a fenced code block copies that block's text to the clipboard; this overrides any other alt-click rule

## Remote server

- The remote server is **hahnca.com**.
- Use **SSH** to access the remote server (SSH keys are already available/configured).
- The Windows machine talks to the server over the **LAN**; the internet can't reach them.
  Unauthenticated, plaintext HTTP between them is fine — if someone is on this LAN we have
  much bigger problems than the wire format. Don't raise it as a concern.

## Backends

- claude3 is the page (`src/`) plus one backend per host (`server/`), all in this repo.
- **wsl** backend: port 7310, deployed to /root/apps/claude3Wsl, also serves the built page.
- **win** backend: port 7311, deployed to C:\Users\mark\apps\claude3Win.
- **srv** backend: port 7312 on hahnca.com, deployed to /root/dev/apps/claude3Srv.
- The tabs and which host each runs on are in `shared/config.ts`.

## Page terminology

- the page is the whole claude3 browser page; the tab strip is the row of tab buttons at its top
- a tab is one project: a sidebar on the left and a pane on the right
- the sidebar is the column of session cards on the left of a tab
- the bar is the single line of prompt text in the pane
- a block is the combination of a bar with the results below it
- a box is the text results in a block below the bar
- a pane is the conversation column right of the sidebar, containing nothing but blocks
  - a pane does not include the prompt box or the stats/buttons to the right of it
- the prompt box is the text box where prompt text is entered
- the footer is the stats/buttons to the right of the prompt box
  - the nav row is the top row in the footer with the status indicator, stop, and ctx buttons
  - the model row is the second row with the model/effort/advisor selectors
  - the stats row is the third bottom row with stats and no buttons
