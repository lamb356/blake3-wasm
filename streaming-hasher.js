import wasmInit, { hash_single, left_subtree_len, parent_cv, root_hash } from './blake3-wasm-streaming/pkg/blake3_wasm_streaming.js';

const CHUNK_SIZE = 1024;
const WORKER_INIT_TIMEOUT = 10000;
const HASH_TASK_TIMEOUT = 30000;

function maxSubtreeLen(offset) {
  if (offset === 0) return Infinity;
  const chunkIndex = offset / 1024;
  const trailingZeros = Math.log2(chunkIndex & -chunkIndex);
  return (1 << trailingZeros) * 1024;
}

export class StreamingHasher {
  #numWorkers;
  #leafSize;
  #bufferDepth;
  #workers = [];
  #pendingTasks = new Map();
  #nextTaskId = 0;
  #initialized = false;
  #nextNodeId = 0;
  #nodeMap = new Map();

  constructor(options = {}) {
    if (typeof options === 'number') {
      options = { workerCount: options };
    }
    this.#numWorkers = options.workerCount ?? 3;
    this.#leafSize = options.leafSize ?? 1048576;
    this.#bufferDepth = options.bufferDepth ?? 2;
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

  #buildTree(offset, size) {
    const id = this.#nextNodeId++;
    const maxSub = maxSubtreeLen(offset);

    if (size <= this.#leafSize && size <= maxSub) {
      const node = { id, type: 'leaf', offset, size, parentId: null };
      this.#nodeMap.set(id, node);
      return node;
    }

    const leftLen = Number(left_subtree_len(BigInt(size)));
    const left = this.#buildTree(offset, leftLen);
    const right = this.#buildTree(offset + leftLen, size - leftLen);

    const node = { id, type: 'node', offset, size, leftId: left.id, rightId: right.id, parentId: null };
    left.parentId = id;
    right.parentId = id;
    this.#nodeMap.set(id, node);
    return node;
  }

  #collectLeaves(node) {
    if (node.type === 'leaf') return [node];
    const nodeData = this.#nodeMap.get(node.id) || node;
    if (nodeData.type === 'leaf') return [nodeData];
    const left = this.#nodeMap.get(nodeData.leftId);
    const right = this.#nodeMap.get(nodeData.rightId);
    return [...this.#collectLeaves(left), ...this.#collectLeaves(right)];
  }

  async hashFile(file) {
    if (!this.#initialized) throw new Error('StreamingHasher not initialized. Call init() first.');

    const t0 = performance.now();
    const buffer = await file.arrayBuffer();
    const len = buffer.byteLength;

    // Empty or single-chunk: hash on main thread
    if (len <= CHUNK_SIZE) {
      const data = new Uint8Array(buffer);
      const hash = hash_single(data);
      return { hash, timeMs: performance.now() - t0 };
    }

    // Build merge tree
    this.#nextNodeId = 0;
    this.#nodeMap = new Map();
    const root = this.#buildTree(0, len);

    // Single leaf: hash_single on main thread (root finalization)
    if (root.type === 'leaf') {
      const data = new Uint8Array(buffer);
      const hash = hash_single(data);
      return { hash, timeMs: performance.now() - t0 };
    }

    // Collect leaf nodes
    const leaves = this.#collectLeaves(root);

    // Dispatch each leaf to a worker
    const cvPromises = new Array(leaves.length);
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const workerIdx = i % this.#numWorkers;
      const slice = buffer.slice(leaf.offset, leaf.offset + leaf.size);
      cvPromises[i] = this.#dispatchBuffer(workerIdx, slice, leaf.offset);
    }

    const cvResults = await Promise.all(cvPromises);

    // Build a leaf id -> cv map for mergeTree
    const cvMap = new Map();
    for (let i = 0; i < leaves.length; i++) {
      cvMap.set(leaves[i].id, cvResults[i]);
    }

    // Merge CVs according to tree structure
    const finalHash = this.#mergeTree(root.id, cvMap, true);
    return { hash: finalHash, timeMs: performance.now() - t0 };
  }

