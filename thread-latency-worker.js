// thread-latency-worker.js — handles echo, atomics, and worker-to-worker benchmarks

self.onmessage = (e) => {
  const { type } = e.data;

  // Mode: postMessage echo (main↔worker round-trip)
  if (type === 'echo') {
    self.postMessage({ type: 'echo', seq: e.data.seq });
    return;
  }

  // Mode: Atomics wait/notify round-trip (main↔worker)
  if (type === 'atomics-start') {
    const { sab, count } = e.data;
    const view = new Int32Array(sab);
    // view[0] = main→worker signal, view[1] = worker→main signal
    for (let round = 0; round < count; round++) {
      // Wait until main stores (round + 1) into view[0]
      Atomics.wait(view, 0, round);
      // Signal back: store (round + 1) into view[1] and notify
      Atomics.store(view, 1, round + 1);
      Atomics.notify(view, 1);
    }
    self.postMessage({ type: 'atomics-done' });
    return;
  }

  // Mode: worker-to-worker responder (echoes on MessagePort)
  if (type === 'w2w-responder') {
    const port = e.data.port;
    port.onmessage = (msg) => {
      port.postMessage(msg.data);
    };
    return;
  }

  // Mode: worker-to-worker driver (runs benchmark on MessagePort)
  if (type === 'w2w-driver') {
    const { port, count, warmup } = e.data;
    const totalRounds = warmup + count;
    const times = new Float64Array(count);
    let round = 0;
    let t0 = 0;

    port.onmessage = () => {
      if (round > 0) {
        const elapsed = performance.now() - t0;
        const measuredIndex = round - 1 - warmup;
        if (measuredIndex >= 0) {
          times[measuredIndex] = elapsed;
        }
      }

      if (round >= totalRounds) {
        // Compute stats from measured rounds
        let total = 0, min = Infinity, max = 0;
        for (let i = 0; i < count; i++) {
          total += times[i];
          if (times[i] < min) min = times[i];
          if (times[i] > max) max = times[i];
        }
        const avg = total / count;
        self.postMessage({
          type: 'w2w-result',
          total,
          avg,
          min,
          max,
          ops: Math.round(1000 / avg)
        });
        return;
      }

      t0 = performance.now();
      port.postMessage(round);
      round++;
    };

    // Kick off first round
    t0 = performance.now();
    port.postMessage(round);
    round++;
    return;
  }
};
