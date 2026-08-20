// Tests for everything in the workbench that does not need a DOM.
//
// The two that matter most: marks must round-trip (or the editor rewrites
// an author's markdown behind their back), and writing a slide must leave
// every other slide byte-identical (or every save churns the diff and
// review becomes impossible).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MARKS,
  parseMarks,
  plainText,
  roundTrips,
  serializeMarks,
} from "../marks.js";
import { draftBranch, parseRepo } from "../github.js";
import {
  isLibrary,
  layoutRegions,
  libraryPaths,
  parseSlides,
  placedBlocks,
  slideRegions,
  writeSlides,
} from "../library.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");

// ---- marks -------------------------------------------------------------

test("every mark parses, and nests", () => {
  const runs = parseMarks("**b** *i* ***bi*** x^2^ H~2~O ~~s~~ __u__ `c`");
  const marksOf = (text) => {
    const run = runs.find((r) => r.text === text);
    return MARKS.filter((m) => run[m]);
  };
  assert.deepEqual(marksOf("b"), ["bold"]);
  assert.deepEqual(marksOf("i"), ["italic"]);
  assert.deepEqual(marksOf("bi"), ["bold", "italic"]);
  assert.deepEqual(marksOf("s"), ["strike"]);
  assert.deepEqual(marksOf("u"), ["underline"]);
  assert.deepEqual(marksOf("c"), ["code"]);

  const nested = parseMarks("**CO~2~ uptake**");
  assert.ok(nested.every((r) => r.bold));
  assert.ok(nested.find((r) => r.text === "2").subscript);
});

test("marks round-trip so the editor never rewrites an author's text", () => {
  for (const text of [
    "**bold**",
    "***bi***",
    "H~2~O",
    "x^2^",
    "~~struck~~",
    "__under__",
    "`code`",
    "**CO~2~ uptake**",
    "12 cm^2^ of CO~2~ at 37 °C",
    "plain text",
    "snake_case_name",
    "unclosed ** stays",
  ]) {
    assert.equal(serializeMarks(parseMarks(text)), text, text);
    assert.ok(roundTrips(text), text);
  }
});

test("a shared mark wraps the whole run, not each span", () => {
  // "**CO****~2~**** uptake**" parses the same but is unreadable in a diff.
  assert.equal(serializeMarks(parseMarks("**CO~2~ uptake**")), "**CO~2~ uptake**");
});

test("serialising is idempotent even where it normalises", () => {
  // Redundant nesting is normalised away; the result must then be stable,
  // or every save would produce a different file from the last.
  for (const text of ["***deep **inner** text***", "__**both**__"]) {
    const once = serializeMarks(parseMarks(text));
    const twice = serializeMarks(parseMarks(once));
    assert.equal(twice, once, text);
    assert.equal(plainText(once), plainText(text), "normalising changed the words");
    assert.ok(!roundTrips(text), "the editor must fall back to source here");
  }
});

test("a code span is literal", () => {
  const [run] = parseMarks("`**not bold**`").filter((r) => r.text.trim());
  assert.ok(run.code && !run.bold);
  assert.equal(run.text, "**not bold**");
});

// ---- github ------------------------------------------------------------

test("repo input accepts a slug or a github URL", () => {
  assert.deepEqual(parseRepo("Agrifoodskills/Clinical-Educator-"), {
    owner: "Agrifoodskills",
    repo: "Clinical-Educator-",
  });
  assert.deepEqual(parseRepo("https://github.com/imbowen1973/FAIR"), {
    owner: "imbowen1973",
    repo: "FAIR",
  });
  assert.equal(parseRepo("not a repo"), null);
});

test("draft branches are stable and namespaced per author", () => {
  const branch = draftBranch("ada", "01-foundations-of-clinical-teaching");
  assert.equal(branch, "draft/ada/01-foundations-of-clinical-teaching");
  // Same inputs, same branch — a second save must not fork a new one.
  assert.equal(branch, draftBranch("ada", "01-foundations-of-clinical-teaching"));
  assert.ok(!draftBranch("ada", "Odd Block/Name!").includes(" "));
});

