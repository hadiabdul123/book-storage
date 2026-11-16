import { afterEach, expect, it, vi } from "vitest";
import { PageTurn, type TurnSource } from "../src/reader/pageTurn";

afterEach(() => vi.unstubAllGlobals());
function pendingTurn() {
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  let complete!: (value: null) => void, location = "page-1";
  const preview = new Promise<null>(resolve => { complete = resolve; });
  const host = { dataset: {} } as HTMLElement;
  const source: TurnSource = { enabled: () => true, canDrag: () => false,
    bounds: () => ({}) as DOMRect, location: () => location, prepare: () => preview };
  const turn = new PageTurn(host, source);
  return { turn, complete, jump: () => { location = "page-9"; } };
}
it("completes an automatic turn exactly once when a layout refresh discards its pending preview", async () => {
  const { turn, complete } = pendingTurn(), navigate = vi.fn(async () => {});
  try {
    const running = turn.run("next", navigate);
    turn.invalidate(); complete(null);
    await running;
    expect(navigate).toHaveBeenCalledTimes(1);
  } finally { turn.destroy(); }
});
it("does not replay a pending automatic turn after an explicit jump elsewhere", async () => {
  const { turn, complete, jump } = pendingTurn(), navigate = vi.fn(async () => {});
  try {
    const running = turn.run("next", navigate);
    jump(); turn.invalidate(); complete(null);
    await running;
    expect(navigate).not.toHaveBeenCalled();
  } finally { turn.destroy(); }
});
