import { expect, test, type BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// This is a transport-contract test, not a substitute for live Supabase/RLS tests.
// Both browser contexts use separate IndexedDB stores; no real service is contacted.
test("two devices transfer original bytes, notes, bookmarks and offline access", async ({
  browser,
  baseURL,
}) => {
  const user = {
    id: "10000000-0000-4000-8000-000000000001",
    email: "reader@example.invalid",
    aud: "authenticated",
    role: "authenticated",
  };
  const jwt = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.dGVzdA`;
  const session = {
    access_token: jwt,
    refresh_token: "test-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: "bearer",
    user,
  };
  const rows = new Map<string, any>(),
    receipts = new Map<string, any>();
  const objects = new Map<string, Buffer>(),
    uploads = new Map<string, { path: string; bytes: Buffer }>();
  let revision = 0;
  const install = async (context: BrowserContext) => {
    await context.addInitScript(
      ({ session }) => {
        if (!localStorage.getItem("test-auth-initialized")) {
          localStorage.setItem("sb-cloud-auth-token", JSON.stringify(session));
          localStorage.setItem("test-auth-initialized", "true");
        }
        if (localStorage.getItem("test-offline"))
          Object.defineProperty(navigator, "onLine", { get: () => false });
      },
      { session },
    );
    await context.routeWebSocket("wss://cloud.supabase.co/**", (socket) =>
      socket.close(),
    );
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.hostname === "127.0.0.1") return route.continue();
      if (url.hostname !== "cloud.supabase.co") return route.abort();
      const p = url.pathname;
      const json = (body: any, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (p === "/auth/v1/user") return json(user);
      if (p === "/rest/v1/rpc/is_library_owner") return json(true);
      if (p === "/rest/v1/rpc/pull_changes") {
        const after = request.postDataJSON().p_after;
        return json(
          [...rows.values()]
            .filter((row) => row.revision > after)
            .sort((a, b) => a.revision - b.revision)
            .slice(0, 200),
        );
      }
      if (p === "/rest/v1/rpc/apply_change") {
        const op = request.postDataJSON().p_operation;
        if (receipts.has(op.opId)) return json(receipts.get(op.opId));
        const prior = rows.get(op.key);
        if ((prior?.revision || 0) !== op.baseRevision)
          return json({ conflict: true, row: prior });
        const row = {
          key: op.key,
          kind: op.kind,
          id: op.id,
          value: op.value,
          deleted: op.deleted,
          revision: ++revision,
          updatedAt: new Date().toISOString(),
        };
        rows.set(op.key, row);
        const result = { conflict: false, row };
        receipts.set(op.opId, result);
        return json(result);
      }
      if (p.startsWith("/storage/v1/upload/resumable")) {
        const headers = {
          "Tus-Resumable": "1.0.0",
          "Access-Control-Expose-Headers": "Location, Upload-Offset, Tus-Resumable",
        };
        if (request.method() === "POST") {
          const meta = Object.fromEntries(
            (request.headers()["upload-metadata"] || "")
              .split(",")
              .map((pair) => {
                const [k, v] = pair.trim().split(" ");
                return [k, Buffer.from(v || "", "base64").toString()];
              }),
          );
          const id = String(uploads.size + 1);
          uploads.set(id, { path: meta.objectName, bytes: Buffer.alloc(0) });
          return route.fulfill({
            status: 201,
            headers: {
              ...headers,
              Location: `https://cloud.supabase.co/storage/v1/upload/resumable/${id}`,
              "Upload-Offset": "0",
            },
          });
        }
        const upload = uploads.get(p.split("/").pop()!);
        if (!upload) return json({ message: "Not found" }, 404);
        if (request.method() === "PATCH") {
          expect(Number(request.headers()["upload-offset"])).toBe(
            upload.bytes.length,
          );
          upload.bytes = Buffer.concat([
            upload.bytes,
            request.postDataBuffer() || Buffer.alloc(0),
          ]);
          objects.set(upload.path, upload.bytes);
        }
        return route.fulfill({
          status: request.method() === "HEAD" ? 200 : 204,
          headers: { ...headers, "Upload-Offset": String(upload.bytes.length) },
        });
      }
      if (p.startsWith("/storage/v1/object/library/")) {
        expect(request.headers().authorization).toBe(`Bearer ${jwt}`);
        const data = objects.get(decodeURIComponent(p.split("/library/")[1]));
        return data
          ? route.fulfill({
              status: 200,
              body: data,
              contentType: "application/pdf",
            })
          : json({ message: "Not found" }, 404);
      }
      return json({ message: `Unexpected request: ${p}` }, 500);
    });
  };
  const pc = await browser.newContext(),
    phone = await browser.newContext({
      viewport: { width: 412, height: 850 },
      isMobile: true,
      hasTouch: true,
    });
  try {
    await install(pc);
    await install(phone);
    const first = await pc.newPage();
    await first.goto(baseURL!);
    await first
      .locator("input[type=file]")
      .setInputFiles(path.resolve("tests/fixtures/tracemonkey.pdf"));
    await expect(first.locator(".book-sync-status")).toContainText("Synced", {
      timeout: 30000,
    });
    const expected = createHash("sha256")
      .update(readFileSync("tests/fixtures/tracemonkey.pdf"))
      .digest("hex");
    expect(
      createHash("sha256")
        .update([...objects.values()][0])
        .digest("hex"),
    ).toBe(expected);
    await first.locator(".book-cover-link").click();
    await expect(first.locator(".reader-loading")).toHaveCount(0);
    await first
      .getByRole("button", { name: "Page notes", exact: true })
      .click();
    await first
      .getByRole("textbox", { name: "Notebook for page 1", exact: true })
      .fill("A note shared between devices");
    await first.getByRole("button", { name: "Save now" }).click();
    await first.getByRole("button", { name: "Close panel" }).click();
    await first
      .getByRole("button", { name: "Add bookmark", exact: true })
      .click();
    await first.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(first.locator(".reader-progress")).toContainText("Page 2");
    await first.getByRole("link", { name: "Back to library" }).click();
    await expect(first.locator(".sync-status")).toContainText("Synced");
    await expect
      .poll(() =>
        [...rows.values()].some(
          (row) => row.kind === "position" && row.value.locator.page === 2,
        ),
      )
      .toBe(true);
    const second = await phone.newPage();
    await second.goto(baseURL!);
    await expect(second.locator(".book-card")).toHaveCount(1);
    await expect(second.locator(".book-sync-status")).toContainText(
      "Download when opened",
    );
    await second.locator(".book-cover-link").click();
    await expect(second.locator(".reader-progress")).toContainText("Page 2", {
      timeout: 30000,
    });
    await second
      .getByRole("button", { name: "Previous page", exact: true })
      .click();
    await expect(
      second.getByRole("button", { name: "Remove bookmark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await second
      .getByRole("button", { name: "Page notes", exact: true })
      .click();
    await expect(
      second.getByRole("textbox", { name: "Notebook for page 1", exact: true }),
    ).toContainText("A note shared between devices");
    await second.getByRole("button", { name: "Close panel" }).click();
    // Offline authorization with an expired/missing session; asset persistence
    // across a real offline browser restart is covered separately by test:pwa.
    await second.evaluate(() => {
      localStorage.removeItem("sb-cloud-auth-token");
      localStorage.setItem("test-offline", "true");
    });
    await second.reload();
    await expect(second.locator(".pdf-page canvas").first()).toBeVisible({
      timeout: 30000,
    });
    await expect(
      second.getByRole("button", { name: "Open my library" }),
    ).toHaveCount(0);
  } finally {
    await pc.close();
    await phone.close();
  }
});
