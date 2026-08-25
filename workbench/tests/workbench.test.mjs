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
import { draftBranch, GitHub, parseRepo, resolveDraftBranch } from "../github.js";
import {
  blockDocuments,
  freePath,
  withResource,
  withoutResource,
} from "../documents.js";
import { markdownToHtml } from "../markdown.js";
import { repoImages, resolveMedia, videoHost, videoThumb } from "../media.js";
import { repoLogos } from "../course.js";
import { readImport, renumber } from "../import.js";
import { canRedo, canUndo, newHistory, record, redo, undo } from "../history.js";
import { describeRegion, needsAsking } from "../relayout.js";
import {
  fillRole,
  freeOutcomeId,
  openingSlides,
  outcomeDoc,
  outcomeList,
  progression,
  roleRegions,
} from "../outcomes.js";
import {
  documentTemplate,
  hasOutcomesSection,
  refreshOutcomes,
  summaryTemplate,
} from "../summary.js";
import {
  blankQuestion,
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
  applyLayoutChange,
  isEmptyRegion,
  layoutChange,
  mintSlideIds,
  parseSlides,
  placedBlocks,
  slideMark,
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
  const branch = draftBranch("ada");
  assert.equal(branch, "draft/ada");
  // One branch per person per library, not one per session: a second
  // session used to fork from the published branch and leave the first
  // session's saved work stranded where nothing was looking.
  assert.equal(branch, draftBranch("ada"));
  assert.ok(!draftBranch("Odd Name!").includes(" "));
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
  // Outcomes are a session's own, so they get a tab beside its plan.
  assert.deepEqual(
    docs.map((d) => d.id),
    ["slides", "outcomes", "lessonplan.md", "workbook.md", "files/data.xlsx"]
  );
  // The lesson plan gets a tab whether or not the manifest lists it,
  // because every block has one.
  assert.equal(docs[1].editor, "outcomes");
  assert.equal(docs[2].title, "Lesson plan");
  assert.equal(docs[3].editor, "markdown");
  assert.equal(docs[4].editor, "attachment");
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
  assert.deepEqual(competencyTags(["AP1", "dok:3"]), {
    develops: ["AP1"],
    outcomes: [],
    dok: 3,
  });
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

test("a question's tags carry the outcome it assesses, namespaced", () => {
  // Three kinds share one flat list, because that is all Moodle gives
  // us, so outcomes are prefixed and everything else stays a competency.
  const xml = writeQuestion({
    type: "essay",
    name: "e",
    tags: toTags(["AP1"], 2, ["O1"]),
  });
  assert.ok(xml.includes("<tag><text>outcome:O1</text></tag>"));
  assert.ok(xml.includes("<tag><text>AP1</text></tag>"));
  assert.ok(xml.includes("<tag><text>dok:2</text></tag>"));

  assert.deepEqual(competencyTags(["outcome:O1", "AP1", "dok:2"]), {
    develops: ["AP1"],
    outcomes: ["O1"],
    dok: 2,
  });
});

test("a hand-written tag is kept, not thrown away", () => {
  // Anything unrecognised is treated as a competency rather than dropped.
  assert.deepEqual(competencyTags(["something-a-human-added"]), {
    develops: ["something-a-human-added"],
    outcomes: [],
    dok: null,
  });
});

// ---- the outcome catalogue --------------------------------------------

test("the catalogue round-trips through the editor's shape", () => {
  const doc = {
    outcomes: {
      O1: { statement: "Do a thing", develops: ["AP1"], dok: 2 },
      O2: "Not yet mapped",
    },
  };
  const list = outcomeList(doc);
  assert.deepEqual(list[0], {
    id: "O1",
    statement: "Do a thing",
    develops: ["AP1"],
    dok: 2,
  });
  // A bare string is just a statement, for a catalogue not yet mapped.
  assert.deepEqual(list[1].develops, []);
  assert.deepEqual(outcomeDoc(list).outcomes.O1, {
    statement: "Do a thing",
    develops: ["AP1"],
    dok: 2,
  });
  // Empty keys are not written: an unmapped outcome stays a one-liner.
  assert.deepEqual(outcomeDoc(list).outcomes.O2, { statement: "Not yet mapped" });
});

test("a new outcome gets a free id", () => {
  assert.equal(freeOutcomeId(new Set()), "O1");
  assert.equal(freeOutcomeId(new Set(["O1", "O2"])), "O3");
});

// ---- the session summary -----------------------------------------------

const SESSION = {
  block: { id: "v130-big-data", title: "Big data", code: "V130", duration: 90 },
  outcomes: [
    { id: "O1", statement: "Identify common ways big data could be misused" },
    { id: "O2", statement: "Evaluate the ethical and legal implications" },
  ],
  documents: [
    { id: "slides", file: "slides.md", title: "Slides", type: "slides" },
    { id: "assessment.xml", file: "assessment.xml", title: "Assessment", type: "assessment" },
  ],
};

test("a summary names the session and lists the outcomes it owns", () => {
  const out = summaryTemplate(SESSION);
  assert.ok(out.includes("# Big data — Summary"));
  assert.ok(out.includes("**Session:** V130"));
  assert.ok(out.includes("- Identify common ways big data could be misused"));
  assert.ok(out.includes("- Evaluate the ethical and legal implications"));
});

test("a summary links the block's own documents, not a folder somewhere", () => {
  // The template a course inherits points at a .docx in a numbered
  // folder. Here the deck and the assessment are in the block.
  const out = summaryTemplate(SESSION);
  assert.ok(out.includes("[Slides](slides.md)"));
  assert.ok(out.includes("[Assessment](assessment.xml)"));
});

test("a section with nothing in it says so", () => {
  // "No assignment" is information; a missing heading is ambiguous.
  const out = summaryTemplate(SESSION);
  assert.ok(out.includes("## Assignment"));
  assert.ok(out.includes("There is no assignment."));
  assert.ok(out.includes("There are no extra materials or sources."));
});

test("refreshing the outcomes leaves every other word alone", () => {
  const out = summaryTemplate(SESSION);
  const edited = out.replace(
    "*Two or three sentences on what this session covers, and why it*",
    "This session explores the ethics of big data in veterinary practice."
  );
  const again = refreshOutcomes(edited, [{ id: "O9", statement: "Something else" }]);

  assert.ok(again.includes("This session explores the ethics of big data"));
  assert.ok(again.includes("- Something else"));
  assert.ok(!again.includes("Identify common ways big data could be misused"));
  assert.ok(again.includes("[Assessment](assessment.xml)"));
});

test("a summary somebody rewrote by hand is never clobbered", () => {
  const theirs = "# My own summary\n\nNo markers here.\n";
  assert.equal(refreshOutcomes(theirs, [{ id: "O1", statement: "x" }]), theirs);
  assert.equal(hasOutcomesSection(theirs), false);
  assert.equal(hasOutcomesSection(summaryTemplate(SESSION)), true);
});

test("a session with no outcomes yet says where to add them", () => {
  const out = summaryTemplate({ ...SESSION, outcomes: [] });
  assert.ok(out.includes("No outcomes are assigned to this session yet"));
});

test("a competency spanning sessions is not flagged; one confined to a session is", () => {
  // The distinction the model rests on: an outcome belongs to one
  // session, a competency builds across several.
  const outcomes = [
    { id: "O1", statement: "a", develops: ["V1"], dok: 1 },
    { id: "O2", statement: "b", develops: ["V1", "V2"], dok: 3 },
  ];
  const blocks = [{ id: "b1", title: "First" }, { id: "b2", title: "Second" }];
  const owner = { O1: "b1", O2: "b2" };
  const rows = progression(outcomes, owner, blocks, { V1: "Spans", V2: "Confined" });

  const spans = rows.find((r) => r.id === "V1");
  assert.deepEqual(spans.sessions.map((s) => s.blockId), ["b1", "b2"], "in delivery order");
  assert.deepEqual(spans.sessions.map((s) => s.dok), [1, 3], "and it builds");
  assert.equal(spans.confined, false);

  assert.equal(rows.find((r) => r.id === "V2").confined, true);
});

test("an outcome with no session contributes to no progression", () => {
  const rows = progression(
    [{ id: "O1", statement: "a", develops: ["V1"], dok: 2 }],
    {},
    [{ id: "b1", title: "First" }],
    { V1: "Nothing builds this" }
  );
  assert.deepEqual(rows[0].sessions, []);
});

// ---- slides filled from the library -------------------------------------

const BLOCK_META = {
  title: "Big data",
  code: "V130",
  duration_minutes: 90,
  outcomes: ["O1", "O2"],
};
const CATALOGUE = {
  O1: { statement: "Identify common ways big data could be misused" },
  O2: { statement: "Evaluate the ethical and legal implications" },
};

test("a title slide is filled from the block, not typed", () => {
  const filled = fillRole(
    { id: "s-01", layout: "Title", role: "title" },
    { blockMeta: BLOCK_META, catalogue: CATALOGUE, layoutRegions: ["title", "subtitle"] }
  );
  assert.equal(filled.title, "Big data");
  assert.equal(filled.subtitle, "V130 · 90 minutes");
});

test("an outcomes slide is filled from the catalogue", () => {
  const filled = fillRole(
    { id: "s-02", layout: "Full", role: "outcomes" },
    { blockMeta: BLOCK_META, catalogue: CATALOGUE, layoutRegions: ["title", "full"] }
  );
  assert.equal(filled.title, "Learning outcomes");
  assert.deepEqual(filled.full, {
    type: "ul",
    items: [
      "Identify common ways big data could be misused",
      "Evaluate the ethical and legal implications",
    ],
  });
});

test("what an author writes on a role slide wins", () => {
  // A role fills what is absent. It never overwrites.
  const filled = fillRole(
    { id: "s-02", layout: "Full", role: "outcomes", title: "What you will do" },
    { blockMeta: BLOCK_META, catalogue: CATALOGUE, layoutRegions: ["title", "full"] }
  );
  assert.equal(filled.title, "What you will do");
});

test("a slide with no role is returned untouched", () => {
  const slide = { id: "s-03", layout: "Full", title: "Ordinary" };
  assert.equal(
    fillRole(slide, { blockMeta: BLOCK_META, catalogue: CATALOGUE, layoutRegions: [] }),
    slide
  );
});

test("filled regions are named, so the editor can stop you typing in them", () => {
  // Typing into a generated region would make a second copy of something
  // the library already holds -- which is the thing roles exist to avoid.
  assert.deepEqual(
    roleRegions({ role: "outcomes" }, ["title", "full"]),
    ["title", "full"]
  );
  // A region the author filled is theirs, and stays editable.
  assert.deepEqual(
    roleRegions({ role: "outcomes", title: "Mine" }, ["title", "full"]),
    ["full"]
  );
});

/** A slides.md with the given frontmatter lines and one slide. */
function deck(frontmatter, slide) {
  const nl = String.fromCharCode(10);
  return (
    ["---", ...frontmatter, "---", ""].join(nl) +
    nl +
    ["--- slide", ...slide, "---", ""].join(nl)
  );
}

// ---- changing a layout must not lose what is in it ---------------------

const RELAYOUT_MAP = {
  Full: { regions: { title: 0, full: 1 } },
  Comparison: { regions: { title: 0, left: 1, right: 2 } },
  Title: { regions: { title: 0 } },
};

test("a layout change reports what has nowhere to go", () => {
  const slide = { id: "s-01", layout: "Full", title: "T", full: { type: "ul", items: ["a"] } };
  const change = layoutChange(slide, RELAYOUT_MAP, "Comparison");
  assert.deepEqual(change.kept, ["title"]);
  assert.deepEqual(change.orphans, ["full"]);
  assert.deepEqual(change.free, ["left", "right"]);
  // Paired off in order as a starting point, never applied unasked.
  assert.deepEqual(change.suggested, { full: "left" });
});

test("a layout with nowhere to put the content says so", () => {
  const slide = { id: "s-01", layout: "Full", title: "T", full: "words" };
  const change = layoutChange(slide, RELAYOUT_MAP, "Title");
  assert.deepEqual(change.orphans, ["full"]);
  assert.deepEqual(change.free, []);
  assert.deepEqual(change.suggested, { full: "" });
});

test("an empty region is not content worth asking about", () => {
  // Every layout leaves regions behind; only the filled ones matter.
  for (const empty of [undefined, null, "", "  ", { type: "ul", items: [] }, { type: "p", text: "" }]) {
    assert.equal(isEmptyRegion(empty), true, JSON.stringify(empty) ?? "undefined");
  }
  for (const full of ["a", { type: "ul", items: ["a"] }, { src: "media/x.png" }, { url: "https://v" }]) {
    assert.equal(isEmptyRegion(full), false, JSON.stringify(full));
  }
  const slide = { id: "s-01", layout: "Full", title: "T", full: "" };
  assert.equal(needsAsking(slide, RELAYOUT_MAP, "Title"), false);
});

test("applying a layout change moves the content it was told to", () => {
  const slide = { id: "s-01", layout: "Full", title: "T", full: { type: "ul", items: ["a"] } };
  const moved = applyLayoutChange(slide, RELAYOUT_MAP, "Comparison", { full: "left" });
  assert.deepEqual(moved, {
    id: "s-01", layout: "Comparison", title: "T", left: { type: "ul", items: ["a"] },
  });
  // An orphan told to go nowhere is dropped, and the key goes with it --
  // leaving it behind is what the renderer refuses.
  const dropped = applyLayoutChange(slide, RELAYOUT_MAP, "Title", { full: "" });
  assert.deepEqual(Object.keys(dropped).sort(), ["id", "layout", "title"]);
});

test("what a region holds is described before it is moved", () => {
  assert.ok(describeRegion({ type: "ul", items: ["a", "b"] }).includes("2 items"));
  assert.equal(describeRegion({ type: "ul", items: ["a"] }), "1 item");
  assert.match(describeRegion("hello"), /hello/);
  assert.ok(describeRegion({ src: "media/cow.png" }).includes("cow.png"));
});

// ---- undo --------------------------------------------------------------

test("undo steps back and redo steps forward again", () => {
  const h = record(newHistory(), "a");
  assert.equal(canUndo(h), false, "nothing to undo at the start");
  record(h, "b");
  record(h, "c");
  assert.equal(undo(h), "b");
  assert.equal(undo(h), "a");
  assert.equal(canUndo(h), false);
  assert.equal(redo(h), "b");
  assert.equal(redo(h), "c");
  assert.equal(canRedo(h), false);
});

test("a burst of typing is one step, not one per keystroke", () => {
  const h = record(newHistory(), "");
  let t = 1000;
  for (const text of ["h", "he", "hel", "hell", "hello"]) record(h, text, "edit:0:full", t += 50);
  assert.equal(h.stack.length, 2, "the whole word is one step");
  assert.equal(undo(h), "");

  // A pause makes the next keystroke a step of its own.
  const g = record(newHistory(), "");
  record(g, "a", "edit:0:full", 1000);
  record(g, "ab", "edit:0:full", 5000);
  assert.equal(g.stack.length, 3);
});

test("typing in a different region never joins the step before it", () => {
  const h = record(newHistory(), "");
  record(h, "a", "edit:0:left", 1000);
  record(h, "b", "edit:0:right", 1010);
  assert.equal(h.stack.length, 3);
});

test("a change after an undo drops the redo tail", () => {
  const h = record(newHistory(), "a");
  record(h, "b");
  record(h, "c");
  undo(h);
  record(h, "d");
  assert.equal(canRedo(h), false, "c is unreachable now");
  assert.equal(undo(h), "b");
});

test("a change after an undo does not coalesce into the step before it", () => {
  const h = record(newHistory(), "");
  record(h, "a", "edit:0:full", 1000);
  undo(h);
  record(h, "z", "edit:0:full", 1050);
  // Without clearing the key this would overwrite, and the undo would be
  // silently discarded.
  assert.equal(canUndo(h), true);
  assert.equal(undo(h), "");
});

test("the stack is capped and drops the oldest", () => {
  const h = newHistory();
  for (let i = 0; i < 200; i += 1) record(h, i);
  assert.ok(h.stack.length <= 60, `capped, got ${h.stack.length}`);
  assert.equal(h.stack[h.stack.length - 1], 199);
});

// ---- slide ids are permanent -------------------------------------------
//
// An id is the key of slide-id-map.json and is written into the
// provenance and speaker notes of every rendered deck. Reissuing one
// points artifacts already in circulation at different content, so these
// pin the rule: allocated once, never reused, never renamed.

test("a new id is above everything the deck has used, not the lowest free", () => {
  assert.deepEqual(mintSlideIds(1, ["s-01", "s-02", "s-03"], 3).ids, ["s-04"]);
  // The gap left by a deleted s-02 is not filled: s-02 is retired.
  assert.deepEqual(mintSlideIds(1, ["s-01", "s-03"], 3).ids, ["s-04"]);
});

test("the high-water mark survives losing the highest slide", () => {
  // Delete s-03, then add one. Without the mark this returns s-03 again.
  assert.deepEqual(mintSlideIds(1, ["s-01", "s-02"], 3).ids, ["s-04"]);
});

test("the mark is read from the deck's frontmatter and only rises", () => {
  const parsed = parseSlides(
    deck(["title: T", "slide_seq: 9"], ["id: s-01", "layout: Full"])
  );
  assert.equal(slideMark(parsed, []), 9);
  // A slide numbered above the recorded mark raises it.
  assert.equal(slideMark(parsed, [{ data: { id: "s-12" } }]), 12);
});

test("adding a slide leaves the frontmatter alone", () => {
  // While the highest id present is the mark, it is derivable and the
  // line would be churn on every review.
  const parsed = parseSlides(deck(["title: T"], ["id: s-01", "layout: Full"]));
  const working = workingSlides(parsed);
  working.push(blankSlide("Full", "s-02"));
  assert.ok(!renderSlidesFile(parsed, working).includes("slide_seq"));
});

test("deleting the highest slide records the mark, so it is not reissued", () => {
  const parsed = parseSlides(
    deck(["title: T"], ["id: s-01", "layout: Full"]) +
      String.fromCharCode(10) +
      ["--- slide", "id: s-02", "layout: Full", "---", ""].join(String.fromCharCode(10))
  );
  assert.equal(parsed.slides.length, 2);

  // Delete s-02. Its number must not come back.
  const working = workingSlides(parsed).slice(0, 1);
  const saved = renderSlidesFile(parsed, working);
  assert.match(saved, /slide_seq: 2/);

  const reopened = parseSlides(saved);
  const left = workingSlides(reopened);
  assert.deepEqual(
    mintSlideIds(1, left.map((w) => w.data.id), slideMark(reopened, left)).ids,
    ["s-03"]
  );
});

test("the mark does not disturb frontmatter that is already there", () => {
  const parsed = parseSlides(
    deck(
      ["session: '01'", "title: T", "version: 1.0.0", "slide_seq: 9"],
      ["id: s-01", "layout: Full"]
    )
  );
  const out = renderSlidesFile(parsed, workingSlides(parsed));
  for (const kept of ["session: '01'", "title: T", "version: 1.0.0"]) {
    assert.ok(out.includes(kept), kept);
  }
  // Updated in place, not appended again on every save.
  assert.equal(out.match(/slide_seq:/g).length, 1);
  const again = parseSlides(out);
  assert.equal(
    renderSlidesFile(again, workingSlides(again)).match(/slide_seq:/g).length,
    1
  );
  // And a mark already written is never lowered.
  assert.match(out, /slide_seq: 9/);
});


test("an import keeps ids that do not clash and lifts ones that do", () => {
  const out = renumber(
    [{ id: "intro-hook" }, { id: "s-01" }],
    ["s-01", "s-02", "s-03"],
    3
  );
  // The author's own id is theirs; only the collision moves, and it
  // moves above the mark rather than into a gap.
  assert.deepEqual(out.map((s) => s.id), ["intro-hook", "s-04"]);
});

test("an import never lands on the id of a deleted slide", () => {
  // Deck lost s-02 and s-03; the mark still says 3.
  assert.deepEqual(renumber([{ id: "s-01" }], ["s-01"], 3).map((s) => s.id), ["s-04"]);
});

test("the opening slides carry a role and no words at all", () => {
  const opening = openingSlides(["s-07", "s-08"]);
  assert.deepEqual(opening.map((s) => s.role), ["title", "outcomes"]);
  assert.deepEqual(opening.map((s) => s.id), ["s-07", "s-08"]);
  for (const slide of opening) {
    assert.deepEqual(Object.keys(slide).sort(), ["id", "layout", "role"]);
  }
});

test("the opening slides refuse to invent their own ids", () => {
  // They used to derive s-01 and s-02 from a stem, which duplicated the
  // ids of any deck that already had them.
  assert.throws(() => openingSlides("s-01"), /two minted ids/);
  assert.throws(() => openingSlides(["s-01"]), /two minted ids/);
});

test("a lesson plan nobody has written is uncreated, not missing", () => {
  // Two different absences. The lesson plan always has a tab because
  // every block needs one, so a block that has not written its plan is
  // incomplete, not broken.
  const block = { id: "b", meta: { resources: [{ type: "workbook", path: "workbook.md" }] } };
  const docs = blockDocuments(block, new Map([["blocks/b/slides.md", "x"]]));
  const plan = docs.find((d) => d.type === "lessonplan");
  assert.equal(plan.uncreated, true);
  assert.equal(plan.missing, false, "nothing declares it, so nothing is broken");

  // A resource block.yaml declares and the repo does not hold is broken.
  const workbook = docs.find((d) => d.id === "workbook.md");
  assert.equal(workbook.uncreated, true);
  assert.equal(workbook.missing, true);
});

test("a pending edit counts as created", () => {
  // blockDocuments reads the pending file map, so a document written but
  // not yet committed is not offered for creation a second time.
  const block = { id: "b", meta: {} };
  const pending = new Map([
    ["blocks/b/slides.md", "x"],
    ["blocks/b/lessonplan.md", "# Summary"],
  ]);
  const plan = blockDocuments(block, pending).find((d) => d.type === "lessonplan");
  assert.equal(plan.uncreated, false);
});

// ---- the other document kinds ------------------------------------------

test("a workbook, an assignment and teacher resources each get a shape", () => {
  // An empty page is where a document that never gets written begins.
  const block = { id: "b", title: "Big data" };
  const outcomes = [{ id: "O1", statement: "Identify misuse" }];

  const assignment = documentTemplate({ kind: "assignment", block, outcomes });
  assert.ok(assignment.includes("## The task"));
  assert.ok(assignment.includes("## What to hand in"));
  assert.ok(assignment.includes("## How it is marked"));
  // An assignment is assessed against the session's outcomes, so they
  // are generated into it the same way the lesson plan gets them.
  assert.ok(assignment.includes("- Identify misuse"));
  assert.equal(hasOutcomesSection(assignment), true);

  const workbook = documentTemplate({ kind: "workbook", block, outcomes });
  assert.ok(workbook.includes("## What you will be able to do"));
  assert.ok(workbook.includes("## Activity 1"));

  const teacher = documentTemplate({ kind: "teacherresources", block, outcomes });
  assert.ok(teacher.includes("## Before the session"));
  assert.ok(teacher.includes("## Materials"));
  // Not the learner's outcomes: this document is for whoever runs it.
  assert.equal(hasOutcomesSection(teacher), false);
});

test("the old instructor guide name still resolves", () => {
  const out = documentTemplate({
    kind: "instructorguide",
    block: { id: "b", title: "Big data" },
  });
  assert.ok(out.includes("# Teacher resources"));
});

test("a kind with no shape of its own still gets a heading", () => {
  const out = documentTemplate({
    kind: "handout",
    title: "Reading list",
    block: { id: "b", title: "Big data" },
  });
  assert.ok(out.startsWith("# Reading list — Big data"));
});

test("a document named by the author takes that name as its file", () => {
  // Two workbooks should be told apart in the strip and in block.yaml,
  // not be "Workbook" and "Workbook 2".
  assert.equal(freePath("workbook", new Set(), "case-study-pack.md"), "case-study-pack.md");
  assert.equal(
    freePath("workbook", new Set(["case-study-pack.md"]), "case-study-pack.md"),
    "case-study-pack-2.md"
  );
  // And with no name given, the kind's own file.
  assert.equal(freePath("workbook", new Set()), "workbook.md");
});

// ---- Moodle's structured feedback --------------------------------------

test("a multiple choice question carries Moodle's combined feedback", () => {
  // Three outcomes, not one blob: this is what makes a quiz teach
  // rather than only score.
  const xml = writeQuestion({
    type: "multichoice",
    name: "Q1",
    questiontext: "<p>Which?</p>",
    single: false,
    shownumcorrect: true,
    correctfeedback: "Exactly right.",
    partiallycorrectfeedback: "Half way there.",
    incorrectfeedback: "Not this time.",
    answers: [{ text: "a", fraction: "50", feedback: "yes" }],
  });
  assert.ok(xml.includes("<correctfeedback format=\"html\">"));
  assert.ok(xml.includes("Exactly right."));
  assert.ok(xml.includes("Half way there."));
  assert.ok(xml.includes("Not this time."));
  assert.ok(xml.includes("<shownumcorrect/>"));
  assert.ok(xml.includes("<showstandardinstruction>0</showstandardinstruction>"));
});

test("a new question gets Moodle's own default wording", () => {
  // So a question created here imports looking like one created there,
  // rather than with three empty feedback fields.
  const q = blankQuestion("multichoice", "Q1");
  assert.equal(q.correctfeedback, "Your answer is correct.");
  assert.equal(q.partiallycorrectfeedback, "Your answer is partially correct.");
  assert.equal(q.incorrectfeedback, "Your answer is incorrect.");
});

test("counting correct answers is only offered when more than one can be", () => {
  const single = writeQuestion({
    type: "multichoice", name: "Q", single: true, shownumcorrect: true, answers: [],
  });
  assert.ok(!single.includes("<shownumcorrect/>"), "meaningless on a single-answer question");
});

test("hints are written in order, with their own flags", () => {
  const xml = writeQuestion({
    type: "multichoice",
    name: "Q",
    hints: [
      { text: "Think about consent", shownumcorrect: true },
      { text: "Two are right", clearwrong: true, options: true },
      { text: "   " },
    ],
    answers: [],
  });
  const hints = xml.split("<hint ").length - 1;
  assert.equal(hints, 2, "an empty hint is not written");
  assert.ok(xml.indexOf("Think about consent") < xml.indexOf("Two are right"));
  assert.ok(xml.includes("<clearwrong/>"));
  assert.ok(xml.includes("<options>1</options>"));
});

test("a short answer question says whether case matters", () => {
  assert.ok(writeQuestion({ type: "shortanswer", name: "Q", usecase: true, answers: [] })
    .includes("<usecase>1</usecase>"));
  assert.ok(writeQuestion({ type: "shortanswer", name: "Q", answers: [] })
    .includes("<usecase>0</usecase>"));
});

test("an essay carries the marker's notes, which the learner never sees", () => {
  const xml = writeQuestion({
    type: "essay",
    name: "Q",
    graderinfo: "Look for a reference to consent.",
    responsefieldlines: 15,
    attachments: 2,
  });
  assert.ok(xml.includes("<graderinfo format=\"html\">"));
  assert.ok(xml.includes("Look for a reference to consent."));
  assert.ok(xml.includes("<responsefieldlines>15</responsefieldlines>"));
  assert.ok(xml.includes("<attachments>2</attachments>"));
  // Combined feedback is a multichoice thing; an essay has no "wrong".
  assert.ok(!xml.includes("<correctfeedback"));
});

test("an untouched question is still byte-identical after all of this", () => {
  // The rule the whole editor rests on, re-checked now the writer emits
  // considerably more.
  const parsed = splitQuestions(QUIZ);
  const untouched = parsed.questions.map((q, i) => ({
    sourceIndex: i, data: null, dirty: false,
  }));
  assert.equal(renderQuizFile(parsed, untouched), QUIZ);
});

// ---- media --------------------------------------------------------------

test("a hosted video gets a still without an API call", () => {
  // YouTube publishes one at a predictable address, so a slide shows a
  // real frame with no key and no request from us.
  const expected = "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
  assert.equal(videoThumb("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), expected);
  assert.equal(videoThumb("https://youtu.be/dQw4w9WgXcQ"), expected);
  assert.equal(videoThumb("https://www.youtube.com/embed/dQw4w9WgXcQ"), expected);
  // Anywhere else needs a poster committed alongside, and saying so is
  // more useful than showing a grey box.
  assert.equal(videoThumb("https://vimeo.com/12345"), null);
  assert.equal(videoHost("https://vimeo.com/12345"), "Vimeo");
});

test("media resolves to somewhere a browser can actually load it", () => {
  const repo = { owner: "o", repo: "r", defaultBranch: "main" };
  const args = { blockId: "a", repo, uploads: new Map(), urls: new Map() };

  // Relative to the block, which is how a slide refers to its own media.
  assert.equal(
    resolveMedia("media/x.png", args),
    "https://raw.githubusercontent.com/o/r/main/blocks/a/media/x.png"
  );
  // A link is already a URL and is left alone.
  assert.equal(resolveMedia("https://x/y.png", args), "https://x/y.png");
  assert.equal(resolveMedia("", args), null);
});

test("the picture already in the repo is offered, the branding is not", () => {
  // A course uses the same diagram in four sessions and should not
  // carry four copies of it.
  assert.deepEqual(
    repoImages([
      "blocks/a/media/x.png",
      "branding/logo.png",
      "course.yaml",
      "blocks/b/media/y.jpg",
    ]),
    ["blocks/a/media/x.png", "blocks/b/media/y.jpg"]
  );
});

// ---- funding and attribution -------------------------------------------

test("emblems are found in branding, and only there", () => {
  // The funder's emblem is a repo-level thing; a picture in a session's
  // media folder is not one.
  assert.deepEqual(
    repoLogos([
      "branding/eu.png",
      "branding/university.svg",
      "blocks/a/media/photo.jpg",
      "course.yaml",
    ]),
    ["branding/eu.png", "branding/university.svg"]
  );
});

// ---- importing slides ---------------------------------------------------

const NEWLINE = String.fromCharCode(10);

const LAYOUTS = {
  Title: { regions: { title: 0, subtitle: 1 } },
  Full: { regions: { title: 0, full: 1 } },
  Split: { regions: { title: 0, left: 1, right: 2 } },
};

test("slides in the grammar are read as slides", () => {
  const result = readImport(
    [
      "--- slide", "id: s-01", "layout: Full", "title: Big data",
      "full:", "  type: ul", "  items:", "    - One", "---",
    ].join("\n"),
    { layoutMap: LAYOUTS }
  );
  assert.equal(result.kind, "grammar");
  assert.equal(result.slides.length, 1);
  assert.deepEqual(result.problems, []);
});

test("a layout the template does not have stops the import", () => {
  // Slides that look fine in a list and fail at render are worse than an
  // import that refuses, because by then nobody remembers where they
  // came from.
  const result = readImport(
    "--- slide\nid: s-01\nlayout: Nope\ntitle: x\n---\n",
    { layoutMap: LAYOUTS }
  );
  const fatal = result.problems.filter((p) => p.fatal);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /unknown layout Nope/);
  assert.match(fatal[0].message, /Title, Full, Split/, "say what is on offer");
});

test("a region the layout does not offer stops the import", () => {
  const result = readImport(
    "--- slide\nid: s-01\nlayout: Full\nleft: hello\n---\n",
    { layoutMap: LAYOUTS }
  );
  const fatal = result.problems.filter((p) => p.fatal);
  assert.match(fatal[0].message, /Full has no region called left/);
});

test("a duplicate id is said, and renumbered rather than refused", () => {
  // Ids are ours to manage, so a clash is worth saying and not worth
  // stopping for. Blocking on one would refuse an import that is fine.
  const result = readImport(
    ["--- slide", "id: s-01", "layout: Full", "title: x", "---", ""].join(NEWLINE),
    { layoutMap: LAYOUTS, existingIds: ["s-01"] }
  );
  assert.match(result.problems[0].message, /already in this deck/);
  assert.equal(result.problems[0].fatal, false);
  assert.equal(result.problems.filter((p) => p.fatal).length, 0, "nothing fatal");
});

test("an empty slide is noted, not refused", () => {
  // Adding one and filling it in later is a legitimate thing to do.
  const result = readImport(
    "--- slide\nid: s-01\nlayout: Full\n---\n",
    { layoutMap: LAYOUTS }
  );
  assert.equal(result.problems.filter((p) => p.fatal).length, 0);
  assert.equal(result.problems[0].fatal, false);
});

test("plain markdown becomes slides, headings first", () => {
  // Content arrives as prose far more often than as this grammar, and a
  // model asked for slides will sometimes hand back a document.
  const result = readImport(
    [
      "# Big data and ethics", "",
      "## What could go wrong", "",
      "- Re-identification", "- Bias in a model", "",
      "## Legal duties", "", "GDPR applies here too.",
    ].join("\n"),
    { layoutMap: LAYOUTS }
  );
  assert.equal(result.kind, "markdown");
  assert.deepEqual(result.slides.map((s) => s.layout), ["Title", "Full", "Full"]);
  assert.deepEqual(result.slides[1].full, {
    type: "ul",
    items: ["Re-identification", "Bias in a model"],
  });
  // Prose with no bullets becomes the body text rather than a one-item list.
  assert.equal(result.slides[2].full, "GDPR applies here too.");
  assert.deepEqual(result.problems, []);
});

test("a heading that collects content gets a layout with room for it", () => {
  const result = readImport("# Only a title\n\n- and a bullet\n", { layoutMap: LAYOUTS });
  assert.equal(result.slides[0].layout, "Full", "Title has nowhere to put a list");
});

test("imported ids are renumbered around what is already there", () => {
  // Pasting s-01 into a deck that has one is the commonest way this goes
  // wrong, and the ids are ours rather than the author's.
  assert.deepEqual(
    renumber([{ id: "s-01" }, { id: "s-02" }], ["s-01", "s-02", "s-03"]).map((s) => s.id),
    ["s-04", "s-05"]
  );
  // Nothing to avoid, nothing changes.
  assert.deepEqual(renumber([{ id: "intro" }], []).map((s) => s.id), ["intro"]);
});

// ---- the draft branch, when older ones are in the way ------------------
//
// Refs are paths. `draft/ada` is a file where `draft/ada/01-intro` makes
// `draft/ada` a directory, so a repository carrying branches from the
// older per-session scheme answers a ref creation with
//
//   422: Reference update failed
//
// which is what reached a user. Nothing is deleted: those branches still
// hold work somebody may want.

function fakeGh({ exists = [], matching = {} } = {}) {
  return {
    async branchExists(_o, _r, branch) {
      return exists.includes(branch);
    },
    async request(path) {
      const prefix = path.split("/git/matching-refs/heads/")[1];
      const refs = matching[prefix];
      if (!refs) {
        const err = new Error("Not Found");
        err.status = 404;
        throw err;
      }
      return refs.map((r) => ({ ref: `refs/heads/${r}` }));
    },
  };
}

test("a fresh repository gets the plain draft branch", async () => {
  const gh = fakeGh();
  assert.equal(await resolveDraftBranch(gh, "o", "r", "ada"), "draft/ada");
});

test("an existing draft branch is reused rather than renamed", async () => {
  const gh = fakeGh({ exists: ["draft/ada"] });
  assert.equal(await resolveDraftBranch(gh, "o", "r", "ada"), "draft/ada");
});

test("older per-session branches make the plain name impossible", async () => {
  // git will not have draft/ada as a file and draft/ada/ as a directory.
  const gh = fakeGh({ matching: { "draft/ada/": ["draft/ada/01-intro", "draft/ada/02-next"] } });
  assert.equal(await resolveDraftBranch(gh, "o", "r", "ada"), "draft/ada/work");
});

test("someone else's drafts do not push us aside", async () => {
  const gh = fakeGh({ matching: { "draft/bob/": ["draft/bob/01-intro"] } });
  assert.equal(await resolveDraftBranch(gh, "o", "r", "ada"), "draft/ada");
});

test("a branch that cannot exist says why, not 422", async () => {
  // The message a user saw was "Reference update failed", which is true
  // and useless. Every write path here can hit it, not only the draft.
  const gh = new GitHub("t");
  gh.branchExists = async () => false;
  gh.request = async (path) => {
    if (path.includes("/git/matching-refs/heads/draft/ada/")) {
      return [{ ref: "refs/heads/draft/ada/01-intro" }];
    }
    throw Object.assign(new Error("Not Found"), { status: 404 });
  };
  await assert.rejects(
    () => gh.ensureBranch("o", "r", "draft/ada", "main"),
    /draft\/ada\/01-intro.*branch and a folder of branches/s
  );
});
