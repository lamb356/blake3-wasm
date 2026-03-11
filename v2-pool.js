// v2-pool.js — WorkerPool with Atomics-based dispatch and shared WASM memory

const SLOTS_PER_WORKER = 8;
const IDLE = 0;
const TASK = 1;
const COMPLETE = 2;
const SHUTDOWN = -1;

export class WorkerPool {
  /**
   * @param {Object} opts
   * @param {number} opts.workerCount
   * @param {WebAssembly.Module} opts.wasmModule
   * @param {WebAssembly.Memory} opts.wasmMemory
   * @param {Object} opts.pkg - initialized WASM bindings (for alloc/free on main thread)
   */
  constructor({ workerCount, wasmModule, wasmMemory, pkg }) {
    this.workerCount = workerCount;
    this.wasmModule = wasmModule;
    this.wasmMemory = wasmMemory;
    this.pkg = pkg;
    this.workers = [];
    this.controlSAB = null;
    this.controlView = null;
    this.cvBasePtr = 0;
    this.loadCounters = new Uint32Array(workerCount);
    this._initialized = false;
  }

  async init() {
    // Allocate control SAB (separate from WASM memory)
    this.controlSAB = new SharedArrayBuffer(this.workerCount * SLOTS_PER_WORKER * 4);
    this.controlView = new Int32Array(this.controlSAB);

    // Pre-allocate CV output slots in WASM heap (32 bytes per worker)
    this.cvBasePtr = this.pkg.alloc_input(this.workerCount * 32);

    // Spawn workers and wait for all to be ready
    const readyPromises = [];

    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(new URL('./v2-worker.js', import.meta.url), { type: 'module' });

      const readyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Worker ${i} init timeout`)), 10000);
        worker.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(timeout);
            resolve();
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timeout);
          reject(new Error(`Worker ${i} error: ${e.message}`));
        };
      });

      worker.postMessage({
        type: 'init',
        module: this.wasmModule,
        memory: this.wasmMemory,
        controlSAB: this.controlSAB,
        workerIndex: i,
      });

      this.workers.push(worker);
      readyPromises.push(readyPromise);
    }

    await Promise.all(readyPromises);
    this._initialized = true;
  }

  /**
   * Dispatch a hash task to a specific worker.
   * Workers always hash exactly 64 KiB — hard contract.
   * @param {number} workerIndex
   * @param {number} dataPtr - pointer into WASM shared memory (must point to 64 KiB)
   * @param {bigint|number} inputOffset - BLAKE3 input offset
   */
  dispatchToWorker(workerIndex, dataPtr, inputOffset) {
    const offset = workerIndex * SLOTS_PER_WORKER;
    const cvPtr = this.cvBasePtr + workerIndex * 32;
    const bigOffset = BigInt(inputOffset);

    // Write task parameters
    Atomics.store(this.controlView, offset + 1, dataPtr);
    Atomics.store(this.controlView, offset + 2, Number(bigOffset & 0xFFFFFFFFn));
    Atomics.store(this.controlView, offset + 3, Number((bigOffset >> 32n) & 0xFFFFFFFFn));
    Atomics.store(this.controlView, offset + 4, cvPtr);

    // Set task flag (must be last write) and notify
    Atomics.store(this.controlView, offset + 0, TASK);
    Atomics.notify(this.controlView, offset + 0);

    this.loadCounters[workerIndex]++;
  }

  /**
   * Wait for a worker to complete and return its CV.
   * @param {number} workerIndex
   * @returns {Promise<Uint8Array>} 32-byte chaining value
   */
  async waitForWorker(workerIndex) {
    const offset = workerIndex * SLOTS_PER_WORKER;

    // Use waitAsync on main thread (non-blocking)
    const result = Atomics.waitAsync(this.controlView, offset + 0, TASK);
    if (result.async) {
      await result.value;
    }
    // If not async, the value already changed (worker was fast)

    // Read the CV from WASM heap
    const cvPtr = this.cvBasePtr + workerIndex * 32;
    const wasmHeap = new Uint8Array(this.wasmMemory.buffer);
    const cv = new Uint8Array(32);
    cv.set(wasmHeap.slice(cvPtr, cvPtr + 32));

    // Reset task flag to idle
    Atomics.store(this.controlView, offset + 0, IDLE);

    this.loadCounters[workerIndex]--;

    return cv;
  }

  /**
   * Get the worker index with the fewest in-flight tasks.
   * @returns {number}
   */
  getLeastLoadedWorker() {
    let minLoad = Infinity;
    let minIdx = 0;
    for (let i = 0; i < this.workerCount; i++) {
      if (this.loadCounters[i] < minLoad) {
        minLoad = this.loadCounters[i];
        minIdx = i;
      }
    }
    return minIdx;
  }

  /**
   * Terminate all workers and free CV slots.
   */
  destroy() {
    // Signal shutdown to all workers
    for (let i = 0; i < this.workerCount; i++) {
      const offset = i * SLOTS_PER_WORKER;
      Atomics.store(this.controlView, offset + 0, SHUTDOWN);
      Atomics.notify(this.controlView, offset + 0);
    }

    // Terminate workers
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];

    // Free CV slots
    if (this.cvBasePtr) {
      this.pkg.free_input(this.cvBasePtr, this.workerCount * 32);
      this.cvBasePtr = 0;
    }

    this._initialized = false;
  }
}
