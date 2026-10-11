// The question bank as data: read, write back, new questions, retyping,
// and what is wrong with a question said the way an educator would.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TYPES, bankProblems, blankQuestion, changeType, clozePreview, nextId, questionProblems, readBank, writeBank,
} from "../questionbank.js";

const OUTCOMES = new Set(["O1", "O2"]);

test("a bank reads, and writes back with anything else it held", () => {
  const bank = readBank("title: Week 1\nquestions:\n  - {id: q-01, type: truefalse, assesses: [O1], stem: S, answer: true}\n");
  assert.equal(bank.questions.length, 1);
  assert.deepEqual(bank.rest, { title: "Week 1" });
  const again = readBank(writeBank(bank));
  assert.deepEqual(again, bank);
  assert.match(readBank("questions: [").problem, /doesn't read/);
  assert.match(readBank("questions: 3").problem, /should be a list/);
  assert.deepEqual(readBank("").questions, []);
});

test("every new question is well formed once its words are filled in", () => {
  const filled = {
    mcq: (q) => { q.stem = "Q"; q.options = [{ text: "a", correct: true }, { text: "b" }]; },
    multi: (q) => { q.stem = "Q"; q.options = [{ text: "a", correct: true }, { text: "b" }]; },
    truefalse: (q) => { q.stem = "S"; },
    short: (q) => { q.stem = "Q"; q.answers = ["x"]; },
    numeric: (q) => { q.stem = "Q"; },
    match: (q) => { q.stem = "Q"; q.pairs = [{ prompt: "a", answer: "1" }, { prompt: "b", answer: "2" }]; },
    cloze: (q) => { q.text = "A [[gap]]."; },
  };
  for (const { type } of TYPES) {
    const q = blankQuestion(type, [], ["O1"]);
    assert.ok(questionProblems(q, { outcomes: OUTCOMES }).length, `${type} starts with something to do`);
    filled[type](q);
    assert.deepEqual(questionProblems(q, { outcomes: OUTCOMES }), [], type);
  }
});

test("ids count up past those in use", () => {
  assert.equal(nextId([]), "q-01");
  assert.equal(nextId([{ id: "q-01" }, { id: "q-03" }]), "q-02");
  assert.equal(blankQuestion("mcq", [{ id: "q-01" }]).id, "q-02");
});

test("retyping keeps the words, outcomes and feedback, and one right answer", () => {
  const q = {
    id: "q-07", type: "multi", assesses: ["O2"], stem: "Which?", feedback: "Because.", points: 2,
    options: [{ text: "a", correct: true }, { text: "b", correct: true }, { text: "c" }],
  };
  const mcq = changeType(q, "mcq");
  assert.equal(mcq.id, "q-07");
  assert.equal(mcq.stem, "Which?");
  assert.deepEqual(mcq.assesses, ["O2"]);
  assert.equal(mcq.feedback, "Because.");
  assert.equal(mcq.points, 2);
  assert.deepEqual(mcq.options, [{ text: "a", correct: true }, { text: "b" }, { text: "c" }]);
  const cloze = changeType(q, "cloze");
  assert.equal(cloze.text, "Which?");
  assert.equal(cloze.stem, undefined);
  assert.equal(changeType(cloze, "short").stem, "Which?");
});

test("problems, in words an educator uses", () => {
  const says = (q, want, extra = {}) =>
    assert.ok(questionProblems(q, { outcomes: OUTCOMES, ...extra }).some((p) => want.test(p)), `${want}`);
  const base = { id: "q-01", assesses: ["O1"], stem: "Q" };
  says({ ...base, type: "mcq", options: [{ text: "a", correct: true }, { text: "b", correct: true }] }, /exactly one answer/);
  says({ ...base, type: "multi", options: [{ text: "a", correct: true }, { text: "b", correct: true }] }, /nothing is being asked/);
  says({ ...base, type: "mcq", options: [{ text: "a", correct: true }, { text: "" }] }, /at least two answers/);
  says({ ...base, type: "truefalse" }, /true or false/);
  says({ ...base, type: "short", answers: ["x", ""] }, /accepted answers is empty/);
  says({ ...base, type: "numeric", answer: 3, tolerance: -1 }, /tolerance/);
  says({ ...base, type: "numeric", answer: 3, points: 0 }, /points/);
  says({ ...base, type: "match", pairs: [{ prompt: "a", answer: "1" }, { prompt: "b", answer: "2" }, { prompt: "c" }] }, /missing its prompt or its answer/);
  says({ ...base, type: "cloze", text: "no gaps" }, /\[\[answer\]\]/);
  says({ ...base, type: "truefalse", answer: true, assesses: [] }, /Choose which learning outcome/);
  says({ ...base, type: "truefalse", answer: true, assesses: ["O9"] }, /O9, which isn't one of the course's outcomes/);
  says({ ...base, type: "essay" }, /type should be one of/);
  const twins = bankProblems([{ ...base, type: "truefalse", answer: true }, { ...base, type: "truefalse", answer: false }]);
  assert.ok(twins.every((list) => list.some((p) => /used by another question/.test(p))));
});

test("a cloze, as a learner sees it", () => {
  assert.equal(clozePreview("Use as [[little]] as possible, as [[much]] as needed."), "Use as _____ as possible, as _____ as needed.");
});
