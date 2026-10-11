// A module as one block of Markdown, read and planned
// (docs/module-md-format.md).
//
// Two steps, both pure. `parseModule` reads the text into what it
// says. `planImport` sets that against the library as it stands and
// works out, file by file, exactly what would change -- which is what
// the preview shows and what Apply writes. Nothing here touches the
// page or the network, so every rule is held by tests/moduleimport-check.mjs.

import { parse as parseYaml, stringify as stringifyYaml } from "./yaml.js";
import { summaryTemplate } from "./summary.js";

const FENCE = /^---\s+(competencies|funding|session)\s*$/;
const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const MODULE_KEYS = [
  "title", "code", "level", "credits", "hours", "programme", "audience",
  "delivery", "language", "description",
];

/** Where a YAML block went wrong, as a line of the whole document. */
function blockProblem(kind, startLine, err) {
  const at = Number.isInteger(err?.mark?.line) ? startLine + 1 + err.mark.line : startLine;
  const reason = String(err?.reason || err?.message || "").split("\n")[0];
  return `The ${kind} block starting on line ${startLine} doesn't read (line ${at}): ${reason}.`;
}

/**
 * The text, read: {meta, competencies, funding, structure, sessions,
 * ignored, problems}. Sessions carry their position as `trail` into
 * `structure`. Problems are what stops an import.
 */
export function parseModule(input) {
  let text = String(input ?? "").replace(/\r\n?/g, "\n").trim();
  // A model often hands it over inside a code fence; so does a person
  // copying from one.
  const fenced = text.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();

  const out = {
    meta: {}, competencies: {}, funding: null,
    structure: [], sessions: [], ignored: 0, problems: [],
  };
  const lines = text.split("\n");
  let i = 0;

  // Front matter: the module itself.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === "---");
    if (end === -1) {
      out.problems.push("The module details at the top open with --- but never close with one.");
      return out;
    }
    try {
      const meta = parseYaml(lines.slice(1, end).join("\n")) || {};
      if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("not a set of name: value lines");
      out.meta = meta;
    } catch (err) {
      out.problems.push(blockProblem("module details", 1, err));
    }
    i = end + 1;
  }
  if (!String(out.meta.title ?? "").trim()) {
    out.problems.push("The module has no title: put `title: …` in the details at the top, between the --- lines.");
  }

  const levels = Array.isArray(out.meta.levels) ? out.meta.levels.map(String) : [];
  // stack[d] is the open grouping at depth d (## is depth 0).
  const stack = [];
  const childrenAt = () => (stack.length ? stack[stack.length - 1].children : out.structure);

  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      const kind = fence[1];
      const start = i + 1; // 1-based line of the fence
      const end = lines.findIndex((l, n) => n > i && l.trim() === "---");
      if (end === -1) {
        out.problems.push(`The ${kind} block starting on line ${start} never closes with ---.`);
        break;
      }
      let data = null;
      try {
        data = parseYaml(lines.slice(i + 1, end).join("\n"));
      } catch (err) {
        out.problems.push(blockProblem(kind, start, err));
      }
      i = end;
      if (data == null) continue;
      if (kind === "competencies") {
        if (typeof data !== "object" || Array.isArray(data)) {
          out.problems.push(`The competencies block on line ${start} should be lines of \`id: label\`.`);
          continue;
        }
        for (const [id, label] of Object.entries(data)) {
          out.competencies[String(id)] =
            typeof label === "object" && label ? String(label.label ?? id) : String(label ?? id);
        }
      } else if (kind === "funding") {
        out.funding = typeof data === "object" && !Array.isArray(data) ? data : { text: String(data) };
      } else {
        if (typeof data !== "object" || Array.isArray(data)) {
          out.problems.push(`The session block on line ${start} should be lines of \`name: value\`.`);
          continue;
        }
        const session = { ...data, line: start };
        const node = { block: null, session };
        childrenAt().push(node);
        out.sessions.push(session);
      }
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const hashes = heading[1].length;
      if (hashes === 1) continue; // the module's own title, again
      const depth = Math.min(hashes - 2, stack.length);
      stack.length = depth;
      const node = { title: heading[2].trim(), children: [] };
      if (levels[depth]) node.kind = levels[depth];
      childrenAt().push(node);
      stack.push(node);
      continue;
    }

    if (line.trim()) out.ignored += 1;
  }
  return out;
}

