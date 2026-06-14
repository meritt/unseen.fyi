// bun:test has no requestAnimationFrame; a microtask stand-in makes frame batching deterministic
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    queueMicrotask(() => {
      cb(0);
    });
    return 0;
  };
}
