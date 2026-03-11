// v2-worker.js — Atomics-based BLAKE3 worker with blocking wait loop
// Uses hash_subtree_ptr_into for zero-allocation hashing

const SLOTS_PER_WORKER = 8;

// Task flag values
const IDLE = 0;
const TASK = 1;
const COMPLETE = 2;
const SHUTDOWN = -1;

let controlView;
let myOffset;
let pkg;

async function init(data) {
  const { module, memory, controlSAB, workerIndex } = data;

  // Dynamic import of the WASM bindings
  pkg = await import('./blake3-wasm-shared/pkg/blake3_wasm_shared.js');
  await pkg.default({ module_or_path: module, memory });

  controlView = new Int32Array(controlSAB);
  myOffset = workerIndex * SLOTS_PER_WORKER;

  postMessage({ type: 'ready', workerIndex });

  // Enter blocking wait loop
  mainLoop();
}

function mainLoop() {
  while (true) {
    // Wait until task_flag becomes TASK or SHUTDOWN.
    // Must handle COMPLETE state: after setting COMPLETE the worker loops back,
    // but the main thread may not have reset to IDLE yet.
    while (true) {
      const flag = Atomics.load(controlView, myOffset + 0);
      if (flag === TASK || flag === SHUTDOWN) break;
      Atomics.wait(controlView, myOffset + 0, flag);
    }

    const flag = Atomics.load(controlView, myOffset + 0);
    if (flag === SHUTDOWN) break;

    const dataPtr    = Atomics.load(controlView, myOffset + 1);
    const offsetLo   = Atomics.load(controlView, myOffset + 2);
    const offsetHi   = Atomics.load(controlView, myOffset + 3);
    const cvPtr      = Atomics.load(controlView, myOffset + 4);
    const inputOffset = BigInt(offsetLo >>> 0) | (BigInt(offsetHi >>> 0) << 32n);

    pkg.hash_subtree_ptr_into(dataPtr, 65536, inputOffset, cvPtr);

    Atomics.store(controlView, myOffset + 0, COMPLETE);
    Atomics.notify(controlView, myOffset + 0);
  }
}

self.onmessage = (e) => {
  if (e.data.type === 'init') {
    init(e.data);
  }
};
