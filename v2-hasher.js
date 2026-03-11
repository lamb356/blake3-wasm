// v2-hasher.js — Fast single-message API tying pool + coordinator + frontier
// Data in → BLAKE3 hash out.

import { WorkerPool } from './v2-pool.js';
import { V2Coordinator } from './v2-coordinator.js';
import { V2Frontier } from './v2-frontier.js';

const PARCEL_SIZE = 65536; // 64 KiB
const CHUNK_SIZE = 1024;   // 1 KiB

export class V2Hasher {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.workerCount]
   */
  constructor({ workerCount = navigator.hardwareConcurrency || 4 } = {}) {
    this.workerCount = workerCount;
    this.pkg = null;
    this.wasmMemory = null;
    this.wasmModule = null;
    this.pool = null;
    this._initialized = false;
  }

  /** Load WASM, create worker pool, ready to hash. */
  async init() {
    const pkg = await import('./blake3-wasm-shared/pkg/blake3_wasm_shared.js');
    const wasmUrl = new URL('./blake3-wasm-shared/pkg/blake3_wasm_shared_bg.wasm', import.meta.url);
    const wasmModule = await WebAssembly.compileStreaming(fetch(wasmUrl));
    const wasmInstance = await pkg.default(wasmModule);
    const wasmMemory = wasmInstance.memory;

    const pool = new WorkerPool({ workerCount: this.workerCount, wasmModule, wasmMemory, pkg });
    await pool.init();

    this.pkg = pkg;
    this.wasmMemory = wasmMemory;
    this.wasmModule = wasmModule;
    this.pool = pool;
    this._initialized = true;
  }

  /**
   * Hash a Uint8Array or ArrayBuffer.
   * @param {Uint8Array|ArrayBuffer} data
   * @returns {Promise<Uint8Array>} 32-byte hash
   */
  async hashBuffer(data) {
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    if (data.byteLength === 0) return this.pkg.hash_single(new Uint8Array(0));
    if (data.byteLength <= PARCEL_SIZE) {
      // Small enough for main-thread single hash
      return this.pkg.hash_single(data);
    }
    // Large: stream through workers, keep original data for single-entry fallback
    const stream = new ReadableStream({
      start(controller) {
        let pos = 0;
        while (pos < data.length) {
          const end = Math.min(pos + 16384, data.length);
          controller.enqueue(data.subarray(pos, end));
          pos = end;
        }
        controller.close();
      }
    });
    return this._hashWithWorkers(stream, data);
  }

  /**
   * Hash a File object.
   * @param {File} file
   * @param {function} [onProgress] - called with bytes processed
   * @returns {Promise<Uint8Array>} 32-byte hash
   */
  async hashFile(file, onProgress) {
    if (file.size === 0) return this.pkg.hash_single(new Uint8Array(0));
    if (file.size <= PARCEL_SIZE) {
      const buf = new Uint8Array(await file.arrayBuffer());
      return this.pkg.hash_single(buf);
    }
    return this._hashWithWorkers(file.stream(), null, onProgress);
  }

  /**
   * Hash a ReadableStream.
   * @param {ReadableStream} stream
   * @param {function} [onProgress]
   * @returns {Promise<Uint8Array>} 32-byte hash
   */
  async hashStream(stream, onProgress) {
    return this._hashWithWorkers(stream, null, onProgress);
  }

  /**
   * Core: coordinator + frontier with tracked parentCvFn for power-of-2 root finalization.
   * @private
   */
  async _hashWithWorkers(stream, originalData, onProgress) {
    const { pkg, wasmMemory, pool } = this;
    const coord = new V2Coordinator({ pool, pkg, wasmMemory });
    const coordResult = await coord.hashStream(stream);

    if (coordResult.totalSize === 0) {
      coord.freeRingBuffer();
      return pkg.hash_single(new Uint8Array(0));
    }

    // Build entry list
    const entries = [];
    for (const e of coordResult.cvs) {
      entries.push({ cv: e.cv, subtreeChunks: e.size / CHUNK_SIZE });
    }
    if (coordResult.tailCV) {
      entries.push({ cv: coordResult.tailCV, subtreeChunks: Math.ceil(coordResult.tailSize / CHUNK_SIZE) });
    }

    let result;

    if (entries.length === 1) {
      // Single entry — need root finalization with original data
      if (originalData) {
        const ptr = pkg.alloc_input(originalData.length);
        new Uint8Array(wasmMemory.buffer).set(originalData, ptr);
        result = pkg.hash_ptr(ptr, originalData.length);
        pkg.free_input(ptr, originalData.length);
      } else {
        // Stream: data is in ring buffer if it fits one parcel
        const totalSize = coordResult.totalSize;
        result = pkg.hash_ptr(coord.ringBasePtr, totalSize);
      }
    } else {
      // Multiple entries: use frontier with tracked parentCvFn
      let lastLeft = null, lastRight = null;
      const parentCvTracked = (l, r) => {
        lastLeft = l;
        lastRight = r;
        return pkg.parent_cv(l, r);
      };

      const frontier = new V2Frontier({
        parentCvFn: parentCvTracked,
        rootHashFn: (l, r) => pkg.root_hash(l, r),
        hashPtrFn: (ptr, size) => pkg.hash_ptr(ptr, size),
      });

      for (const e of entries) {
        frontier.pushSubtreeCV(e.cv, e.subtreeChunks);
      }

      if (frontier.stack.length === 1 && lastLeft && lastRight) {
        // Power-of-2: all merged eagerly into 1 entry — redo final merge as root
        result = pkg.root_hash(lastLeft, lastRight);
      } else if (frontier.stack.length >= 2) {
        // Normal case: finalize merges right-to-left
        result = frontier.finalize();
      } else {
        // Single entry after pushing multiple? Shouldn't happen with entries.length > 1
        // but handle defensively
        result = frontier.stack[0].cv;
      }
    }

    coord.freeRingBuffer();
    return result;
  }

  /** Terminate workers, free memory. */
  destroy() {
    if (this.pool) {
      this.pool.destroy();
      this.pool = null;
    }
    this._initialized = false;
  }
}
