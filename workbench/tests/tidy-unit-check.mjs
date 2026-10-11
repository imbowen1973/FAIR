// Groupings that only repeat their one session's name: found, removed
// without losing or moving a session, and genuine groupings left alone.

import { test } from "node:test";
import assert from "node:assert/strict";

import { blockIds, redundantGroupings, unwrapRedundant } from "../structure.js";

const TITLES = {
  "01": "Foundations of clinical teaching",
  "05": "Feedback that changes practice",
  "07": "Rounds",
};
const titleOf = (id) => TITLES[id];
const COURSE = () => [
  { title: "Week 1", children: [{ kind: "module", title: "Foundations of  Clinical teaching", children: [{ block: "01" }] }] },
  { title: "WEEK 2", children: [{ kind: "module", title: "Assessment and feedback", children: [{ block: "05" }] }] },
  { title: "Rounds", children: [{ block: "07" }, { block: "08" }] },
  { title: "Week2", children: [] },
];

test("only a grouping whose one session has its name is a wrapper", () => {
  // Case and spacing do not make a difference of name; a second session,
  // or a different title, does.
  assert.deepEqual(redundantGroupings(COURSE(), titleOf), [[0, 0]]);
});

test("removing wrappers keeps every session, in order", () => {
  const after = unwrapRedundant(COURSE(), titleOf);
  assert.deepEqual(blockIds(after), blockIds(COURSE()));
  assert.deepEqual(after[0], { title: "Week 1", children: [{ block: "01" }] });
  assert.deepEqual(after[1], COURSE()[1]);
});

test("nested wrappers, removed deepest first", () => {
  const tree = [{ title: "Rounds", children: [{ title: "Rounds", children: [{ block: "07" }] }] }];
  const after = unwrapRedundant(tree, titleOf);
  assert.deepEqual(after, [{ block: "07" }]);
});
