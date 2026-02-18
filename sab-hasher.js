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

export class SABHasher {
  #numWorkers;
  #chunkSize;
  #workers = [];
  #pendingTasks = new Map();
  #nextTaskId = 0;
  #initialized = false;
  #nextNodeId = 0;
  #nodeMap = new Map();

  constructor(options = {}) {
    this.#numWorkers = options.workerCount ?? 6;
    this.#chunkSize = options.chunkSize ?? 1048576;
  }

  async init() {
    await wasmInit();

    const readyPromises = [];
    for (let i = 0; i < this.#numWorkers; i++) {
      const worker = new Worker('./sab-worker.js', { type: 'module' });

      const readyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Worker ${i} init timed out after ${WORKER_INIT_TIMEOUT}ms`));
        }, WORKER_INIT_TIMEOUT);

        worker.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(timeout);
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

    if (size <= this.#chunkSize && size <= maxSub) {
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

  #mergeTree(nodeId, cvMap, isRoot) {
    const node = this.#nodeMap.get(nodeId);
    if (node.type === 'leaf') {
      return cvMap.get(nodeId);
    }

    const leftCV = this.#mergeTree(node.leftId, cvMap, false);
    const rightCV = this.#mergeTree(node.rightId, cvMap, false);
    return isRoot ? root_hash(leftCV, rightCV) : parent_cv(leftCV, rightCV);
  }

  #dispatchTask(workerIdx, offset, size) {
    const taskId = this.#nextTaskId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingTasks.delete(taskId);
        reject(new Error(`Hash task ${taskId} timed out after ${HASH_TASK_TIMEOUT}ms`));
      }, HASH_TASK_TIMEOUT);

      this.#pendingTasks.set(taskId, { workerIndex: workerIdx, resolve, reject, timeout });
      this.#workers[workerIdx].postMessage({ type: 'hash', offset, size, taskId });
    });
  }

  async hash(uint8Array) {
    if (!this.#initialized) throw new Error('SABHasher not initialized. Call init() first.');
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('SharedArrayBuffer is not available. Ensure the page is cross-origin isolated (COOP/COEP headers).');
    }

    const t0 = performance.now();

    // Small input shortcut: hash on main thread
    if (uint8Array.byteLength < 65536) {
      const hash = hash_single(uint8Array);
      return { hash, timeMs: performance.now() - t0, workerStats: [] };
    }

    // Create SAB and copy data once
    const sab = new SharedArrayBuffer(uint8Array.byteLength);
    new Uint8Array(sab).set(uint8Array);

    // Send SAB reference to all workers
    for (const w of this.#workers) {
      w.postMessage({ type: 'buffer', buffer: sab });
    }

    // Build tree
    this.#nextNodeId = 0;
    this.#nodeMap = new Map();
    const root = this.#buildTree(0, uint8Array.byteLength);

    // Single leaf: hash on main thread
    if (root.type === 'leaf') {
      const hash = hash_single(uint8Array);
      return { hash, timeMs: performance.now() - t0, workerStats: [] };
    }

    // Collect leaves
    const leaves = this.#collectLeaves(root);

    // Per-worker stats
    const workerStats = Array.from({ length: this.#numWorkers }, (_, i) => ({
      id: i, tasks: 0, bytes: 0, timeMs: 0
    }));

    // DAG bubble-up merge
    const cvMap = new Map();
    const workerInFlight = new Array(this.#numWorkers).fill(0);

    let resolveRoot, rejectRoot;
    const rootPromise = new Promise((r, rej) => { resolveRoot = r; rejectRoot = rej; });

    const bubbleUp = (nodeId) => {
      const node = this.#nodeMap.get(nodeId);
      if (node.parentId === null) {
        resolveRoot(cvMap.get(nodeId));
        return;
      }

      const parent = this.#nodeMap.get(node.parentId);
      const leftCv = cvMap.get(parent.leftId);
      const rightCv = cvMap.get(parent.rightId);

      if (leftCv && rightCv) {
        const isRoot = parent.parentId === null;
        const mergedCv = isRoot ? root_hash(leftCv, rightCv) : parent_cv(leftCv, rightCv);
        cvMap.set(parent.id, mergedCv);
        bubbleUp(parent.id);
      }
    };

    // Dispatch all leaves with least-loaded worker selection
    for (const leaf of leaves) {
      let workerIdx = 0;
      for (let w = 1; w < this.#numWorkers; w++) {
        if (workerInFlight[w] < workerInFlight[workerIdx]) workerIdx = w;
      }
      workerInFlight[workerIdx]++;
      const leafId = leaf.id;
      const leafSize = leaf.size;
      const dispatchTime = performance.now();

      this.#dispatchTask(workerIdx, leaf.offset, leaf.size).then(cv => {
        const elapsed = performance.now() - dispatchTime;
        workerStats[workerIdx].tasks++;
        workerStats[workerIdx].bytes += leafSize;
        workerStats[workerIdx].timeMs += elapsed;
        workerInFlight[workerIdx]--;
        cvMap.set(leafId, cv);
        bubbleUp(leafId);
      }).catch(err => rejectRoot(err));
    }

    const finalHash = await rootPromise;
    for (const ws of workerStats) {
      ws.speedMBs = ws.timeMs > 0 ? (ws.bytes / 1048576) / (ws.timeMs / 1000) : 0;
    }
    return { hash: finalHash, timeMs: performance.now() - t0, workerStats };
  }

  terminate() {
    for (const worker of this.#workers) {
      worker.terminate();
    }
    this.#workers = [];
    for (const [, { reject, timeout }] of this.#pendingTasks) {
      clearTimeout(timeout);
      reject(new Error('SABHasher terminated'));
    }
    this.#pendingTasks.clear();
    this.#initialized = false;
  }
}
