// v2-incremental.js — Multi-message incremental hasher
// Feed data via update() calls with eager dispatch to workers.
// Workers hash parcels immediately as data arrives.

import { V2Frontier } from './v2-frontier.js';

const PARCEL_SIZE = 65536; // 64 KiB
const CHUNK_SIZE = 1024;   // 1 KiB

export class V2IncrementalHasher {
  constructor({ pool, pkg, wasmMemory }) {
    this.pool = pool;
    this.pkg = pkg;
    this.wasmMemory = wasmMemory;
    this._queue = Promise.resolve();
    this.ringBasePtr = 0;
  }

  async init() {
    const workerCount = this.pool.workerCount;
    this.ringBasePtr = this.pkg.alloc_input(workerCount * PARCEL_SIZE);
    this._resetState();
  }

  _resetState() {
    const workerCount = this.pool.workerCount;
    this.slotFree = new Array(workerCount).fill(true);
    this.currentSlot = -1;
    this.slotBytesWritten = 0;
    this.fileOffset = 0;
    this.pending = [];
    this.collectedCVs = [];
    this._finalized = false;
    this._queue = Promise.resolve();
  }

  async update(data) {
    if (this._finalized) throw new Error('Cannot update after finalize()');
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    if (data.length === 0) return this;
    this._queue = this._queue.then(() => this._ingest(data));
    await this._queue;
    return this;
  }

  async _ingest(chunk) {
    let chunkPos = 0;
    let heap = new Uint8Array(this.wasmMemory.buffer);
    while (chunkPos < chunk.length) {
      if (this.currentSlot === -1) {
        this.currentSlot = await this._acquireFreeSlot();
        this.slotBytesWritten = 0;
      }

      const remainSlot = PARCEL_SIZE - this.slotBytesWritten;
      const remainChunk = chunk.length - chunkPos;
      const toCopy = Math.min(remainSlot, remainChunk);

      const destOffset = this.ringBasePtr + this.currentSlot * PARCEL_SIZE + this.slotBytesWritten;
      heap.set(chunk.subarray(chunkPos, chunkPos + toCopy), destOffset);

      chunkPos += toCopy;
      this.slotBytesWritten += toCopy;

      if (this.slotBytesWritten === PARCEL_SIZE) {
        const dataPtr = this.ringBasePtr + this.currentSlot * PARCEL_SIZE;
        this.pool.dispatchToWorker(this.currentSlot, dataPtr, BigInt(this.fileOffset));
        this.pending.push({ slotIndex: this.currentSlot, offset: this.fileOffset });
        this.slotFree[this.currentSlot] = false;
        this.fileOffset += PARCEL_SIZE;
        this.currentSlot = -1;
      }
    }
  }

  async _acquireFreeSlot() {
    for (let i = 0; i < this.slotFree.length; i++) {
      if (this.slotFree[i]) {
        this.slotFree[i] = false;
        return i;
      }
    }
    const { slotIndex, offset } = this.pending.shift();
    const cv = await this.pool.waitForWorker(slotIndex);
    this.collectedCVs.push({ cv, offset, size: PARCEL_SIZE });
    this.slotFree[slotIndex] = false;
    return slotIndex;
  }

  async finalize() {
    await this._queue;
    if (this._finalized) throw new Error('Already finalized');
    this._finalized = true;

    // Drain all pending workers
    while (this.pending.length > 0) {
      const { slotIndex, offset } = this.pending.shift();
      const cv = await this.pool.waitForWorker(slotIndex);
      this.slotFree[slotIndex] = true;
      this.collectedCVs.push({ cv, offset, size: PARCEL_SIZE });
    }

    // Empty input
    if (this.fileOffset === 0 && this.slotBytesWritten === 0) {
      return this.pkg.hash_single(new Uint8Array(0));
    }

    // Tail: partial slot
    let tailCV = null;
    let tailOffset = this.fileOffset;
    let tailSize = 0;
    if (this.currentSlot !== -1 && this.slotBytesWritten > 0) {
      tailSize = this.slotBytesWritten;
      const slotPtr = this.ringBasePtr + this.currentSlot * PARCEL_SIZE;
      tailCV = this.pkg.hash_subtree_ptr(slotPtr, tailSize, BigInt(this.fileOffset));
    }

    const totalSize = this.fileOffset + tailSize;

    // Sort CVs by offset
    this.collectedCVs.sort((a, b) => a.offset - b.offset);

    // Build entries
    const entries = [];
    for (const e of this.collectedCVs) {
      entries.push({ cv: e.cv, subtreeChunks: e.size / CHUNK_SIZE });
    }
    if (tailCV) {
      entries.push({ cv: tailCV, subtreeChunks: Math.ceil(tailSize / CHUNK_SIZE) });
    }

    // Single entry: root finalization with data still in ring buffer
    if (entries.length === 1) {
      const slotIdx = this.currentSlot !== -1 ? this.currentSlot : 0;
      const ptr = this.ringBasePtr + slotIdx * PARCEL_SIZE;
      return this.pkg.hash_ptr(ptr, totalSize);
    }

    // Multiple entries: frontier with tracked parentCvFn
    const { pkg } = this;
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
      return pkg.root_hash(lastLeft, lastRight);
    } else if (frontier.stack.length >= 2) {
      return frontier.finalize();
    }
    return frontier.stack[0].cv;
  }

  reset() {
    this._resetState();
  }

  destroy() {
    if (this.ringBasePtr) {
      this.pkg.free_input(this.ringBasePtr, this.pool.workerCount * PARCEL_SIZE);
      this.ringBasePtr = 0;
    }
    this.pool = null;
    this.pkg = null;
    this.wasmMemory = null;
  }
}
