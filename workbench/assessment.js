// Moodle XML, edited as a form.
//
// The file is the artifact: Moodle imports this XML directly, so there
// is no build step between what an author edits and what a learner sits.
// That makes one rule non-negotiable.
//
//   **A question the author did not touch must come back byte-identical.**
//
// Re-serialising a parsed XML document reformats every question and
// turns a one-word edit into a whole-file diff, which makes review
// impossible. So this keeps each <question> element's original source
// text and re-serialises only what changed -- exactly what
// renderSlidesFile does for slides.md, and for the same reason.
//
// It also means a question type this editor does not understand is
// carried through untouched rather than lost. Silently dropping an
// author's matching question would be far worse than declining to edit
// it.
//
// Splitting and writing are string operations, so they run under
// `node --test`. Reading a question's fields needs an XML parser and so
// runs in the browser, where the tab strip drives it.

/** Types the form can edit. Everything else is preserved, not edited. */
export const EDITABLE = ["multichoice", "truefalse", "shortanswer", "essay"];

export const TYPE_LABEL = {
  multichoice: "Multiple choice",
  truefalse: "True or false",
  shortanswer: "Short answer",
  essay: "Essay",
  matching: "Matching",
  numerical: "Numerical",
  cloze: "Embedded answers (cloze)",
  description: "Description",
  category: "Category",
};

const QUESTION_OPEN = /<question\b[^>]*>/gi;

/** The line ending this file already uses. */
function newlineOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Split a Moodle XML file into its questions, keeping each one's exact
 * source span so an untouched question can be copied back verbatim.
 *
 * Returns `{text, questions: [{start, end, type, source}]}`.
 * Moodle XML never nests <question>, so a straight scan is enough.
 */
export function splitQuestions(text) {
  const source = String(text ?? "");
  const questions = [];
  QUESTION_OPEN.lastIndex = 0;
  let open;
  let previousEnd = 0;
  while ((open = QUESTION_OPEN.exec(source)) !== null) {
    const close = source.indexOf("</question>", QUESTION_OPEN.lastIndex);
    if (close === -1) break; // truncated file: keep what we have
    const end = close + "</question>".length;

    // Take the span from the start of its line, so the question's own
    // indentation belongs to the question. Otherwise re-joining loses it
    // and every question after the first shows as changed.
    const lineStart = source.lastIndexOf("\n", open.index) + 1;
    const start = /^[ \t]*$/.test(source.slice(lineStart, open.index))
      ? lineStart
      : open.index;

    const type = (open[0].match(/type\s*=\s*"([^"]*)"/i) || [])[1] ?? "";
    questions.push({
      start,
      end,
      type,
      // Whatever separated it from the one before, kept exactly: a file
      // written with no blank line between questions must come back
      // without one.
      gapBefore: source.slice(previousEnd, start),
      source: source.slice(start, end),
    });
    previousEnd = end;
    QUESTION_OPEN.lastIndex = end;
  }
  return { text: source, questions };
}

/**
 * Rebuild the file from a working list.
 *
 * Each entry is `{sourceIndex, data, dirty}`, the same shape the slide
 * editor uses. Untouched entries are copied from the original bytes;
 * only dirty or new ones are written out.
 */
export function renderQuizFile(parsed, working) {
  const nl = newlineOf(parsed.text || "");
  const has = parsed.questions.length > 0;
  const header = has
    ? parsed.text.slice(0, parsed.questions[0].start)
    : quizHeader(parsed.text, nl);
  const tail = has
    ? parsed.text.slice(parsed.questions[parsed.questions.length - 1].end)
    : `${nl}</quiz>${nl}`;

  // The default gap for a question that was not in the file before: a
  // blank line, matching how Moodle's own export lays them out.
  const defaultGap = nl + nl;
  let out = header;
  working.forEach((entry, position) => {
    const original = entry.sourceIndex === null ? null : parsed.questions[entry.sourceIndex];
    if (position > 0) out += original?.gapBefore || defaultGap;
    out += !entry.dirty && original ? original.source : writeQuestion(entry.data, nl);
  });
  return out + tail;
}

/** The opening of a file that has no questions yet. */
function quizHeader(text, nl) {
  const at = String(text ?? "").indexOf("</quiz>");
  if (at !== -1) return text.slice(0, at).replace(/\s*$/, nl);
  return `<?xml version="1.0" encoding="UTF-8"?>${nl}<quiz>${nl}`;
}

