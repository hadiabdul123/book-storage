import type { Page } from "@playwright/test";
// Original generated scan: no copyrighted book or private content in fixtures.
export async function scanPdf(page: Page) {
  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 1000;
      c.height = 1300;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 1000, 1300);
      ctx.fillStyle = "black";
      ctx.font = "48px Arial";
      ctx.fillText("Reading opens new doors.", 100, 180);
      ctx.fillText("Every reader can make notes.", 100, 270);
      ctx.fillText("Clear words are easy to select.", 100, 360);
      return c.toDataURL("image/jpeg", 0.95).split(",")[1];
    }),
    "base64",
  );
  const stream = Buffer.from("q 500 0 0 650 0 0 cm /Im0 Do Q");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 650] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1000 /Height 1300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from("\nendstream"),
    ]),
  ];
  let pdf = Buffer.from("%PDF-1.4\n"),
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([
      pdf,
      Buffer.from(`${i + 1} 0 obj\n`),
      o,
      Buffer.from("\nendobj\n"),
    ]);
  });
  const xref = pdf.length;
  return Buffer.concat([
    pdf,
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
    ),
  ]);
}
