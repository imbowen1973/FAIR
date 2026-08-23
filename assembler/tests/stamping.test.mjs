// Every relative import must be one the deploy knows how to stamp.
//
// GitHub Pages sends max-age=600 on everything and the Office webview
// keeps files far longer, so an unstamped module can be served stale
// against fresh siblings. publish-pane.yml rewrites relative imports to
// carry the commit sha, and it does that with two `sed` patterns.
//
// A pattern only matches what it was written for. The `from "../x.js"`
// form went unstamped for as long as the step existed, and so did
// `await import("./wasm-renderer.js")` — the pane's entire renderer.
// Both were found by reading, not by failing, which is the problem.
//
// So: pin the forms. If someone writes an import the deploy cannot
// stamp, this fails here rather than shipping a cache bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");

/**
 * What the sed patterns in publish-pane.yml actually require: a double
 * quote, and a path of the shape `./name.js` or `../name.js`.
 */
const QUOTE = '"';
const PLAIN_PATH = /^[.]{1,2}\/[A-Za-z0-9_.-]+\.js$/;

/** Anything that reaches for a neighbouring file, however it is written. */
const RELATIVE = /(?:from|import)\s*\(?\s*(['"`])(\.[^'"`]*?\.js)\1/g;

function shipped() {
  const out = [];
  for (const dir of [join(REPO, "assembler", "web"), join(REPO, "workbench")]) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;
      out.push([join(dir, name), readFileSync(join(dir, name), "utf8")]);
    }
  }
  return out;
}

test("every relative import is in a form the deploy can stamp", () => {
  const unstampable = [];
  for (const [path, source] of shipped()) {
    for (const match of source.matchAll(RELATIVE)) {
      const [text, quote, spec] = match;
      // Single quotes and backticks are not wrong JavaScript; they are
      // simply not what the sed patterns match, which is worse — it
      // fails silently, in a browser, later. Same for a query string or
      // a path with characters the pattern does not admit.
      if (quote !== QUOTE || !PLAIN_PATH.test(spec)) {
        unstampable.push(`${path.replace(REPO, "")}: ${text}`);
      }
    }
  }
  assert.deepEqual(
    unstampable,
    [],
    "use double quotes and a plain path, or teach publish-pane.yml the new form:\n" +
      unstampable.join("\n")
  );
});

test("the deploy stamps both the pane and the workbench", () => {
  const yml = readFileSync(
    join(REPO, ".github", "workflows", "publish-pane.yml"),
    "utf8"
  );
  // The pane was left out of stamping entirely, which is how a renamed
  // logo went on 404ing in Office long after the deploy that renamed it.
  assert.match(yml, /taskpane\.html/, "the pane's entry point is stamped");
  assert.match(yml, /workbench\/index\.html/, "the workbench's is too");
  // Guards, not just rewrites: a miss must fail the deploy.
  assert.match(yml, /exit 1/, "an unstamped import fails the build");
});
