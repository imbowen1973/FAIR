// The schematic: boxes at the template's true placeholder geometry.
//
// It answers one question — is my content in the region I meant? — and
// nothing else. It is not a preview of the deck and must never look like
// one: no fonts, no theme colours, no attempt at type size. Anything
// that made it resemble the artifact would invite an author to trust it,
// and the moment they trust it, drift between this and the renderer
// becomes a bug they cannot see. Preview deck is the trustworthy one.
//
// Geometry comes from layout-geometry.json, emitted by
// `fair-template --geometry` from the library's own template, so the
// rectangles are that designer's, not ours.

import { plainText } from "./marks.js";

function summarise(value) {
  if (value == null) return "";
  if (typeof value === "string") return plainText(value);
  if (Array.isArray(value)) return value.map(summarise).join(" · ");

  switch (value.type) {
    case "ul":
    case "ol":
      return (value.items || [])
        .map((item) => (typeof item === "string" ? plainText(item) : plainText(item.text || "")))
        .join(" · ");
    case "p":
      return plainText(value.text || "");
    case "image":
      return `▨ ${value.src || "image"}`;
    case "mermaid":
      return `◈ ${value.src || "diagram"}`;
    case "video":
      return `▶ ${value.url || "video"}`;
    default:
      return "";
  }
}

/**
 * Draw `slide` into `host` using the layout's rectangles.
 * Returns the set of regions it could not place.
 */
export function drawSchematic(host, { geometry, layoutKey, slide, activeRegion }) {
  host.innerHTML = "";
  const layout = geometry?.layouts?.[layoutKey];

  if (!layout) {
    host.innerHTML =
      '<p class="empty">No geometry for this layout. Run ' +
      "<code>fair-template &lt;template&gt; --geometry layout-geometry.json</code> " +
      "in the library and commit the result.</p>";
    return new Set(Object.keys(slide || {}));
  }

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.style.aspectRatio = String(geometry.slide?.aspect || 1.7778);

  const unplaced = new Set();
  for (const [region, value] of Object.entries(slide || {})) {
    const rect = layout.regions[region];
    if (!rect) {
      unplaced.add(region);
      continue;
    }
    const box = document.createElement("div");
    box.className = "region";
    if (region === activeRegion) box.classList.add("active");
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;

    const name = document.createElement("span");
    name.className = "region-name";
    name.textContent = region;

    const body = document.createElement("span");
    body.className = "region-body";
    body.textContent = summarise(value);

    box.append(name, body);
    stage.appendChild(box);
  }

  // Regions the layout offers but the slide leaves empty: drawn faintly so
  // an author can see what is available to fill.
  for (const [region, rect] of Object.entries(layout.regions)) {
    if (region in (slide || {})) continue;
    const box = document.createElement("div");
    box.className = "region vacant";
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    const name = document.createElement("span");
    name.className = "region-name";
    name.textContent = region;
    box.appendChild(name);
    stage.appendChild(box);
  }

  host.appendChild(stage);
  return unplaced;
}
