# Architecture

Vue 3 + Vite single-page app (scaffolded with create-vite, `vue` template).

- `index.html` — entry page; mounts `#app` and loads `src/main.js`.
- `src/main.js` — creates the Vue app from `src/App.vue`.
- `src/components/` — components; `src/assets/` — bundled assets; `public/` — copied as-is.
- `npm run dev` / `npm run build` (→ `dist/`) / `npm run preview`.

Gotchas:
- SPA fallback: Vite dev and preview serve `index.html` for unknown paths (default `appType: 'spa'`).
  A production host serving `dist/` must do the same rewrite or deep links 404.
- No router yet; add `vue-router` with `createWebHistory()` when routes are needed.
