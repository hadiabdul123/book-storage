import { chromium, test, expect, type BrowserContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { textPdf } from "../helpers/text-pdf";
const user = { id: "10000000-0000-4000-8000-000000000001", email: "reader@example.invalid", aud: "authenticated", role: "authenticated" };
const session = { access_token: "test-access", refresh_token: "test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user };
async function transport(context: BrowserContext) {
  await context.routeWebSocket("wss://cloud.supabase.co/**", s => s.close());
  await context.route("https://cloud.supabase.co/**", async route => {
    const p = new URL(route.request().url()).pathname;
    if (p.includes("/storage/")) { await route.fulfill({ status: 503, body: "Synthetic storage unavailable" }); return; }
    let body: unknown = [];
    if (p.includes("/token")) body = session;
    else if (p.endsWith("/user")) body = user;
    else if (p.endsWith("is_library_owner")) body = true;
    else if (p.endsWith("apply_change")) {
      const op = route.request().postDataJSON().p_operation;
      body = { conflict: false, row: { key: `${op.kind}:${op.id}`, kind: op.kind, id: op.id, value: op.value, revision: 1, deleted: op.deleted, editedAt: op.createdAt, editId: op.opId, updatedAt: op.createdAt } };
    } else if (p.endsWith("/research")) body = { answer: "The universe expands [S1].", model: "test-provider", sources: [{ id: "S1", kind: "web", title: "Synthetic evidence", url: "https://example.org/evidence", excerpt: "Observed expansion.", retrievedAt: new Date().toISOString() }] };
    await route.fulfill({ json: body });
  });
}
test("an authenticated production install opens offline with an expired session and resumes queued research after reconnect", async ({ baseURL }) => {
  const root = path.resolve(".local"); const profile = mkdtempSync(path.join(root, "auth-pwa-"));
  const options = { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined };
  let context = await chromium.launchPersistentContext(profile, options);
  try {
    await transport(context); const page = await context.newPage();
    await page.goto(baseURL!);
    await page.getByLabel("Email", { exact: true }).fill(user.email); await page.getByLabel("Password", { exact: true }).fill("synthetic-password"); await page.getByRole("button", { name: "Open my library" }).click();
    await expect(page.locator(".library-page")).toBeVisible();
    await page.locator("input[type=file]").setInputFiles({ name: "offline-auth.pdf", mimeType: "application/pdf", buffer: textPdf(["The universe is expanding."]) });
    await expect(page.locator(".book-card")).toHaveCount(1);
    await page.goto(new URL("#/notebooks", baseURL!).href);
    await page.getByRole("button", { name: "New notebook", exact: true }).click(); await page.getByLabel("Notebook name").fill("Authenticated offline notebook"); await page.getByRole("button", { name: "Create notebook", exact: true }).click();
    await page.getByRole("button", { name: "New page", exact: true }).click(); await page.getByRole("textbox", { name: "Topic note title" }).fill("Offline writing"); await page.getByRole("textbox", { name: "Topic note content" }).fill("Saved before the offline restart."); await page.getByRole("button", { name: "Save now", exact: true }).click(); await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    // First install activates without claiming an already-open page. Navigate
    // once under the worker before clearing the ordinary browser cache.
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Topic note content" })).toContainText("before the offline restart");
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.evaluate(session => localStorage.setItem("sb-cloud-auth-token", JSON.stringify({ ...session, expires_at: 1 })), session);
    const cdp = await context.newCDPSession(page); await cdp.send("Network.clearBrowserCache"); await cdp.detach();
    await context.close();
    context = await chromium.launchPersistentContext(profile, { ...options, offline: true });
    await transport(context); const offlinePage = await context.newPage();
    const errors: string[] = []; offlinePage.on("pageerror", e => errors.push(e.message));
    await offlinePage.goto(baseURL!); await expect(offlinePage.locator(".library-page")).toBeVisible(); await expect(offlinePage.locator(".book-card")).toHaveCount(1);
    await expect(offlinePage.getByRole("button", { name: "Open my library" })).toHaveCount(0);
    await offlinePage.locator(".book-cover-link").click(); await expect(offlinePage.locator(".textLayer")).toContainText("universe");
    await offlinePage.goto(new URL("#/notebooks", baseURL!).href); await offlinePage.getByRole("button", { name: /^Offline writing/ }).click();
    await expect(offlinePage.getByRole("textbox", { name: "Topic note content" })).toContainText("before the offline restart");
    await offlinePage.getByRole("textbox", { name: "Topic note content" }).fill("Edited while fully offline."); await offlinePage.getByRole("button", { name: "Save now", exact: true }).click(); await expect(offlinePage.locator(".topic-save-status")).toContainText("Saved on this device");
    await offlinePage.getByRole("button", {name:"Page options",exact:true}).click();
    await offlinePage.getByRole("button", { name: "Research", exact: true }).click();
    await offlinePage.getByRole("textbox", { name: "Research question" }).fill("What is cosmic expansion?");
    await offlinePage.getByText("More actions", { exact: true }).click();
    await offlinePage.getByRole("button", { name: "Search the web", exact: true }).click();
    await expect(offlinePage.locator(".research-pending")).toContainText("cosmic expansion");
    await context.setOffline(false); await offlinePage.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(offlinePage.locator(".research-answer")).toContainText("universe expands", { timeout: 25000 });
    await offlinePage.getByRole("tab", { name: "Notes", exact: true }).click();
    await expect(offlinePage.getByRole("textbox", { name: "Topic note content" })).toContainText("Edited while fully offline");
    expect(errors).toEqual([]);
  } finally { await context.close(); if (path.dirname(profile) !== root) throw new Error("Unexpected test profile"); rmSync(profile, { recursive: true, force: true }); }
});
