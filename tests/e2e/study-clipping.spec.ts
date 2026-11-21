import JSZip from "jszip";
import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
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
  await page.getByRole("button",{name:"Select book image"}).click();
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
    await expect(page.locator(".study-drag-dot")).toBeVisible();
    await expect(page.locator(".notebook-drop-line")).toBeVisible();
    await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await client.detach();
  } else {
    await page.mouse.move(origin.x,origin.y); await page.mouse.down();
    await page.mouse.move(x,y,{steps:15});
    await expect(page.locator(".study-drag-dot")).toBeVisible();
    await expect(page.locator(".notebook-drop-line")).toBeVisible(); await page.mouse.up();
  }
  await expect(editor.locator(".source-citation a")).toHaveCount(1);
  await expect(page.locator(".study-drag-dot")).toBeHidden();
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
    await page.getByRole("button",{name:"Close panel",exact:true}).click();
    await expect(page.locator(".study-notebook")).toHaveCount(0);
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


test("tap a book picture, copy it, and paste it onto a study page", async ({page, context}) => {
  await context.grantPermissions(["clipboard-read","clipboard-write"]);
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([400,500]);
  const png = await pdf.embedPng(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#245c84"; ctx.fillRect(0,0,32,32);
    return canvas.toDataURL("image/png");
  }));
  sheet.drawText("Illustrated page",{x:30,y:460});
  sheet.drawImage(png,{x:100,y:315,width:120,height:80});
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({name:"Illustration.pdf",mimeType:"application/pdf",buffer:Buffer.from(await pdf.save())});
  await page.locator(".book-cover-link").click();
  await clickTool(page,"Study notebook");
  await page.getByText("Create a page",{exact:true}).click();
  await page.getByRole("button",{name:"Create note",exact:true}).click();
  const editor = page.getByRole("textbox",{name:"Topic note content"});
  await expect(editor).toBeEditable();
  await page.getByRole("button",{name:"Insert",exact:true}).click();
  await page.getByRole("button",{name:"Select book image"}).click();
  const box = (await page.locator('.pdf-page[data-page="1"] canvas').first().boundingBox())!;
  await page.mouse.click(box.x+box.width*.4,box.y+box.height*.29);
  await page.getByRole("button",{name:"Copy image",exact:true}).click();
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read()).some(item=>item.types.includes("image/png")))).toBe(true);
  await editor.click();
  await editor.press("ControlOrMeta+v");
  const image = page.locator(".study-notebook figure img");
  await expect(image).toBeVisible();
  await expect.poll(()=>image.evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(240);
  expect(await image.evaluate(el => {
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!;
    ctx.drawImage(el as HTMLImageElement,0,0,1,1);
    return Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);
  })).toEqual([36,92,132]);
  await page.reload(); await clickTool(page,"Study notebook");
  await expect(image).toBeVisible();
});