/** "90", "90 min", "1.5 h", "2 hours" -> minutes, or null. */
export function minutes(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Math.round(value);
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)?$/i);
  if (!m) return NaN;
  const n = Number(m[1]);
  return /^h/i.test(m[2] ?? "") ? Math.round(n * 60) : Math.round(n);
}

export function slug(text, limit = 40) {
  const s = String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, limit).replace(/-+$/g, "") || "session";
}

function readYaml(files, path) {
  const text = files.get(path);
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return parseYaml(text) || {};
  } catch {
    return null; // broken: the plan refuses to overwrite it
  }
}

const write = (value) => stringifyYaml(value);

/**
 * What importing `parsed` into the library held in `files` (a Map of
 * path -> text) would change. Returns:
 *
 *   problems  reasons not to apply; empty means it can be
 *   notes     things worth knowing that do not stop it
 *   rows      [{path, action: "create"|"update"|"same", detail}]
 *   changes   Map path -> new text, for the files that change
 */
export function planImport(parsed, files) {
  const problems = [...parsed.problems];
  const notes = [];
  const rows = [];
  const changes = new Map();

  const course = readYaml(files, "course.yaml");
  const framework = readYaml(files, "competencies/framework.yaml");
  const catalogue = readYaml(files, "outcomes.yaml");
  const attribution = readYaml(files, "attribution.yaml");
  for (const [path, doc] of [
    ["course.yaml", course], ["competencies/framework.yaml", framework],
    ["outcomes.yaml", catalogue], ["attribution.yaml", attribution],
  ]) {
    if (doc === null) {
      problems.push(`${path} can't be read at the moment, so the import would overwrite it. Fix it first.`);
    }
  }
  if (problems.length) return { problems, notes, rows, changes };

  const existingBlocks = new Set(
    [...files.keys()]
      .map((p) => p.match(/^blocks\/([^/]+)\/(?:block\.yaml|slides\.md|lessonplan\.md)$/)?.[1])
      .filter(Boolean)
  );

  // -- competencies: existing ∪ imported
  const known = new Set([
    ...Object.keys(framework.competencies ?? {}),
    ...Object.keys(parsed.competencies),
  ]);

  // -- outcome ids: explicit ones, then numbered after the highest in use
  const existingOutcomes = catalogue.outcomes ?? {};
  const explicit = [];
  for (const s of parsed.sessions) {
    if (s.outcomes && typeof s.outcomes === "object" && !Array.isArray(s.outcomes)) {
      explicit.push(...Object.keys(s.outcomes));
    }
  }
  let highest = 0;
  for (const id of [...Object.keys(existingOutcomes), ...explicit]) {
    const n = Number(String(id).match(/^O(\d+)$/i)?.[1]);
    if (n > highest) highest = n;
  }
  const seenOutcomes = new Map(); // id -> session title
  const normal = (text) => String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const byStatement = new Map();
  for (const [id, entry] of Object.entries(existingOutcomes)) {
    const statement = typeof entry === "object" && entry ? entry.statement : entry;
    if (!explicit.includes(id)) byStatement.set(normal(statement), id);
  }

  // -- sessions
  const seenSessions = new Map();
  const outcomesOut = { ...existingOutcomes };
  let order = 0;
  for (const s of parsed.sessions) {
    order += 1;
    const title = String(s.title ?? "").trim();
    if (!title) {
      problems.push(`The session on line ${s.line} has no title.`);
      continue;
    }
    const id = s.id ? String(s.id).trim() : `${String(order).padStart(2, "0")}-${slug(title)}`;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      problems.push(`“${title}”: its id “${id}” can only use letters, numbers, dots, dashes and underscores.`);
      continue;
    }
    if (seenSessions.has(id)) {
      problems.push(`Two sessions have the id ${id} (“${seenSessions.get(id)}” and “${title}”).`);
      continue;
    }
    seenSessions.set(id, title);
    s.id = id;
    const duration = minutes(s.duration);
    if (Number.isNaN(duration)) {
      problems.push(`“${title}”: duration “${s.duration}” isn't a number of minutes (try 90, 90 min or 1.5 h).`);
    }
    s.minutes = Number.isNaN(duration) ? null : duration;

    // outcomes: {id: statement | {statement, develops, dok}} or [statement]
    const list = [];
    const raw = s.outcomes;
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const statement = typeof entry === "object" && entry ? entry.statement : entry;
        // An outcome written without an id keeps the one it was given
        // last time, found by its words: importing the same module twice
        // must change nothing, not renumber it.
        let id = byStatement.get(normal(statement));
        if (!id || seenOutcomes.has(id)) {
          highest += 1;
          id = `O${highest}`;
        }
        list.push({ id, statement, develops: entry?.develops, dok: entry?.dok });
      }
    } else if (raw && typeof raw === "object") {
      for (const [oid, entry] of Object.entries(raw)) {
        const statement = typeof entry === "object" && entry ? entry.statement : entry;
        list.push({ id: String(oid), statement, develops: entry?.develops, dok: entry?.dok });
      }
    } else if (raw != null) {
      problems.push(`“${title}”: outcomes should be a list of statements, or lines of \`id: statement\`.`);
    }
    s.outcomeIds = [];
    for (const o of list) {
      if (!String(o.statement ?? "").trim()) {
        problems.push(`“${title}”: outcome ${o.id} has no statement.`);
        continue;
      }
      if (seenOutcomes.has(o.id)) {
        problems.push(`Outcome ${o.id} is given twice (in “${seenOutcomes.get(o.id)}” and “${title}”). Outcome ids are module-wide.`);
        continue;
      }
      seenOutcomes.set(o.id, title);
      const develops = o.develops == null ? [] : (Array.isArray(o.develops) ? o.develops : [o.develops]).map(String);
      for (const c of develops) {
        if (!known.has(c)) {
          problems.push(`“${title}”, outcome ${o.id}: develops ${c}, which isn't one of the module's competencies (${[...known].join(", ") || "none defined"}).`);
        }
      }
      const before = typeof existingOutcomes[o.id] === "object" && existingOutcomes[o.id] ? existingOutcomes[o.id] : {};
      const entry = { ...before, statement: String(o.statement).trim() };
      if (develops.length) entry.develops = develops;
      if (o.dok != null) entry.dok = Number(o.dok);
      outcomesOut[o.id] = entry;
      s.outcomeIds.push(o.id);
      s.outcomeList = [...(s.outcomeList ?? []), { id: o.id, statement: entry.statement }];
    }
  }
  if (problems.length) return { problems, notes, rows, changes };

  const change = (path, text, detail) => {
    const before = files.get(path);
    if (before === text) {
      rows.push({ path, action: "same", detail });
      return;
    }
    changes.set(path, text);
    rows.push({ path, action: before === undefined ? "create" : "update", detail });
  };

  // -- course.yaml: the module's details, and the running order
  const toStructure = (nodes) =>
    nodes.map((node) =>
      node.session
        ? { block: node.session.id }
        : { ...(node.kind ? { kind: node.kind } : {}), title: node.title, children: toStructure(node.children) }
    );
  // The module's details first and the running order last, as a person
  // would write the file; anything else already in it is kept.
  const { structure: _old, ...rest } = course;
  const nextCourse = { ...rest };
  for (const key of MODULE_KEYS) {
    if (parsed.meta[key] != null && parsed.meta[key] !== "") nextCourse[key] = parsed.meta[key];
  }
  nextCourse.structure = toStructure(parsed.structure);
  const placedBefore = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n?.block) placedBefore.push(String(n.block));
      else walk(n?.children);
    }
  };
  walk(course.structure);
  const leftOut = placedBefore.filter((b) => !seenSessions.has(b));
  if (leftOut.length) {
    notes.push(
      `${leftOut.length} session${leftOut.length === 1 ? "" : "s"} already in the course ` +
        `${leftOut.length === 1 ? "isn't" : "aren't"} in the import (${leftOut.join(", ")}). ` +
        "They stay, outside the running order, until you place them again."
    );
  }
  const groupings = (nodes) => nodes.reduce((n, x) => n + (x.session ? 0 : 1 + groupings(x.children)), 0);
  change(
    "course.yaml",
    write(nextCourse),
    `the module's details, and a running order of ${parsed.sessions.length} session` +
      `${parsed.sessions.length === 1 ? "" : "s"} in ${groupings(parsed.structure)} grouping` +
      `${groupings(parsed.structure) === 1 ? "" : "s"}`
  );

  // -- competencies
  const imported = Object.entries(parsed.competencies);
  if (imported.length) {
    const comps = { ...(framework.competencies ?? {}) };
    for (const [id, label] of imported) {
      comps[id] = typeof comps[id] === "object" && comps[id] ? { ...comps[id], label } : label;
    }
    change("competencies/framework.yaml", write({ ...framework, competencies: comps }),
      `${imported.length} competenc${imported.length === 1 ? "y" : "ies"}`);
  }

  // -- outcomes
  if (seenOutcomes.size) {
    change("outcomes.yaml", write({ ...catalogue, outcomes: outcomesOut }),
      `${seenOutcomes.size} learning outcome${seenOutcomes.size === 1 ? "" : "s"}`);
  }

  // -- funding
  if (parsed.funding) {
    const keep = Object.fromEntries(
      Object.entries(parsed.funding).filter(([k]) => ["text", "logo", "corner"].includes(k))
    );
    change("attribution.yaml", write({ ...attribution, ...keep }), "the funding credit on every slide");
  }

  // -- sessions
  for (const s of parsed.sessions) {
    const path = `blocks/${s.id}/block.yaml`;
    const isNew = !existingBlocks.has(s.id);
    const before = isNew ? {} : readYaml(files, path);
    if (before === null) {
      problems.push(`${path} can't be read at the moment, so the import would overwrite it. Fix it first.`);
      continue;
    }
    const meta = { ...before, title: String(s.title).trim() };
    if (s.minutes != null) meta.duration_minutes = s.minutes;
    if (s.outcomeIds.length) meta.outcomes = s.outcomeIds;
    if (isNew && !meta.resources) meta.resources = [];
    change(path, write(meta), isNew ? `new session “${meta.title}”` : `“${meta.title}”: title, duration and outcomes`);

    const plan = `blocks/${s.id}/lessonplan.md`;
    if (isNew && !files.has(plan)) {
      let text = summaryTemplate({
        block: { id: s.id, title: meta.title, duration: meta.duration_minutes },
        outcomes: s.outcomeList ?? [],
        documents: [],
      });
      const summary = String(s.summary ?? "").trim();
      if (summary) {
        text = text.replace(
          "*Two or three sentences on what this session covers, and why it*\n*matters to the people sitting in it.*",
          summary
        );
      }
      change(plan, text, `its lesson plan, ${summary ? "opening with the summary" : "ready to write"}`);
    }
  }

  // Hours, if given, against what the sessions add up to.
  const total = parsed.sessions.reduce((n, s) => n + (s.minutes ?? 0), 0);
  const hours = Number(parsed.meta.hours);
  if (hours && total) {
    notes.push(
      `The sessions add up to ${Math.round((total / 60) * 10) / 10} contact hours of the ` +
        `${hours} learner hours given — the rest is self-study, assignments and assessment.`
    );
  }
  if (parsed.ignored) {
    notes.push(
      `${parsed.ignored} line${parsed.ignored === 1 ? "" : "s"} outside the blocks and headings ` +
        `${parsed.ignored === 1 ? "was" : "were"} ignored.`
    );
  }
  return { problems, notes, rows, changes };
}