  async hashFileStreaming(file, onProgress) {
    if (!this.#initialized) throw new Error('StreamingHasher not initialized. Call init() first.');

    const t0 = performance.now();
    const totalBytes = file.size;

    // Empty or single-chunk: hash on main thread
    if (totalBytes <= CHUNK_SIZE) {
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      const hash = hash_single(data);
      if (onProgress) onProgress({ bytesRead: totalBytes, totalBytes, bytesHashed: totalBytes });
      return { hash, timeMs: performance.now() - t0 };
    }

    // Phase 1: Tree planning
    this.#nextNodeId = 0;
    this.#nodeMap = new Map();
    const root = this.#buildTree(0, totalBytes);

    // Single leaf: hash_single on main thread
    if (root.type === 'leaf') {
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      const hash = hash_single(data);
      if (onProgress) onProgress({ bytesRead: totalBytes, totalBytes, bytesHashed: totalBytes });
      return { hash, timeMs: performance.now() - t0 };
    }

    // Collect leaves in left-to-right order
    const leaves = this.#collectLeaves(root);

    // Phase 2: Streaming + dispatch with backpressure
    const cvMap = new Map();
    const workerInFlight = new Array(this.#numWorkers).fill(0);
    let slotResolve = null;
    let bytesRead = 0;
    let bytesHashed = 0;

    // Root promise for DAG bubble-up completion
    let resolveRoot, rejectRoot;
    const rootPromise = new Promise((r, rej) => { resolveRoot = r; rejectRoot = rej; });

    // Phase 3: DAG bubble-up merge
    const bubbleUp = (nodeId) => {
      const node = this.#nodeMap.get(nodeId);
      if (node.parentId === null) {
        // This is the root - we're done
        resolveRoot(cvMap.get(nodeId));
        return;
      }

      const parent = this.#nodeMap.get(node.parentId);
      const leftCv = cvMap.get(parent.leftId);
      const rightCv = cvMap.get(parent.rightId);

      if (leftCv && rightCv) {
        // Both children ready - merge
        const isRoot = parent.parentId === null;
        const mergedCv = isRoot ? root_hash(leftCv, rightCv) : parent_cv(leftCv, rightCv);
        cvMap.set(parent.id, mergedCv);
        bubbleUp(parent.id);
      }
    };

    // Stream the file, filling leaf buffers and dispatching
    let currentLeafIdx = 0;
    let leafBuffer = new Uint8Array(leaves[0].size);
    let leafFilled = 0;

    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let chunkOffset = 0;
        const chunk = value;

        while (chunkOffset < chunk.length && currentLeafIdx < leaves.length) {
          const leaf = leaves[currentLeafIdx];
          const remaining = leaf.size - leafFilled;
          const toCopy = Math.min(remaining, chunk.length - chunkOffset);

          leafBuffer.set(chunk.subarray(chunkOffset, chunkOffset + toCopy), leafFilled);
          leafFilled += toCopy;
          chunkOffset += toCopy;

          if (leafFilled === leaf.size) {
            // Wait for backpressure before dispatching
            while (Math.min(...workerInFlight) >= this.#bufferDepth) {
              await new Promise(r => { slotResolve = r; });
            }

            // Pick worker with fewest in-flight tasks
            let workerIdx = 0;
            for (let w = 1; w < this.#numWorkers; w++) {
              if (workerInFlight[w] < workerInFlight[workerIdx]) workerIdx = w;
            }

            workerInFlight[workerIdx]++;
            const leafId = leaf.id;
            const leafSize = leaf.size;
            const bufferToSend = leafBuffer.buffer;

            this.#dispatchBuffer(workerIdx, bufferToSend, leaf.offset).then(cv => {
              workerInFlight[workerIdx]--;
              if (slotResolve) { slotResolve(); slotResolve = null; }
              bytesHashed += leafSize;
              if (onProgress) onProgress({ bytesRead, totalBytes, bytesHashed });
              cvMap.set(leafId, cv);
              bubbleUp(leafId);
            }).catch(err => {
              rejectRoot(err);
            });

            currentLeafIdx++;
            if (currentLeafIdx < leaves.length) {
              leafBuffer = new Uint8Array(leaves[currentLeafIdx].size);
              leafFilled = 0;
            }
          }
        }

        bytesRead += chunk.length;
        if (onProgress) onProgress({ bytesRead, totalBytes, bytesHashed });
      }
    } finally {
      reader.releaseLock();
    }

    // Wait for DAG to fully resolve
    const finalHash = await rootPromise;
    return { hash: finalHash, timeMs: performance.now() - t0 };
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
        { type: 'hash', data: buffer, offset: inputOffset, size: buffer.byteLength, taskId },
        [buffer]
      );
    });
  }

  #mergeTree(nodeId, cvMap, isRoot) {
    const node = this.#nodeMap.get(nodeId);
    if (node.type === 'leaf') {
      return cvMap.get(nodeId);
    }

    const leftCV = this.#mergeTree(node.leftId, cvMap, false);
    const rightCV = this.#mergeTree(node.rightId, cvMap, false);
    return isRoot ? root_hash(leftCV, rightCV) : parent_cv(leftCV, rightCV);
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
