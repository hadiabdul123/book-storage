import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import "./prepare-dictionary.mjs";
import { deflateSync } from "node:zlib";

mkdirSync("public/pdf-assets", { recursive: true });
for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
  const source = `node_modules/pdfjs-dist/${folder}`;
  if (existsSync(source))
    cpSync(source, `public/pdf-assets/${folder}`, { recursive: true });
}
// Small original app icon, generated without an image tool or runtime dependency.
function crc(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) {
    n ^= b;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function icon(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let color = [49, 92, 134, 255];
      const u = x / size,
        v = y / size;
      if (v > 0.28 && v < 0.72 && u > 0.25 && u < 0.49)
        color = [255, 255, 255, 255];
      if (v > 0.28 && v < 0.72 && u > 0.52 && u < 0.75)
        color = [188, 212, 234, 255];
      if (v > 0.28 && v < 0.51 && u > 0.61 && u < 0.68)
        color = [232, 185, 104, 255];
      for (let c = 0; c < 4; c++)
        rows[y * (size * 4 + 1) + 1 + x * 4 + c] = color[c];
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const size of [192, 512])
  writeFileSync(`public/icon-${size}.png`, icon(size));
