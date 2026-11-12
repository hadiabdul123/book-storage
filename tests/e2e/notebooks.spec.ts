import { openTools, clickTool } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
async function openPdf(page: Page) {
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45000 });
  await page.locator(".book-cover-link").click();
  await openTools(page);
  await expect(page.locator(".pdf-page .textLayer span").first()).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("leafmark-controls-pinned", "true"),
  );
});
test("formatted page notebooks persist, search, export and restore", async ({
  page,
}, testInfo) => {
  await openPdf(page);
  await clickTool(page, "Page notes");
  const editor = page.getByRole("textbox", {
    name: "Notebook for page 1",
    exact: true,
  });
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.fill("A notebook idea");
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially("Second bullet");
  await expect(editor.locator("li")).toHaveCount(2);
  await page.getByLabel("Page note tags").fill("research, learning");
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(page.locator(".notebook-status")).toHaveText(
    "Saved on this device",
  );
  await page.screenshot({
    path: `.local/review-notebook-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.reload();
  await openTools(page);
  await clickTool(page, "Page notes");
  await expect(editor).toContainText("Second bullet");
  await expect(editor.locator("li")).toHaveCount(2);
  await page.getByLabel("Search page notes").fill("learning");
  await expect(page.locator(".notebook-results .search-result")).toHaveCount(1);
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("link", { name: "Back to library" }).click();
  await page.goto("/#/notes");
  await page.getByLabel("Note type").selectOption("page-note");
  await expect(page.locator(".annotation-card")).toHaveCount(1);
  await expect(page.locator(".annotation-card li")).toHaveCount(2);
  const download = page.waitForEvent("download");
  await page.getByLabel("Export notes").selectOption("json");
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Notebook for page 1" }),
  ).toContainText("Second bullet");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete page note" }).click();
  await expect(page.locator(".annotation-card")).toHaveCount(0);
  await page.goto("/#/settings");
  await page
    .locator(".trash-row")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(page.locator(".trash-row")).toHaveCount(0);
  await page.goto("/#/notes");
  await expect(page.locator(".annotation-card")).toContainText("Second bullet");
});
test("meaning lookup preserves selection and adds definitions to the page notebook", async ({
  page,
}, testInfo) => {
  await openPdf(page);
  await page
    .locator(".pdf-page .textLayer")
    .first()
    .evaluate((layer) => {
      const span = [...layer.querySelectorAll("span")].find((s) =>
        /Dynamic/.test(s.textContent || ""),
      )!;
      const at = span.textContent!.indexOf("Dynamic");
      const range = document.createRange();
      range.setStart(span.firstChild!, at);
      range.setEnd(span.firstChild!, at + 7);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page
    .getByLabel("Note for selected passage")
    .fill("Keep this unsaved thought");
  await page.getByRole("button", { name: "Meaning", exact: true }).click();
  await expect(page.locator(".dictionary-entry").first()).toBeVisible();
  await page.screenshot({
    path: `.local/review-meaning-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByLabel("Note for selected passage")).toHaveValue(
    "Keep this unsaved thought",
  );
  await page.getByRole("button", { name: "Meaning", exact: true }).click();
  await page
    .getByRole("button", { name: "Add to page note", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Notebook for page 1" }),
  ).toContainText("Simple English Wiktionary");
  await page.getByRole("button", { name: "Close panel" }).click();
  await openTools(page);
  await page.getByRole("button", { name: /Unfinished notes/ }).click();
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await clickTool(page, "Dictionary");
  await page.getByLabel("Dictionary word").fill("went");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.locator(".dictionary-entry h3").first()).toHaveText("go");
});
test("PDF layout settings persist on this device and continuous scrolling resumes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openPdf(page);
  await clickTool(page, "Reading settings");
  await page
    .getByRole("combobox", { name: "Pages across", exact: true })
    .selectOption("2");
  await expect(
    page.getByRole("combobox", { name: "Pages across", exact: true }),
  ).toHaveValue("2");
  await page
    .getByRole("combobox", { name: "Navigation", exact: true })
    .selectOption("paginated");
  await expect(page.locator(".pdf-reader")).toHaveAttribute(
    "data-navigation",
    "paginated",
  );
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".pdf-reader")).toHaveAttribute(
    "data-columns",
    "2",
  );
  await expect(page.locator(".pdf-page:visible")).toHaveCount(2);
  await page.screenshot({
    path: `.local/review-layout-${testInfo.project.name}.png`,
  });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator('.pdf-page[data-page="3"]')).toBeVisible();
  await page.reload();
  await openTools(page);
  await clickTool(page, "Reading settings");
  await expect(
    page.getByRole("combobox", { name: "Navigation", exact: true }),
  ).toHaveValue("paginated");
  await expect(
    page.getByRole("combobox", { name: "Pages across", exact: true }),
  ).toHaveValue("2");
  await page
    .getByRole("combobox", { name: "Navigation", exact: true })
    .selectOption("continuous");
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".pdf-page:visible")).toHaveCount(14);
  const before = await page.locator(".pdf-reader").evaluate((e) => e.scrollTop);
  await page.locator(".pdf-reader").hover();
  await page.mouse.wheel(0, 800);
  await expect
    .poll(() => page.locator(".pdf-reader").evaluate((e) => e.scrollTop))
    .toBeGreaterThan(before + 100);
  await page.setViewportSize({ width: 412, height: 900 });
  await expect(page.locator(".pdf-reader")).toHaveAttribute(
    "data-columns",
    "1",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".pdf-reader")).toHaveAttribute(
    "data-columns",
    "2",
  );
  await clickTool(page, "Reading settings");
  await page.getByRole("button", { name: "Select a region" }).click();
  await expect(page.locator(".pdf-reader")).toHaveClass(/region-mode/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".pdf-reader")).not.toHaveClass(/region-mode/);
});

