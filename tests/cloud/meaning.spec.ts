import { test, expect, type Page } from "@playwright/test";
import { textPdf } from "../helpers/text-pdf";
import { clickTool } from "../e2e/controls";
const user = { id: "10000000-0000-4000-8000-000000000001", email: "reader@example.invalid", aud: "authenticated", role: "authenticated" };
const session = { access_token: "test-access", refresh_token: "test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user };
const answer = "Definition\nComfort means feeling at ease.\n\nIn this passage\nThe room feels pleasant and safe.\n\nExamples\n1. The chair offers comfort.\n2. Her words brought comfort.\n3. I value comfort at home.\n\nUsage\nComfort can be a noun or a verb.";
async function open(page: Page, respond: (request: any) => Promise<{ status?: number; body: unknown }>) {
  await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned", "true"));
  await page.context().routeWebSocket("wss://cloud.supabase.co/**", socket => socket.close());
  await page.route("https://cloud.supabase.co/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/functions/v1/research")) {
      const result = await respond(route.request().postDataJSON());
      await route.fulfill({ status: result.status || 200, json: result.body }).catch(() => {}); return;
    }
    await route.fulfill({ json: path.includes("/token") ? session : path.endsWith("is_library_owner") ? true : path.endsWith("/user") ? user : [] });
  });
  await page.goto("/"); await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("test-password"); await page.getByRole("button", { name: "Open my library" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "Meaning.pdf", mimeType: "application/pdf", buffer: textPdf(["comfort", "The room is quiet and comfortable."]) });
  await expect(page.locator(".book-card")).toHaveCount(1); await page.locator(".book-cover-link").click();
  await expect(page.locator(".textLayer span").filter({ hasText: /^comfort$/ })).toBeVisible();
}
for (const width of [390, 810]) test(`Groq explains a selected word, caches it and saves to a page note at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); const requests: any[] = [];
  await open(page, async request => { requests.push(request); return { body: { answer, model: "test-groq", sources: [] } }; });
  await page.locator(".textLayer span").filter({ hasText: /^comfort$/ }).evaluate(el => {
    const r = document.createRange(); r.selectNodeContents(el); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("button", { name: "Explain", exact: true })).toBeVisible(); expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Explain", exact: true }).click();
  await expect(page.locator(".ai-meaning")).toContainText("3. I value comfort");
  expect(requests).toHaveLength(1); expect(requests[0].meaning.term).toBe("comfort"); expect(requests[0].sources[0].excerpt).toContain("quiet");
  await expect(page.locator(".dictionary-entry")).toHaveCount(0);
  const box = (await page.locator(".passage-popup").boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  await page.screenshot({ path: test.info().outputPath("groq-explanation.png") });
  await page.getByRole("button", { name: "Close selection tools", exact: true }).click();
  await clickTool(page, "Dictionary"); await page.getByLabel("Dictionary word").fill("comfort"); await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.locator(".ai-meaning")).toContainText("AI explanation"); expect(requests).toHaveLength(2); // typed lookup has different context
  await page.getByRole("button", { name: "Look up", exact: true }).click(); await expect(page.locator(".ai-meaning")).toBeVisible(); // deliberate retry may refresh
  await page.locator(".ai-meaning").getByRole("button", { name: "Add to page note", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Notebook for page 1" })).toContainText("AI explanation");
  await clickTool(page, "Dictionary"); await page.getByLabel("Dictionary word").fill("comfort"); await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.locator(".ai-meaning")).toContainText("Saved on this device");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("AI errors fall back and a late response cannot replace a new lookup", async ({ page }) => {
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  await open(page, async request => {
    if (request.meaning.term === "comfort") { await held; return { body: { answer, model: "late", sources: [] } }; }
    return { status: 429, body: { code: "quota", error: "Quota reached" } };
  });
  await clickTool(page, "Dictionary"); await page.getByLabel("Dictionary word").fill("comfort"); await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.getByText("Explaining with Groq…", { exact: true })).toBeVisible();
  await page.getByLabel("Dictionary word").fill("thoughtful"); await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(page.locator(".dictionary-entry h3").first()).toHaveText("thoughtful");
  await expect(page.getByText("AI allowance reached. Showing the dictionary.", { exact: true })).toBeVisible();
  finish(); await expect(page.locator(".ai-meaning")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry AI", exact: true })).toBeVisible();
});

test("concept images load after the text and keep attribution when placed in either notebook", async ({page}) => {
  const titles = ["File:Earth.jpg","File:Earth structure.jpg"];
  const origin = "https://upload.wikimedia.org/";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64");
  let release!:()=>void;
  const gate = new Promise<void>(resolve => { release=resolve; });
  await page.route("https://en.wikipedia.org/w/api.php?**", async r => {
    await gate;
    await r.fulfill({json:{query:{pages:[{title:"Earth",pageimage:"Earth.jpg",images:[{title:titles[1]}]}]}}});
  });
  await page.route("https://commons.wikimedia.org/w/api.php?**", r => r.fulfill({json:{query:{pages:titles.map((title,i)=>({
    title,imageinfo:[{thumburl:origin+i+".png",descriptionurl:"https://commons.wikimedia.org/wiki/"+title.replaceAll(" ","_"),
      extmetadata:{Artist:{value:"<b>Science artist</b>"},LicenseShortName:{value:"CC BY-SA 4.0"}}}],
  }))}}}));
  await page.route(origin+"**",r=>r.fulfill({body:png,contentType:"image/png"}));
  await open(page,async ()=>({body:{answer,model:"test",sources:[],visualQuery:"Earth"}}));
  async function explain() {
    await page.locator(".textLayer span").filter({hasText:/^comfort$/}).evaluate(el => {
      const r=document.createRange(); r.selectNodeContents(el); const s=getSelection()!; s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event("selectionchange"));
    });
    await page.getByRole("button",{name:"Explain",exact:true}).click();
  }
  await explain();
  await expect(page.locator(".ai-meaning")).toContainText("Comfort means feeling at ease");
  await expect(page.getByRole("figure",{name:"Concept images"})).toHaveCount(0);
  release();
  await page.getByRole("button",{name:"Next image"}).click();
  await expect(page.locator(".meaning-gallery figcaption")).toContainText("Earth structure");
  await page.getByRole("button",{name:"Image options"}).click();
  await page.getByRole("button",{name:"Add to notebook…"}).click();
  const picker=page.getByRole("dialog",{name:"Add image to notebook"});
  await picker.getByLabel("Save destination").selectOption("new");
  await picker.getByLabel("Note title").fill("Planet notes");
  await picker.getByRole("button",{name:"Save image"}).click();
  await expect(picker).toContainText("Image saved to notebook.");
  await picker.getByRole("button",{name:"Done"}).click();
  await explain();
  await page.locator(".meaning-picture").click({button:"right"});
  await page.getByRole("button",{name:"Copy to Study notebook"}).click();
  const study = page.locator(".study-notebook");
  await study.getByLabel("Write in").selectOption({label:"Planet notes"});
  await expect(study.locator(".notebook-paper")).toContainText("Science artist");
  await expect(study.locator(".notebook-paper")).toContainText("Meaning");
  await study.getByRole("button",{name:"Insert at cursor"}).click();
  await expect(study.locator(".study-pending")).toHaveCount(0);
  await expect(study.locator(".notebook-paper img")).toHaveCount(2);
});

test("shows the first streamed definition while the rest of the explanation is still pending", async ({page}) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (url,init) => {
      if (!String(url).endsWith("/functions/v1/research") || new Headers(init?.headers).get("accept") !== "application/x-ndjson")
        return original(url,init);
      const encoder = new TextEncoder(), first = "Definition\nA place of rest.";
      return new Response(new ReadableStream({start(out) {
        out.enqueue(encoder.encode(JSON.stringify({text:first})+"\n"));
        window.addEventListener("finish-test-meaning",() => {
          out.enqueue(encoder.encode(JSON.stringify({result:{answer:first+"\n\nExamples\nA quiet room.",sources:[],model:"test"}})+"\n")); out.close();
        },{once:true});
      }}),{headers:{"Content-Type":"application/x-ndjson"}});
    };
  });
  await open(page,async ()=>({status:500,body:{}}));
  await clickTool(page,"Dictionary");
  await page.getByLabel("Dictionary word").fill("comfort");
  await page.getByRole("button",{name:"Look up",exact:true}).click();
  await expect(page.locator(".ai-meaning")).toContainText("A place of rest.",{timeout:3000});
  await expect(page.getByRole("button",{name:"Add to page note"})).toHaveCount(0);
  await page.evaluate(()=>window.dispatchEvent(new Event("finish-test-meaning")));
  await expect(page.locator(".ai-meaning")).toContainText("A quiet room.");
  await expect(page.getByRole("button",{name:"Add to page note"})).toBeVisible();
});
