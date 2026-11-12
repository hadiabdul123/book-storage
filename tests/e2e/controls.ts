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
