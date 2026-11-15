import { test, expect, type Page } from "@playwright/test";
const user = { id: "10000000-0000-4000-8000-000000000001", email: "reader@example.invalid", aud: "authenticated", role: "authenticated" };
const session = { access_token: "test-access", refresh_token: "test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user };
async function bound(page: Page) {
  await page.context().routeWebSocket("wss://cloud.supabase.co/**", s => s.close());
  await page.route("https://cloud.supabase.co/**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("is_library_owner") ? true : [] }));
  await page.goto("/");
  await page.evaluate(async ({ user, session }) => {
    const { db } = await import("/src/db.ts");
    await db.meta.put({ key: "owner", value: user.id });
    await db.meta.put({ key: "draft", value: "Writing kept offline" });
    localStorage.setItem("sb-cloud-auth-token", JSON.stringify(session));
  }, { user, session });
}
test("a bound device opens saved content when online status is true but the server cannot be reached", async ({ page }) => {
  await bound(page);
  await page.route("https://cloud.supabase.co/**", route => route.abort("internetdisconnected"));
  await page.reload();
  await expect(page.locator(".library-page")).toBeVisible({ timeout: 18000 });
  await expect(page.locator(".local-access-banner")).toContainText("saved on this device");
  expect(await page.evaluate(async () => (await (await import("/src/db.ts")).db.meta.get("draft"))?.value)).toBe("Writing kept offline");
});
test("expired rejected refresh opens the bound library and offers sign-in for sync", async ({ page }) => {
  await bound(page);
  await page.evaluate(session => localStorage.setItem("sb-cloud-auth-token", JSON.stringify({ ...session, expires_at: 1 })), session);
  await page.route("**/auth/v1/token**", route => route.fulfill({ status: 400, json: { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" } }));
  await page.reload();
  await expect(page.locator(".library-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in to sync", exact: true })).toBeVisible();
});
test("a conflicting cached account is refused even with navigator offline", async ({ page }) => {
  await bound(page);
  await page.evaluate(session => localStorage.setItem("sb-cloud-auth-token", JSON.stringify({ ...session, user: { ...session.user, id: "different-account" } })), session);
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("another account");
  await expect(page.locator(".library-page")).toHaveCount(0);
});
test("an explicit owner denial cannot later be bypassed with offline fallback", async ({ page }) => {
  await bound(page);
  await page.route("**/rpc/is_library_owner", route => route.fulfill({ json: false }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("not the configured library owner");
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true }));
  await page.reload();
  await expect(page.locator(".library-page")).toHaveCount(0);
});
