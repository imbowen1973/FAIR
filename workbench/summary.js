// The session summary, in the shape a course already uses.
//
// A summary is the front page of a session: what it covers, what a
// learner will be able to do afterwards, and what is in the folder. The
// established template names those sections in a fixed order, and this
// writes that same document from what the repo already knows.
//
// Two things are generated rather than typed:
//
//   **Learning outcomes** come from the catalogue, between markers, so
//   the summary and the alignment map cannot drift. Edit the outcomes in
//   the course editor and refresh the section; edit the prose freely
//   around it.
//
//   **What is in this session** comes from the block's own documents.
//   The template a course inherits from a shared drive points at
//   `V130_lesson_content_01.docx (in 02_lectures_and_videos_online)` --
//   a file in a folder somewhere. Here the deck, the workbook and the
//   assessment are in the block, so the summary links them instead of
//   describing where to go and look.
//
// A section with nothing in it says so, rather than being left out: "no
// assignment" is information, and a missing heading is ambiguous.

export const MARK_START = "<!-- outcomes: from outcomes.yaml -->";
export const MARK_END = "<!-- /outcomes -->";

/**
 * The outcomes section body, from the outcomes a session owns.
 * `outcomes` is [{id, statement}] in catalogue order.
 */
export function outcomesSection(outcomes) {
  const lines = ["By the end of the session, participants will be able to:", ""];
  if (!outcomes.length) {
    lines.push(
      "*No outcomes are assigned to this session yet — add them in the " +
        "course editor, above the blocks.*"
    );
  } else {
    for (const outcome of outcomes) {
      const statement = String(outcome.statement || "").trim() || `(${outcome.id})`;
      lines.push(`- ${statement}`);
    }
  }
  return lines.join("\n");
}

/**
 * Replace the generated outcomes section, leaving every other word alone.
 *
 * Returns the text unchanged when the markers are not there, so a
 * summary somebody rewrote by hand is never clobbered.
 */
export function refreshOutcomes(markdown, outcomes) {
  const text = String(markdown ?? "");
  const from = text.indexOf(MARK_START);
  const to = text.indexOf(MARK_END);
  if (from === -1 || to === -1 || to < from) return text;
  const body = outcomesSection(outcomes);
  return (
    text.slice(0, from) +
    `${MARK_START}\n\n${body}\n\n${MARK_END}` +
    text.slice(to + MARK_END.length)
  );
}

/** Whether a summary still carries the generated section. */
export function hasOutcomesSection(markdown) {
  const text = String(markdown ?? "");
  return text.includes(MARK_START) && text.includes(MARK_END);
}

/** A document link, or the sentence that says there is none. */
function listOrNone(documents, none) {
  if (!documents.length) return `*${none}*`;
  return documents
    .map((doc) => `- [${doc.title}](${doc.file ?? doc.id})`)
    .join("\n");
}

/**
 * A session summary for `block`.
 *
 * block      {id, title, code, duration}
 * outcomes   the outcomes this session owns
 * documents  from blockDocuments(), minus the summary itself
 */
