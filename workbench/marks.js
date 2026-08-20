// The inline grammar, in JavaScript — a mirror of renderer/runs.py.
//
// The editor is WYSIWYG, so it holds text as spans with marks and has to
// turn that back into the same syntax the renderer parses. Two rules make
// the round trip safe: tokenize (marks nest, so a split regex cannot do
// it), and serialize in a fixed mark order so identical content always
// produces identical markdown. Without that second rule, editing a slide
// and saving it would churn the diff even when nothing changed.
//
// tests/marks.test.mjs checks this agrees with the Python, case for case.

/** Delimiters, longest first: ** before *, and ~~ before ~. */
const DELIMITERS = [
  ["***", ["bold", "italic"]],
  ["**", ["bold"]],
  ["~~", ["strike"]],
  ["__", ["underline"]],
  ["*", ["italic"]],
  ["~", ["subscript"]],
  ["^", ["superscript"]],
  ["`", ["code"]],
];

export const MARKS = [
  "bold",
  "italic",
  "superscript",
  "subscript",
  "strike",
  "underline",
  "code",
];

// Serialisation order — the inverse of how a reader nests them. Fixed so
// {bold, subscript} always emits **x~2~** and never ~**x**~.
const WRAP_ORDER = ["code", "underline", "strike", "subscript", "superscript", "italic", "bold"];

const WRAPPER = {
  bold: "**",
  italic: "*",
  strike: "~~",
  underline: "__",
  subscript: "~",
  superscript: "^",
  code: "`",
};

function emptyMarks() {
  return Object.fromEntries(MARKS.map((m) => [m, false]));
}

function parseInto(text, marks, out) {
  let literal = "";
  let i = 0;

  const flush = () => {
    if (literal) {
      out.push({ text: literal, ...marks });
      literal = "";
    }
  };

  outer: while (i < text.length) {
    for (const [delimiter, names] of DELIMITERS) {
      if (!text.startsWith(delimiter, i)) continue;
      const close = text.indexOf(delimiter, i + delimiter.length);
      if (close === -1) continue; // unclosed: ordinary text
      const inner = text.slice(i + delimiter.length, close);
      if (!inner) continue; // empty span
      flush();
      const applied = { ...marks };
      for (const name of names) applied[name] = true;
      if (names.includes("code")) {
        // A code span is literal: markers inside it are content.
        out.push({ text: inner, ...applied });
      } else {
        parseInto(inner, applied, out);
      }
      i = close + delimiter.length;
      continue outer;
    }
    literal += text[i];
    i += 1;
  }

  flush();
}

/** Markdown -> [{text, bold, italic, ...}]. */
export function parseMarks(text) {
  const out = [];
  parseInto(text ?? "", emptyMarks(), out);
  return out.length ? out : [{ text: "", ...emptyMarks() }];
}

/**
 * Wrap a run of spans that all carry `marks`, innermost first.
 * bold+italic collapses to the three-star form rather than ** then *.
 */
function wrap(inner, marks) {
  let out = inner;
  let rest = marks;
  if (marks.includes("bold") && marks.includes("italic")) {
    rest = marks.filter((m) => m !== "bold" && m !== "italic");
    for (const mark of rest) out = WRAPPER[mark] + out + WRAPPER[mark];
    return `***${out}***`;
  }
  for (const mark of rest) out = WRAPPER[mark] + out + WRAPPER[mark];
  return out;
}

/**
 * Emit spans as markdown, factoring marks shared by a whole run into one
 * pair of delimiters. Emitting each span independently would turn
 * "**CO~2~ uptake**" into "**CO****~2~**** uptake**" — same meaning to the
 * parser, unreadable in a diff.
 */
function emit(spans, applied) {
  if (spans.length === 0) return "";

  const common = WRAP_ORDER.filter(
    (m) => !applied.has(m) && spans.every((s) => s[m])
  );
  if (common.length) {
    const next = new Set([...applied, ...common]);
    return wrap(emit(spans, next), common);
  }

  const [first, ...others] = spans;
  const outstanding = WRAP_ORDER.filter((m) => !applied.has(m) && first[m]);
  if (outstanding.length === 0) {
    return first.text + emit(others, applied);
  }

  // Longest prefix still carrying this mark, so the run wraps once.
  const mark = outstanding[0];
  let n = 1;
  while (n < spans.length && spans[n][mark]) n += 1;
  return emit(spans.slice(0, n), applied) + emit(spans.slice(n), applied);
}

/** [{text, marks...}] -> markdown, merging neighbours that match. */
export function serializeMarks(spans) {
  const merged = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = merged[merged.length - 1];
    if (last && MARKS.every((m) => !!last[m] === !!span[m])) {
      last.text += span.text;
    } else {
      merged.push({ ...span });
    }
  }
  return emit(merged, new Set());
}

/** Every marker stripped — what the index and search see. */
export function plainText(text) {
  return parseMarks(text)
    .map((s) => s.text)
    .join("");
}

/**
 * True when re-serialising the parse gives the input back. The editor
 * refuses to open a WYSIWYG field on text that does not round-trip,
 * falling back to source editing, so it can never silently rewrite an
 * author's markdown into something subtly different.
 */
export function roundTrips(text) {
  return serializeMarks(parseMarks(text)) === (text ?? "");
}
