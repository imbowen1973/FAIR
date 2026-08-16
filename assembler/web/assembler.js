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
