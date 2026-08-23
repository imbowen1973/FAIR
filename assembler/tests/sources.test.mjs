// The library list both panes share.
//
// The sharing itself is localStorage on one origin and is checked in a
// browser (workbench/tests/shared-sources-check.mjs). These pin the
// shape: what a repo entry looks like, that the list is a set, and that
// a corrupted value cannot take a pane down with it.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Node has no localStorage; the module only ever asks for these four.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  addSource,
  initialSource,
  loadSources,
  rememberLast,
  removeSource,
  repoOf,
  repoSource,
  sourcesAreShared,
  storeSources,
} = await import("../web/sources.js");

beforeEach(() => store.clear());

test("a repo is described the same way by either pane", () => {
  const source = repoSource("Agrifoodskills", "Andragogy-Pedagogy");
  assert.deepEqual(source, {
    url: "wasm:Agrifoodskills/Andragogy-Pedagogy",
    name: "Agrifoodskills/Andragogy-Pedagogy",
    kind: "repo",
  });
  // And read back, so a library added in one pane opens in the other.
  assert.deepEqual(repoOf(source), {
    owner: "Agrifoodskills",
    repo: "Andragogy-Pedagogy",
  });
});

test("a corpus URL is not a repo, and says so rather than half-parsing", () => {
  assert.equal(repoOf({ url: "https://corpus.example.org/" }), null);
  assert.equal(repoOf({}), null);
  assert.equal(repoOf(null), null);
});

test("the list is a set: adding the same library twice adds it once", () => {
  addSource(repoSource("a", "b"));
  addSource(repoSource("a", "b"));
  addSource(repoSource("c", "d"));
  assert.deepEqual(loadSources().map((s) => s.name), ["a/b", "c/d"]);
});

test("removing one leaves the rest", () => {
  addSource(repoSource("a", "b"));
  addSource(repoSource("c", "d"));
  const left = removeSource("wasm:a/b");
  assert.deepEqual(left.map((s) => s.name), ["c/d"]);
  assert.deepEqual(loadSources().map((s) => s.name), ["c/d"]);
});

test("a corrupted list is empty, not an exception", () => {
  // A pane that throws while reading its own settings shows nothing at
  // all, and Office says only that the add-in could not be started.
  for (const junk of ["{not json", '"a string"', "42", "null", '[{"no":"url"}]']) {
    store.set("fair.sources", junk);
    assert.deepEqual(loadSources(), [], junk);
  }
});

test("launch opens the last library used, else the first", () => {
  addSource(repoSource("a", "b"));
  addSource(repoSource("c", "d"));
  assert.equal(initialSource().name, "a/b", "the first, with nothing remembered");
  rememberLast("wasm:c/d");
  assert.equal(initialSource().name, "c/d");
  // A remembered library that has since been removed must not strand it.
  removeSource("wasm:c/d");
  assert.equal(initialSource().name, "a/b");
  storeSources([]);
  assert.equal(initialSource(), null);
});

test("storage that refuses is reported, not assumed", () => {
  assert.equal(sourcesAreShared(), true);
  const real = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => {
    throw new Error("private mode");
  };
  assert.equal(sourcesAreShared(), false, "a pane that cannot store must say so");
  assert.deepEqual(loadSources(), [], "and still not throw");
  globalThis.localStorage.setItem = real;
});
