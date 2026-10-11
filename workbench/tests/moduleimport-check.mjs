// A module as one block of Markdown (docs/module-md-format.md): read it,
// then plan exactly what it changes in a library.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { minutes, parseModule, planImport } from "../moduleimport.js";
import { parse } from "../yaml.js";

const EXAMPLE = readFileSync(new URL("./fixtures/module-example.md", import.meta.url), "utf8");
const LIBRARY = () =>
  new Map([
    ["course.yaml", "id: ce\ntitle: Old title\nstructure:\n  - block: 00-old\n"],
    ["blocks/00-old/block.yaml", "title: Old session\n"],
  ]);

test("the documented example reads cleanly", () => {
  const m = parseModule(EXAMPLE);
  assert.deepEqual(m.problems, []);
  assert.equal(m.meta.title, "Clinical Educator");
  assert.deepEqual(Object.keys(m.competencies), ["CE1", "CE2", "CE3"]);
  assert.match(m.funding.text, /Co-funded/);
  assert.deepEqual(m.sessions.map((s) => s.title), [
    "The clinic is not a classroom", "Adult learners in practice", "Feedback that changes practice",
  ]);
  assert.equal(m.ignored, 0);
});

test("headings are the groupings, named by `levels`, and sessions sit under them", () => {
  const plan = planImport(parseModule(EXAMPLE), LIBRARY());
  const course = parse(plan.changes.get("course.yaml"));
  assert.deepEqual(course.structure, [
    {
      kind: "unit", title: "Foundations of clinical teaching",
      children: [{
        kind: "day", title: "Day 1 — the clinic is not a classroom",
        children: [{ block: "01-the-clinic-is-not-a-classroom" }, { block: "02-adult-learners-in-practice" }],
      }],
    },
    { kind: "unit", title: "Assessment and feedback", children: [{ block: "05-feedback" }] },
  ]);
  // The module's details are kept in course.yaml, its id untouched.
  assert.equal(course.id, "ce");
  assert.equal(course.title, "Clinical Educator");
  assert.equal(course.level, "EQF 6");
  assert.equal(course.hours, 120);
});

test("every file the spec promises, and only those", () => {
  const plan = planImport(parseModule(EXAMPLE), LIBRARY());
  assert.deepEqual(plan.problems, []);
  assert.deepEqual([...plan.changes.keys()].sort(), [
    "attribution.yaml",
    "blocks/01-the-clinic-is-not-a-classroom/block.yaml",
    "blocks/01-the-clinic-is-not-a-classroom/lessonplan.md",
    "blocks/02-adult-learners-in-practice/block.yaml",
    "blocks/02-adult-learners-in-practice/lessonplan.md",
    "blocks/05-feedback/block.yaml",
    "blocks/05-feedback/lessonplan.md",
    "competencies/framework.yaml",
    "course.yaml",
    "outcomes.yaml",
  ]);
  const block = parse(plan.changes.get("blocks/01-the-clinic-is-not-a-classroom/block.yaml"));
  assert.deepEqual(block, {
    title: "The clinic is not a classroom", duration_minutes: 90, outcomes: ["O1", "O2"], resources: [],
  });
  const outcomes = parse(plan.changes.get("outcomes.yaml")).outcomes;
  assert.deepEqual(outcomes.O1, {
    statement: "Plan a teaching moment around a live case", develops: ["CE1", "CE2"], dok: 3,
  });
  // A list of statements gets ids after the highest in use.
  assert.deepEqual(parse(plan.changes.get("blocks/02-adult-learners-in-practice/block.yaml")).outcomes, ["O10"]);
  // The lesson plan opens with the summary and lists the outcomes.
  const lesson = plan.changes.get("blocks/01-the-clinic-is-not-a-classroom/lessonplan.md");
  assert.match(lesson, /Most clinical teaching is improvised/);
  assert.match(lesson, /- Plan a teaching moment around a live case/);
  // The old session is named, not deleted.
  assert.ok(plan.notes.some((n) => /00-old/.test(n) && /outside the running order/.test(n)));
  assert.ok(!plan.changes.has("blocks/00-old/block.yaml"));
});

