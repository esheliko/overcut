#!/usr/bin/env node
// `npm run smoke`: serves the production build (`npm run build` first) with `vite preview` and runs the Playwright smoke tests against it.
// SMOKE_BASE_URL tests an already-running site and starts no server. Extra arguments go to `playwright test`.
import { spawn } from 'node:child_process';

const bin = (c) => (process.platform === 'win32' ? `${c}.cmd` : c);
const done = (p) => new Promise((res) => p.on('close', (code) => res(code ?? 1)));
// `npm run preview` starts child processes: stop the whole group, or the server outlives the run and the next run tests a stale build.
const stop = (p) => {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
    else process.kill(-p.pid);
  } catch { /* already gone */ }
};
const args = process.argv.slice(2);
let server;
let base = process.env.SMOKE_BASE_URL;
if (!base) {
  base = 'http://localhost:4173';
  const up = () => fetch(base).then((r) => r.ok, () => false);
  if (await up()) { console.error(`smoke: something already answers on ${base} (a stale preview server?): stop it, or set SMOKE_BASE_URL to test it on purpose`); process.exit(1); }
  server = spawn(bin('npm'), ['run', 'preview', '-w', '@app/web'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { await new Promise((r) => setTimeout(r, 1000)); ok = await up(); }
  if (!ok) { stop(server); console.error('smoke: the preview server did not come up (run `npm run build` first)'); process.exit(1); }
}
const code = await done(spawn(bin('npx'), ['playwright', 'test', ...args], { stdio: 'inherit', env: { ...process.env, SMOKE_BASE_URL: base } }));
if (server) stop(server);
process.exit(code);