test("native PDF text drops use notebook ink and both editors keep heading and emphasis",async ({page}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({name:"Book.pdf",mimeType:"application/pdf",buffer:numberedPdf(1)});
  await page.locator(".book-cover-link").click(); await clickTool(page,"Study notebook");
  await page.getByText("Create a page",{exact:true}).click();
  await page.getByRole("button",{name:"Create note",exact:true}).click();
  const editor=page.getByRole("textbox",{name:"Topic note content"});
  await expect(editor).toBeEditable();
  await editor.evaluate(el=>{
    const r=el.getBoundingClientRect(), data=new DataTransfer();
    data.setData("text/html",'<span style="color:transparent;font-size:1px">Visible passage</span>');
    data.setData("text/plain","Visible passage");
    el.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,clientX:r.left+6,clientY:r.top+8,dataTransfer:data}));
  });
  await expect(editor).toContainText("Visible passage");
  await expect(editor.locator("[style*=transparent]")).toHaveCount(0);
  const format=page.getByRole("button",{name:"Format",exact:true});
  await editor.click(); await editor.press("ControlOrMeta+a"); await format.click();
  await page.getByLabel("Paragraph style").selectOption("2");
  await page.getByRole("button",{name:"Bold",exact:true}).click();
  await page.getByRole("button",{name:"Italic",exact:true}).click();
  await page.getByRole("button",{name:"Underline",exact:true}).click();
  await page.getByRole("spinbutton",{name:"Note text size"}).fill("22");
  await page.getByRole("spinbutton",{name:"Note text size"}).press("Enter");
  await expect(editor.locator("h2 strong")).toHaveText("Visible passage");
  await expect(editor.locator("u")).toHaveText("Visible passage");
  await expect(editor.locator("em")).toHaveText("Visible passage");
  await expect(editor.locator("span[style*=font-size]")).toHaveCSS("font-size","22px");
  await expect(page.getByText("Saved on this device",{exact:true})).toBeAttached();
  const noteId=await page.evaluate(()=>Object.entries(localStorage).find(([k])=>k.startsWith("study-note:"))![1]);
  await page.goto("/#/notebooks?note="+noteId);
  await expect(editor.locator("h2 strong")).toHaveText("Visible passage");
  await editor.getByText("Visible passage",{exact:true}).click(); await format.click();
  await page.getByLabel("Paragraph style").selectOption("0");
  await page.getByRole("button",{name:"Bullet list",exact:true}).click();
  await expect(editor.locator("ul li")).toContainText("Visible passage");
});

test("drag the study pane larger and close immediately after writing an untitled note",async ({page,isMobile}) => {
  await page.addInitScript(() => localStorage.setItem("leafmark-controls-pinned","true"));
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({name:"Pane test.pdf",mimeType:"application/pdf",buffer:numberedPdf(1)});
  await page.locator(".book-cover-link").click(); await clickTool(page,"Study notebook");
  const rail = page.locator(".reader-header");
  await expect(rail).toBeHidden();
  await page.getByRole("button",{name:"Show reading controls"}).click();
  await expect(rail).toBeVisible();
  await page.getByText("Create a page",{exact:true}).click();
  await page.getByRole("button",{name:"Create note",exact:true}).click();
  const editor=page.getByRole("textbox",{name:"Topic note content"});
  await expect(editor).toBeEditable();
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(el => {
    const sel=document.getSelection();
    return sel?.isCollapsed && el.contains(sel.anchorNode) && getComputedStyle(el).caretColor !== "transparent";
  })).toBe(true);
  await page.keyboard.insertText("Typing from the opening caret.");
  await expect(editor).toHaveText("Typing from the opening caret.");

  await expect(rail).toBeHidden();
  let finalBounds;
  if (!isMobile) {
    const pane = page.locator(".reader-panel"), before = (await pane.boundingBox())!;
    const x=before.x+before.width-3,y=before.y+before.height-4;
    await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+70,y+40,{steps:8}); await page.mouse.up();
    const after=(await pane.boundingBox())!;
    expect(after.width-before.width).toBeGreaterThan(50);
    expect(after.height-before.height).toBeGreaterThan(25);
    expect(Math.abs(after.x-before.x)).toBeLessThan(3);
    const title = (await pane.getByRole("heading",{name:"Study notebook"}).boundingBox())!;
    const center = title.x + title.width/2;
    await page.mouse.move(center,title.y+9); await page.mouse.down();
    await page.mouse.move(center+65,title.y+39,{steps:6}); await page.mouse.up();
    finalBounds = (await pane.boundingBox())!;
    expect(finalBounds.x-after.x).toBeCloseTo(65,0);
    await expect(editor).toBeFocused();
  } else {
    const pane = page.locator(".reader-panel"), before=(await pane.boundingBox())!;
    const grip=(await page.getByLabel("Resize study notebook top").boundingBox())!;
    await page.mouse.move(grip.x+20,grip.y+4);await page.mouse.down();
    await page.mouse.move(grip.x+20,grip.y-45,{steps:5});await page.mouse.up();
    finalBounds=(await pane.boundingBox())!;
    expect(finalBounds.height-before.height).toBeGreaterThan(35);
  }
  await page.getByLabel("Topic note title").fill("");
  await editor.fill("Keep the last line.");
  await page.getByRole("button",{name:"Close panel",exact:true}).click();
  await expect(page.locator(".reader-panel")).toHaveCount(0);
  await page.reload(); await clickTool(page,"Study notebook");
  const reopened = (await page.locator(".reader-panel").boundingBox())!;
  expect(Math.abs(reopened.height-finalBounds.height)).toBeLessThan(2);
  expect(Math.abs(reopened.x-finalBounds.x)).toBeLessThan(2);
  await expect(editor).toHaveText("Keep the last line.");
  await expect(page.getByLabel("Topic note title")).toHaveValue("Untitled note");
  await page.evaluate(async () => {
    const {db,list} = await import("/src/db.ts");
    const [note] = await list("notebook-note");
    note.document = {type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Previously invisible draft",
      marks:[{type:"textStyle",attrs:{color:"transparent",fontSize:"1px"}}]}]}]};
    await db.meta.put({key:"topic-draft:"+note.id,value:JSON.stringify(note)});
  });
  await page.reload(); await clickTool(page,"Study notebook");
  await expect(editor).toHaveText("Previously invisible draft");
  await expect(editor.locator("span[style]")).toHaveCount(0);
  await editor.evaluate(element => {
    const canvas = document.createElement("canvas");
    const data = new DataTransfer();
    data.setData("text/html", '<img src="' + canvas.toDataURL() + '">');
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  const imported = page.getByRole("img", { name: "Dropped media.png" });
  await expect(imported).toBeVisible();
  await page.getByRole("button",{name:"Close panel",exact:true}).click();
  await expect(page.locator(".reader-panel")).toHaveCount(0);
});

