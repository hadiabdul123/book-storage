import { afterEach, expect, it, vi } from "vitest";
import { NarrationAudio } from "../src/reader/narrationAudio";

class TestWorker {
  static latest: TestWorker;
  onmessage?: (message: { data: unknown }) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { TestWorker.latest = this; }
  reply() {
    const [{ id }] = this.postMessage.mock.lastCall!;
    this.onmessage?.({ data: { id, samples: new Float32Array([0.5]), rate: 24000 } });
  }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("replays prepared speech and generates fresh audio when the speed changes", async () => {
  vi.stubGlobal("Worker", TestWorker);
  const audio = new NarrationAudio();
  try {
    const first = audio.generate("A passage.", "af_heart", 1, vi.fn());
    const worker = TestWorker.latest;
    worker.reply();
    audio.cancelPending();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(await audio.generate("A passage.", "af_heart", 1, vi.fn())).toBe(await first);
    const faster = audio.generate("A passage.", "af_heart", 1.5, vi.fn());
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.reply();
    await faster;
  } finally { audio.destroy(); }
});

it("releases an unresponsive voice worker and lets the reader retry the same sentence", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", TestWorker);
  const audio = new NarrationAudio();
  try {
    const stalled = audio.generate("A passage.", "af_heart", 1, vi.fn());
    const old = TestWorker.latest;
    const failed = expect(stalled).rejects.toThrow("stopped responding");
    await vi.advanceTimersByTimeAsync(90_000);
    await failed;
    expect(old.terminate).toHaveBeenCalledOnce();
    const retry = audio.generate("A passage.", "af_heart", 1, vi.fn());
    expect(TestWorker.latest).not.toBe(old);
    TestWorker.latest.reply();
    expect((await retry).samples).toHaveLength(1);
  } finally { audio.destroy(); }
});
