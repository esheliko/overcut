#!/usr/bin/env node
/* global document, innerWidth, innerHeight, devicePixelRatio, crossOriginIsolated -- these run inside the browser page (page.evaluate) */
// Runs inside the Android emulator job: serves apps/web/dist, opens it in the emulator's Chrome over adb (Playwright's experimental Android driver)
// and writes emulator-proxy.json (capabilities, horizontal overflow, load timing). Results are an "emulator-proxy": they prove function, layout and 4 GB memory behaviour, not real-device speed (ADR 0013).
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { _android as android } from '@playwright/test';

const root = 'apps/web/dist', port = 4173;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path === '/' ? 'index.html' : path), body;
  try { body = await readFile(file); } catch { file = join(root, 'index.html'); body = await readFile(file); }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
  res.end(body);
}).listen(port);

const out = { kind: 'emulator-proxy', at: new Date().toISOString(), ok: false };
try {
  execFileSync('adb', ['reverse', `tcp:${port}`, `tcp:${port}`]);
  const [device] = await android.devices();
  if (!device) throw new Error('no android device');
  out.device = { model: device.model(), serial: device.serial() };
  const context = await device.launchBrowser();
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  out.loadMs = Date.now() - t0;
  out.page = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    deviceMemory: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency,
    webgpu: 'gpu' in navigator, webcodecs: typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined',
    crossOriginIsolated, opfs: !!navigator.storage?.getDirectory,
  }));
  out.ok = !out.page.horizontalOverflow;
  await context.close(); await device.close();
} catch (e) {
  out.error = String(e?.message ?? e);
}
await writeFile('emulator-proxy.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
server.close();
process.exit(out.ok ? 0 : 1);
