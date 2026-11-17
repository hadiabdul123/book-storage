import { afterEach, expect, it, vi } from "vitest";
import { animationClock } from "../src/reader/animationClock";
import { bindPdfZoom } from "../src/reader/pdfZoom";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("pauses the vendor's perpetual animation without losing its pending frame", () => {
  let frame: FrameRequestCallback | undefined;
  const request = vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; });
  const cancel = vi.fn();
  let wall = 1000;
  const clock = animationClock(request, cancel, () => wall), draw = vi.fn();
  const loop: FrameRequestCallback = time => { draw(time); clock.request(loop); };
  clock.request(loop);
  expect(request).not.toHaveBeenCalled();
  clock.resume(); frame!(1000);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(draw).toHaveBeenLastCalledWith(0);
  clock.pause();
  expect(cancel).toHaveBeenCalledWith(1);
  const requests = request.mock.calls.length;
  expect(request).toHaveBeenCalledTimes(requests);
  wall = 20_000;
  clock.resume(); frame!(20_000);
  expect(draw).toHaveBeenCalledTimes(2);
  expect(draw).toHaveBeenLastCalledWith(0);
  clock.destroy(); clock.resume();
  expect(request).toHaveBeenCalledTimes(requests + 2);
});

it("accepts and coalesces zoom requests while rendering, retaining the preview until the latest is ready", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const doc = { addEventListener() {}, removeEventListener() {} };
  const host = { ownerDocument: doc, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 700 }) } as unknown as HTMLElement;
  let value = 1;
  const pending: (() => void)[] = [];
  const clear = vi.fn(), preview = vi.fn();
  const commit = vi.fn((target: number) => new Promise<void>(resolve => pending.push(() => { value = target; resolve(); })));
  const zoom = bindPdfZoom(host, { value: () => value, preview, clear, commit, error: error => { throw error; } });
  zoom.request(1.5);
  zoom.request(2);
  zoom.request(2.75);
  expect(commit.mock.calls.map(call => call[0])).toEqual([1.5]);
  expect(clear).not.toHaveBeenCalled();
  pending.shift()!(); await Promise.resolve(); await Promise.resolve();
  expect(commit.mock.calls.map(call => call[0])).toEqual([1.5, 2.75]);
  expect(clear).not.toHaveBeenCalled();
  pending.shift()!(); await Promise.resolve(); await Promise.resolve();
  expect(value).toBe(2.75);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(preview).toHaveBeenLastCalledWith(2.75, { x: 250, y: 28 }, { x: 250, y: 28 });
  zoom.destroy();
});

it("keeps active folds moving when native RAF is throttled, then stops every wakeup at rest", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const request = vi.fn(() => 1), cancel = vi.fn(), draw = vi.fn();
  const clock = animationClock(request, cancel);
  const loop: FrameRequestCallback = time => { draw(time); clock.request(loop); };
  clock.request(loop); clock.resume();
  await vi.advanceTimersByTimeAsync(100);
  expect(draw).toHaveBeenCalledTimes(3);
  expect(draw).toHaveBeenLastCalledWith(96);
  clock.pause();
  const frames = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(draw).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenCalledTimes(frames);
  clock.destroy();
});

it("counts sparse active frames fully without counting a long idle gap", () => {
  let frame!: FrameRequestCallback, wall = 0;
  const request = (callback: FrameRequestCallback) => { frame = callback; return 1; };
  const clock = animationClock(request, () => {}, () => wall), draw = vi.fn();
  const loop: FrameRequestCallback = time => { draw(time); clock.request(loop); };
  clock.request(loop); clock.resume();
  frame(250); frame(750);
  expect(draw).toHaveBeenLastCalledWith(750);
  clock.pause(); wall = 20_000; clock.resume(); frame(20_100);
  expect(draw).toHaveBeenLastCalledWith(850);
  clock.destroy();
});
