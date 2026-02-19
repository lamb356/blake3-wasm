import init, { hash_subtree } from './blake3-wasm-streaming/pkg/blake3_wasm_streaming.js';

let ready = false;
let storedSAB = null;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
      await init();
      ready = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message });
    }
    return;
  }

  if (type === 'buffer') {
    storedSAB = e.data.buffer;
    return;
  }

  if (type === 'hash') {
    if (!ready) {
      self.postMessage({ type: 'error', error: 'Worker not initialized', taskId: e.data.taskId });
      return;
    }
    const { offset, size, taskId } = e.data;
    const fileOffset = e.data.fileOffset ?? offset;
    try {
      const view = new Uint8Array(storedSAB, offset, size);
      const cv = hash_subtree(view, BigInt(fileOffset));
      self.postMessage({ type: 'result', cv, offset, size, taskId });
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message, taskId });
    }
    return;
  }
};
