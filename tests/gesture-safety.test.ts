import { afterEach, expect, it, vi } from "vitest";
import { PageTurn, type TurnSource } from "../src/reader/pageTurn";
import { bindPageSwipes } from "../src/reader/swipes";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function surface() {
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, visualViewport: { scale: 1 } });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const doc = Object.assign(new EventTarget(), { getSelection: () => ({ toString: () => "" }), defaultView: { innerWidth: 400, visualViewport: { scale: 1 } } });
  const root = Object.assign(new EventTarget(), { dataset: {}, ownerDocument: doc, closest: () => null }) as unknown as HTMLElement;
  const prepare = vi.fn(async () => null), navigate = vi.fn(async () => {});
  const source: TurnSource = { enabled: () => true, canDrag: () => true, canTap: () => true, navigate,
    bounds: () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 }) as DOMRect,
    location: () => "1", prepare };
  const event = (name: string, values: object) => root.dispatchEvent(Object.assign(new Event(name, { cancelable: true }), values));
  return { root, source, prepare, navigate, event };
}
it("a held edge cannot become a turn while text preparation is still pending", async () => {
  vi.useFakeTimers(); const { root, source, prepare, navigate, event } = surface();
  const turn = new PageTurn(root, source); turn.bind(root);
  event("pointerdown", { button: 0, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: 390, clientY: 300 });
  await vi.advanceTimersByTimeAsync(600);
  event("pointermove", { pointerId: 1, clientX: 200, clientY: 300 });
  event("pointerup", { pointerId: 1, clientX: 200, clientY: 300 });
  expect(prepare).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled(); turn.destroy();
});
it("selection ownership cancels an armed edge tap without needing a native range", () => {
  const { root, source, navigate, event } = surface(); const turn = new PageTurn(root, source); turn.bind(root);
  event("pointerdown", { button: 0, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: 390, clientY: 300 });
  root.dispatchEvent(new Event("reader-selection-start"));
  event("pointerup", { pointerId: 1, clientX: 390, clientY: 300 });
  expect(navigate).not.toHaveBeenCalled(); turn.destroy();
});
it("a selection supersedes an automatic turn waiting for a cold preview", async () => {
  const { root, source } = surface(); vi.stubGlobal("matchMedia", () => ({ matches: false }));
  let complete!: (value: null) => void; source.prepare = () => new Promise(resolve => { complete = resolve; });
  const turn = new PageTurn(root, source), navigate = vi.fn(async () => {}); turn.bind(root);
  const pending = turn.run("next", navigate); root.dispatchEvent(new Event("reader-selection-start")); complete(null); await pending;
  expect(navigate).not.toHaveBeenCalled(); turn.destroy();
});
it("a logical selection permanently cancels the current swipe even if tools close before release", () => {
  const { root, event } = surface(), navigate = vi.fn(); const cleanup = bindPageSwipes(root, () => true, navigate);
  event("touchstart", { touches: [{ identifier: 1, clientX: 300, clientY: 200 }] });
  event("touchmove", { touches: [{ identifier: 1, clientX: 240, clientY: 200 }] });
  root.dispatchEvent(new Event("reader-selection-start"));
  event("touchend", { changedTouches: [{ identifier: 1, clientX: 100, clientY: 200 }] });
  expect(navigate).not.toHaveBeenCalled(); cleanup();
});