// ---- library shape -----------------------------------------------------

test("a library is recognised by its recipe and a block with slides", () => {
  assert.ok(isLibrary(["course.yaml", "blocks/01-x/slides.md", "template.pptx"]));
  assert.ok(!isLibrary(["course.yaml", "README.md"]));
  assert.ok(!isLibrary(["blocks/01-x/slides.md"]));
});

test("only library paths are fetched", () => {
  const wanted = libraryPaths([
    "course.yaml",
    "blocks/01-x/slides.md",
    "blocks/01-x/media/a.png",
    "layout-map.yaml",
    "README.md",
    ".github/workflows/ci.yml",
    "credentials/c.yaml",
  ]);
  assert.ok(wanted.includes("blocks/01-x/media/a.png"));
  assert.ok(!wanted.includes("README.md"));
  assert.ok(!wanted.includes(".github/workflows/ci.yml"));
});

test("placedBlocks walks the recipe in order", () => {
  const structure = [
    {
      kind: "module",
      title: "One",
      children: [{ block: "a" }, { kind: "day", title: "D", children: [{ block: "b" }] }],
    },
    { block: "c" },
  ];
  assert.deepEqual(placedBlocks(structure), ["a", "b", "c"]);
});

test("regions come from the layout map, not from a hard-coded list", () => {
  const map = {
    _style: { code_typeface: "Consolas" },
    Split: { layout_name: "Two Content", regions: { title: 0, left: 1, right: 2 } },
  };
  assert.deepEqual(layoutRegions(map, "Split"), ["title", "left", "right"]);
  assert.deepEqual(layoutRegions(map, "Nope"), []);
});

// ---- slides.md round trip ---------------------------------------------

const SAMPLE = `---
session: "t-01"
title: Test
version: 1.0.0
---

--- slide
id: s-01
layout: Title
title: First
subtitle: Sub
---

--- slide
id: s-02
layout: Full
title: Second
full:
  type: ul
  items:
    - one
    - two
notes: |
  Narration that must survive untouched,
  across several lines.
develops: [C1]
dok: 2
---
`;

test("parsing finds every slide and its regions", () => {
  const parsed = parseSlides(SAMPLE);
  assert.equal(parsed.frontmatter.session, "t-01");
  assert.equal(parsed.slides.length, 2);
  assert.deepEqual(slideRegions(parsed.slides[1].data), ["title", "full"]);
  assert.ok(parsed.slides[1].data.notes.includes("several lines"));
});

test("writing no edits returns the file byte-for-byte", () => {
  const parsed = parseSlides(SAMPLE);
  assert.equal(writeSlides(parsed, new Map()), SAMPLE);
});

test("editing one slide leaves the others byte-identical", () => {
  const parsed = parseSlides(SAMPLE);
  const edited = { ...parsed.slides[0].data, title: "Changed" };
  const out = writeSlides(parsed, new Map([[0, edited]]));

  // The untouched slide keeps its exact source, notes and all.
  const original = SAMPLE.slice(parsed.slides[1].start, parsed.slides[1].end);
  assert.ok(out.includes(original.trimEnd()), "slide 2 was rewritten");
  assert.ok(out.includes("Changed"));
  assert.equal(parseSlides(out).slides.length, 2);
});

test("a real library file survives a no-op write", () => {
  const path = join(
    REPO,
    "..",
    "Andragogy-Pedagogy",
    "blocks",
    "01-the-paradigm-shift-from-pedagogy-to",
    "slides.md"
  );
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return; // the sibling library is not checked out here
  }
  const parsed = parseSlides(text);
  assert.equal(parsed.slides.length, 6);
  assert.equal(parsed.slides.filter((s) => s.error).length, 0);
  assert.equal(writeSlides(parsed, new Map()), text);
});

test("a malformed slide is reported, not thrown", () => {
  const broken = SAMPLE.replace("layout: Full", "layout: [unclosed");
  const parsed = parseSlides(broken);
  assert.equal(parsed.slides.length, 2);
  assert.ok(parsed.slides[1].error, "the bad slide should carry its error");
});
