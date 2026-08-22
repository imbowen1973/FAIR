// The in-browser renderer writes a hand-listed set of edufair_renderer
// modules into the Pyodide filesystem. A module that render.py imports
// but the list omits fails only at render time, in a browser, with a
// ModuleNotFoundError nothing in CI would otherwise catch — which is
// exactly how `attribution` slipped through.
//
// Derive the required set from the Python sources and compare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MODULES } from "../web/wasm-renderer.js";

const SRC = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "renderer",
  "src",
  "edufair_renderer"
);

/** Intra-package imports: `from .x import y` and `from . import x`. */
function localImports(source) {
  const names = new Set();
  for (const m of source.matchAll(/^from\s+\.(\w+)\s+import/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^from\s+\.\s+import\s+(.+)$/gm)) {
    for (const part of m[1].split(",")) names.add(part.trim().split(/\s+/)[0]);
  }
  return names;
}

/** Everything reachable from the entry point the wasm driver calls. */
function reachableFrom(entry) {
  const available = new Set(
    readdirSync(SRC)
      .filter((f) => f.endsWith(".py"))
      .map((f) => f.slice(0, -3))
  );
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const mod = queue.shift();
    if (seen.has(mod) || !available.has(mod)) continue;
    seen.add(mod);
    for (const dep of localImports(readFileSync(join(SRC, `${mod}.py`), "utf-8"))) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

test("wasm MODULES covers everything build_corpus imports", () => {
  // The driver in wasm-renderer.js calls edufair_renderer.corpus.build_corpus.
  const required = reachableFrom("corpus");
  const listed = new Set(MODULES);
  const missing = [...required].filter((m) => !listed.has(m)).sort();
  assert.deepEqual(
    missing,
    [],
    `wasm-renderer.js MODULES is missing: ${missing.join(", ")} — ` +
      "the in-browser render would throw ModuleNotFoundError"
  );
});

test("wasm MODULES lists only modules that exist", () => {
  const available = new Set(
    readdirSync(SRC)
      .filter((f) => f.endsWith(".py"))
      .map((f) => f.slice(0, -3))
  );
  const bogus = MODULES.filter((m) => !available.has(m));
  assert.deepEqual(bogus, [], `no such module: ${bogus.join(", ")}`);
});

test("__init__ is always loaded so the package imports at all", () => {
  assert.ok(MODULES.includes("__init__"));
});

test("the renderer never writes to or clears a Pyodide system directory", () => {
  // /lib holds Pyodide's own stdlib (python312.zip). rmtree'ing it takes
  // the standard library out from under the interpreter, and the very
  // next import dies with FileNotFoundError. /usr and /proc are equally
  // off limits; our mounts must be distinct paths, not prefixes of them.
  const src = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "..", "web", "wasm-renderer.js"),
    "utf-8"
  );
  const SYSTEM = ["/lib", "/usr", "/proc", "/dev", "/bin"];
  const offenders = [];
  for (const dir of SYSTEM) {
    // A system path used as a literal, or as the parent of a write.
    const literal = new RegExp(`["'\`]${dir}(["'/\`])`, "g");
    for (const m of src.matchAll(literal)) offenders.push(m[0]);
  }
  assert.deepEqual(
    offenders,
    [],
    `wasm-renderer.js references Pyodide system paths: ${offenders.join(", ")}`
  );
});
