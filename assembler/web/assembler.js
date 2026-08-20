// Pure assembler logic — no Office.js dependency, so it is unit-testable
// in Node. The task pane (taskpane.js) wires these to the PowerPoint API.

/**
 * Spec B.2: entries whose `develops` includes cId, grouped by sourcePptx
 * so inserts can be batched one call per source deck.
 *
 * Replacing the body with a FalkorDB Cypher query later must not change
 * the shape: competency id in, Map<sourcePptx, entries[]> out.
 *
 * @param {{slides: Array}} catalog
 * @param {string} cId
 * @returns {Map<string, Array>}
 */
export function slidesForCompetency(catalog, cId) {
  return groupBySource(
    catalog.slides.filter((s) => (s.develops || []).includes(cId))
  );
}

/**
 * Group slide entries by their source deck — the shape buildInsertPlan
 * consumes. Tree selection and competency selection both route through
 * here, so there is one insert path rather than two.
 *
 * @param {Array} slides
 * @returns {Map<string, Array>}
 */
export function groupBySource(slides) {
  const groups = new Map();
  for (const slide of slides) {
    if (!groups.has(slide.sourcePptx)) groups.set(slide.sourcePptx, []);
    groups.get(slide.sourcePptx).push(slide);
  }
  return groups;
}

/** Distinct competencies actually used by at least one slide, with labels. */
export function usedCompetencies(catalog) {
  const used = new Set();
  for (const slide of catalog.slides) {
    for (const c of slide.develops || []) used.add(c);
  }
  return [...used]
    .sort()
    .map((id) => ({ id, label: catalog.competencies?.[id] ?? id }));
}

/**
 * Insert plan for a selection: one entry per source deck, carrying the
 * sourceRefs (slideId#creationId) for insertSlidesFromBase64.
 *
 * @param {Map<string, Array>} groups
 * @param {Set<string>} selectedSlideIds authored slide ids the user kept
 * @returns {Array<{sourcePptx: string, sourceRefs: string[], slides: Array}>}
 */
export function buildInsertPlan(groups, selectedSlideIds) {
  const plan = [];
  for (const [sourcePptx, slides] of groups) {
    const kept = slides.filter((s) => selectedSlideIds.has(s.slideId));
    if (kept.length === 0) continue;
    plan.push({
      sourcePptx,
      sourceRefs: kept.map((s) => s.sourceRef),
      slides: kept,
    });
  }
  return plan;
}

// Delivery structure, outermost first — mirrors NESTING in corpus.py.
// Each level is optional; a container holds either the next level or
// sessions, so a flat modules[].sessions[] still yields module -> session.
const NESTING = [
  ["modules", "module"],
  ["days", "day"],
  ["blocks", "block"],
];

function sessionNode(sessionId, byId, slidesBySession) {
  const session = byId.get(sessionId);
  const slides = slidesBySession.get(sessionId) || [];
  return {
    kind: "session",
    title: session?.title ?? sessionId,
    meta: { sessionId, durationMinutes: session?.durationMinutes ?? null },
    children: slides.map((s) => ({
      kind: "slide",
      title: s.title ?? s.slideId,
      meta: { slideId: s.slideId, dok: s.dok, develops: s.develops || [] },
      children: [],
      slideIds: [s.slideId],
    })),
    slideIds: slides.map((s) => s.slideId),
  };
}

function containerNode(node, level, kind, byId, slidesBySession) {
  for (let i = level; i < NESTING.length; i++) {
    const [key, childKind] = NESTING[i];
    if (!Array.isArray(node[key])) continue;
    const children = node[key].map((child) =>
      containerNode(child, i + 1, childKind, byId, slidesBySession)
    );
    return {
      kind,
      title: node.title ?? childKind,
      meta: {},
      children,
      slideIds: children.flatMap((c) => c.slideIds),
    };
  }
  const children = (node.sessions || []).map((sid) =>
    sessionNode(String(sid), byId, slidesBySession)
  );
  return {
    kind,
    title: node.title ?? kind,
    meta: {},
    children,
    slideIds: children.flatMap((c) => c.slideIds),
  };
}

