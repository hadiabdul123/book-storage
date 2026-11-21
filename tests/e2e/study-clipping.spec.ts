import { test, expect } from "@playwright/test";
import { numberedPdf } from "../helpers/numbered-pdf";
import { clickTool } from "./controls";

test("clip a PDF passage and region to the same notebook page", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name:"Study clipping.pdf", mimeType:"application/pdf", buffer:numberedPdf(2) });
  await page.locator(".book-cover-link").click();
  const first = page.locator('.pdf-page[data-page="1"] .textLayer span').first();
  await expect(first).toBeVisible();
  await first.evaluate(span => {
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = document.getSelection()!;
    selection.removeAllRanges();selection.addRange(range);
  });
  await page.getByRole("button",{name:"Insert into notebook",exact:true}).click();
  await page.getByText("Create a page",{exact:true}).click();
  await page.getByRole("button",{name:"Create note",exact:true}).click();
  const editor = page.getByRole("textbox",{name:"Topic note content"});
  await expect(editor).toBeEditable();
  await page.getByRole("button",{name:"Insert at caret"}).click();
  await expect(editor.locator(".source-citation a")).toHaveCount(1);
  await page.getByRole("button",{name:"Insert",exact:true}).click();
  await page.getByRole("button",{name:"Clip PDF region"}).click();
  const paper = (await page.locator('.pdf-page[data-page="1"]').boundingBox())!;
  const host = (await page.locator(".reading-column").boundingBox())!;
  const x=Math.max(95,paper.x+paper.width*.4), y=Math.max(host.y+50,Math.min(host.y+host.height*.45,paper.y+paper.height*.42));
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+45,y+35,{steps:6});await page.mouse.up();
  await page.getByRole("button",{name:"Insert into notebook",exact:true}).click();
  await page.getByRole("button",{name:"Insert at caret"}).click();
  await expect(editor.locator(".source-citation a")).toHaveCount(2);
  await page.getByRole("figure",{name:"Attachment: Page 1.png"}).scrollIntoViewIfNeeded();
  await expect(page.locator(".study-notebook img").first()).toBeVisible();
  await page.reload();await clickTool(page,"Study notebook");
  await expect(editor.locator(".source-citation a")).toHaveCount(2);
  await page.getByRole("figure",{name:"Attachment: Page 1.png"}).scrollIntoViewIfNeeded();
  await expect(page.locator(".study-notebook img").first()).toBeVisible();
});

for (const empty of [true, false]) test(empty ? "drag selected PDF words into an empty notebook page" : "drag selected PDF words directly between notebook paragraphs", async ({page,isMobile,browserName}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({ name:"Margin notes.pdf", mimeType:"application/pdf", buffer:numberedPdf(2) });
  await page.locator(".book-cover-link").click();
  await clickTool(page,"Study notebook");
  await page.getByText("Create a page",{exact:true}).click();
  await page.getByRole("button",{name:"Create note",exact:true}).click();
  const editor = page.getByRole("textbox",{name:"Topic note content"});
  await expect(editor).toBeEditable();
  if (!empty) {
    await editor.fill("Before"); await editor.press("End"); await editor.press("Enter");
    await editor.pressSequentially("After");
  }
  const move = page.getByRole("button",{name:"Move study notebook"});
  if (await move.isVisible()) {
    for (let i=0;i<10;i++) await move.press("ArrowRight");
  }
  const word = page.locator('.pdf-page[data-page="1"] .textLayer span').first();
  const origin = await word.evaluate(el => {
    const range=document.createRange(); range.selectNodeContents(el);
    const sel=document.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
    const r=range.getBoundingClientRect(); return { x:r.left+r.width*.5,y:r.top+r.height*.5,text:range.toString() };
  });
  await expect(page.locator(".passage-popup")).toBeVisible();
  const target = (await (empty ? editor.locator("p").first() : editor.getByText("After",{exact:true})).boundingBox())!;
  expect(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest(".reader-host"),origin)).toBe(true);
  const x = target.x+1, y = target.y+target.height*.5;
  if (isMobile && browserName === "chromium") {
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:origin.x,y:origin.y}]});
    await client.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x,y}]});
    await expect(page.locator(".notebook-drop-line")).toBeVisible();
    await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await client.detach();
  } else {
    await page.mouse.move(origin.x,origin.y); await page.mouse.down();
    await page.mouse.move(x,y,{steps:15});
    await expect(page.locator(".notebook-drop-line")).toBeVisible(); await page.mouse.up();
  }
  await expect(editor.locator(".source-citation a")).toHaveCount(1);
  if (!empty) {
    await expect(editor.locator("p").first()).toHaveText("Before");
    await expect(editor.locator("p").last()).toHaveText("After");
  }
  const quote=editor.getByText(origin.text,{exact:true});
  await expect(quote).toBeVisible();
  expect(await quote.evaluate(el=>getComputedStyle(el).color)).not.toBe("rgba(0, 0, 0, 0)");
  await page.reload(); await clickTool(page,"Study notebook");
  await expect(editor.getByText(origin.text,{exact:true})).toBeVisible();
  await expect(editor.locator(".source-citation a")).toHaveAttribute("href",/%22page%22%3A1/);
});