test("an existing session is updated, and its lesson plan and deck never touched", () => {
  const files = LIBRARY();
  files.set("blocks/05-feedback/block.yaml", "title: Feedback\nresources:\n  - {type: workbook, path: workbook.md}\ncode: FB\n");
  files.set("blocks/05-feedback/lessonplan.md", "# Mine, written by hand\n");
  files.set("blocks/05-feedback/slides.md", "---\nsession: x\n---\n");
  const plan = planImport(parseModule(EXAMPLE), files);
  const meta = parse(plan.changes.get("blocks/05-feedback/block.yaml"));
  assert.equal(meta.title, "Feedback that changes practice");
  assert.equal(meta.code, "FB");
  assert.deepEqual(meta.resources, [{ type: "workbook", path: "workbook.md" }]);
  assert.ok(!plan.changes.has("blocks/05-feedback/lessonplan.md"));
  assert.ok(!plan.changes.has("blocks/05-feedback/slides.md"));
});

test("importing the same module twice changes nothing the second time", () => {
  const first = planImport(parseModule(EXAMPLE), LIBRARY());
  const files = LIBRARY();
  for (const [path, text] of first.changes) files.set(path, text);
  const second = planImport(parseModule(EXAMPLE), files);
  assert.equal(second.changes.size, 0);
  assert.ok(second.rows.every((r) => r.action === "same"));
});

test("what stops an import, said plainly", () => {
  const cases = [
    ["--- session\ntitle: A\n---\n", /no title/],
    ["---\ntitle: M\n---\n--- session\nduration: 30\n---\n", /has no title/],
    ["---\ntitle: M\n---\n--- session\ntitle: A\noutcomes:\n  O1: {statement: x, develops: [ZZ]}\n---\n", /develops ZZ, which isn't one of the module's competencies/],
    ["---\ntitle: M\n---\n--- session\ntitle: A\noutcomes: {O1: x}\n---\n--- session\ntitle: B\noutcomes: {O1: y}\n---\n", /Outcome O1 is given twice/],
    ["---\ntitle: M\n---\n--- session\nid: x\ntitle: A\n---\n--- session\nid: x\ntitle: B\n---\n", /Two sessions have the id x/],
    ["---\ntitle: M\n---\n--- session\ntitle: A\nduration: soon\n---\n", /isn't a number of minutes/],
    ["---\ntitle: M\n---\n--- session\ntitle: [A\n---\n", /session block starting on line 4 doesn't read/],
    ["---\ntitle: M\n---\n--- session\ntitle: A\n", /never closes/],
  ];
  for (const [text, want] of cases) {
    const plan = planImport(parseModule(text), new Map());
    assert.ok(plan.problems.some((p) => want.test(p)), `${want} in ${JSON.stringify(plan.problems)}`);
    assert.equal(plan.changes.size, 0);
  }
});

test("a broken file in the library is never overwritten", () => {
  const files = new Map([["outcomes.yaml", "outcomes:\n  O1: x\nF\n- y\n"]]);
  const plan = planImport(parseModule(EXAMPLE), files);
  assert.ok(plan.problems.some((p) => /outcomes.yaml can't be read/.test(p)));
  assert.equal(plan.changes.size, 0);
});

test("what models wrap it in, and say around it, does no harm", () => {
  const wrapped = "```markdown\n" + EXAMPLE.trim() + "\n```";
  assert.deepEqual(parseModule(wrapped).problems, []);
  const chatty = EXAMPLE.replace("## Assessment", "Here is the rest of your module!\n\n## Assessment");
  const m = parseModule(chatty);
  assert.equal(m.ignored, 1);
  assert.ok(planImport(m, new Map()).notes.some((n) => /1 line .* was ignored/.test(n)));
});

test("durations", () => {
  assert.equal(minutes(90), 90);
  assert.equal(minutes("90 min"), 90);
  assert.equal(minutes("1.5 h"), 90);
  assert.equal(minutes("2 hours"), 120);
  assert.equal(minutes(undefined), null);
  assert.ok(Number.isNaN(minutes("soon")));
});
