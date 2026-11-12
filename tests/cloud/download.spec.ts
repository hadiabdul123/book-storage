import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const bytes = readFileSync("tests/fixtures/tracemonkey.pdf");
const hash = createHash("sha256").update(bytes).digest("hex");
const user = { id: "10000000-0000-4000-8000-000000000001", email: "reader@example.invalid", aud: "authenticated", role: "authenticated" };
const book = { id: "download-book", title: "Download recovery", author: "Fixture", description: "", format: "pdf", filename: "fixture.pdf", hash,
  bytes: bytes.length, tags: [], status: "reading", addedAt: "2026-11-12", sourcePath: "fixture.pdf" };
const position = { id: book.id, bookId: book.id, locator: { v: 1, type: "pdf", hash, page: 2, y: 0 }, progress: 0.1, readAt: "2026-11-12T12:00:00Z", device: "other-device" };
const note = { id: "retained-note", bookId: book.id, locator: position.locator, text: "Saved passage", note: "Keep this cloud note", color: "yellow", tags: [], createdAt: "2026-11-12" };
async function setup(page: Page, replies: Array<"abort" | "valid" | "corrupt" | "forbidden">) {
  const nonces: string[] = [];
  await page.addInitScript(({ user }) => {
    localStorage.setItem("leafmark-controls-pinned", "true");
    localStorage.setItem("sb-cloud-auth-token", JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh", expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: "bearer", user }));
    const original = window.fetch;
    (window as any).downloadCacheModes = [];
    window.fetch = (input, init) => {
      if (String(input).includes("/storage/v1/object/library/"))
        (window as any).downloadCacheModes.push(init?.cache);
      return original(input, init);
    };
  }, { user });
  await page.context().routeWebSocket("wss://cloud.supabase.co/**", socket => socket.close());
  await page.route("https://cloud.supabase.co/**", route => {
    const request = route.request(), url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("is_library_owner")) return json(true);
    if (url.pathname.endsWith("/auth/v1/user")) return json(user);
    if (url.pathname.endsWith("pull_changes")) return json(request.postDataJSON().p_after ? [] : [
      { key: `book:${book.id}`, kind: "book", id: book.id, value: book, revision: 1, deleted: false },
      { key: `position:${book.id}`, kind: "position", id: book.id, value: position, revision: 2, deleted: false },
      { key: `annotation:${note.id}`, kind: "annotation", id: note.id, value: note, revision: 3, deleted: false },
    ]);
    if (url.pathname.endsWith("apply_change")) {
      const op = request.postDataJSON().p_operation;
      return json({ conflict: false, row: { ...op, revision: 100, updatedAt: new Date().toISOString() } });
    }
    if (url.pathname.includes("/storage/v1/object/library/")) {
      expect(request.headers().authorization).toBe("Bearer test-access");
      expect(url.pathname).toBe(`/storage/v1/object/library/${user.id}/fixture.pdf`);
      nonces.push(url.searchParams.get("cacheNonce") || "");
      const reply = replies.shift() || "valid";
      if (reply === "abort") return route.abort("failed");
      if (reply === "forbidden") return json({ statusCode: "403", message: "Forbidden", error: "AccessDenied" }, 403);
      return route.fulfill({ contentType: "application/pdf", body: reply === "valid" ? bytes : bytes.subarray(0, 100) });
    }
    return json({ message: "Unexpected request" }, 500);
  });
  await page.goto("/");
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator(".book-cover-link").click();
  return nonces;
}

test("an interrupted download retries with fresh cache keys, restores position and stays offline", async ({ page }) => {
  const nonces = await setup(page, ["abort", "valid"]);
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  expect(nonces).toHaveLength(2);
  expect(new Set(nonces).size).toBe(2);
  expect(nonces.every(Boolean)).toBe(true);
  expect(await page.evaluate(() => (window as any).downloadCacheModes)).toEqual(["no-store", "no-store"]);
  expect(await page.evaluate(async () => {
    const { db } = await import("/src/db.ts");
    const file = await db.files.get("download-book");
    const digest = await crypto.subtle.digest("SHA-256", await file!.source.arrayBuffer());
    return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
  })).toBe(hash);
  await page.evaluate(async () => {
    Object.defineProperty(navigator, "onLine", { get: () => false });
    const { downloadBook } = await import("/src/sync.ts");
    const { db } = await import("/src/db.ts");
    await downloadBook((await db.rows.get("book:download-book"))!.value as any);
  });
  expect(nonces).toHaveLength(2);
});

for (const width of [1280, 390]) test(`failed transfer offers accessible retry at ${width}px without losing notes`, async ({ page }) => {
  await page.setViewportSize({ width, height: 850 });
  const nonces = await setup(page, ["abort", "abort", "valid"]);
  await expect(page.getByRole("alert")).toContainText("book download was interrupted");
  await expect(page.locator(".resume-reading")).toHaveCount(0);
  expect(nonces).toHaveLength(2);
  expect(await page.evaluate(async () => (await import("/src/db.ts")).db.files.count())).toBe(0);
  await page.getByRole("button", { name: "Retry opening book" }).click();
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(nonces).toHaveLength(3);
  expect(await page.evaluate(async () => (await (await import("/src/db.ts")).db.rows.get("annotation:retained-note"))!.value.note)).toBe("Keep this cloud note");
});

test("access denial is not retried and corrupt bytes never become an offline copy", async ({ page }) => {
  const nonces = await setup(page, ["forbidden", "corrupt"]);
  await expect(page.getByRole("alert")).toContainText("Sign in again");
  expect(nonces).toHaveLength(1);
  await page.getByRole("button", { name: "Retry opening book" }).click();
  await expect(page.getByRole("alert")).toContainText("did not match this book");
  expect(nonces).toHaveLength(2);
  expect(await page.evaluate(async () => (await import("/src/db.ts")).db.files.count())).toBe(0);
});


test("book opens and persists when Chrome's network blob reader fails", async ({ page }) => {
  await page.addInitScript(() => {
    Response.prototype.blob = async function () {
      throw new TypeError("Failed to fetch");
    };
  });
  const nonces = await setup(page, ["valid"]);
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  expect(nonces).toHaveLength(1);
  expect(await page.evaluate(async () => {
    const file = await (await import("/src/db.ts")).db.files.get("download-book");
    return { size: file!.source.size, type: file!.source.type };
  })).toEqual({ size: bytes.length, type: "application/pdf" });
  await page.reload();
  await expect(page.locator(".reader-progress")).toContainText("Page 2");
  expect(nonces).toHaveLength(1);
});
