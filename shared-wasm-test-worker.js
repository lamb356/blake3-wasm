// ES module worker for shared-wasm-test.html Test 4
let pkg;

self.onmessage = async (e) => {
  if (e.data.type === 'init') {
    pkg = await import('./blake3-wasm-shared/pkg/blake3_wasm_shared.js');
    await pkg.default({ module_or_path: e.data.module, memory: e.data.memory });
    self.postMessage({ type: 'ready' });
  }
  if (e.data.type === 'hash') {
    const { ptr, size, offset, taskId } = e.data;
    const cv = pkg.hash_subtree_ptr(ptr, size, BigInt(offset));
    self.postMessage({ type: 'result', cv: new Uint8Array(cv), taskId });
  }
};
