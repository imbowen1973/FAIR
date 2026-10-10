// The private companion's pure side: which files are read, which tabs a
// block gains, whether a companion belongs to this course, and the quick
// check of a question bank as it is typed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkPairing,
  checkQuestions,
  companionDocuments,
  companionPaths,
  starterQuestions,
} from "../companion.js";

test("reads companion.yaml and each block's text files, nothing else", () => {
  assert.deepEqual(
    companionPaths([
      "companion.yaml", "README.md",
      "blocks/01/questions.yaml", "blocks/01/instructorguide.md",
      "blocks/01/media/answer-key.png", "blocks/01/deep/x.md",
    ]),
    ["companion.yaml", "blocks/01/questions.yaml", "blocks/01/instructorguide.md"]
  );
});

test("a block gains two private, fixed tabs routed to the companion", () => {
  const files = new Map([["blocks/01/questions.yaml", "questions: []"]]);
  const docs = companionDocuments("01", files);
  assert.deepEqual(docs.map((d) => [d.id, d.editor, d.repo, d.private, d.uncreated]), [
    ["companion:questions.yaml", "questions", "companion", true, false],
    ["companion:instructorguide.md", "markdown", "companion", true, true],
  ]);
  assert.equal(docs[0].path, "blocks/01/questions.yaml");
});

test("pairing: empty is set up, a match is fine, another course is refused", () => {
  assert.deepEqual(checkPairing(undefined, "o/lib"), { ok: true, setup: true, library: null });
  assert.equal(checkPairing("library: O/Lib\n", "o/lib").ok, true);
  const other = checkPairing("library: o/other\n", "o/lib");
  assert.equal(other.ok, false);
  assert.match(other.problem, /belongs to o\/other/);
  assert.equal(checkPairing("library: [unclosed", "o/lib").ok, false);
});

test("the starter bank is itself a valid bank", () => {
  const { problems, items } = checkQuestions(starterQuestions(["O1"]), { outcomes: new Set(["O1"]) });
  assert.deepEqual(problems, []);
  assert.equal(items.length, 1);
});

test("the quick check names what is wrong, per question", () => {
  const bank = [
    "questions:",
    "  - {id: q1, type: mcq, assesses: [O1], stem: s, options: [{text: a, correct: true}, {text: b, correct: true}]}",
    "  - {id: q1, type: truefalse, assesses: [O9], stem: s, answer: maybe}",
    "  - {id: q3, type: cloze, assesses: [O1], text: no gaps here}",
    "  - {id: q4, type: essay, assesses: [O1], stem: s}",
  ].join("\n");
  const { problems } = checkQuestions(bank, { outcomes: new Set(["O1"]) });
  const text = problems.join("\n");
  assert.match(text, /q1.*exactly one correct/);
  assert.match(text, /duplicate id/);
  assert.match(text, /unknown outcome O9/);
  assert.match(text, /true or false/);
  assert.match(text, /cloze needs 'text' with gaps/);
  assert.match(text, /q4.*type must be one of/);
});

test("broken YAML is a problem, not an exception", () => {
  assert.match(checkQuestions("questions: [").problems[0], /Not valid YAML/);
  assert.match(checkQuestions("foo: 1").problems[0], /top-level 'questions'/);
});
