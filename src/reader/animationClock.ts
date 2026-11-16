/** Private curl clock: no browser work while idle, and no idle-time jump when
 * resumed. A bounded timer keeps active folds moving when WebKit throttles RAF. */
export function animationClock(request = requestAnimationFrame, cancel = cancelAnimationFrame) {
  let running = false, next = 0, frame = 0, disposed = false, ticket = 0;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let time = 0, previous: number | undefined;
  const callbacks = new Map<number, FrameRequestCallback>();
  const disarm = () => { ticket++; cancel(frame); frame = 0; clearTimeout(fallback); fallback = undefined; };
  const arm = () => {
    if (!running || disposed || frame) return;
    const token = ++ticket;
    const deliver = (timestamp: number) => {
      if (token !== ticket || !running || disposed) return;
      disarm(); tick(timestamp);
    };
    frame = request(deliver);
    // Used only during an active turn/held fold. It is cancelled whenever the
    // normal animation frame arrives, and stopped entirely between turns.
    fallback = setTimeout(() => deliver(performance.now()), 32);
  };
  const tick = (timestamp: number) => {
    if (!running || disposed) return;
    if (previous !== undefined) time += Math.max(0, Math.min(50, timestamp - previous));
    previous = timestamp;
    const pending = [...callbacks]; callbacks.clear();
    // Book in the owner realm before handing control to the vendor iframe.
    arm();
    for (const [, callback] of pending) { if (disposed || !running) break; callback(time); }
    if (!callbacks.size) disarm();
  };
  return {
    request: (callback: FrameRequestCallback) => { const id = ++next; callbacks.set(id, callback); if (callbacks.size) arm(); return id; },
    cancel: (id: number) => { callbacks.delete(id); if (!callbacks.size) disarm(); },
    resume: () => { running = true; if (callbacks.size) arm(); },
    pause: () => { running = false; previous = undefined; disarm(); },
    destroy: () => { disposed = true; running = false; disarm(); callbacks.clear(); },
  };
}
