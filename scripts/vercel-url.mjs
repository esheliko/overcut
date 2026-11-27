#!/usr/bin/env node
// Extracts the deployment URL from `vercel deploy` output (stdout and stderr mixed, any CLI version). Reads stdin, prints the URL or exits 1.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app\b/gi;

/** The last `https://<name>.vercel.app` in the output (the deployment, not inspect/dashboard links), or null. */
export function extractDeploymentUrl(output) {
  const hits = String(output).match(URL_RE);
  return hits && hits.length > 0 ? hits[hits.length - 1].toLowerCase() : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = extractDeploymentUrl(readFileSync(0, 'utf8'));
  if (!url) process.exit(1);
  console.log(url);
}
