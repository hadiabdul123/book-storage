// Dependency-free syntax check using a supplied installed TypeScript compiler.
// Useful in restricted environments; this does NOT replace npm run typecheck.
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const ts = require(process.env.LEAFMARK_TYPESCRIPT || "typescript");
let count = 0,
  errors = 0;
function check(file) {
  const result = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  count++;
  for (const diagnostic of result.diagnostics || []) {
    errors++;
    const point = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    console.error(
      `${file}:${point.line + 1}:${point.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }
}
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${item.name}`;
    if (item.isDirectory()) walk(file);
    else if (/\.tsx?$/.test(file) && !file.endsWith(".d.ts")) check(file);
  }
}
walk("src");
walk("tests");
for (const file of [
  "vite.config.ts",
  "vitest.config.ts",
  "playwright.config.ts",
])
  check(file);
console.log(
  `Checked ${count} TypeScript files for syntax: ${errors} diagnostics.`,
);
process.exitCode = errors ? 1 : 0;
