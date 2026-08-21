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
  blockDocuments,
  freePath,
  withResource,
  withoutResource,
} from "../documents.js";
import { markdownToHtml } from "../markdown.js";
import {
  competencyTags,
  renderQuizFile,
  splitQuestions,
  toTags,
  writeQuestion,
} from "../assessment.js";

import {
  isLibrary,
  layoutRegions,
  libraryPaths,
  parseSlides,
  placedBlocks,
  slideRegions,
  writeSlides,
  asListType,
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

// ---- adding, deleting and reordering slides ----------------------------

import {
  blankSlide,
  renderSlidesFile,
  workingSlides,
} from "../library.js";

const CRLF = SAMPLE.replace(/\n/g, "\r\n");

test("a working list rebuilds the file unchanged", () => {
  for (const [label, text] of [["LF", SAMPLE], ["CRLF", CRLF]]) {
    const parsed = parseSlides(text);
    assert.equal(renderSlidesFile(parsed, workingSlides(parsed)), text, label);
  }
});

test("line endings are preserved, never mixed", () => {
  // A CRLF repo rewritten with \n shows every touched slide as wholly
  // changed, which makes review useless.
  const parsed = parseSlides(CRLF);
  const working = workingSlides(parsed);
  working[0].data = { ...working[0].data, title: "Changed" };
  working[0].dirty = true;
  const out = renderSlidesFile(parsed, working);
  assert.ok(out.includes("\r\n"), "lost CRLF");
  assert.ok(!/[^\r]\n/.test(out), "introduced a bare LF into a CRLF file");
});

test("adding a slide leaves the existing ones byte-identical", () => {
  const parsed = parseSlides(SAMPLE);
  const working = workingSlides(parsed);
  working.push(blankSlide("Full", "s-99"));

  const out = renderSlidesFile(parsed, working);
  const re = parseSlides(out);
  assert.equal(re.slides.length, 3);
  assert.equal(re.slides[2].data.id, "s-99");
  assert.equal(re.slides[2].data.layout, "Full");
  for (const i of [0, 1]) {
    assert.equal(
      out.slice(re.slides[i].start, re.slides[i].end),
      SAMPLE.slice(parsed.slides[i].start, parsed.slides[i].end),
      `slide ${i} was rewritten`
    );
  }
});

test("a new slide can be inserted in the middle", () => {
  const parsed = parseSlides(SAMPLE);
  const working = workingSlides(parsed);
  working.splice(1, 0, blankSlide("Section", "s-mid"));

  const re = parseSlides(renderSlidesFile(parsed, working));
  assert.deepEqual(
    re.slides.map((s) => s.data.id),
    ["s-01", "s-mid", "s-02"]
  );
});

test("deleting a slide removes only that slide", () => {
  const parsed = parseSlides(SAMPLE);
  const working = workingSlides(parsed);
  working.splice(0, 1);

  const out = renderSlidesFile(parsed, working);
  const re = parseSlides(out);
  assert.deepEqual(re.slides.map((s) => s.data.id), ["s-02"]);
  // The survivor keeps its notes verbatim.
  assert.ok(re.slides[0].data.notes.includes("several lines"));
});

test("reordering keeps each slide's own bytes", () => {
  const parsed = parseSlides(SAMPLE);
  const working = workingSlides(parsed);
  const [first] = working.splice(0, 1);
  working.push(first);

  const out = renderSlidesFile(parsed, working);
  const re = parseSlides(out);
  assert.deepEqual(re.slides.map((s) => s.data.id), ["s-02", "s-01"]);
  // Moved, not rewritten: the source of each is unchanged.
  assert.equal(
    out.slice(re.slides[0].start, re.slides[0].end),
    SAMPLE.slice(parsed.slides[1].start, parsed.slides[1].end)
  );
  assert.equal(
    out.slice(re.slides[1].start, re.slides[1].end),
    SAMPLE.slice(parsed.slides[0].start, parsed.slides[0].end)
  );
});

test("an added slide survives a re-parse and carries no junk", () => {
  const parsed = parseSlides(SAMPLE);
  const working = workingSlides(parsed);
  working.push(blankSlide("Blank", "s-new"));

  const re = parseSlides(renderSlidesFile(parsed, working));
  const added = re.slides[2];
  assert.equal(added.error, null);
  assert.deepEqual(Object.keys(added.data).sort(), ["id", "layout"]);
});

test("everything still parses after a mix of operations", () => {
  const parsed = parseSlides(SAMPLE);
  const working = workingSlides(parsed);
  working.push(blankSlide("Full", "s-03"));
  working[0].data = { ...working[0].data, title: "Retitled" };
  working[0].dirty = true;
  const [moved] = working.splice(1, 1);
  working.push(moved);

  const re = parseSlides(renderSlidesFile(parsed, working));
  assert.equal(re.slides.filter((s) => s.error).length, 0);
  assert.deepEqual(re.slides.map((s) => s.data.id), ["s-01", "s-03", "s-02"]);
  assert.equal(re.slides[0].data.title, "Retitled");
});

test("switches between bulleted and numbered, keeping the words", () => {
  assert.deepEqual(
    asListType({ type: "ul", items: ["a", "b"] }, "ol"),
    { type: "ol", items: ["a", "b"] }
  );
});

test("keeps region keys such as colour across a change", () => {
  assert.deepEqual(
    asListType({ type: "ul", color: "accent2", items: ["a"] }, "ol"),
    { type: "ol", color: "accent2", items: ["a"] }
  );
});

test("flattens nesting when a list becomes plain lines", () => {
  // Plain text has nowhere to keep hierarchy, so losing it is honest;
  // silently dropping the nested words would not be.
  assert.deepEqual(
    asListType({ type: "ul", items: [{ text: "a", items: ["b"] }, "c"] }, null),
    { type: "p", text: ["a", "b", "c"].join("\n") }
  );
});

test("writes a bare string when there is nothing else to carry", () => {
  assert.equal(asListType({ type: "ul", items: ["a"] }, null), "a");
});

test("keeps the p wrapper for several lines, which a bare string cannot hold", () => {
  // The canvas draws a bare string as one paragraph, so two lines inside
  // one would run together on the slide.
  assert.deepEqual(asListType({ type: "ul", items: ["a", "b"] }, null), {
    type: "p",
    text: ["a", "b"].join("\n"),
  });
});

test("keeps a wrapper only when the region has other keys", () => {
  assert.deepEqual(
    asListType({ type: "ul", color: "accent2", items: ["a", "b"] }, null),
    { type: "p", color: "accent2", text: ["a", "b"].join("\n") }
  );
});

test("makes a list out of plain text, a line per item", () => {
  assert.deepEqual(asListType(["one", "two"].join("\n"), "ul"), {
    type: "ul",
    items: ["one", "two"],
  });
});

test("leaves media alone: an image is not a list", () => {
  const image = { type: "image", src: "x.png" };
  assert.equal(asListType(image, "ul"), image);
});

test("returns the same value when nothing changes, so callers can skip a commit", () => {
  const list = { type: "ol", items: ["a"] };
  assert.equal(asListType(list, "ol"), list);
  assert.equal(asListType("plain", null), "plain");
});

// ---- documents ---------------------------------------------------------

test("a block's tabs are the deck, the lesson plan, then the manifest", () => {
  const block = {
    id: "01-x",
    meta: {
      resources: [
        { type: "workbook", title: "Learner workbook", path: "workbook.md" },
        { type: "file", title: "Data", path: "files/data.xlsx" },
      ],
    },
  };
  const files = new Map([
    ["blocks/01-x/slides.md", ""],
    ["blocks/01-x/workbook.md", ""],
    ["blocks/01-x/files/data.xlsx", ""],
  ]);
  const docs = blockDocuments(block, files);
  assert.deepEqual(
    docs.map((d) => d.id),
    ["slides", "lessonplan.md", "workbook.md", "files/data.xlsx"]
  );
  // The lesson plan gets a tab whether or not the manifest lists it,
  // because every block has one.
  assert.equal(docs[1].title, "Lesson plan");
  assert.equal(docs[2].editor, "markdown");
  assert.equal(docs[3].editor, "attachment");
});

test("a document the manifest declares but the repo lacks is marked, not hidden", () => {
  const block = { id: "b", meta: { resources: [{ path: "gone.md" }] } };
  const docs = blockDocuments(block, new Map());
  assert.equal(docs.find((d) => d.id === "gone.md").missing, true);
});

test("adding a second document of a kind does not overwrite the first", () => {
  assert.equal(freePath("workbook", new Set()), "workbook.md");
  assert.equal(freePath("workbook", new Set(["workbook.md"])), "workbook-2.md");
  assert.equal(
    freePath("workbook", new Set(["workbook.md", "workbook-2.md"])),
    "workbook-3.md"
  );
});

test("a resource is replaced rather than duplicated", () => {
  const first = withResource([], { type: "workbook", path: "workbook.md" });
  const again = withResource(first, { type: "workbook", title: "Renamed", path: "workbook.md" });
  assert.equal(again.length, 1);
  assert.equal(again[0].title, "Renamed");
  assert.deepEqual(withoutResource(again, "workbook.md"), []);
});

// ---- markdown ----------------------------------------------------------

test("markdown renders the blocks a lesson plan uses", () => {
  assert.equal(markdownToHtml("# Title"), "<h1>Title</h1>");
  assert.equal(markdownToHtml("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(
    markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |"),
    "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
      "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
  );
});

test("a nested list nests inside its item, not beside it", () => {
  // <ul> as a direct child of <ul> renders, but it is not valid HTML and
  // a screen reader announces it as a stray list.
  assert.equal(
    markdownToHtml("- a\n  - b"),
    "<ul><li>a<ul><li>b</li></ul></li></ul>"
  );
});

test("markdown inline marks come from marks.js, not a second parser", () => {
  assert.equal(markdownToHtml("CO~2~ and **bold**"), "<p>CO<sub>2</sub> and <strong>bold</strong></p>");
});

test("markdown escapes text and refuses a script URL", () => {
  assert.equal(markdownToHtml("a < b & c"), "<p>a &lt; b &amp; c</p>");
  // The link is shown as the author typed it rather than dropped, so
  // nothing disappears silently, but it is not made clickable.
  assert.equal(markdownToHtml("[x](javascript:alert(1))"), "<p>[x](javascript:alert(1))</p>");
});

// ---- assessments -------------------------------------------------------

const QUIZ = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<quiz>",
  '  <question type="category">',
  "    <category><text>top</text></category>",
  "  </question>",
  "",
  '  <question type="multichoice">',
  "    <name><text>q1</text></name>",
  '    <answer fraction="100"><text>Yes</text></answer>',
  "  </question>",
  "",
  '  <question type="matching">',
  "    <subquestion><text>a</text><answer><text>b</text></answer></subquestion>",
  "  </question>",
  "</quiz>",
  "",
].join("\n");

test("an assessment splits into its questions", () => {
  const parsed = splitQuestions(QUIZ);
  assert.deepEqual(
    parsed.questions.map((q) => q.type),
    ["category", "multichoice", "matching"]
  );
});

test("an untouched assessment is written back byte-identical", () => {
  // The file is what Moodle imports, so a reformatting write would turn
  // every edit into an unreviewable diff.
  for (const source of [QUIZ, QUIZ.replace(/\n\n/g, "\n"), QUIZ.replace(/\n/g, "\r\n")]) {
    const parsed = splitQuestions(source);
    const untouched = parsed.questions.map((q, i) => ({
      sourceIndex: i,
      data: null,
      dirty: false,
    }));
    assert.equal(renderQuizFile(parsed, untouched), source);
  }
});

test("editing one question leaves every other byte-identical", () => {
  const parsed = splitQuestions(QUIZ);
  const working = parsed.questions.map((q, i) => ({
    sourceIndex: i,
    data: null,
    dirty: false,
  }));
  working[1] = {
    sourceIndex: 1,
    dirty: true,
    data: { type: "multichoice", name: "q1", questiontext: "<p>Which?</p>", answers: [] },
  };
  const out = renderQuizFile(parsed, working);
  assert.ok(out.startsWith(QUIZ.slice(0, QUIZ.indexOf('<question type="multichoice"') - 2)));
  assert.ok(out.includes("<subquestion><text>a</text><answer><text>b</text></answer></subquestion>"));
  assert.ok(out.trimEnd().endsWith("</quiz>"));
});

test("a question type the editor cannot edit survives unchanged", () => {
  const parsed = splitQuestions(QUIZ);
  const matching = parsed.questions[2];
  const out = renderQuizFile(parsed, [{ sourceIndex: 2, data: null, dirty: false }]);
  assert.ok(out.includes(matching.source));
});

test("competency and depth of knowledge are written as Moodle tags", () => {
  const xml = writeQuestion({ type: "essay", name: "e", tags: toTags(["AP1", "AP3"], 3) });
  assert.ok(xml.includes("<tag><text>AP1</text></tag>"));
  assert.ok(xml.includes("<tag><text>dok:3</text></tag>"));
  assert.deepEqual(competencyTags(["AP1", "dok:3"]), { develops: ["AP1"], dok: 3 });
});

test("CDATA wraps what needs it and nothing else", () => {
  // Matching Moodle's own export keeps an edited question a few lines
  // different from its neighbours rather than wholly reformatted.
  const xml = writeQuestion({ type: "essay", name: "Plain name", questiontext: "<p>HTML</p>" });
  assert.ok(xml.includes("<text>Plain name</text>"));
  assert.ok(xml.includes("<text><![CDATA[<p>HTML</p>]]></text>"));
});

test("a question whose text contains ]]> does not break out of its CDATA", () => {
  const xml = writeQuestion({ type: "essay", name: "x", questiontext: "a ]]> b" });
  assert.ok(!/\]\]>\s*b/.test(xml.split("questiontext")[1].split("</text>")[0].replace("<![CDATA[", "")));
  assert.ok(xml.includes("]]]]><![CDATA[>"));
});
