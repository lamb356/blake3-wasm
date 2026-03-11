// v2-blake3.js — Convenient single-message API with lazy auto-init singleton.
// No setup needed: just call hash() or hashStream().

import { V2Hasher } from './v2-hasher.js';
import { V2IncrementalHasher } from './v2-incremental.js';

let hasher = null;
let initPromise = null;

async function ensureInit() {
  if (hasher) return hasher;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    hasher = new V2Hasher();
    await hasher.init();
    return hasher;
  })();
  return initPromise;
}

export async function hash(data) {
  const h = await ensureInit();
  if (data instanceof ArrayBuffer) data = new Uint8Array(data);
  return h.hashBuffer(data);
}

export async function hashStream(stream) {
  const h = await ensureInit();
  return h.hashStream(stream);
}

export async function createHasher() {
  const h = await ensureInit();
  const incremental = new V2IncrementalHasher({
    pool: h.pool, pkg: h.pkg, wasmMemory: h.wasmMemory
  });
  await incremental.init();
  return incremental;
}
