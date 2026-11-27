// Stamps the service worker cache name with the build hash so each build gets its own cache and `activate` deletes the old ones.
import { createHash } from 'node:crypto';

export const SW_PLACEHOLDER = '__BUILD__';

/** Short stable hash of the (content-hashed) bundle file names plus the worker source itself. */
export function buildHash(fileNames, swSource) {
  const h = createHash('sha256');
  for (const n of [...fileNames].sort()) h.update(n + '\n');
  h.update(swSource);
  return h.digest('hex').slice(0, 12);
}

/** Replaces the VERSION placeholder; throws when it is missing so a refactor cannot silently drop the stamp. */
export function stampSw(swSource, hash) {
  if (!swSource.includes(SW_PLACEHOLDER)) throw new Error('sw.js has no ' + SW_PLACEHOLDER + ' placeholder');
  return swSource.split(SW_PLACEHOLDER).join(hash);
}
