#!/usr/bin/env node
/**
 * One command to screenshot the app for the "Screenshots for visual changes" rule in CLAUDE.md.
 *   node scripts/shot.mjs "/" --sel "main" --out <scratchpad>/here.png [--phone | --w 1280 --h 800] [--click TEXT]... [--text TEXT] [--full] [--wait MS]
 * Builds if apps/web/dist is missing or older than the sources, serves it with `vite preview` on :4199 (unless SMOKE_BASE_URL is set), opens the path,
 * clicks the given visible texts in order, waits for --text, and screenshots the element (--sel), the viewport, or the whole page (--full).
 * --phone = 390x844 touch, default 820x900. Then send the path with SendUserFile (it must be inside your scratchpad directory).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const vals = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const one = (n, d) => vals(n)[0] ?? d;
const route = argv.find((a, i) => a.startsWith('/') && !(argv[i - 1] || '').startsWith('--')) ?? '/';
const phone = flag('phone');
const W = Number(one('w', phone ? 390 : 820)), H = Number(one('h', phone ? 844 : 900));
const out = one('out', path.join(process.env.CLAUDE_SCRATCHPAD || '/tmp', 'shot.png'));

const newest = (d) => readdirSync(d, { withFileTypes: true }).reduce((m, e) => (['node_modules', 'dist', 'wasm-pkg', 'target'].includes(e.name) ? m : Math.max(m, e.isDirectory() ? newest(path.join(d, e.name)) : statSync(path.join(d, e.name)).mtimeMs)), 0);
let base = process.env.SMOKE_BASE_URL, server = null;
if (!base) {
  base = 'http://localhost:4199';
  const built = existsSync('apps/web/dist/index.html') ? statSync('apps/web/dist/index.html').mtimeMs : 0;
  if (!built || built < Math.max(newest('apps/web/src'), newest('crates'), newest('packages/engine-client/src'))) { console.error('building...'); if (spawnSync('npm', ['run', 'build'], { stdio: 'ignore' }).status) { console.error('build failed'); process.exit(1); } }
  server = spawn('npx', ['vite', 'preview', '--port', '4199', '--strictPort'], { stdio: 'ignore', cwd: 'apps/web', detached: process.platform !== 'win32' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)); }
}
const done = (code) => { if (server) { try { process.kill(-server.pid); } catch { /* already gone */ } } process.exit(code); };
try {
  const chrome = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const b = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  await page.goto(base + route);
  await page.waitForLoadState('networkidle').catch(() => {});
  for (const t of vals('click')) { await page.getByText(t, { exact: true }).first().click({ timeout: 30_000 }); await page.waitForTimeout(500); }
  for (const t of vals('text')) await page.getByText(t).first().waitFor({ timeout: 40_000 });
  await page.waitForTimeout(Number(one('wait', 800)));
  if (one('sel')) { const el = page.locator(one('sel')).first(); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: out }); }
  else await page.screenshot({ path: out, fullPage: flag('full') });
  await b.close();
  console.log(out);
  done(0);
} catch (e) { console.error(String(e).split('\n')[0]); done(1); }
