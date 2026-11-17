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
export async function showPassageAction(page: Page, name: string) {
  await expect(page.locator(".passage-popup")).toHaveAttribute("aria-busy", "false");
  const action = page.getByRole("button", { name, exact: true });
  if (await action.isVisible()) return;
  const palette = /^(yellow|blue|green|pink|purple) highlight$/.test(name);
  const toggle = page.getByRole("button", { name: palette ? "Choose highlight color" : "More passage actions", exact: true });
  await expect.poll(async () => await action.isVisible() || await toggle.isVisible()).toBe(true);
  if (await action.isVisible()) return;
  await toggle.click();
  await expect(action).toBeVisible();
}
export async function showSavedItem(page: Page) {
  if (!page.url().includes("#/notes")) return;
  if (!(await page.locator(".notes-preview-pane").isVisible())) await page.locator(".notes-passage-list section button").first().click();
}

/** A short curl can start and finish between Playwright's visibility polls.
 * Observe its real visible/flipping state rather than slowing the animation. */
export async function observePaperTurns(page: Page) {
  await page.evaluate(() => {
    const state = { seen: 0 };
    (window as any).__paperTurns = state;
    let turning = false;
    new MutationObserver(() => {
      const frame = document.querySelector(".paper-turn-stage");
      const flipping = !!frame && getComputedStyle(frame).visibility === "visible" &&
        document.querySelector<HTMLElement>(".reader-host")?.dataset.pageTurnState === "flipping";
      if (flipping && !turning) state.seen++;
      turning = flipping;
    }).observe(document.querySelector(".reader-shell")!, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["style", "data-page-turn-state"],
    });
  });
  return () => page.evaluate(() => (window as any).__paperTurns.seen as number);
}