for (const format of ["epub","docx"] as const) test("insert an illustrated "+format+" image with its source",async ({page}) => {
  await page.goto("/");
  const input = page.locator("input[type=file]");
  if (format === "epub") await input.setInputFiles("tests/fixtures/alice.epub");
  else {
    const zip = new JSZip(), rels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    const relation = (type:string,target:string) => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rels+'/'+type+'" Target="'+target+'"/></Relationships>';
    zip.file("_rels/.rels",relation("officeDocument","word/document.xml"));
    zip.file("word/_rels/document.xml.rels",relation("image","media/figure.png"));
    zip.file("word/media/figure.png", await page.evaluate(()=>{
      const canvas=document.createElement("canvas");canvas.width=canvas.height=60;
      canvas.getContext("2d")!.fillRect(0,0,60,60); return canvas.toDataURL().split(",")[1];
    }),{base64:true});
    zip.file("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="'+rels+'"><w:body><w:p><w:r><w:t>Book diagram</w:t></w:r></w:p><w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId1"/></v:shape></w:pict></w:r></w:p></w:body></w:document>');
    await input.setInputFiles({name:"Diagram.docx",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",buffer:await zip.generateAsync({type:"nodebuffer"})});
  }
  await page.locator(".book-cover-link").click();
  if (format === "epub") {
    await clickTool(page,"Contents"); await page.locator(".toc-item").filter({hasText:/rabbit|chapter|down/i}).first().click();
  }
  await clickTool(page,"Study notebook"); await page.getByText("Create a page",{exact:true}).click();
  await page.getByRole("button",{name:"Create note",exact:true}).click();
  await page.getByRole("button",{name:"Insert",exact:true}).click();
  await page.getByRole("button",{name:"Select book image"}).click();
  const img = format === "epub" ? page.frameLocator(".reader-host iframe").first().locator("img").first() : page.locator(".docx-content img").first();
  await img.click();
  await page.getByRole("button",{name:"Insert at caret"}).click();
  await expect(page.locator(".study-notebook figure img")).toBeVisible();
  await expect(page.locator(".study-notebook .source-citation a")).toHaveAttribute("href",new RegExp(format));
});
