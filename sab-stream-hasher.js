import wasmInit, { hash_single, left_subtree_len, parent_cv, root_hash } from './blake3-wasm-streaming/pkg/blake3_wasm_streaming.js';

const CHUNK_SIZE = 1024;
const WORKER_INIT_TIMEOUT = 10000;
const HASH_TASK_TIMEOUT = 30000;
const MAX_INFLIGHT_PER_WORKER = 2;

function maxSubtreeLen(offset) {
  if (offset === 0) return Infinity;
  const chunkIndex = offset / 1024;
  const trailingZeros = Math.log2(chunkIndex & -chunkIndex);
  return (1 << trailingZeros) * 1024;
}

export class SABStreamHasher {
  #numWorkers;
  #chunkSize;
  #workers = [];
  #pendingTasks = new Map();
  #nextTaskId = 0;
  #initialized = false;
  #nextNodeId = 0;
  #nodeMap = new Map();
  #sab = null;
  #numSlots = 0;
  #slotInUse = [];

  constructor(options = {}) {
    this.#numWorkers = options.workerCount ?? 6;
    this.#chunkSize = options.chunkSize ?? 1048576;
  }

  async init() {
    await wasmInit();

    this.#numSlots = this.#numWorkers * MAX_INFLIGHT_PER_WORKER;
    this.#sab = new SharedArrayBuffer(this.#numSlots * this.#chunkSize);
    this.#slotInUse = new Array(this.#numSlots).fill(false);

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

    // Send SAB to all workers once during init
    for (const w of this.#workers) {
      w.postMessage({ type: 'buffer', buffer: this.#sab });
    }

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

  #findFreeSlot() {
    for (let i = 0; i < this.#numSlots; i++) {
      if (!this.#slotInUse[i]) return i;
    }
    return -1;
  }

  #dispatchTask(workerIdx, sabSlotOffset, fileOffset, size) {
    const taskId = this.#nextTaskId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingTasks.delete(taskId);
        reject(new Error(`Hash task ${taskId} timed out after ${HASH_TASK_TIMEOUT}ms`));
      }, HASH_TASK_TIMEOUT);

      this.#pendingTasks.set(taskId, { workerIndex: workerIdx, resolve, reject, timeout });
      this.#workers[workerIdx].postMessage({ type: 'hash', offset: sabSlotOffset, fileOffset, size, taskId });
    });
  }

  async hashFile(file) {
    if (!this.#initialized) throw new Error('SABStreamHasher not initialized. Call init() first.');
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('SharedArrayBuffer is not available. Ensure the page is cross-origin isolated (COOP/COEP headers).');
    }

    const t0 = performance.now();

    // Small input shortcut: hash on main thread
    if (file.size < 65536) {
      const data = new Uint8Array(await file.arrayBuffer());
      const hash = hash_single(data);
      return { hash, timeMs: performance.now() - t0, workerStats: [] };
    }

    // Build tree
    this.#nextNodeId = 0;
    this.#nodeMap = new Map();
    const root = this.#buildTree(0, file.size);

    // Single leaf: hash on main thread
    if (root.type === 'leaf') {
      const data = new Uint8Array(await file.arrayBuffer());
      const hash = hash_single(data);
      return { hash, timeMs: performance.now() - t0, workerStats: [] };
    }

    // Collect leaves
    const leaves = this.#collectLeaves(root);

    // Reset all slots to free
    this.#slotInUse.fill(false);

    // Per-worker stats
    const workerStats = Array.from({ length: this.#numWorkers }, (_, i) => ({
      id: i, tasks: 0, bytes: 0, timeMs: 0, underruns: 0
    }));

    // DAG bubble-up merge
    const cvMap = new Map();
    const workerInFlight = new Array(this.#numWorkers).fill(0);
    const workerHasHadWork = new Array(this.#numWorkers).fill(false);
    const workerUnderruns = new Array(this.#numWorkers).fill(0);

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

    // Single resolver for dual backpressure (worker + slot)
    let resolveSlot = null;

    // Double-buffering: queue filled slots for dispatch instead of blocking
    const pendingDispatches = []; // { slotIdx, leaf, leafId, leafSize }

    const tryDispatchPending = () => {
      while (pendingDispatches.length > 0) {
        if (workerInFlight.every(n => n >= MAX_INFLIGHT_PER_WORKER)) return;
        const item = pendingDispatches.shift();

        let workerIdx = 0;
        for (let w = 1; w < this.#numWorkers; w++) {
          if (workerInFlight[w] < workerInFlight[workerIdx]) workerIdx = w;
        }
        if (workerInFlight[workerIdx] === 0 && workerHasHadWork[workerIdx]) {
          workerUnderruns[workerIdx]++;
        }
        workerHasHadWork[workerIdx] = true;
        workerInFlight[workerIdx]++;

        const dispatchTime = performance.now();
        this.#dispatchTask(workerIdx, item.slotIdx * this.#chunkSize, item.leaf.offset, item.leaf.size)
          .then(cv => onTaskDone(workerIdx, item.slotIdx, item.leafId, item.leafSize, dispatchTime, cv))
          .catch(err => rejectRoot(err));
      }
    };

    const onTaskDone = (workerIdx, slotIdx, leafId, leafSize, dispatchTime, cv) => {
      const elapsed = performance.now() - dispatchTime;
      workerStats[workerIdx].tasks++;
      workerStats[workerIdx].bytes += leafSize;
      workerStats[workerIdx].timeMs += elapsed;
      workerInFlight[workerIdx]--;
      this.#slotInUse[slotIdx] = false;
      cvMap.set(leafId, cv);
      bubbleUp(leafId);
      tryDispatchPending();
      if (resolveSlot) {
        resolveSlot();
        resolveSlot = null;
      }
    };

    // Stream + dispatch loop
    let currentLeafIdx = 0;

    // Acquire first free slot
    let currentSlotIdx = this.#findFreeSlot();
    this.#slotInUse[currentSlotIdx] = true;
    let slotView = new Uint8Array(this.#sab, currentSlotIdx * this.#chunkSize, leaves[0].size);
    let leafFilled = 0;

    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = value;
        let chunkOffset = 0;

        while (chunkOffset < chunk.length && currentLeafIdx < leaves.length) {
          const leaf = leaves[currentLeafIdx];
          const remaining = leaf.size - leafFilled;
          const toCopy = Math.min(remaining, chunk.length - chunkOffset);

          slotView.set(chunk.subarray(chunkOffset, chunkOffset + toCopy), leafFilled);
          leafFilled += toCopy;
          chunkOffset += toCopy;

          if (leafFilled === leaf.size) {
            // Queue for dispatch (non-blocking)
            pendingDispatches.push({
              slotIdx: currentSlotIdx, leaf, leafId: leaf.id, leafSize: leaf.size
            });
            tryDispatchPending();

            currentLeafIdx++;
            if (currentLeafIdx < leaves.length) {
              // Find next free slot — only blocks if ALL slots busy
              let nextSlot = this.#findFreeSlot();
              while (nextSlot === -1) {
                await new Promise(r => { resolveSlot = r; });
                tryDispatchPending();
                nextSlot = this.#findFreeSlot();
              }
              currentSlotIdx = nextSlot;
              this.#slotInUse[currentSlotIdx] = true;
              slotView = new Uint8Array(this.#sab, currentSlotIdx * this.#chunkSize, leaves[currentLeafIdx].size);
              leafFilled = 0;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Drain any remaining pending dispatches
    while (pendingDispatches.length > 0) {
      tryDispatchPending();
      if (pendingDispatches.length > 0) {
        await new Promise(r => { resolveSlot = r; });
      }
    }

    const finalHash = await rootPromise;
    for (let i = 0; i < workerStats.length; i++) {
      workerStats[i].underruns = workerUnderruns[i];
      workerStats[i].speedMBs = workerStats[i].timeMs > 0 ? (workerStats[i].bytes / 1048576) / (workerStats[i].timeMs / 1000) : 0;
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
      reject(new Error('SABStreamHasher terminated'));
    }
    this.#pendingTasks.clear();
    this.#initialized = false;
  }
}
