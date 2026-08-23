// Does the Word pane actually render a .docx in the browser?
//
// The pane is Python in Pyodide: python-docx and markdown-it-py installed
// at runtime, plus the edufair_renderer.word package fetched as source.
// Any one of those can be missing and nothing says so until a user clicks
// Insert. So run it for real and read the bytes that come back.
//
//   node tests/word-pane-check.mjs
//
// Needs a site-shaped build served somewhere (see create-check.mjs).

import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const BASE = process.env.WB || "http://localhost:8896/";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

await page.goto(`${BASE}word-taskpane.html`, { waitUntil: "domcontentloaded" });

const MARKDOWN = [
  "# Cold chain fundamentals",
  "",
  "Vaccines fail quietly. A freezer that drifts for six hours looks",
  "exactly like one that did not.",
  "",
  "## What to check",
  "",
  "- The **log**, not the light",
  "- The door seal",
  "- H~2~O ingress at the hinge",
  "",
  "> A single excursion is a notifiable event.",
  "",
  "| Check | When |",
  "|---|---|",
  "| Log | Daily |",
  "| Seal | Weekly |",
  "",
].join("\n");

console.log("running the renderer in the browser (this downloads Pyodide)…");
const result = await page.evaluate(async (markdown) => {
  const t0 = performance.now();
  const steps = [];
  try {
    const { renderMarkdownToDocx, bytesToBase64 } = await import("./word-renderer.js");
    const bytes = await renderMarkdownToDocx(
      markdown,
      { title: "Cold chain fundamentals", project: "test/lib" },
      (m) => steps.push(m)
    );
    const base64 = bytesToBase64(bytes);
    return {
      ok: true,
      steps,
      length: bytes.length,
      // A .docx is a zip: it must start PK, or nothing downstream works.
      zip: bytes[0] === 0x50 && bytes[1] === 0x4b,
      base64Length: base64.length,
      seconds: Math.round((performance.now() - t0) / 100) / 10,
    };
  } catch (err) {
    return { ok: false, steps, error: String(err?.message ?? err) };
  }
}, MARKDOWN);

console.log(JSON.stringify(result, null, 1));
if (errors.length) console.log("page errors:", errors.slice(0, 3));

if (result.ok) {
  const bytes = await page.evaluate(async (markdown) => {
    const { renderMarkdownToDocx } = await import("./word-renderer.js");
    return Array.from(await renderMarkdownToDocx(markdown, {}, () => {}));
  }, MARKDOWN);
  writeFileSync(process.argv[2] || "browser-rendered.docx", Buffer.from(bytes));
  console.log("wrote", process.argv[2] || "browser-rendered.docx");
}

const failed = !result.ok || !result.zip || result.length < 5000 || errors.length > 0;
console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
