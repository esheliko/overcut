#!/usr/bin/env node
// Packs apps/web/dist into a Vercel "Build Output API" folder (.vercel/output) so CI can `vercel deploy --prebuilt`.
// Vercel's own build image has no Rust toolchain, so the engine is built in CI and only the finished static site is uploaded.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('.vercel/output', { recursive: true, force: true });
mkdirSync('.vercel/output', { recursive: true });
cpSync('apps/web/dist', '.vercel/output/static', { recursive: true });
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
writeFileSync('.vercel/output/config.json', JSON.stringify({
  version: 3,
  routes: [
    { src: '/sw.js', headers: { 'Cache-Control': 'no-cache', ...isolation }, continue: true },
    { src: '/(.*)', headers: isolation, continue: true },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },
  ],
}, null, 2));
console.log('wrote .vercel/output');