export function summaryTemplate({ block, outcomes = [], documents = [] }) {
  const code = block.code || block.id;
  const title = block.title || block.id;
  const kind = (types) => documents.filter((d) => types.includes(d.type));

  const teaching = kind(["slides", "workbook", "instructorguide", "handout"]);
  const assignments = kind(["assignment"]);
  const assessments = kind(["assessment"]);
  const extras = documents.filter(
    (d) => !["slides", "workbook", "instructorguide", "handout", "assignment",
             "assessment", "lessonplan"].includes(d.type)
  );

  return [
    `# ${title} — Summary`,
    "",
    `**Session:** ${code}`,
    // A blank line between them: two lines of markdown with none would
    // render as one paragraph run together.
    block.duration ? "" : null,
    block.duration ? `**Duration:** ${block.duration} minutes` : null,
    "",
    "*Two or three sentences on what this session covers, and why it*",
    "*matters to the people sitting in it.*",
    "",
    "## Learning outcomes",
    "",
    MARK_START,
    "",
    outcomesSection(outcomes),
    "",
    MARK_END,
    "",
    "## Activities",
    "",
    teaching.length
      ? "The lecturer presents the topic using:"
      : "*Describe what happens in the session.*",
    teaching.length ? "" : null,
    teaching.length ? listOrNone(teaching, "") : null,
    "",
    "## Extra material and sources",
    "",
    listOrNone(extras, "There are no extra materials or sources."),
    "",
    "## Assignment",
    "",
    listOrNone(assignments, "There is no assignment."),
    "",
    "## Assessment",
    "",
    assessments.length
      ? "Answer the questions in:\n\n" + listOrNone(assessments, "")
      : "*There is no assessment for this session.*",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// ---- the other documents ------------------------------------------------
//
// A workbook, an assignment and a teacher's resources are the same kind
// of thing as the lesson plan: a markdown document with named sections
// in a fixed order. They differ only in which sections, and in who is
// meant to read them.
//
// Each starts from a shape rather than an empty page, because an empty
// page is where a document that never gets written begins. The headings
// are a checklist an author can delete from.

/** An assignment: what a learner does, hands in, and is judged on. */
function assignmentTemplate({ block, outcomes }) {
  return [
    `# Assignment — ${block.title || block.id}`,
    "",
    "## The task",
    "",
    "*What the learner has to do, in a sentence or two.*",
    "",
    "## What this assesses",
    "",
    MARK_START,
    "",
    outcomesSection(outcomes),
    "",
    MARK_END,
    "",
    "## What to hand in",
    "",
    "*The form, the length, and where it goes.*",
    "",
    "## How it is marked",
    "",
    "| Criterion | What good looks like |",
    "|---|---|",
    "|  |  |",
    "",
  ].join("\n");
}

/** A workbook: the learner's own pages. */
function workbookTemplate({ block, outcomes }) {
  return [
    `# Workbook — ${block.title || block.id}`,
    "",
    "*For the learner to work through, during or after the session.*",
    "",
    "## What you will be able to do",
    "",
    MARK_START,
    "",
    outcomesSection(outcomes),
    "",
    MARK_END,
    "",
    "## Activity 1",
    "",
    "*What to do, and space to record the answer.*",
    "",
    "## Notes",
    "",
  ].join("\n");
}

/** Teacher resources: what the person running it needs to hand. */
function teacherTemplate({ block }) {
  return [
    `# Teacher resources — ${block.title || block.id}`,
    "",
    "## Before the session",
    "",
    "*What to prepare, print, book or test.*",
    "",
    "## Materials",
    "",
    "*Equipment, handouts, anything that has to be in the room.*",
    "",
    "## Running it",
    "",
    "*Timings, groupings, and the bits that usually go wrong.*",
    "",
    "## Further reading",
    "",
  ].join("\n");
}

/** A plain document, for a kind with no template of its own. */
function plainTemplate({ kind, title, block }) {
  return [`# ${title || kind} — ${block.title || block.id}`, "", ""].join("\n");
}

/**
 * The starting text for a document of `kind`.
 *
 * The lesson plan is the session summary; the rest are the shapes above.
 * Everything markdown goes through here, so a new kind gets a template
 * by being added in one place rather than by being special-cased at the
 * call site.
 */
export function documentTemplate({ kind, title, block, outcomes = [], documents = [] }) {
  if (kind === "lessonplan") return summaryTemplate({ block, outcomes, documents });
  if (kind === "assignment") return assignmentTemplate({ block, outcomes });
  if (kind === "workbook") return workbookTemplate({ block, outcomes });
  if (kind === "teacherresources" || kind === "instructorguide") {
    return teacherTemplate({ block });
  }
  return plainTemplate({ kind, title, block });
}