/**
 * The corpus as a navigable tree:
 * credential -> module -> day -> block -> session -> slide.
 *
 * Absent levels collapse rather than rendering empty rungs, and sessions
 * no credential claims are gathered under a trailing pseudo-credential so
 * a library with no credentials/ directory still browses.
 *
 * @param {{sessions: Array, slides: Array, credentials?: Array}} catalog
 * @returns {Array} root nodes
 */
export function buildTree(catalog) {
  const byId = new Map((catalog.sessions || []).map((s) => [s.sessionId, s]));
  const slidesBySession = new Map();
  for (const slide of catalog.slides || []) {
    if (!slidesBySession.has(slide.sessionId)) slidesBySession.set(slide.sessionId, []);
    slidesBySession.get(slide.sessionId).push(slide);
  }

  // A course recipe wins when present: the structure is the course's own,
  // and blocks carry resources that are not slides at all.
  if ((catalog.structure || []).length > 0) {
    return catalog.structure.map((node) =>
      courseNode(node, catalog, byId, slidesBySession)
    );
  }

  const claimed = new Set();
  const roots = (catalog.credentials || []).map((cred) => {
    const node = containerNode(cred, 0, "credential", byId, slidesBySession);
    node.title = cred.title ?? cred.id;
    node.meta = { id: cred.id, ects: cred.ects ?? null };
    walk(node, (n) => {
      if (n.kind === "session") claimed.add(n.meta.sessionId);
    });
    return node;
  });

  const orphans = (catalog.sessions || [])
    .map((s) => s.sessionId)
    .filter((id) => !claimed.has(id));
  if (orphans.length > 0) {
    const children = orphans.map((id) => sessionNode(id, byId, slidesBySession));
    roots.push({
      kind: "credential",
      title: roots.length ? "Unassigned sessions" : "All sessions",
      meta: { id: null, ects: null, unassigned: true },
      children,
      slideIds: children.flatMap((c) => c.slideIds),
    });
  }
  return roots;
}

/**
 * One node of the course recipe. A group nests; a block leaf carries its
 * deck's slides and, beside them, the resources that are not slides —
 * lesson plans, workbooks, question banks. Those are shown and linked,
 * never selectable: PowerPoint cannot insert a workbook.
 */
function courseNode(node, catalog, byId, slidesBySession) {
  if (node.kind !== "block") {
    const children = (node.children || []).map((child) =>
      courseNode(child, catalog, byId, slidesBySession)
    );
    return {
      kind: node.kind || "group",
      title: node.title || "",
      meta: {},
      children,
      slideIds: children.flatMap((c) => c.slideIds),
    };
  }

  const blockId = node.block;
  const block = (catalog.blocks || []).find((b) => b.blockId === blockId);
  const session = (catalog.sessions || []).find((s) => s.blockId === blockId);
  const slides = session ? slidesBySession.get(session.sessionId) || [] : [];

  const children = slides.map((s) => ({
    kind: "slide",
    title: s.title ?? s.slideId,
    meta: { slideId: s.slideId, dok: s.dok, develops: s.develops || [] },
    children: [],
    slideIds: [s.slideId],
  }));

  for (const resource of block?.resources || []) {
    children.push({
      kind: "resource",
      title: resource.title,
      meta: { type: resource.type, path: resource.path },
      children: [],
      slideIds: [],
    });
  }

  return {
    kind: "block",
    title: block?.title || blockId,
    meta: {
      blockId,
      durationMinutes: block?.durationMinutes ?? null,
      resources: (block?.resources || []).length,
    },
    children,
    slideIds: slides.map((s) => s.slideId),
  };
}

/** Depth-first visit, used for tri-state selection and counting. */
export function walk(node, fn) {
  fn(node);
  for (const child of node.children || []) walk(child, fn);
}

