# claude3

Claude Code in a browser page: one tab per project, each a session sidebar and a conversation
pane, like the claude2 VS Code extension. The claude CLI runs under a small Node backend on each
host (WSL, Windows, hahnca.com); the tabs and hosts are in `shared/config.ts`.

- `./run`: deploy any backend not running the repo's server code, then the page with hot update at http://localhost:5310 (`npm run dev` is the page alone)
- `npm run build`: type-check page and server, build the page to `dist/`
- `npm test`: the renderer's self-check
- `./deploy [--if-stale] [wsl] [win] [srv]`: copy the backend to its hosts and (re)start it there

See `.claude/architecture.md` for how it fits together.
