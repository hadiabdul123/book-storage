// Executes actual application pure functions when npm installation is unavailable.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  ts = require(process.env.LEAFMARK_TYPESCRIPT || "typescript");
async function load(file) {
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}
const { findQuote, quoteAt, normalizeRect, csvCell } =
  await load("src/anchors.ts");
const { readingSeconds } = await load("src/model.ts");
const tests = [
  [
    "Repeated quotes resolve by context",
    () => {
      const t = "first: repeated passage. second: repeated passage.",
        at = t.lastIndexOf("repeated passage");
      assert.deepEqual(findQuote(t, quoteAt(t, at, at + 16)), {
        start: at,
        end: at + 16,
      });
    },
  ],
  [
    "Ambiguous quotes remain unresolved",
    () =>
      assert.equal(
        findQuote("same text, same text", {
          exact: "same text",
          prefix: "",
          suffix: "",
        }),
        null,
      ),
  ],
  [
    "Inserted content does not shift a contextual anchor",
    () => {
      const t = "A passage with unicode: café 中文 🌿.";
      assert.deepEqual(
        findQuote("new preface " + t, quoteAt(t, 15, t.length)),
        { start: 27, end: t.length + 12 },
      );
    },
  ],
  [
    "Missing quotes remain unresolved",
    () =>
      assert.equal(
        findQuote("content", { exact: "missing", prefix: "", suffix: "" }),
        null,
      ),
  ],
  [
    "Empty quotes remain unresolved",
    () =>
      assert.equal(
        findQuote("content", { exact: "", prefix: "", suffix: "" }),
        null,
      ),
  ],
  [
    "PDF rectangles normalize reversed axes",
    () =>
      assert.deepEqual(normalizeRect([125, 700, 20, 680]), [20, 680, 125, 700]),
  ],
  [
    "CSV export neutralizes formula injection",
    () => assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"'),
  ],
  [
    "CSV export preserves multiline notes",
    () => assert.equal(csvCell("line one\nline two"), '"line one\nline two"'),
  ],
  [
    "Overlapping sessions count once",
    () =>
      assert.equal(
        readingSeconds([
          { start: 1000, end: 11000 },
          { start: 6000, end: 16000 },
        ]),
        15,
      ),
  ],
  [
    "Statistics clip to the reporting interval",
    () =>
      assert.equal(
        readingSeconds(
          [
            { start: 1000, end: 11000 },
            { start: 6000, end: 16000 },
          ],
          8000,
          13000,
        ),
        5,
      ),
  ],
];
for (const [name, run] of tests) {
  run();
  console.log(`PASS ${name}`);
}
console.log(
  `${tests.length} core checks passed. Browser, database, and build checks are separate.`,
);
