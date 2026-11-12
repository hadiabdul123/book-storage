import { expect, it } from "vitest";
import { defaultReadingPointer, normalizeReadingPointer, readReadingPointer, saveReadingPointer, trimReadingTrail } from "../src/readingPointerSettings";

it("defaults off and rejects corrupt or incompatible saved preferences", () => {
  for (const value of [null, "broken", '{"version":2,"settings":{"pointer":true}}'])
    expect(readReadingPointer({ getItem: () => value })).toEqual(defaultReadingPointer);
  expect(readReadingPointer({ getItem: () => { throw Error("blocked"); } })).toEqual(defaultReadingPointer);
});
it("validates shapes and colors and bounds adjustable values", () => {
  expect(normalizeReadingPointer({ pointer: "true", trail: true, shape: "bad", color: "url(bad)",
    size: 900, length: -3, thickness: NaN, opacity: 100, fade: 0 })).toEqual({
    ...defaultReadingPointer, trail: true, size: 64, length: 40, opacity: 80, fade: 150,
  });
});
it("round trips shared device preferences and surfaces storage failures", () => {
  let value = "";
  const storage = { getItem: () => value, setItem: (_key: string, input: string) => { value = input; } };
  const settings = { ...defaultReadingPointer, pointer: true, shape: "ring" as const, size: 48 };
  saveReadingPointer(storage, settings);
  expect(readReadingPointer(storage)).toEqual(settings);
  expect(() => saveReadingPointer({ setItem: () => { throw Error("full"); } }, settings)).toThrow("full");
});
it("cuts the tail at the exact distance and expires old samples", () => {
  const points = [0, 100, 200].map(x => ({ x, y: 0, time: 100 + x }));
  expect(trimReadingTrail(points, 150, 300, 400).map(p => p.x)).toEqual([50, 100, 200]);
  expect(trimReadingTrail(points, 400, 550, 400).map(p => p.x)).toEqual([100, 200]);
  expect(trimReadingTrail(points, 400, 701, 400)).toEqual([]);
});
it("bounds trail memory even with dense pointer input", () => {
  const points = Array.from({ length: 1000 }, (_, x) => ({ x: x / 100, y: 0, time: 100 }));
  expect(trimReadingTrail(points, 400, 100, 1000)).toHaveLength(96);
});
