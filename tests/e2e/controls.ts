import { expect, type Page } from "@playwright/test";
export async function openTools(page: Page) {
  if (!page.url().includes("/read/")) return;
  await expect(page.locator(".reader-shell")).toBeVisible();
  const reveal = page.getByRole("button", {
    name: "Show reading controls",
    exact: true,
  });
  await reveal.focus();
  await reveal.press("Enter");
  const menu = page.getByRole("button", { name: "Reading tools", exact: true });
  if (
    (await menu.isVisible()) &&
    (await menu.getAttribute("aria-expanded")) === "false"
  )
    await menu.click();
}

export async function clickTool(page: Page, name: string) {
  await openTools(page);
  await page.getByRole("button", { name, exact: true }).click();
}

/** A short curl can start and finish between Playwright's visibility polls.
 * Observe its real visible/flipping state rather than slowing the animation. */
export async function observePaperTurns(page: Page) {
  await page.evaluate(() => {
    const state = { seen: 0 };
    (window as any).__paperTurns = state;
    const frames = new WeakSet<Element>();
    new MutationObserver(() => {
      const frame = document.querySelector(".paper-turn-stage");
      if (frame && !frames.has(frame) && getComputedStyle(frame).visibility === "visible" &&
          document.querySelector<HTMLElement>(".reader-host")?.dataset.pageTurnState === "flipping") {
        frames.add(frame); state.seen++;
      }
    }).observe(document.querySelector(".reader-shell")!, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["style", "data-page-turn-state"],
    });
  });
  return () => page.evaluate(() => (window as any).__paperTurns.seen as number);
}
