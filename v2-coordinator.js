// v2-coordinator.js — Ring buffer coordinator with streaming dispatch
// Reads from ReadableStream, buffers into 64 KiB parcels in WASM heap,
// dispatches to WorkerPool, collects CVs in file-offset order.

const PARCEL_SIZE = 65536; // 64 KiB — hard contract

export class V2Coordinator {
  /**
   * @param {Object} opts
   * @param {import('./v2-pool.js').WorkerPool} opts.pool
   * @param {Object} opts.pkg - initialized WASM bindings
   * @param {WebAssembly.Memory} opts.wasmMemory
   */
  constructor({ pool, pkg, wasmMemory }) {
    this.pool = pool;
    this.pkg = pkg;
    this.wasmMemory = wasmMemory;
    this.ringBasePtr = 0;
  }

  /**
   * Hash a ReadableStream, returning CVs in file-offset order.
   * @param {ReadableStream<Uint8Array>} stream
   * @returns {Promise<{cvs: Array<{cv: Uint8Array, offset: number, size: number}>, tailCV: Uint8Array|null, tailOffset: number, tailSize: number, totalSize: number}>}
   */
  async hashStream(stream) {
    const workerCount = this.pool.workerCount;

    // Allocate ring buffer: one 64 KiB slot per worker
    this.ringBasePtr = this.pkg.alloc_input(workerCount * PARCEL_SIZE);

    const slotFree = new Array(workerCount).fill(true);
    const pending = []; // { slotIndex, offset }
    const collectedCVs = [];

    let fileOffset = 0;
    let currentSlot = -1;
    let slotBytesWritten = 0;

    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;

        let chunkPos = 0;
        let heap = new Uint8Array(this.wasmMemory.buffer);
        while (chunkPos < chunk.length) {
          // Acquire a slot if we don't have one
          if (currentSlot === -1) {
            currentSlot = await this._acquireFreeSlot(slotFree, pending, collectedCVs);
            slotBytesWritten = 0;
          }

          // How much can we write into this slot?
          const remainSlot = PARCEL_SIZE - slotBytesWritten;
          const remainChunk = chunk.length - chunkPos;
          const toCopy = Math.min(remainSlot, remainChunk);

          const destOffset = this.ringBasePtr + currentSlot * PARCEL_SIZE + slotBytesWritten;
          heap.set(chunk.subarray(chunkPos, chunkPos + toCopy), destOffset);

          chunkPos += toCopy;
          slotBytesWritten += toCopy;

          // If slot is full, dispatch it
          if (slotBytesWritten === PARCEL_SIZE) {
            this._dispatchSlot(currentSlot, fileOffset, slotFree, pending);
            fileOffset += PARCEL_SIZE;
            currentSlot = -1;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Drain all pending workers
    while (pending.length > 0) {
      const { slotIndex, offset } = pending.shift();
      const cv = await this.pool.waitForWorker(slotIndex);
      slotFree[slotIndex] = true;
      collectedCVs.push({ cv, offset, size: PARCEL_SIZE });
    }

    // Handle tail (partial last slot)
    let tailCV = null;
    let tailOffset = fileOffset;
    let tailSize = 0;

    if (currentSlot !== -1 && slotBytesWritten > 0) {
      tailSize = slotBytesWritten;
      const slotPtr = this.ringBasePtr + currentSlot * PARCEL_SIZE;
      tailCV = this.pkg.hash_subtree_ptr(slotPtr, slotBytesWritten, BigInt(fileOffset));
      fileOffset += slotBytesWritten;
    }

    // Sort CVs by offset
    collectedCVs.sort((a, b) => a.offset - b.offset);

    return {
      cvs: collectedCVs,
      tailCV,
      tailOffset,
      tailSize,
      totalSize: fileOffset,
    };
  }

  /**
   * Hash a File object.
   * @param {File} file
   * @returns {Promise<Object>} same as hashStream
   */
  async hashFile(file) {
    return this.hashStream(file.stream());
  }

  /**
   * Free the ring buffer allocation.
   */
  freeRingBuffer() {
    if (this.ringBasePtr) {
      this.pkg.free_input(this.ringBasePtr, this.pool.workerCount * PARCEL_SIZE);
      this.ringBasePtr = 0;
    }
  }

  /**
   * Acquire a free slot. If none available, drain the oldest pending worker.
   * @private
   */
  async _acquireFreeSlot(slotFree, pending, collectedCVs) {
    // Scan for any free slot
    for (let i = 0; i < slotFree.length; i++) {
      if (slotFree[i]) {
        slotFree[i] = false;
        return i;
      }
    }

    // No free slots — drain the oldest pending
    const { slotIndex, offset } = pending.shift();
    const cv = await this.pool.waitForWorker(slotIndex);
    collectedCVs.push({ cv, offset, size: PARCEL_SIZE });
    slotFree[slotIndex] = false;
    return slotIndex;
  }

  /**
   * Dispatch a full slot to a worker.
   * @private
   */
  _dispatchSlot(slotIndex, parcelFileOffset, slotFree, pending) {
    const dataPtr = this.ringBasePtr + slotIndex * PARCEL_SIZE;
    this.pool.dispatchToWorker(slotIndex, dataPtr, BigInt(parcelFileOffset));
    pending.push({ slotIndex, offset: parcelFileOffset });
    slotFree[slotIndex] = false;
  }
}
