// A question bank (questions.yaml), as data a form can edit.
//
// Pure: reading the bank, writing it back, the question types and what
// each needs, and what is wrong with a question in words an educator
// uses -- "mark exactly one answer as correct", never "'options' must
// have exactly one correct". The form (questionsui.js) and the Text
// view's checker (companion.js) both say it this way, from here.
//
// The grammar is docs/questions-format.md; the Python in questions.py
// is the authority that Check and the Moodle export run.

import { parse, stringify } from "./yaml.js";

/** The types, in the order the "add" menu offers them. */
export const TYPES = [
  { type: "mcq", label: "Multiple choice", note: "One right answer among several." },
  { type: "multi", label: "Multiple answers", note: "Tick every right answer." },
  { type: "truefalse", label: "True or false", note: "A statement to judge." },
  { type: "short", label: "Short answer", note: "A word or phrase, typed." },
  { type: "numeric", label: "Number", note: "A value, with a tolerance." },
  { type: "match", label: "Matching", note: "Pair each prompt with its answer." },
  { type: "cloze", label: "Fill the gaps", note: "Text with blanks to complete." },
];
export const TYPE_NAMES = Object.fromEntries(TYPES.map((t) => [t.type, t.label]));

/** The bank as data, or {problem} when the text will not read. */
export function readBank(text) {
  let data;
  try {
    data = parse(String(text ?? "")) ?? {};
  } catch (err) {
    return { problem: `The text doesn't read as a question bank: ${String(err.message).split("\n")[0]}` };
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return { problem: "The text should start with `questions:` and list the questions under it." };
  }
  const { questions, ...rest } = data;
  if (questions != null && !Array.isArray(questions)) {
    return { problem: "`questions:` should be a list." };
  }
  return { questions: (questions ?? []).map((q) => (q && typeof q === "object" ? q : {})), rest };
}

/** Back to text: anything else the file held is kept, questions last. */
export function writeBank({ questions, rest = {} }) {
  return stringify({ ...rest, questions });
}

/** The next free id: q-01, q-02, … */
export function nextId(questions) {
  const used = new Set(questions.map((q) => String(q.id ?? "")));
  for (let n = 1; ; n++) {
    const id = `q-${String(n).padStart(2, "0")}`;
    if (!used.has(id)) return id;
  }
}

/** A new question of `type`, ready to fill in. */
export function blankQuestion(type, questions, assesses = []) {
  const base = { id: nextId(questions), type, assesses: [...assesses] };
  switch (type) {
    case "mcq":
    case "multi":
      return { ...base, stem: "", options: [{ text: "", correct: true }, { text: "" }, { text: "" }] };
    case "truefalse":
      return { ...base, stem: "", answer: true };
    case "short":
      return { ...base, stem: "", answers: [""] };
    case "numeric":
      return { ...base, stem: "", answer: 0, tolerance: 0 };
    case "match":
      return { ...base, stem: "", pairs: [{ prompt: "", answer: "" }, { prompt: "", answer: "" }] };
    case "cloze":
      return { ...base, text: "" };
    default:
      return { ...base, stem: "" };
  }
}

/**
 * The same question as another type, keeping what carries over: its
 * id, outcomes, feedback, points, and the question's words.
 */
export function changeType(question, type) {
  const words = question.type === "cloze" ? question.text : question.stem;
  const fresh = blankQuestion(type, [], question.assesses ?? []);
  const keep = {};
  for (const key of ["feedback", "points"]) if (question[key] != null) keep[key] = question[key];
  const next = { ...fresh, id: question.id, ...keep };
  if (type === "cloze") next.text = words ?? "";
  else next.stem = words ?? "";
  // Options survive between the two kinds of choice question.
  if (["mcq", "multi"].includes(type) && Array.isArray(question.options)) {
    next.options = question.options.map((o) => ({ ...o }));
    if (type === "mcq") {
      let seen = false;
      next.options = next.options.map((o) => {
        const correct = o.correct === true && !seen;
        if (correct) seen = true;
        const { correct: _c, ...restOption } = o;
        return correct ? { ...restOption, correct: true } : restOption;
      });
    }
  }
  return next;
}

