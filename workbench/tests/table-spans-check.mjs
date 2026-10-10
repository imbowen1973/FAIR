// The preview's merge resolution must agree with the renderer's parser:
// "<" joins the cell on the left, "^" the cell above, "\<" and "\^" are
// literal, and anything malformed is drawn unmerged rather than thrown.

import { test } from "node:test";
import assert from "node:assert/strict";

import { tableSpans } from "../library.js";

const shape = (grid) =>
  tableSpans(grid).map((row) =>
    row.map((c) => (c ? `${c.text}${c.rowspan > 1 || c.colspan > 1 ? `[${c.rowspan}x${c.colspan}]` : ""}` : "·"))
  );

test("horizontal and vertical merges", () => {
  assert.deepEqual(
    shape([["Stage", "Timing", "<"], ["Receive", "Day 1", "x"], ["^", "Day 2", "y"]]),
    [["Stage", "Timing[1x2]", "·"], ["Receive[2x1]", "Day 1", "x"], ["·", "Day 2", "y"]]
  );
});

test("a 2x2 block accepts either marker inside", () => {
  assert.deepEqual(shape([["Both", "<"], ["^", "^"]]), [["Both[2x2]", "·"], ["·", "·"]]);
  assert.deepEqual(shape([["Both", "<"], ["^", "<"]]), [["Both[2x2]", "·"], ["·", "·"]]);
});

test("escaped markers are literal text", () => {
  assert.deepEqual(shape([["\\<", "\\^"]]), [["<", "^"]]);
});

test("malformed merges draw unmerged instead of throwing", () => {
  // An L-shape is not a rectangle; the renderer refuses it, the preview
  // just shows the cells as they are.
  const out = tableSpans([["a", "<"], ["^", "b"]]);
  assert.equal(out[0][0].colspan, 1);
  assert.equal(out[0][0].rowspan, 1);
});
