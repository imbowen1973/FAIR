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
  const groups = new Map();
  for (const slide of catalog.slides) {
    if (!(slide.develops || []).includes(cId)) continue;
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

/**
 * Turn what a user types into a library source: {name, url} where url is
 * the SITE ROOT that serves data/catalog.json and data/<decks>. Git
 * hosting without git language: the user pastes "owner/repo", a
 * github.com repo URL, or any https URL near the catalog, and it
 * resolves. Returns null when unusable.
 *
 *   owner/repo                       -> https://owner.github.io/repo
 *   https://github.com/owner/repo    -> https://owner.github.io/repo
 *   https://site/x/data/catalog.json -> https://site/x
 *   https://site/x/data              -> https://site/x
 *   https://site/x                   -> https://site/x
 */
export function normalizeSource(input) {
  const raw = (input || "").trim().replace(/\/+$/, "");
  if (!raw) return null;

  const isUrl = /^https?:\/\//.test(raw);
  const ghRepo = raw.match(
    /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
  );
  if (ghRepo && (!isUrl || /^https?:\/\/(www\.)?github\.com\//.test(raw))) {
    const [, owner, repo] = ghRepo;
    return {
      name: `${owner}/${repo}`,
      url: `https://${owner.toLowerCase()}.github.io/${repo}`,
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
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
