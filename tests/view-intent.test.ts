import { expect, it, vi, afterEach } from "vitest";
import { ViewIntent } from "../src/reader/viewIntent";
afterEach(() => vi.useRealTimers());
it("merges rapid independent settings and zoom into one final view", async () => {
  vi.useFakeTimers(); const render = vi.fn(async () => {});
  const view = new ViewIntent({ zoom: 1, columns: 1, rotation: 0 }, render, () => {});
  const requests = [view.request({ zoom: 2 }), view.request({ columns: 2 }), view.request({ zoom: 1.5 }), view.request({ rotation: 90 })];
  expect(render).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(151); await Promise.all(requests);
  expect(render).toHaveBeenCalledOnce(); expect(render.mock.calls[0][0]).toEqual({ zoom: 1.5, columns: 2, rotation: 90 });
  view.destroy();
});
it("cancels the active revision, keeps one latest intent, and settles every caller", async () => {
  vi.useFakeTimers(); const seen: number[] = []; let finish!: () => void; let active = 0, peak = 0;
  const view = new ViewIntent({ zoom: 1 }, async (value, signal) => {
    active++; peak = Math.max(peak, active); seen.push(value.zoom);
    if (seen.length === 1) await new Promise<void>(resolve => { finish = resolve; signal.addEventListener("abort", resolve, { once: true }); });
    active--;
  }, () => {});
  const first = view.request({ zoom: 2 }); await vi.advanceTimersByTimeAsync(151);
  const requests = [view.request({ zoom: 3 }), view.request({ zoom: 1.25 })]; finish();
  await vi.advanceTimersByTimeAsync(301); await Promise.all([first, ...requests]);
  expect(seen).toEqual([2, 1.25]); expect(peak).toBe(1); view.destroy();
});
it("pauses during a gesture, clears a failed revision, and allows recovery", async () => {
  vi.useFakeTimers(); let fail = true;
  const render = vi.fn(async () => { if (fail) throw new Error("render failed"); });
  const view = new ViewIntent({ zoom: 1 }, render, () => {});
  view.pause(true); const pending = view.request({ zoom: 2 }); const rejected = expect(pending).rejects.toThrow("render failed");
  await vi.advanceTimersByTimeAsync(500); expect(render).not.toHaveBeenCalled();
  view.pause(false); await vi.advanceTimersByTimeAsync(151); await rejected;
  fail = false; const reset = view.request({ zoom: 1 }); await vi.advanceTimersByTimeAsync(151); await reset;
  view.destroy();
});
