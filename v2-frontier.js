// v2-frontier.js — Merkle frontier (48-entry CV stack)
// Takes subtree CVs from the coordinator and merges them into the final
// BLAKE3 hash using an eager binary merge (equal-sized subtrees merge immediately).

export class V2Frontier {
  /**
   * @param {Object} opts
   * @param {(left: Uint8Array, right: Uint8Array) => Uint8Array} opts.parentCvFn  — PARENT flag merge
   * @param {(left: Uint8Array, right: Uint8Array) => Uint8Array} opts.rootHashFn  — PARENT|ROOT finalize
   * @param {(ptr: number, size: number) => Uint8Array} opts.hashPtrFn             — full hash (single-entry fallback)
   */
  constructor({ parentCvFn, rootHashFn, hashPtrFn }) {
    this.parentCvFn = parentCvFn;
    this.rootHashFn = rootHashFn;
    this.hashPtrFn = hashPtrFn;
    this.stack = []; // { cv: Uint8Array, subtreeSize: number }
  }

  /**
   * Push a subtree CV and eagerly merge with equal-sized entries on top of stack.
   * @param {Uint8Array} cv — 32-byte chaining value (non-root)
   * @param {number} subtreeSize — number of 1 KiB chunks this CV covers
   */
  pushSubtreeCV(cv, subtreeSize) {
    while (this.stack.length > 0 && this.stack[this.stack.length - 1].subtreeSize === subtreeSize) {
      const left = this.stack.pop();
      cv = this.parentCvFn(left.cv, cv);
      subtreeSize *= 2;
    }
    this.stack.push({ cv, subtreeSize });
  }

  /**
   * Finalize the frontier into a root hash.
   * @param {{ ptr: number, size: number }} [singleEntryData] — original data pointer for single-entry case
   * @returns {Uint8Array|null} — 32-byte root hash, or null if empty
   */
  finalize(singleEntryData) {
    if (this.stack.length === 0) return null;

    if (this.stack.length === 1) {
      if (singleEntryData) {
        return this.hashPtrFn(singleEntryData.ptr, singleEntryData.size);
      }
      return this.stack[0].cv; // non-root CV; caller must handle
    }

    // 2+ entries: merge right-to-left, final merge uses rootHashFn
    let right = this.stack.pop().cv;
    while (this.stack.length > 1) {
      const left = this.stack.pop();
      right = this.parentCvFn(left.cv, right);
    }
    return this.rootHashFn(this.stack.pop().cv, right);
  }

  /**
   * Reset the frontier for reuse.
   */
  reset() {
    this.stack.length = 0;
  }
}