function cdata(text) {
  // "]]>" inside the payload would close the section early; splitting it
  // across two sections is the standard way out and changes no bytes of
  // the author's text.
  return `<![CDATA[${String(text ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function attr(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/**
 * A `<text>` element.
 *
 * CDATA only when the content needs it. Moodle's own export writes a
 * plain question name and CDATA-wraps the HTML fields, and matching that
 * keeps an edited question a few lines different from its neighbours
 * rather than wholly reformatted.
 */
function textEl(name, value, indent, { raw = false } = {}) {
  const text = String(value ?? "");
  const body = raw || /[<>&]/.test(text) ? cdata(text) : text;
  return `${indent}<${name}>${body}</${name}>`;
}

/**
 * One question, as Moodle XML.
 *
 * Written only for questions the author actually changed, so the shape
 * here never touches a question this editor does not understand.
 */
export function writeQuestion(data, nl = "\n") {
  const i = "    ";
  const out = [`  <question type="${attr(data.type)}">`];
  out.push(`${i}<name>`);
  out.push(textEl("text", data.name || "", i + "  "));
  out.push(`${i}</name>`);
  out.push(`${i}<questiontext format="html">`);
  out.push(textEl("text", data.questiontext || "", i + "  ", { raw: true }));
  out.push(`${i}</questiontext>`);
  out.push(`${i}<generalfeedback format="html">`);
  out.push(textEl("text", data.generalfeedback || "", i + "  ", { raw: true }));
  out.push(`${i}</generalfeedback>`);
  out.push(`${i}<defaultgrade>${Number(data.defaultgrade ?? 1).toFixed(7)}</defaultgrade>`);
  out.push(`${i}<penalty>${Number(data.penalty ?? 0.3333333).toFixed(7)}</penalty>`);
  out.push(`${i}<hidden>0</hidden>`);

  if (data.type === "multichoice") {
    out.push(`${i}<single>${data.single === false ? "false" : "true"}</single>`);
    out.push(`${i}<shuffleanswers>${data.shuffleanswers === false ? "false" : "true"}</shuffleanswers>`);
    out.push(`${i}<answernumbering>abc</answernumbering>`);
  }
  if (data.type === "essay") {
    out.push(`${i}<responseformat>editor</responseformat>`);
    out.push(`${i}<responserequired>1</responserequired>`);
    out.push(`${i}<attachments>0</attachments>`);
  }

  for (const answer of data.answers ?? []) {
    out.push(`${i}<answer fraction="${attr(answer.fraction ?? 0)}" format="html">`);
    out.push(textEl("text", answer.text || "", i + "  ", { raw: true }));
    out.push(`${i + "  "}<feedback format="html">`);
    out.push(textEl("text", answer.feedback || "", i + "    ", { raw: true }));
    out.push(`${i + "  "}</feedback>`);
    out.push(`${i}</answer>`);
  }

  // Competency and depth of knowledge ride in tags, which Moodle imports
  // natively -- no sidecar file, and nothing lost on the way in.
  const tags = (data.tags ?? []).filter(Boolean);
  if (tags.length) {
    out.push(`${i}<tags>`);
    for (const tag of tags) {
      out.push(`${i + "  "}<tag>${textEl("text", tag, "")}</tag>`);
    }
    out.push(`${i}</tags>`);
  }

  out.push("  </question>");
  return out.join(nl);
}

/** A blank question of `type`, ready to fill in. */
export function blankQuestion(type, name) {
  const base = {
    type,
    name,
    questiontext: "",
    generalfeedback: "",
    defaultgrade: 1,
    penalty: 0.3333333,
    tags: [],
    answers: [],
  };
  if (type === "multichoice") {
    base.single = true;
    base.shuffleanswers = true;
    base.answers = [
      { text: "", fraction: "100", feedback: "" },
      { text: "", fraction: "0", feedback: "" },
    ];
  }
  if (type === "truefalse") {
    base.answers = [
      { text: "true", fraction: "100", feedback: "" },
      { text: "false", fraction: "0", feedback: "" },
    ];
  }
  if (type === "shortanswer") {
    base.answers = [{ text: "", fraction: "100", feedback: "" }];
  }
  return base;
}

/** Competency ids and DOK, read back out of a question's tags. */
export function competencyTags(tags) {
  const out = { develops: [], dok: null };
  for (const tag of tags ?? []) {
    const dok = String(tag).match(/^dok:(\d)$/i);
    if (dok) out.dok = Number(dok[1]);
    else out.develops.push(String(tag));
  }
  return out;
}

/** The tag list for a set of competencies and a DOK. */
export function toTags(develops, dok) {
  const out = [...(develops ?? [])];
  if (dok) out.push(`dok:${dok}`);
  return out;
}

// ---- reading, which needs an XML parser --------------------------------

function inner(element, selector) {
  const node = element.querySelector(selector);
  return node ? node.textContent : "";
}

/**
 * A question element's fields, as the form needs them.
 * Browser only: DOMParser has no counterpart in node.
 */
export function readQuestion(source) {
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.querySelector("parsererror")) return null;
  const element = doc.documentElement;
  const type = element.getAttribute("type") || "";

  const answers = [...element.querySelectorAll(":scope > answer")].map((a) => ({
    text: inner(a, ":scope > text"),
    fraction: a.getAttribute("fraction") ?? "0",
    feedback: inner(a, ":scope > feedback > text"),
  }));

  return {
    type,
    name: inner(element, ":scope > name > text"),
    questiontext: inner(element, ":scope > questiontext > text"),
    generalfeedback: inner(element, ":scope > generalfeedback > text"),
    defaultgrade: Number(inner(element, ":scope > defaultgrade") || 1),
    penalty: Number(inner(element, ":scope > penalty") || 0.3333333),
    single: inner(element, ":scope > single") !== "false",
    shuffleanswers: inner(element, ":scope > shuffleanswers") !== "false",
    answers,
    tags: [...element.querySelectorAll(":scope > tags > tag > text")].map(
      (t) => t.textContent
    ),
  };
}

/** The working list for a file, the same shape the slide editor uses. */
export function workingQuestions(parsed) {
  return parsed.questions.map((q, index) => ({
    sourceIndex: index,
    data: null, // read lazily: an unopened question is never parsed
    type: q.type,
    dirty: false,
  }));
}
