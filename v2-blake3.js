// v2-blake3.js — Convenient single-message API with lazy auto-init singleton.
// No setup needed: just call hash() or hashStream().

import { V2Hasher } from './v2-hasher.js';

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
