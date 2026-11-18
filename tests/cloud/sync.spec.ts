import { compareEdits } from "../../src/syncOrder";
import { openTools, clickTool } from "../e2e/controls";
import { expect, test, type BrowserContext } from "@playwright/test";
import { scanPdf } from "../helpers/scanned-pdf";
import { createHash } from "node:crypto";
import { wavFixture } from "../helpers/audio-fixture";

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
    uploads = new Map<string, { path: string; bytes: Buffer; length: string }>();
  let revision = 0;
  let interruptedMedia = false;
  const install = async (context: BrowserContext) => {
    await context.addInitScript(
      ({ session }) => {
        localStorage.setItem("leafmark-controls-pinned", "true");
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
        if (["notebook-media", "notebook-image"].includes(op.kind) && !op.deleted)
          expect(objects.get(`${user.id}/${op.value.noteId}/${op.id}.${op.value.extension}`)?.length).toBe(op.value.size);
        if (receipts.has(op.opId)) return json(receipts.get(op.opId));
        const prior = rows.get(op.key);
        const candidate = { ...op, editedAt: op.createdAt, editId: op.opId, updatedAt: op.createdAt };
        if (prior && compareEdits(candidate, prior) <= 0) {
          const result = { conflict: false, superseded: true, row: prior };
          receipts.set(op.opId, result);
          return json(result);
        }
        const row = {
          key: op.key,
          kind: op.kind,
          id: op.id,
          value: op.value,
          deleted: op.deleted,
          revision: ++revision,
          updatedAt: new Date().toISOString(),
          editedAt: op.createdAt,
          editId: op.opId,
        };
        rows.set(op.key, row);
        const result = { conflict: false, row };
        receipts.set(op.opId, result);
        return json(result);
      }
      if (p.startsWith("/storage/v1/upload/resumable")) {
        const headers = {
          "Tus-Resumable": "1.0.0",
          "Access-Control-Expose-Headers":
            "Location, Upload-Offset, Upload-Length, Tus-Resumable",
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
          uploads.set(id, { path: meta.objectName, bytes: Buffer.alloc(0), length: request.headers()["upload-length"] });
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
          if (upload.path.endsWith(".wav") && !interruptedMedia) {
            interruptedMedia = true;
            return route.fulfill({ status: 503, headers });
          }
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
          headers: { ...headers, "Upload-Offset": String(upload.bytes.length), "Upload-Length": upload.length },
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
      if (p.startsWith("/storage/v1/object/sign/notebook-media/") && request.method() === "POST") {
        const path = decodeURIComponent(p.split("/notebook-media/")[1]);
        return objects.has(path) ? json({ signedURL: `/object/sign/notebook-media/${path}?token=test` }) : json({ message: "Not found" }, 404);
      }
      if (p.startsWith("/storage/v1/object/notebook-media/") || p.startsWith("/storage/v1/object/sign/notebook-media/")) {
        const data = objects.get(decodeURIComponent(p.split("/notebook-media/")[1]));
        if (!data) return json({ message: "Not found" }, 404);
        if (p.endsWith(".png")) return route.fulfill({ status: 200, body: data, contentType: "image/png" });
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || "");
        if (!range) return route.fulfill({ status: 200, body: data, contentType: "audio/wav", headers: { "Accept-Ranges": "bytes" } });
        const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
        return route.fulfill({ status: 206, body: data.subarray(start, end + 1), contentType: "audio/wav",
          headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${data.length}` } });
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
    const original = await scanPdf(first, false, 2);
    await first.locator("input[type=file]").setInputFiles({ name: "Shared scan.pdf", mimeType: "application/pdf", buffer: original });
    await expect(first.locator(".book-sync-status")).toContainText("Synced", {
      timeout: 30000,
    });
    const expected = createHash("sha256")
      .update(original)
      .digest("hex");
    expect(
      createHash("sha256")
        .update([...objects.values()][0])
        .digest("hex"),
    ).toBe(expected);
    await expect(first.locator(".book-preparation")).toContainText("Text ready", { timeout: 60_000 });
    await expect.poll(() => [...rows.values()].some(row => row.kind === "book" && row.value.preparedTextPath && objects.has(`${user.id}/${row.value.preparedTextPath}`)), { timeout: 30_000 }).toBe(true);
    expect([...uploads.values()].filter(upload => upload.path.endsWith("/source.pdf"))).toHaveLength(1);
    await first.locator(".book-cover-link").click();
    await openTools(first);
    await expect(first.locator(".reader-loading")).toHaveCount(0);
    await clickTool(first, "Page notes");
    await first
      .getByRole("textbox", { name: "Notebook for page 1", exact: true })
      .fill("A note shared between devices");
    await first.getByRole("button", { name: "Save now" }).click();
    await first.getByRole("button", { name: "Close panel" }).click();
    await clickTool(first, "Add bookmark");
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
    await phone.addInitScript(() => {
      (window as any).__ocrJobs = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message: any, ...args: any[]) {
        if (message?.action === "recognize") (window as any).__ocrJobs++;
        return (post as any).call(this, message, ...args);
      };
    });
    await phone.route("**/ocr/**", route => route.abort());
    const second = await phone.newPage();
    await second.goto(baseURL!);
    await expect(second.locator(".book-card")).toHaveCount(1);
    await expect(second.locator(".book-sync-status")).toContainText(
      "Download when opened",
    );
    await second.locator(".book-cover-link").click();
    await openTools(second);
    await expect(second.locator(".reader-progress")).toContainText("Page 2", {
      timeout: 30000,
    });
    await expect(second.locator('.pdf-page[data-page="2"] .ocr-text-layer')).toContainText("Reading opens");
    expect(await second.evaluate(() => (window as any).__ocrJobs)).toBe(0);
    await second
      .getByRole("button", { name: "Previous page", exact: true })
      .click();
    await expect(
      second.getByRole("button", { name: "Remove bookmark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await clickTool(second, "Page notes");
    await expect(
      second.getByRole("textbox", { name: "Notebook for page 1", exact: true }),
    ).toContainText("A note shared between devices");
    // No manual sync button: a new PC edit uploads on save, and returning to
    // the phone pulls it for the notebook reopened below.
    await first.locator(".book-cover-link").click();
    await openTools(first);
    if (
      (await first.locator(".reader-progress").innerText()).includes("Page 2")
    )
      await first
        .getByRole("button", { name: "Previous page", exact: true })
        .click();
    await clickTool(first, "Page notes");
    await first
      .getByRole("textbox", { name: "Notebook for page 1", exact: true })
      .fill("Automatic sync on return");
    await first.getByRole("button", { name: "Save now" }).click();
    await expect(first.locator(".notebook-status")).toHaveText(
      "Saved on this device",
    );
    await expect
      .poll(
        () =>
          [...rows.values()].some(
            (row) =>
              row.kind === "annotation" &&
              JSON.stringify(row.value).includes("Automatic sync on return"),
          ),
        { timeout: 20000 },
      )
      .toBe(true);
    await second.evaluate(() => window.dispatchEvent(new Event("focus")));
    await second.getByRole("button", { name: "Close panel" }).click();
    await clickTool(second, "Page notes");
    await expect(
      second.getByRole("textbox", { name: "Notebook for page 1", exact: true }),
    ).toContainText("Automatic sync on return");
    await second.getByRole("button", { name: "Close panel" }).click();
    // Two isolated devices edit the same highlight offline. Exercise both
    // upload orders: the later removal must win without a Settings visit.
    await first.getByRole("button", { name: "Close panel" }).click();
    await first.getByRole("link", { name: "Back to library", exact: true }).click();
    await second.getByRole("link", { name: "Back to library", exact: true }).click();
    for (const deleteUploadsFirst of [true, false]) {
      const id = `hello-${deleteUploadsFirst}`;
      await first.evaluate(async (id) => {
        const { list, save } = await import("/src/db.ts");
        const book = (await list("book"))[0];
        await save("annotation", { id, bookId: book.id, text: "hello", note: "", color: "yellow", tags: [],
          createdAt: new Date().toISOString(), locator: { v: 1, type: "pdf", hash: book.hash, page: 1, y: 0 } });
      }, id);
      await expect.poll(() => rows.has(`annotation:${id}`)).toBe(true);
      await second.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => second.evaluate(async (id) => {
        const { db } = await import("/src/db.ts"); return !!(await db.rows.get(`annotation:${id}`));
      }, id)).toBe(true);
      for (const device of [first, second]) await device.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        window.dispatchEvent(new Event("offline"));
      });
      await first.evaluate(async (id) => {
        const { get, save } = await import("/src/db.ts");
        await save("annotation", { ...(await get("annotation", id))!, color: "blue" });
      }, id);
      await second.evaluate(async (id) => {
        const { db, get, save } = await import("/src/db.ts");
        const row = (await db.rows.get(`annotation:${id}`))!;
        // An old-version conflict must not block this new explicit removal.
        await db.conflicts.put({ key: row.key, local: row, remote: row, detectedAt: new Date().toISOString() });
        await save("annotation", (await get("annotation", id))!, true);
      }, id);
      for (const device of deleteUploadsFirst ? [second, first] : [first, second]) {
        await device.evaluate(() => {
          Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
          window.dispatchEvent(new Event("online"));
        });
        await expect.poll(() => device.evaluate(async () => {
          const { db } = await import("/src/db.ts"); return db.outbox.count();
        })).toBe(0);
      }
      expect(rows.get(`annotation:${id}`).deleted).toBe(true);
      for (const device of [first, second]) {
        await device.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => device.evaluate(async (id) => {
          const { db } = await import("/src/db.ts");
          return { deleted: (await db.rows.get(`annotation:${id}`))?.deleted, conflicts: await db.conflicts.count() };
        }, id)).toEqual({ deleted: true, conflicts: 0 });
      }
    }
    await first.goto(new URL("/#/notebooks", baseURL!).href);
    await first.getByRole("button", { name: "New notebook", exact: true }).click();
    await first.getByLabel("Notebook name").fill("Shared seminar");
    await first.getByRole("button", { name: "Create notebook" }).click();
    await expect(first.getByRole("dialog").filter({ has: first.getByRole("heading", { name: "New notebook" }) })).toBeHidden();
    await expect(first.locator(".notebook-detail-actions")).toContainText("Shared seminar");
    await first.getByRole("button", { name: "New note", exact: true }).click();
    const writing = first.getByRole("textbox", { name: "Topic note content" });
    await expect(writing).toHaveAttribute("contenteditable", "true");
    await writing.fill("Return to this moment. ");
    await first.getByLabel("Attach image, video or audio").setInputFiles({ name: "seminar.wav", mimeType: "audio/wav", buffer: wavFixture() });
    await expect.poll(() => [...rows.values()].some(row => row.kind === "notebook-media" && !row.deleted), { timeout: 20000 }).toBe(true);
    expect(interruptedMedia).toBe(true);
    const media = [...rows.values()].find(row => row.kind === "notebook-media").value;
    await expect.poll(() => first.locator("audio").evaluate((element: HTMLAudioElement) => element.duration)).toBe(3);
    await first.locator("audio").evaluate((element: HTMLAudioElement) => { element.currentTime = 1.5; });
    await first.getByRole("button", { name: "More actions for seminar.wav" }).click();
    await first.getByRole("menuitem", { name: "Insert timestamp", exact: true }).click();
    await expect.poll(() => JSON.stringify(rows.get(`notebook-note:${media.noteId}`)?.value.document)).toContain("&at=1.5");
    await second.goto(new URL(`/#/notebooks?note=${media.noteId}`, baseURL!).href);
    await second.getByRole("link", { name: "0:01" }).click();
    await expect.poll(() => second.locator("audio").evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(1.5, 1);
    const seminarMenu = second.getByRole("button", { name: "More actions for seminar.wav" });
    await seminarMenu.click();
    await second.getByRole("menuitem", { name: "Keep offline" }).click();
    await expect.poll(() => second.evaluate(async id => Boolean(await (await import("/src/db.ts")).db.mediaFiles.get(id)), media.id)).toBe(true);

    const image = await first.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 16; canvas.height = 12;
      canvas.getContext("2d")!.fillRect(0, 0, 16, 12);
      return canvas.toDataURL().split(",")[1];
    });
    await first.getByLabel("Attach image, video or audio").setInputFiles({ name: "diagram.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
    await expect.poll(() => [...rows.values()].some(row => row.kind === "notebook-image" && row.value.placement?.after), { timeout: 20_000 }).toBe(true);
    await first.getByRole("button", { name: "More actions for diagram.png" }).click();
    await first.getByRole("menuitem", { name: "Move freely" }).click();
    await expect.poll(() => [...rows.values()].find(row => row.kind === "notebook-image")?.value.placement?.free?.width).toBe(.45);
    await second.reload();
    const diagram = second.getByRole("figure", { name: "Attachment: diagram.png" });
    await diagram.scrollIntoViewIfNeeded();
    await expect(diagram.getByRole("img", { name: "diagram.png" })).toBeVisible();
    await expect(second.locator(".notebook-free-media").getByRole("figure", { name: "Attachment: diagram.png" })).toBeVisible();
    await diagram.getByRole("button", { name: "More actions for diagram.png" }).click();
    await second.getByRole("menuitem", { name: "Keep offline" }).click();
    const imageId = [...rows.values()].find(row => row.kind === "notebook-image").id;
    await expect.poll(() => second.evaluate(async id => Boolean(await (await import("/src/db.ts")).db.mediaFiles.get(id)), imageId)).toBe(true);

    const highlightId = await first.evaluate(async () => {
      const { list, save } = await import("/src/db.ts");
      const book = (await list("book"))[0];
      const id = crypto.randomUUID();
      await save("annotation", { id, bookId: book.id, locator: { v: 1, type: "pdf", page: 1, y: .2, hash: book.hash },
        text: "A highlight with shared follow-ups", note: "Original note", color: "yellow", tags: [], createdAt: new Date().toISOString() });
      return id;
    });
    await expect.poll(() => rows.has(`annotation:${highlightId}`)).toBe(true);
    const addFollowup = async (device: typeof first, text: string) => {
      await device.goto(new URL(`/#/notes?item=${highlightId}`, baseURL!).href);
      await device.getByRole("button", { name: "Add follow-up note" }).click();
      await device.getByLabel("New follow-up note").fill(text);
      await device.getByRole("button", { name: "Save follow-up note" }).click();
    };
    await Promise.all([addFollowup(first, "Note written on the PC"), addFollowup(second, "Note written on the phone")]);
    await expect.poll(() => [...rows.values()].filter(row => row.kind === "highlight-followup" && row.value.annotationId === highlightId).length).toBe(2);
    await second.reload();
    await expect(second.getByRole("region", { name: "Follow-up notes" }).locator("article")).toHaveCount(2);

    await second.goto(baseURL!);
    await second.locator(".book-cover-link").click();
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
    await second.goto(new URL(`/#/notebooks?note=${media.noteId}`, baseURL!).href);
    await diagram.scrollIntoViewIfNeeded();
    await expect(diagram.getByRole("img", { name: "diagram.png" })).toBeVisible();
  } finally {
    await pc.close();
    await phone.close();
  }
});
