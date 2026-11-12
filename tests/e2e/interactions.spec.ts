import { openTools, clickTool } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import JSZip from "jszip";
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
async function selectPdf(page: Page, partial = false) {
  await page
    .locator(".pdf-page .textLayer")
    .first()
    .evaluate((layer, partial) => {
      const span = [...layer.querySelectorAll("span")].find((s) =>
        s.textContent?.includes("Dynamic"),
      )!;
      const at = span.textContent!.indexOf("Dynamic"),
        r = document.createRange();
      r.setStart(span.firstChild!, at);
      r.setEnd(span.firstChild!, at + (partial ? 3 : 7));
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
    }, partial);
  await expect(page.locator(".passage-popup")).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("leafmark-controls-pinned", "true"),
  );
});
test("floating meanings, one-click highlights and partial reselection support undo and redo", async ({
  page,
}, info) => {
  await openPdf(page);
  await selectPdf(page);
  await page.getByRole("button", { name: "Meaning", exact: true }).click();
  await expect(
    page.locator(".passage-popup .dictionary-entry").first(),
  ).toBeVisible();
  await expect(page.locator(".reader-panel")).toHaveCount(0);
  const rect = await page.locator(".passage-popup").boundingBox();
  const viewport = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height + 1);
  await page.screenshot({
    path: `.local/floating-meaning-${info.project.name}.png`,
  });
  await page.getByRole("button", { name: "Change word", exact: true }).click();
  await page.getByLabel("Dictionary word").fill("thoughtful");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(
    page.locator(".passage-popup .dictionary-entry h3").first(),
  ).toHaveText("thoughtful");
  await page
    .getByRole("button", { name: "yellow highlight", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "yellow highlight", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Meaning", exact: true }).click();
  await page
    .getByRole("button", { name: "blue highlight", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "blue highlight", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await selectPdf(page, true);
  await expect(
    page.getByRole("button", { name: "blue highlight", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "blue highlight", exact: true })
    .click();
  await expect(page.locator(".pdf-highlight")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".pdf-highlight")).toHaveCount(0);
  await clickTool(page, "Undo reader change");
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await page.reload();
  await openTools(page);
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo reader change", exact: true }),
  ).toBeDisabled();
});
test("page and passage bookmarks toggle, indicate saved state, and persist", async ({
  page,
}) => {
  await openPdf(page);
  await clickTool(page, "Add bookmark");
  await expect(
    page.getByRole("button", { name: "Remove bookmark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator('.pdf-page[data-page="2"]')
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await expect(
    page.getByRole("button", { name: "Add bookmark", exact: true }),
  ).toBeVisible();
  await page
    .locator('.pdf-page[data-page="1"]')
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(
    page.getByRole("button", { name: "Remove bookmark", exact: true }),
  ).toBeVisible();
  await clickTool(page, "Remove bookmark");
  await expect(
    page.getByRole("button", { name: "Add bookmark", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove bookmark", exact: true }),
  ).toBeVisible();
  await selectPdf(page);
  await page
    .getByRole("button", { name: "Bookmark passage", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove passage bookmark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".passage-bookmark")).toHaveCount(1);
  await clickTool(page, "Reading settings");
  await page
    .getByRole("combobox", { name: "Zoom", exact: true })
    .selectOption("1.25");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await selectPdf(page);
  await expect(
    page.getByRole("button", { name: "Remove passage bookmark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await openTools(page);
  await expect(page.locator(".passage-bookmark")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Remove bookmark", exact: true }),
  ).toBeVisible();
  const toolsMenu = page.getByRole("button", {
    name: "Reading tools",
    exact: true,
  });
  if (
    (await toolsMenu.isVisible()) &&
    (await toolsMenu.getAttribute("aria-expanded")) === "true"
  )
    await toolsMenu.click();
  await page.locator(".passage-bookmark").click();
  await page
    .getByRole("button", { name: "Remove passage bookmark", exact: true })
    .click();
  await expect(page.locator(".passage-bookmark")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove bookmark", exact: true }),
  ).toBeVisible();
});
test("note typing keeps native undo and unfinished drafts survive dismissal and reload", async ({
  page,
}) => {
  await openPdf(page);
  await selectPdf(page);
  await page
    .getByRole("button", { name: "yellow highlight", exact: true })
    .click();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const note = page.getByRole("textbox", { name: "Note for selected passage" });
  await note.pressSequentially("A private draft");
  await note.press("Control+z");
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  await note.fill("Recovered writing");
  await note.press("Escape");
  await expect(page.locator(".passage-popup")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Unfinished notes/ }),
  ).toBeVisible();
  await page.reload();
  await openTools(page);
  await page.getByRole("button", { name: /Unfinished notes/ }).click();
  await expect(note).toHaveValue("Recovered writing");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Unfinished notes/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Remove highlight", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await selectPdf(page);
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  await expect(note).toHaveValue("Recovered writing");
});

for (const format of ["epub", "docx"] as const)
  test(`${format} selection tools, bookmark markers and keyboard history survive reflow`, async ({
    page,
  }, info) => {
    await page.goto("/");
    if (format === "epub")
      await page
        .locator("input[type=file]")
        .setInputFiles(path.resolve("tests/fixtures/alice.epub"));
    else {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      zip.file(
        "_rels/.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      );
      zip.file(
        "word/document.xml",
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          Array.from(
            { length: 30 },
            (_, i) =>
              `<w:p><w:r><w:t>Thoughtful reading helps us understand an idea. Paragraph ${i + 1} supplies more text for reading-place tests.</w:t></w:r></w:p>`,
          ).join("") +
          "</w:body></w:document>",
      );
      await page.locator("input[type=file]").setInputFiles({
        name: "Thoughtful.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: await zip.generateAsync({ type: "nodebuffer" }),
      });
    }
    await expect(page.locator(".book-card")).toHaveCount(1, { timeout: 45000 });
    await page.locator(".book-cover-link").click();
    await openTools(page);
    await expect(page.locator(".reader-loading")).toHaveCount(0, {
      timeout: 45000,
    });
    if (format === "epub") {
      await clickTool(page, "Contents");
      await page
        .locator(".toc-item")
        .filter({ hasText: /rabbit|chapter|down/i })
        .first()
        .click();
    }
    const body =
      format === "epub"
        ? page.frameLocator(".reader-host iframe").first().locator("body")
        : page.locator(".docx-content");
    await expect(body).toContainText(
      format === "epub" ? "Alice was beginning" : "Thoughtful reading",
    );
    await clickTool(page, "Add bookmark");
    await expect(
      page.getByRole("button", { name: "Remove bookmark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await body.evaluate(
      (body, word) => {
        const doc = body.ownerDocument,
          walker = doc.createTreeWalker(body, 4);
        let node;
        while ((node = walker.nextNode())) {
          const at = node.textContent?.indexOf(word) ?? -1;
          if (at < 0) continue;
          const r = doc.createRange();
          r.setStart(node, at);
          r.setEnd(node, at + word.length);
          const s = doc.getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
          doc.dispatchEvent(new Event("selectionchange"));
          break;
        }
      },
      format === "epub" ? "beginning" : "Thoughtful",
    );
    await expect(page.locator(".passage-popup")).toBeVisible();
    await page
      .getByRole("button", { name: "green highlight", exact: true })
      .click();
    const marks = page.locator(
      format === "epub" ? ".leafmark-highlight" : ".docx-highlights span",
    );
    await expect(marks.first()).toBeVisible();
    await body.evaluate((el) => {
      el.setAttribute("tabindex", "0");
      (el as HTMLElement).focus();
    });
    await body.press("Control+z");
    await expect(marks).toHaveCount(0);
    await body.press("Control+y");
    await expect(marks.first()).toBeVisible();
    await page
      .getByRole("button", { name: "Bookmark passage", exact: true })
      .click();
    await expect(page.locator(".passage-bookmark")).toHaveCount(1);
    await clickTool(page, "Reading settings");
    await page.getByLabel("Text size").fill("24");
    await page.getByLabel("Text size").dispatchEvent("change");
    await page
      .getByRole("button", { name: "Close panel", exact: true })
      .click();
    await expect(page.locator(".passage-bookmark")).toHaveCount(1);
    const toolsMenu = page.getByRole("button", {
      name: "Reading tools",
      exact: true,
    });
    if (
      (await toolsMenu.isVisible()) &&
      (await toolsMenu.getAttribute("aria-expanded")) === "true"
    )
      await toolsMenu.click();
    await page.locator(".passage-bookmark").click();
    await page.getByRole("button", { name: "Meaning", exact: true }).click();
    await expect(
      page.locator(".passage-popup .dictionary-entry").first(),
    ).toBeVisible();
    await page.screenshot({
      path: `.local/floating-${format}-${info.project.name}.png`,
    });
    await page.reload();
    await openTools(page);
    await expect(marks.first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".passage-bookmark")).toHaveCount(1);
  });

test("overlapping highlights require a choice and failed removal keeps the mark", async ({
  page,
}) => {
  await openPdf(page);
  await selectPdf(page);
  await page
    .getByRole("button", { name: "yellow highlight", exact: true })
    .click();
  await page.evaluate(async () => {
    const { db, save } = await import(/* @vite-ignore */ "/src/db.ts");
    const row = (await db.rows.toArray()).find(
      (r: any) => r.kind === "annotation",
    )!;
    await save("annotation", {
      ...row.value,
      id: "overlapping-copy",
      color: "blue",
      text: "Overlapping highlight",
    });
  });
  await selectPdf(page, true);
  await expect(page.locator(".overlap-choices button")).toHaveCount(2);
  await page
    .locator(".overlap-choices button")
    .filter({ hasText: "Overlapping highlight" })
    .click();
  await page.evaluate(async () => {
    const { db } = await import(/* @vite-ignore */ "/src/db.ts");
    const row = await db.rows.get("annotation:overlapping-copy");
    await db.conflicts.put({
      key: row.key,
      local: row,
      remote: { ...row, revision: 8 },
      detectedAt: new Date().toISOString(),
    });
  });
  await page
    .getByRole("button", { name: "Remove highlight", exact: true })
    .click();
  await expect(
    page.getByText(/Resolve the conflicting versions/),
  ).toBeVisible();
  await expect(page.locator(".pdf-highlight")).toHaveCount(2);
  await page.evaluate(async () => {
    const { db } = await import(/* @vite-ignore */ "/src/db.ts");
    await db.conflicts.clear();
  });
  await page
    .getByRole("button", { name: "Remove highlight", exact: true })
    .click();
  await expect(page.locator(".pdf-highlight")).toHaveCount(1);
});
