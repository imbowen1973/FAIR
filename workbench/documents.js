// What a block holds, as a list of documents.
//
// A block is a session, not a deck: a lesson plan, a workbook, an
// instructor guide, an assignment, an assessment, and the spreadsheets
// and images that go with them. `block.yaml`'s `resources:` is the
// manifest, and this turns it into the tabs an author sees.
//
// Two rules keep the manifest honest:
//
//   - The deck is implicit. `slides.md` is fixed by convention and the
//     renderer keys off that name; listing it in `resources:` as well
//     would index it twice in catalog.json. It is a tab here and a
//     convention in the file.
//   - The lesson plan is required. Every block has one, so it always
//     gets a tab even when `resources:` has not caught up.

/** Kinds an author can add, and what each one is called by default. */
export const KINDS = {
  lessonplan: { label: "Lesson plan", file: "lessonplan.md", editor: "markdown" },
  assessment: { label: "Assessment", file: "assessment.xml", editor: "assessment" },
  assignment: { label: "Assignment", file: "assignment.md", editor: "markdown" },
  workbook: { label: "Workbook", file: "workbook.md", editor: "markdown" },
  instructorguide: {
    label: "Instructor guide",
    file: "instructorguide.md",
    editor: "markdown",
  },
  handout: { label: "Handout", file: "handout.md", editor: "markdown" },
};

export const LESSON_PLAN_FILE = "lessonplan.md";
export const SLIDES_FILE = "slides.md";
export const MEDIA_DIR = "media";
export const FILES_DIR = "files";

/** Which editor opens a path, from its extension and declared type. */
export function editorFor(type, path) {
  if (KINDS[type]?.editor) return KINDS[type].editor;
  if (/\.md$/i.test(path)) return "markdown";
  if (/\.xml$/i.test(path)) return "assessment";
  return "attachment"; // a spreadsheet, a PDF: carried, linked, not edited
}

/** A readable name for a file nobody bothered to title. */
function titleFrom(path) {
  const base = path.split("/").pop().replace(/\.[^.]+$/, "");
  const known = Object.values(KINDS).find(
    (k) => k.file.replace(/\.[^.]+$/, "") === base
  );
  if (known) return known.label;
  const words = base.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Every document in a block, in tab order: the deck first, the lesson
 * plan next, then whatever `resources:` declares.
 *
 * Each is `{id, title, type, path, file, editor, uncreated, missing}`.
 * `path` is repo relative so it can be handed straight to the file map.
 *
 * Two different absences, and conflating them misleads:
 *
 *   `uncreated` — no file behind this tab yet. The lesson plan always
 *   has a tab because every block needs one, so a block that has not
 *   written its plan is here, not broken.
 *
 *   `missing` — `block.yaml` declares it and the repo does not hold it.
 *   That is a broken declaration, and worth seeing rather than hiding.
 */
export function blockDocuments(block, files) {
  if (!block) return [];
  const dir = `blocks/${block.id}`;
  const out = [
    {
      id: "slides",
      title: "Slides",
      type: "slides",
      uncreated: files ? !files.has(`${dir}/${SLIDES_FILE}`) : false,
      // The name to link by, relative to the block. For everything else
      // the id already is that; the deck is the one whose id is a label.
      file: SLIDES_FILE,
      path: `${dir}/${SLIDES_FILE}`,
      editor: "slides",
      missing: false, // the deck tab always opens; it may simply be empty
    },
  ];

  // A session's learning outcomes are a thing you edit, so they get a
  // tab. They are stored in the repo-wide catalogue because slides and
  // questions reference them by id -- but storage is not where an author
  // should have to go to write one.
  out.push({
    id: "outcomes",
    title: "Outcomes",
    type: "outcomes",
    editor: "outcomes",
    path: "outcomes.yaml",
    uncreated: false,
    missing: false,
  });

  const seen = new Set([SLIDES_FILE]);
  const declared = Array.isArray(block.meta?.resources) ? block.meta.resources : [];

  // The lesson plan leads, declared or not, because every block has one.
  const plan = declared.find((r) => r?.path === LESSON_PLAN_FILE);
  const rest = declared.filter((r) => r?.path !== LESSON_PLAN_FILE);
  for (const entry of [plan ?? { type: "lessonplan", path: LESSON_PLAN_FILE }, ...rest]) {
    if (!entry || typeof entry.path !== "string") continue;
    const rel = entry.path;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const path = `${dir}/${rel}`;
    const type = String(entry.type || "").trim() || inferType(rel);
    out.push({
      id: rel,
      title: String(entry.title || "").trim() || titleFrom(rel),
      type,
      file: rel,
      path,
      editor: editorFor(type, rel),
      uncreated: files ? !files.has(path) : false,
      // Declared but absent. An undeclared lesson plan that has simply
      // not been written yet is uncreated, not missing.
      missing: files ? declared.some((r) => r?.path === rel) && !files.has(path) : false,
    });
  }
  return out;
}

/** A type for a resource that declared none, from its name. */
function inferType(rel) {
  const base = rel.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase();
  if (KINDS[base]) return base;
  const ext = rel.split(".").pop().toLowerCase();
  return ext === "md" ? "handout" : ext || "file";
}

/**
 * `resources:` with `entry` added, or replaced if that path is already
 * declared. Returned as a plain array so the caller writes it back into
 * block.yaml — this never touches a file itself.
 */
export function withResource(resources, entry) {
  const list = Array.isArray(resources) ? [...resources] : [];
  const at = list.findIndex((r) => r?.path === entry.path);
  if (at >= 0) list[at] = { ...list[at], ...entry };
  else list.push(entry);
  return list;
}

/** `resources:` without the document at `path`. */
export function withoutResource(resources, path) {
  const list = Array.isArray(resources) ? resources : [];
  return list.filter((r) => r?.path !== path);
}

/**
 * A free path for a new document of `kind`, so adding a second workbook
 * does not silently overwrite the first.
 */
export function freePath(kind, taken) {
  const file = KINDS[kind]?.file ?? `${kind}.md`;
  if (!taken.has(file)) return file;
  const stem = file.replace(/\.[^.]+$/, "");
  const ext = file.slice(stem.length);
  for (let n = 2; n < 99; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${taken.size + 1}${ext}`;
}
