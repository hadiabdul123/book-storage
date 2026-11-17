import { showPassageAction } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { clickTool, openTools } from "./controls";
import { textPdf } from "../helpers/text-pdf";

async function open(page: Page) {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name: "dictionary-lines.pdf", mimeType: "application/pdf", buffer: textPdf(["differ-", "ence", "psychic energy", "psychic entropy"]) });
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  await openTools(page);
  await expect(page.locator(".textLayer span").filter({ hasText: /^differ-$/ })).toBeVisible();
}
async function lookUp(page: Page, term: string) {
  await page.getByLabel("Dictionary word").fill(term);
  await page.getByRole("button", { name: "Look up", exact: true }).click();
}
async function annotation(page: Page) {
  return page.evaluate(async () => {
    const { db } = await import(/* @vite-ignore */ "/src/db.ts");
    const row = (await db.rows.toArray()).find((row: any) => row.kind === "annotation");
    return { text: row.value.text, locator: row.value.locator };
  });
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true"));
});

test("split-line lookup and phrase glossary preserve the original saved highlight", async ({ page }, info) => {
  const requests: string[] = [];
  await page.route("https://*.wikipedia.org/**", async (route) => { requests.push(route.request().url()); await route.abort(); });
  await open(page);
  const original = await page.locator(".textLayer").first().evaluate((layer) => {
    const spans = [...layer.querySelectorAll("span")];
    const start = spans.find((span) => span.textContent === "differ-")!;
    const end = spans.find((span) => span.textContent === "ence")!;
    const range = document.createRange();
    range.setStart(start.firstChild!, 0);
    range.setEnd(end.firstChild!, 4);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return selection.toString();
  });
  await showPassageAction(page, "yellow highlight");
  await page.getByRole("button", { name: "yellow highlight", exact: true }).click();
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  const saved = await annotation(page);
  expect(saved.text).toBe(original);
  await showPassageAction(page, "Meaning");
  await page.getByRole("button", { name: "Meaning", exact: true }).click();
  await expect(page.locator(".dictionary-entry h3").first()).toHaveText("difference");
  await expect(page.locator(".lookup-resolution")).toContainText("difference");
  await page.getByRole("button", { name: "Change word", exact: true }).click();
  await lookUp(page, "psychic entropy");
  await expect(page.locator(".dictionary-entry").first()).toContainText("Flow / attention");
  await expect(page.locator(".dictionary-example").first()).toContainText("unfinished task");
  await page.screenshot({ path: `.local/meaning-upgrade-${info.project.name}.png` });
  await lookUp(page, "psychic energy");
  await page.getByRole("button", { name: "More meanings", exact: true }).click();
  await expect(page.locator(".dictionary-entry").nth(1)).toContainText("Psychoanalytic theory");
  expect(requests).toEqual([]);
  await page.reload();
  await openTools(page);
  await expect(page.locator(".pdf-highlight").first()).toBeVisible();
  expect(await annotation(page)).toEqual(saved);
});

test("automatic online references retain attribution, persist offline, and respect the device toggle", async ({ page, context }) => {
  const requests: string[] = [];
  await page.route("https://*.wikipedia.org/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ json: { query: { pages: [{ ns: 0, title: "Cognitive dissonance", extract: "Discomfort when beliefs and actions conflict." }] } } });
  });
  await open(page);
  await clickTool(page, "Dictionary");
  await lookUp(page, "cognitive dissonance");
  await expect(page.locator(".dictionary-reference")).toContainText("Discomfort when beliefs");
  expect(requests).toHaveLength(1);
  const request = new URL(requests[0]);
  expect(request.searchParams.get("titles")).toBe("cognitive dissonance");
  await page.locator(".dictionary-reference").getByRole("button", { name: "Add to page note" }).click();
  await expect(page.getByRole("textbox", { name: "Notebook for page 1" })).toContainText("CC BY-SA 4.0");
  await expect(page.getByRole("textbox", { name: "Notebook for page 1" })).toContainText("Retrieved:");
  await clickTool(page, "Dictionary");
  await lookUp(page, "cognitive dissonance");
  await expect(page.locator(".dictionary-reference")).toBeVisible();
  await page.getByLabel("Use online references").uncheck();
  await expect(page.locator(".dictionary-reference")).toBeVisible();
  await page.reload();
  await openTools(page);
  await clickTool(page, "Dictionary");
  await expect(page.getByLabel("Use online references")).not.toBeChecked();
  await context.setOffline(true);
  await lookUp(page, "cognitive dissonance");
  await expect(page.locator(".dictionary-reference")).toContainText("Discomfort when beliefs");
  await lookUp(page, "unknown specialist phrase");
  await expect(page.locator(".meaning-panel")).toContainText("Online references are turned off");
  expect(requests).toHaveLength(1);
});

test("local meanings stay visible during online lookup and obsolete responses cannot replace a new query", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const requests: string[] = [];
  await page.route("https://*.wikipedia.org/**", async (route) => {
    requests.push(route.request().url());
    await held;
    await route.fulfill({ json: { query: { pages: [{ ns: 0, title: "Old response", extract: "An old explanation." }] } } }).catch(() => {});
  });
  await open(page);
  await clickTool(page, "Dictionary");
  await lookUp(page, "psychic entropy");
  await expect(page.locator(".dictionary-entry")).toContainText("Plain-English explanation");
  await page.getByRole("button", { name: "Find another explanation" }).click();
  await expect(page.locator(".meaning-panel")).toContainText("Looking for an online reference");
  await expect(page.locator(".dictionary-entry")).toContainText("worries");
  await expect.poll(() => requests.length).toBe(1);
  await lookUp(page, "comfort");
  release();
  await expect(page.locator(".dictionary-entry h3").first()).toHaveText("comfort");
  await expect(page.locator(".dictionary-reference")).toHaveCount(0);
  await lookUp(page, "one two three four five");
  await expect(page.locator(".meaning-panel")).toContainText("four words");
  expect(requests).toHaveLength(1);
});