test("study notebooks reopen the page chosen for each PDF", async ({page}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles([1,2].map(n => ({
    name:"Study "+n+".pdf", mimeType:"application/pdf", buffer:numberedPdf(n),
  })));
  await expect(page.locator(".book-card")).toHaveCount(2);
  async function open(index:number) {
    await page.goto("/#/");
    await page.locator(".book-card").filter({hasText:"Study "+index}).locator(".book-cover-link").click();
    await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
    await clickTool(page,"Study notebook");
  }
  for (const n of [1,2]) {
    await open(n);
    await expect(page.getByLabel("Write in")).toHaveValue("");
    await page.getByText("Create a page",{exact:true}).click();
    await page.getByRole("button",{name:"Create note",exact:true}).click();
    await page.getByLabel("Topic note title").fill("Field study "+n);
    await page.locator(".study-writing-tools summary").click();
    await page.getByRole("button",{name:"Save now",exact:true}).click();
    await expect(page.locator(".topic-save-status")).toContainText("Saved on this device");
  }
  for (const n of [1,2]) {
    await open(n);
    await expect(page.getByLabel("Topic note title")).toHaveValue("Field study "+n);
    await expect(page.getByLabel("Write in")).toBeHidden();
  }
});

test("lasso deletes two PDF strokes together and undo restores both", async ({page}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({name:"Ink.pdf",mimeType:"application/pdf",buffer:numberedPdf(1)});
  await page.locator(".book-cover-link").click();
  await expect(page.locator(".reader-shell")).toHaveAttribute("data-loading","false");
  await expect(page.locator(".textLayer span").first()).toBeVisible();
  await clickTool(page,"Draw on PDF");
  const paper = page.locator(".pdf-ink-layer").first();
  await expect(paper).toBeVisible();
  await expect(page.locator(".reader-host")).not.toHaveAttribute("aria-busy","true");
  const box=(await paper.boundingBox())!;
  const x=box.x+box.width*.48, y=Math.max(175,box.y+Math.min(160,box.height*.3));
  await expect.poll(() => page.evaluate(({x,y}) => !!document.elementFromPoint(x,y)?.closest(".pdf-ink-layer"),{x,y})).toBe(true);
  for (const dy of [0,20]) {
    await page.mouse.move(x,y+dy);await page.mouse.down();await page.mouse.move(x+30,y+dy+4,{steps:5});await page.mouse.up();
  }
  const strokes=paper.locator("path[data-stroke]");
  await expect(strokes).toHaveCount(2);
  await page.getByRole("button",{name:"Select ink with lasso"}).click();
  await page.mouse.move(x-10,y-12);await page.mouse.down();
  for(const [px,py] of [[x+40,y-12],[x+40,y+35],[x-10,y+35],[x-10,y-12]])await page.mouse.move(px,py,{steps:4});
  await page.mouse.up();await expect(paper.locator(".ink-lasso circle")).toBeVisible();
  await page.getByRole("button",{name:"Delete selection",exact:true}).click();
  await expect(strokes).toHaveCount(0);
  await page.getByRole("button",{name:"Undo drawing",exact:true}).click();
  await expect(strokes).toHaveCount(2);
});
