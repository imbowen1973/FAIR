// Unsaved work kept in the browser: written per repository and branch,
// read back only where it still differs, flagged where the branch moved,
// and never the reason anything fails.

import { test } from "node:test";
import assert from "node:assert/strict";

import { clearDraft, loadDraft, saveDraft } from "../drafts.js";

function memoryStore(limit = Infinity) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (String(v).length > limit) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

const base = new Map([["blocks/a/slides.md", "old"], ["course.yaml", "c"]]);

test("an edit comes back for the same repository and branch only", () => {
  const store = memoryStore();
  saveDraft("o", "r", "main", {
    changed: [{ path: "blocks/a/slides.md", content: "new" }], uploads: new Map(), base,
  }, store);
  const draft = loadDraft("o", "r", "main", base, store);
  assert.equal(draft.files.get("blocks/a/slides.md"), "new");
  assert.deepEqual(draft.moved, []);
  assert.equal(loadDraft("o", "r", "draft/t", base, store), null);
  assert.equal(loadDraft("o", "other", "main", base, store), null);
});

test("nothing pending clears the draft", () => {
  const store = memoryStore();
  saveDraft("o", "r", "main", { changed: [{ path: "x", content: "1" }], uploads: new Map(), base }, store);
  saveDraft("o", "r", "main", { changed: [], uploads: new Map(), base }, store);
  assert.equal(store.size(), 0);
});

test("a file that moved on the branch since is flagged, not dropped", () => {
  const store = memoryStore();
  saveDraft("o", "r", "main", {
    changed: [{ path: "blocks/a/slides.md", content: "mine" }], uploads: new Map(), base,
  }, store);
  const now = new Map([["blocks/a/slides.md", "theirs"]]);
  const draft = loadDraft("o", "r", "main", now, store);
  assert.equal(draft.files.get("blocks/a/slides.md"), "mine");
  assert.deepEqual(draft.moved, ["blocks/a/slides.md"]);
});

test("an edit the branch already holds is not restored", () => {
  const store = memoryStore();
  saveDraft("o", "r", "main", {
    changed: [{ path: "blocks/a/slides.md", content: "saved elsewhere" }], uploads: new Map(), base,
  }, store);
  const now = new Map([["blocks/a/slides.md", "saved elsewhere"]]);
  assert.equal(loadDraft("o", "r", "main", now, store), null);
});

test("pictures come back as bytes; too many for the quota keeps the words", () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const store = memoryStore();
  saveDraft("o", "r", "main", {
    changed: [{ path: "a.md", content: "t" }], uploads: new Map([["m/p.png", bytes]]), base,
  }, store);
  assert.deepEqual([...loadDraft("o", "r", "main", base, store).uploads.get("m/p.png")], [...bytes]);

  const tight = memoryStore(200);
  const big = new Uint8Array(400);
  const kept = saveDraft("o", "r", "main", {
    changed: [{ path: "a.md", content: "t" }], uploads: new Map([["m/big.png", big]]), base,
  }, tight);
  assert.equal(kept.pictures, 0);
  const draft = loadDraft("o", "r", "main", base, tight);
  assert.equal(draft.files.get("a.md"), "t");
  assert.equal(draft.left, 1);
});

test("blocked or corrupt storage is no draft, never an error", () => {
  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(saveDraft("o", "r", "main", { changed: [{ path: "a", content: "b" }], uploads: new Map(), base }, blocked), null);
  assert.equal(loadDraft("o", "r", "main", base, blocked), null);
  clearDraft("o", "r", "main", blocked);
  const store = memoryStore();
  store.setItem("fair.wb.draft:o/r@main", "{not json");
  assert.equal(loadDraft("o", "r", "main", base, store), null);
});