function snippet(text, at, width = 120) {
  const start = Math.max(0, at - Math.floor(width / 2));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/**
 * Find slides by what they say, not just how they are tagged. Searches
 * slide titles, speaker notes, session titles and competency labels.
 * Title hits outrank notes hits; empty query returns nothing.
 *
 * @returns {Array<{slideId, sessionId, field, snippet, slide}>}
 */
export function searchCatalog(catalog, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];

  const sessionTitles = new Map(
    (catalog.sessions || []).map((s) => [s.sessionId, s.title ?? ""])
  );
  const competencyHits = new Set(
    Object.entries(catalog.competencies || {})
      .filter(([id, label]) => `${id} ${label}`.toLowerCase().includes(q))
      .map(([id]) => id)
  );

  const results = [];
  for (const slide of catalog.slides || []) {
    const title = slide.title ?? "";
    const notes = slide.notes ?? "";
    const sessionTitle = sessionTitles.get(slide.sessionId) ?? "";

    let field = null;
    let text = "";
    let at = -1;
    if ((at = title.toLowerCase().indexOf(q)) >= 0) {
      field = "title";
      text = title;
    } else if ((at = sessionTitle.toLowerCase().indexOf(q)) >= 0) {
      field = "session";
      text = sessionTitle;
    } else if ((at = notes.toLowerCase().indexOf(q)) >= 0) {
      field = "notes";
      text = notes;
    } else if ((slide.develops || []).some((c) => competencyHits.has(c))) {
      field = "competency";
      text = (slide.develops || []).filter((c) => competencyHits.has(c)).join(", ");
      at = 0;
    }
    if (!field) continue;

    results.push({
      slideId: slide.slideId,
      sessionId: slide.sessionId,
      field,
      snippet: field === "competency" ? text : snippet(text, at),
      slide,
    });
  }

  const rank = { title: 0, session: 1, competency: 2, notes: 3 };
  return results.sort((a, b) => rank[a.field] - rank[b.field]);
}

/**
 * Hosts that serve git repos, not corpora. A repo holds markdown; the
 * pane needs a rendered catalog and cannot clone or render one itself.
 * Rejecting these up front turns an opaque CORS failure into a message
 * that points at the puller.
 */
const GIT_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "www.gitlab.com",
  "bitbucket.org",
  "www.bitbucket.org",
]);

/**
 * Parse "owner/repo" or a github.com repo URL into {owner, repo}, for
 * the in-browser renderer. Null when the input is not a GitHub repo.
 */
export function parseRepoInput(input) {
  const raw = (input || "").trim().replace(/\/+$/, "");
  let m = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (m && !raw.includes(":")) return { owner: m[1], repo: m[2] };
  m = raw.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/** True when the input names a git repo rather than a corpus server. */
export function isRepoUrl(input) {
  const raw = (input || "").trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return true; // bare owner/repo slug
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    GIT_HOSTS.has(url.hostname.toLowerCase()) ||
    url.pathname.replace(/\/+$/, "").endsWith(".git")
  );
}

/**
 * Turn what a user types into a library source: {name, url} where url is
 * the SITE ROOT that serves data/catalog.json and data/<decks>. Sources
 * are corpus servers — another local build, a server on the network, or
 * (later) the middle layer rendering on demand. Decks are never
 * published, so there is deliberately no repo-slug shorthand: a git
 * repo holds markdown and is not itself consumable by the pane.
 *
 *   https://site/x/data/catalog.json -> https://site/x
 *   https://site/x/data              -> https://site/x
 *   https://site/x                   -> https://site/x
 *
 * Returns null when unusable (non-https, unparseable).
 */
export function normalizeSource(input) {
  const raw = (input || "").trim().replace(/\/+$/, "");
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (isRepoUrl(raw)) return null;
  let base = url.href.replace(/\/+$/, "");
  base = base.replace(/\/data\/catalog\.json$/, "").replace(/\/data$/, "");
  const name = url.hostname + new URL(base).pathname.replace(/\/$/, "");
  return { name, url: base };
}

/** Join a source base URL with a catalog-relative path. Empty base = same-origin. */
export function joinUrl(base, path) {
  if (!base) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** ArrayBuffer -> base64, chunked to stay clear of argument limits. */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