const filled = (v) => typeof v === "string" && v.trim() !== "";

/**
 * What is wrong with one question, in plain words; [] when nothing.
 * `outcomes` (a Set of ids, or null) and `duplicate` (its id is used
 * by another question) come from the bank around it.
 */
export function questionProblems(q, { outcomes = null, duplicate = false } = {}) {
  const out = [];
  if (!q || typeof q !== "object") return ["This entry isn't a question."];
  if (!filled(String(q.id ?? ""))) out.push("It has no id.");
  else if (duplicate) out.push(`Its id ${q.id} is used by another question too.`);
  if (!TYPE_NAMES[q.type]) {
    out.push(`Its type should be one of: ${TYPES.map((t) => t.label.toLowerCase()).join(", ")}.`);
    return out;
  }
  const assesses = Array.isArray(q.assesses) ? q.assesses.map(String) : [];
  if (!assesses.length) out.push("Choose which learning outcome it tests.");
  else if (outcomes) {
    for (const oid of assesses) {
      if (!outcomes.has(oid)) out.push(`It tests ${oid}, which isn't one of the course's outcomes.`);
    }
  }
  if (q.type !== "cloze" && !filled(q.stem)) out.push("Write the question.");
  const options = Array.isArray(q.options) ? q.options : [];
  const correct = options.filter((o) => o && o.correct === true).length;
  if (["mcq", "multi"].includes(q.type)) {
    if (options.filter((o) => filled(o?.text)).length < 2) out.push("Give at least two answers to choose from.");
    if (options.some((o) => !filled(o?.text))) out.push("One of the answers is empty.");
    if (q.type === "mcq" && correct !== 1) out.push("Mark exactly one answer as correct.");
    if (q.type === "multi" && correct < 1) out.push("Mark at least one answer as correct.");
    if (q.type === "multi" && options.length && correct === options.length) {
      out.push("Every answer is marked correct, so nothing is being asked.");
    }
  }
  if (q.points != null && !(typeof q.points === "number" && q.points > 0)) {
    out.push("Its points should be a number above zero.");
  }
  if (q.type === "truefalse" && typeof q.answer !== "boolean") {
    out.push("Choose whether the statement is true or false.");
  }
  if (q.type === "short" && !(Array.isArray(q.answers) && q.answers.some(filled))) {
    out.push("Add at least one accepted answer.");
  } else if (q.type === "short" && q.answers.some((a) => !filled(a))) {
    out.push("One of the accepted answers is empty.");
  }
  if (q.type === "numeric" && (typeof q.answer !== "number" || Number.isNaN(q.answer))) {
    out.push("Give the right answer as a number.");
  }
  if (q.type === "numeric" && q.tolerance != null && !(typeof q.tolerance === "number" && q.tolerance >= 0)) {
    out.push("The tolerance should be zero or more.");
  }
  if (q.type === "match") {
    const pairs = Array.isArray(q.pairs) ? q.pairs : [];
    if (pairs.filter((p) => filled(p?.prompt) && filled(p?.answer)).length < 2) {
      out.push("Give at least two complete pairs to match.");
    } else if (pairs.some((p) => !filled(p?.prompt) || !filled(p?.answer))) {
      out.push("One of the pairs is missing its prompt or its answer.");
    }
  }
  if (q.type === "cloze" && !/\[\[[^\[\]]+\]\]/.test(String(q.text ?? ""))) {
    out.push("Mark at least one gap in the text, written [[answer]].");
  }
  return out;
}

/** Problems for every question, by index: [[...], [...], …]. */
export function bankProblems(questions, { outcomes = null } = {}) {
  const counts = new Map();
  for (const q of questions) counts.set(String(q?.id ?? ""), (counts.get(String(q?.id ?? "")) ?? 0) + 1);
  return questions.map((q) =>
    questionProblems(q, { outcomes, duplicate: (counts.get(String(q?.id ?? "")) ?? 0) > 1 })
  );
}

/** The text a cloze shows a learner: each gap as a blank. */
export function clozePreview(text) {
  return String(text ?? "").replace(/\[\[[^\[\]]+\]\]/g, "_____");
}
