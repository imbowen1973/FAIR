// The private twin: question banks and instructor guides, in a repo of
// their own (docs/companion-repo.md).
//
// The public library holds what a learner may see; the companion holds
// what only an educator may -- the half whose value depends on students
// not finding it. GitHub's own access model makes it shareable: grant a
// partner's team read access and they have it.
//
// The two are joined by block ids. The companion mirrors the library's
// block folders and names the library in companion.yaml; the library
// never names the companion, because publishing the public half must not
// advertise the private one. So the pairing lives here, in this browser
// (prefs.js), and in the companion's own companion.yaml -- never in the
// library.
//
// Pure helpers: which files to read, which tabs a block gains, starters,
// and a quick check of a bank as it is typed. The authoritative check is
// the Python one (questions.py), which Check runs.

import { parse } from "./yaml.js";

export const COMPANION_FILE = "companion.yaml";

/** The educator documents a block can have, in tab order. */
export const COMPANION_DOCS = [
  { kind: "questions", file: "questions.yaml", title: "Questions", editor: "questions" },
  { kind: "instructorguide", file: "instructorguide.md", title: "Instructor guide", editor: "markdown" },
];

export const ITEM_TYPES = ["mcq", "multi", "truefalse", "short", "numeric", "match", "cloze"];

/** The text files a companion holds that the workbench reads. */
export function companionPaths(paths) {
  return paths.filter(
    (p) => p === COMPANION_FILE || /^blocks\/[^/]+\/[^/]+\.(md|ya?ml)$/i.test(p)
  );
}

/**
 * A block's educator tabs. Ids are prefixed so they can never collide
 * with a library document, and every one is marked as the companion's,
 * which is what routes its text and its saves to the other repo.
 */
export function companionDocuments(blockId, files) {
  return COMPANION_DOCS.map((d) => {
    const path = `blocks/${blockId}/${d.file}`;
    return {
      id: `companion:${d.file}`,
      title: d.title,
      type: d.kind,
      editor: d.editor,
      path,
      file: d.file,
      repo: "companion",
      private: true,
      uncreated: files ? !files.has(path) : false,
      missing: false,
    };
  });
}

/**
 * Does this companion belong to this library? companion.yaml names its
 * public twin; a missing file is a companion not set up yet, which is
 * fine -- the workbench offers to write it.
 */
export function checkPairing(text, library) {
  if (text === undefined || text === null || text === "") {
    return { ok: true, setup: true, library: null };
  }
  let meta;
  try {
    meta = parse(text);
  } catch (err) {
    return { ok: false, problem: `companion.yaml is not valid YAML: ${err.message}` };
  }
  const named = typeof meta?.library === "string" ? meta.library.trim() : "";
  if (!named) return { ok: true, setup: false, library: null, license: meta?.license ?? null };
  if (named.toLowerCase() !== String(library).toLowerCase()) {
    return {
      ok: false,
      library: named,
      problem: `its companion.yaml says it belongs to ${named}, not ${library}`,
    };
  }
  return { ok: true, setup: false, library: named, license: meta?.license ?? null };
}

export function starterCompanionYaml(library) {
  return (
    `library: ${library}\n` +
    'license: "Shared with named educators — not for redistribution"\n'
  );
}

export function starterGuide(title) {
  return (
    `# ${title}: instructor guide\n\n` +
    "## Before the session\n\n" +
    "## Running it\n\n" +
    "## Answers and discussion\n\n" +
    "## Marking\n"
  );
}

export function starterQuestions(outcomeIds = []) {
  const assesses = outcomeIds.length ? `[${outcomeIds.slice(0, 1).join(", ")}]` : "[]";
  return (
    "questions:\n" +
    "  - id: q-01\n" +
    "    type: mcq\n" +
    `    assesses: ${assesses}\n` +
    "    stem: Write the question here.\n" +
    "    options:\n" +
    "      - text: The right answer\n" +
    "        correct: true\n" +
    "        feedback: Why it is right.\n" +
    "      - text: A plausible wrong answer\n" +
    "        feedback: Why it is not.\n"
  );
}

const isText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * A quick check of a bank, as it is typed: the shape of every item and
 * whether the outcomes it assesses exist. Mirrors questions.py closely
 * enough to catch what an author gets wrong; Check runs the real one.
 *
 * Returns {items: [{id, type, stem, assesses}], problems: [string]}.
 */
export function checkQuestions(text, { outcomes = null } = {}) {
  let data;
  try {
    data = parse(text);
  } catch (err) {
    return { items: [], problems: [`Not valid YAML: ${err.message.split("\n")[0]}`] };
  }
  if (!data || !Array.isArray(data.questions)) {
    return { items: [], problems: ["Needs a top-level 'questions' list."] };
  }
  const items = [];
  const problems = [];
  const seen = new Set();
  data.questions.forEach((raw, index) => {
    const where = `Question ${index + 1}${raw?.id ? ` (${raw.id})` : ""}`;
    if (!raw || typeof raw !== "object") {
      problems.push(`${where}: must be a mapping.`);
      return;
    }
    if (!isText(String(raw.id ?? ""))) problems.push(`${where}: missing 'id'.`);
    else if (seen.has(String(raw.id))) problems.push(`${where}: duplicate id.`);
    seen.add(String(raw.id));
    if (!ITEM_TYPES.includes(raw.type)) {
      problems.push(`${where}: type must be one of ${ITEM_TYPES.join(", ")}.`);
    }
    const assesses = raw.assesses;
    if (!Array.isArray(assesses) || !assesses.length) {
      problems.push(`${where}: 'assesses' must list the outcome ids it tests.`);
    } else if (outcomes) {
      for (const oid of assesses) {
        if (!outcomes.has(String(oid))) problems.push(`${where}: assesses unknown outcome ${oid}.`);
      }
    }
    if (raw.type !== "cloze" && !isText(raw.stem)) problems.push(`${where}: missing 'stem'.`);
    const options = Array.isArray(raw.options) ? raw.options : [];
    const correct = options.filter((o) => o && o.correct === true).length;
    if (raw.type === "mcq" && correct !== 1) problems.push(`${where}: an mcq needs exactly one correct option.`);
    if (raw.type === "multi" && correct < 1) problems.push(`${where}: a multi needs at least one correct option.`);
    if ((raw.type === "mcq" || raw.type === "multi") && options.length < 2) {
      problems.push(`${where}: needs at least two options.`);
    }
    if (raw.type === "truefalse" && typeof raw.answer !== "boolean") {
      problems.push(`${where}: 'answer' must be true or false.`);
    }
    if (raw.type === "short" && !(Array.isArray(raw.answers) && raw.answers.length)) {
      problems.push(`${where}: list the accepted 'answers'.`);
    }
    if (raw.type === "numeric" && typeof raw.answer !== "number") {
      problems.push(`${where}: 'answer' must be a number.`);
    }
    if (raw.type === "match" && !(Array.isArray(raw.pairs) && raw.pairs.length >= 2)) {
      problems.push(`${where}: a match needs at least two 'pairs'.`);
    }
    if (raw.type === "cloze" && !/\[\[[^\[\]]+\]\]/.test(String(raw.text ?? ""))) {
      problems.push(`${where}: a cloze needs 'text' with gaps written [[answer]].`);
    }
    items.push({
      id: String(raw.id ?? ""),
      type: String(raw.type ?? ""),
      stem: String(raw.stem ?? raw.text ?? ""),
      assesses: Array.isArray(assesses) ? assesses.map(String) : [],
    });
  });
  if (!data.questions.length) problems.push("The bank has no questions yet.");
  return { items, problems };
}