test("resizing retains the point within a PDF page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openPdf(page);
  const reader = page.locator(".pdf-reader");
  await reader.evaluate((host) => {
    const target = host.querySelector<HTMLElement>('[data-page="2"]')!;
    host.scrollTop +=
      target.getBoundingClientRect().top -
      host.getBoundingClientRect().top +
      target.clientHeight * 0.35;
  });
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  for (const width of [900, 1440, 900, 1440]) {
    const previousWidth = await page
      .locator('.pdf-page[data-page="2"]')
      .evaluate((el) => el.clientWidth);
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        page
          .locator('.pdf-page[data-page="2"]')
          .evaluate((el) => el.clientWidth),
      )
      .not.toBe(previousWidth);
    await expect
      .poll(() =>
        reader.evaluate((host) => {
          const target = host.querySelector<HTMLElement>('[data-page="2"]')!;
          return Math.abs(
            (host.getBoundingClientRect().top -
              target.getBoundingClientRect().top) /
              target.clientHeight -
              0.35,
          );
        }),
      )
      .toBeLessThan(0.015);
  }
});

test("an unpaired final PDF page remains usable in two-page mode", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles(path.resolve("tests/fixtures/jbig2-symbol-offset.pdf"));
  await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45000 });
  await page.locator(".book-cover-link").click();
  await openTools(page);
  await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
  await clickTool(page, "Reading settings");
  await page
    .getByRole("combobox", { name: "Pages across", exact: true })
    .selectOption("2");
  await page
    .getByRole("combobox", { name: "Navigation", exact: true })
    .selectOption("paginated");
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".pdf-reader")).toHaveAttribute(
    "data-columns",
    "2",
  );
  await expect(page.locator(".pdf-page:visible")).toHaveCount(1);
  await page.locator(".pdf-reader").focus();
  await page.keyboard.press("PageDown");
  await page.keyboard.press("PageUp");
  await expect(page.locator(".pdf-page:visible canvas")).toHaveCount(1);
  await expect(page.locator(".reader-progress")).toContainText("Page 1");
});

test("page following pins active writing and failed saves retain the notebook", async ({
  page,
}) => {
  await openPdf(page);
  await clickTool(page, "Page notes");
  const first = page.getByRole("textbox", {
    name: "Notebook for page 1",
    exact: true,
  });
  await expect(first).toHaveAttribute("contenteditable", "true");
  await first.fill("Pinned writing");
  await page
    .locator('.pdf-page[data-page="2"]')
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await expect(first).toBeVisible();
  await page.getByRole("button", { name: "Follow current page" }).click();
  await expect(
    page.getByRole("textbox", { name: "Notebook for page 2", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Notebook for page 2", exact: true })
    .fill("Saved before conflict");
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await expect(page.locator(".notebook-status")).toHaveText(
    "Saved on this device",
  );
  await page.evaluate(async () => {
    const { db } = await import(/* @vite-ignore */ "/src/db.ts");
    const row = (await db.rows.toArray()).find(
      (r: any) => r.value.type === "page-note" && r.value.locator.page === 2,
    );
    await db.conflicts.put({
      key: row.key,
      local: row,
      remote: { ...row, revision: 5 },
      detectedAt: new Date().toISOString(),
    });
  });
  await page
    .getByRole("textbox", { name: "Notebook for page 2", exact: true })
    .fill("Keep this unsaved writing");
  await expect(page.locator(".notebook-status")).toContainText(
    "Could not save",
  );
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(
    page.getByRole("textbox", { name: "Notebook for page 2", exact: true }),
  ).toContainText("Keep this unsaved writing");
  await page.evaluate(async () => {
    const { db } = await import(/* @vite-ignore */ "/src/db.ts");
    await db.conflicts.clear();
  });
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await expect(page.locator(".notebook-status")).toHaveText(
    "Saved on this device",
  );
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".page-notebook")).toHaveCount(0);
  // Choosing a specific page's note must not be overwritten by auto-follow.
  await page
    .getByRole("button", { name: "Notes for page 1", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(
    page.getByRole("textbox", { name: "Notebook for page 1", exact: true }),
  ).toContainText("Pinned writing");
  await page
    .locator('.pdf-page[data-page="3"]')
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect(page.locator(".reader-progress")).toContainText("Page 3");
  await expect(
    page.getByRole("textbox", { name: "Notebook for page 1", exact: true }),
  ).toBeVisible();
});
