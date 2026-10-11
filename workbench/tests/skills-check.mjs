// The skills teach a model the formats; the importers define them. These
// hold the two together: what the skills show as the format must be
// what the workbench accepts, or a model following them would produce
// something the import refuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseModule, planImport } from "../moduleimport.js";
import { parseSlides } from "../library.js";

const read = (p) => readFileSync(new URL(`../../skills/${p}`, import.meta.url), "utf8");
const blocks = (text, lang) =>
  [...text.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```", "g"))].map((m) => m[1]);

test("both skills say who they are, as Claude needs", () => {
  for (const name of ["fair-ed-module", "fair-ed-session"]) {
    const head = read(`${name}/SKILL.md`).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    assert.match(head, new RegExp(`^name: ${name}$`, "m"));
    assert.match(head, /^description: .{80,}/m);
  }
});

test("the module skill's example imports with no problems", () => {
  const [example] = blocks(read("fair-ed-module/SKILL.md"), "markdown");
  const plan = planImport(parseModule(example), new Map());
  assert.deepEqual(plan.problems, []);
  assert.ok(plan.changes.has("course.yaml"));
  assert.ok(plan.changes.has("outcomes.yaml"));
});

test("the session skill's slides parse as a deck", () => {
  const decks = blocks(read("fair-ed-session/SKILL.md"), "markdown");
  const text = "---\nsession: x\ntitle: X\nversion: 0.1.0\n---\n\n" + decks.join("\n\n") + "\n";
  const deck = parseSlides(text);
  const slides = deck.slides ?? deck;
  assert.ok(slides.length >= 3, "the role slides and the example");
});
