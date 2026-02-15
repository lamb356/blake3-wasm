import wasmInit, { hash_single, left_subtree_len, parent_cv, root_hash } from './blake3-wasm-streaming/pkg/blake3_wasm_streaming.js';

const CHUNK_SIZE = 1024;
const WORKER_INIT_TIMEOUT = 10000;
const HASH_TASK_TIMEOUT = 30000;

export class StreamingHasher {
  #numWorkers;
  #workers = [];
  #pendingTasks = new Map();
  #nextTaskId = 0;
  #initialized = false;

  constructor(numWorkers = navigator.hardwareConcurrency || 4) {
    this.#numWorkers = numWorkers;
  }

  async init() {
    // Init main-thread WASM for hash_single, parent_cv, root_hash, left_subtree_len
    await wasmInit();

    // Spawn workers and wait for all to be ready
    const readyPromises = [];
    for (let i = 0; i < this.#numWorkers; i++) {
      const worker = new Worker('./streaming-worker.js', { type: 'module' });

      const readyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Worker ${i} init timed out after ${WORKER_INIT_TIMEOUT}ms`));
        }, WORKER_INIT_TIMEOUT);

        worker.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(timeout);
            // Replace onmessage with task handler
            worker.onmessage = (evt) => this.#handleWorkerMessage(i, evt);
            resolve();
          } else if (e.data.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(e.data.error));
          }
        };

        worker.onerror = (err) => {
          clearTimeout(timeout);
          reject(err);
        };
      });

      worker.postMessage({ type: 'init' });
      this.#workers.push(worker);
      readyPromises.push(readyPromise);
    }

    await Promise.all(readyPromises);

    // Set up error handlers that reject all pending tasks for that worker
    for (let i = 0; i < this.#numWorkers; i++) {
      this.#workers[i].onerror = (err) => {
        for (const [taskId, { workerIndex, reject }] of this.#pendingTasks) {
          if (workerIndex === i) {
            reject(new Error(`Worker ${i} error: ${err.message}`));
            this.#pendingTasks.delete(taskId);
          }
        }
      };
    }

    this.#initialized = true;
  }

  #handleWorkerMessage(workerIndex, e) {
    const { type, taskId, cv, error } = e.data;
    const pending = this.#pendingTasks.get(taskId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.#pendingTasks.delete(taskId);

    if (type === 'result') {
      pending.resolve(cv);
    } else if (type === 'error') {
      pending.reject(new Error(error));
    }
  }

  async hashFile(file) {
    if (!this.#initialized) throw new Error('StreamingHasher not initialized. Call init() first.');

    const t0 = performance.now();
    const buffer = await file.arrayBuffer();
    const len = buffer.byteLength;

    // Empty or single-chunk: hash on main thread
    if (len <= CHUNK_SIZE) {
      console.log(`[StreamingHasher] len=${len} <= ${CHUNK_SIZE}, using hash_single on main thread`);
      const data = new Uint8Array(buffer);
      const hash = hash_single(data);
      return { hash, timeMs: performance.now() - t0 };
    }

    // Build merge tree
    const tree = this.#buildTree(0, len, this.#numWorkers);

    // If tree is a single leaf (1 worker, entire file), hash_subtree returns
    // a non-root CV — root finalization would never be applied. Fall back to
    // hash_single which correctly produces the final BLAKE3 hash.
    if (tree.type === 'leaf') {
      console.log(`[StreamingHasher] single leaf (len=${len}, workers=${this.#numWorkers}), using hash_single on main thread`);
      const data = new Uint8Array(buffer);
      const hash = hash_single(data);
      return { hash, timeMs: performance.now() - t0 };
    }

    // Collect leaf nodes
    const leaves = [];
    this.#collectLeaves(tree, leaves);
    console.log(`[StreamingHasher] len=${len}, workers=${this.#numWorkers}, leaves=${leaves.length}, tree splits:`);
    for (const leaf of leaves) {
      console.log(`  leaf[${leaf.index}]: offset=${leaf.offset}, len=${leaf.len}`);
    }

    // Dispatch each leaf to a worker
    const cvPromises = new Array(leaves.length);
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const workerIdx = i % this.#numWorkers;
      cvPromises[i] = this.#dispatchToWorker(workerIdx, buffer, leaf.offset, leaf.len);
    }

    const cvResults = await Promise.all(cvPromises);

    // Merge CVs according to tree structure
    const finalHash = this.#mergeTree(tree, cvResults, true);
    console.log(`[StreamingHasher] done in ${(performance.now() - t0).toFixed(1)}ms`);
    return { hash: finalHash, timeMs: performance.now() - t0 };
  }

  async hashFileStreaming(file, onProgress) {
    if (!this.#initialized) throw new Error('StreamingHasher not initialized. Call init() first.');

    const t0 = performance.now();
    const totalBytes = file.size;

    // Empty or single-chunk: hash on main thread (no streaming benefit)
    if (totalBytes <= CHUNK_SIZE) {
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      const hash = hash_single(data);
      if (onProgress) onProgress({ bytesRead: totalBytes, totalBytes, bytesHashed: totalBytes });
      return { hash, timeMs: performance.now() - t0 };
    }

    // Build merge tree
    const tree = this.#buildTree(0, totalBytes, this.#numWorkers);

    // Single leaf: hash_single on main thread (same root-finalization fix as hashFile)
    if (tree.type === 'leaf') {
      console.log(`[StreamingHasher] streaming: single leaf (len=${totalBytes}, workers=${this.#numWorkers}), using hash_single`);
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      const hash = hash_single(data);
      if (onProgress) onProgress({ bytesRead: totalBytes, totalBytes, bytesHashed: totalBytes });
      return { hash, timeMs: performance.now() - t0 };
    }

    // Collect leaf nodes (defines byte ranges)
    const leaves = [];
    this.#collectLeaves(tree, leaves);
    console.log(`[StreamingHasher] streaming: len=${totalBytes}, workers=${this.#numWorkers}, leaves=${leaves.length}`);

    // Allocate a buffer per leaf and prepare state
    const leafBuffers = leaves.map(l => new ArrayBuffer(l.len));
    const leafFilled = new Array(leaves.length).fill(0);
    let currentLeafIdx = 0;
    let bytesRead = 0;
    let bytesHashed = 0;

    const cvPromises = new Array(leaves.length);

    // Stream loop
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let chunkOffset = 0;
        const chunk = value; // Uint8Array

        while (chunkOffset < chunk.length && currentLeafIdx < leaves.length) {
          const leaf = leaves[currentLeafIdx];
          const remaining = leaf.len - leafFilled[currentLeafIdx];
          const toCopy = Math.min(remaining, chunk.length - chunkOffset);

          // Copy into the leaf buffer
          const dest = new Uint8Array(leafBuffers[currentLeafIdx]);
          dest.set(chunk.subarray(chunkOffset, chunkOffset + toCopy), leafFilled[currentLeafIdx]);
          leafFilled[currentLeafIdx] += toCopy;
          chunkOffset += toCopy;

          // If leaf buffer is full, dispatch to worker
          if (leafFilled[currentLeafIdx] === leaf.len) {
            const workerIdx = currentLeafIdx % this.#numWorkers;
            const leafIdx = currentLeafIdx;
            const leafLen = leaf.len;
            cvPromises[leafIdx] = this.#dispatchBuffer(workerIdx, leafBuffers[leafIdx], leaf.offset)
              .then(cv => {
                bytesHashed += leafLen;
                if (onProgress) onProgress({ bytesRead, totalBytes, bytesHashed });
                return cv;
              });
            currentLeafIdx++;
          }
        }

        bytesRead += chunk.length;
        if (onProgress) onProgress({ bytesRead, totalBytes, bytesHashed });
      }
    } finally {
      reader.releaseLock();
    }

    // Wait for all workers to finish
    const cvResults = await Promise.all(cvPromises);

    // Merge CVs according to tree structure
    const finalHash = this.#mergeTree(tree, cvResults, true);
    console.log(`[StreamingHasher] streaming done in ${(performance.now() - t0).toFixed(1)}ms`);
    return { hash: finalHash, timeMs: performance.now() - t0 };
  }

