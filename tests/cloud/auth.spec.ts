import { test, expect, type Page } from "@playwright/test";
const user = { id: "10000000-0000-4000-8000-000000000001", email: "reader@example.invalid", aud: "authenticated", role: "authenticated" };
const session = { access_token: "test-access", refresh_token: "test-refresh", expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: "bearer", user };
async function transport(page: Page, owner = true) {
  await page.context().routeWebSocket("wss://cloud.supabase.co/**", socket => socket.close());
  await page.route("https://cloud.supabase.co/**", route => {
    const p = new URL(route.request().url()).pathname;
    const body = p.includes("/token") ? session : p.endsWith("is_library_owner") ? owner : p.endsWith("/user") ? user : [];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}
async function signIn(page: Page) {
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Open my library" }).click();
}
test("sign-in opens the library and survives reload", async ({ page }) => {
  await transport(page);
  await page.goto("/");
  await signIn(page);
  await expect(page.locator(".library-page")).toBeVisible();
  await page.reload();
  await expect(page.locator(".library-page")).toBeVisible();
});
test("an unauthorized account gets a visible error instead of a silent button reset", async ({ page }) => {
  await transport(page, false);
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText("not the configured library owner");
  // Repeating the same server error must not silently reset the button.
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText("not the configured library owner");
  await expect(page.locator(".library-page")).toHaveCount(0);
});
test("repair removes only this project's stale login and preserves pending private data", async ({ page }) => {
  await transport(page, false);
  await page.goto("/");
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    await db.meta.put({ key: "owner", value: "10000000-0000-4000-8000-000000000001" });
    await db.meta.put({ key: "draft", value: "unsynced writing" });
    await db.files.put({ id: "private-book", source: new Blob(["private bytes"]), uploaded: false });
    await db.outbox.put({ opId: "pending", key: "annotation:pending", sequence: 1 });
    localStorage.setItem("unrelated-setting", "keep");
  });
  await signIn(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Repair sign-in on this device" }).click();
  await expect(page.getByRole("button", { name: "Open my library" })).toBeVisible();
  expect(await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    return { token: localStorage.getItem("sb-cloud-auth-token"), setting: localStorage.getItem("unrelated-setting"),
      owner: (await db.meta.get("owner"))?.value, draft: (await db.meta.get("draft"))?.value,
      files: await db.files.count(), pending: await db.outbox.count() };
  })).toEqual({ token: null, setting: "keep", owner: user.id, draft: "unsynced writing", files: 1, pending: 1 });
});
test("unresponsive sign-in exits the spinner and offers repair", async ({ page }) => {
  await transport(page);
  await page.route("**/auth/v1/token**", async route => {
    await new Promise(resolve => setTimeout(resolve, 20000));
    await route.abort().catch(() => {});
  });
  await page.goto("/");
  await signIn(page);
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 18000 });
  await expect(page.getByRole("button", { name: "Open my library" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Repair sign-in on this device" })).toBeEnabled();
});

test("expired rejected session can sign in again without clearing local storage", async ({ page }) => {
  await transport(page);
  await page.addInitScript(session => {
    localStorage.setItem("sb-cloud-auth-token", JSON.stringify({ ...session, expires_at: 1 }));
  }, session);
  await page.route("**/auth/v1/token?grant_type=refresh_token", route => route.fulfill({
    status: 400, contentType: "application/json", body: JSON.stringify({ error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }),
  }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open my library" })).toBeVisible();
  await signIn(page);
  await expect(page.locator(".library-page")).toBeVisible();
});
test("repair cannot switch a private local library to a different account", async ({ page }) => {
  await transport(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    await db.meta.put({ key: "owner", value: "a-different-owner" });
  });
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText("another account's private library");
  await expect(page.locator(".library-page")).toHaveCount(0);
});
