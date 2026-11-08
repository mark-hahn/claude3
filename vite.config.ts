import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// Dev only: the page's console, uncaught errors included, mirrored to vite-console.log in the repo
// so Claude can read it. Emptied at each vite start, which keeps it to one run's worth.
function consoleToFile(): Plugin {
  const file = fileURLToPath(new URL('vite-console.log', import.meta.url))
  const client = `
    const send = (level, args) => navigator.sendBeacon('/__console', level + ' ' + args.map((arg) => {
      if (arg instanceof Error) return arg.stack || String(arg);
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' '));
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[level];
      console[level] = (...args) => { original.apply(console, args); send(level, args); };
    }
    addEventListener('error', (event) => send('uncaught', [event.error ?? event.message]));
    addEventListener('unhandledrejection', (event) => send('unhandled', [event.reason]));`
  return {
    name: 'console-to-file',
    apply: 'serve',
    configureServer(server) {
      fs.writeFileSync(file, '')
      server.middlewares.use('/__console', (req, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => (body += chunk))
        req.on('end', () => {
          fs.appendFileSync(file, `[${new Date().toLocaleTimeString('en-GB')}] ${body}\n`)
          res.end()
        })
      })
    },
    transformIndexHtml: () => [{ tag: 'script', children: client, injectTo: 'head-prepend' }],
  }
}

// https://vite.dev/config/
// Fixed ports, strict: the backends accept requests only from these origins (shared/config.ts
// ORIGINS), and 5173 is already the tv client's.
export default defineConfig({
  plugins: [consoleToFile(), vue()],
  server: { port: 5310, strictPort: true },
  preview: { port: 4310, strictPort: true },
})