  #buildTree(offset, len, maxLeaves) {
    if (maxLeaves <= 1 || len <= CHUNK_SIZE) {
      return { type: 'leaf', offset, len, index: -1 };
    }

    const leftLen = Number(left_subtree_len(BigInt(len)));
    const rightLen = len - leftLen;
    const leftWorkers = Math.max(1, Math.min(maxLeaves - 1, Math.round(maxLeaves * leftLen / len)));
    const rightWorkers = maxLeaves - leftWorkers;

    console.log(`[buildTree] split offset=${offset} len=${len}: left=${leftLen}(${leftWorkers}w) right=${rightLen}(${rightWorkers}w)`);

    return {
      type: 'node',
      left: this.#buildTree(offset, leftLen, leftWorkers),
      right: this.#buildTree(offset + leftLen, rightLen, rightWorkers),
    };
  }

  #collectLeaves(node, leaves) {
    if (node.type === 'leaf') {
      node.index = leaves.length;
      leaves.push(node);
    } else {
      this.#collectLeaves(node.left, leaves);
      this.#collectLeaves(node.right, leaves);
    }
  }

  #dispatchBuffer(workerIdx, buffer, inputOffset) {
    const taskId = this.#nextTaskId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingTasks.delete(taskId);
        reject(new Error(`Hash task ${taskId} timed out after ${HASH_TASK_TIMEOUT}ms`));
      }, HASH_TASK_TIMEOUT);

      this.#pendingTasks.set(taskId, { workerIndex: workerIdx, resolve, reject, timeout });
      this.#workers[workerIdx].postMessage(
        { type: 'hash', data: buffer, inputOffset, taskId },
        [buffer]
      );
    });
  }

  #dispatchToWorker(workerIdx, buffer, offset, len) {
    const slice = buffer.slice(offset, offset + len);
    return this.#dispatchBuffer(workerIdx, slice, offset);
  }

  #mergeTree(node, cvs, isRoot) {
    if (node.type === 'leaf') {
      return cvs[node.index];
    }

    const leftCV = this.#mergeTree(node.left, cvs, false);
    const rightCV = this.#mergeTree(node.right, cvs, false);
    const fn = isRoot ? 'root_hash' : 'parent_cv';
    const result = isRoot ? root_hash(leftCV, rightCV) : parent_cv(leftCV, rightCV);
    console.log(`[mergeTree] ${fn}(left, right) isRoot=${isRoot}`);
    return result;
  }

  terminate() {
    for (const worker of this.#workers) {
      worker.terminate();
    }
    this.#workers = [];
    // Reject any remaining pending tasks
    for (const [, { reject, timeout }] of this.#pendingTasks) {
      clearTimeout(timeout);
      reject(new Error('StreamingHasher terminated'));
    }
    this.#pendingTasks.clear();
    this.#initialized = false;
  }
}
