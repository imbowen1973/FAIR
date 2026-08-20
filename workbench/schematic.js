// The preview pane: content drawn at the template's own geometry, type
// sizes, alignment and theme colours.
//
// It is representative, not authoritative. Everything it uses comes from
// the template — rectangles, point sizes, the colour scheme — so it does
// not invent an appearance the deck will not have. But it is HTML: it
// cannot know PowerPoint's line breaking, autofit, or how a long list
// overflows, and it never will. **Preview deck** renders the real file,
// and that remains the thing an author should trust before publishing.
//
// The distinction is worth keeping sharp. A preview that looks like the
// artifact invites trust; the honest position is to look close, say it is
// close, and keep the real render one click away.

import { parseMarks } from "./marks.js";

const TAG = {
  bold: "strong",
  italic: "em",
  superscript: "sup",
  subscript: "sub",
  strike: "s",
  underline: "u",
  code: "code",
};

const ALIGN = { l: "left", ctr: "center", r: "right", just: "justify" };

/** Marked-up text -> DOM, so ^2^ shows as a superscript, not as "^2^". */
function markedUp(text) {
  const fragment = document.createDocumentFragment();
  for (const span of parseMarks(text ?? "")) {
    let node = document.createTextNode(span.text);
    for (const [mark, tag] of Object.entries(TAG)) {
      if (!span[mark]) continue;
      const wrapper = document.createElement(tag);
      wrapper.appendChild(node);
      node = wrapper;
    }
    fragment.appendChild(node);
  }
  return fragment;
}

function themeColour(theme, slot) {
  if (!slot) return null;
  return theme?.[slot] ?? null;
}

/** One list item, including its nesting and any colour it carries. */
function itemNode(item, level, style, theme, scale) {
  const li = document.createElement("li");
  const text = typeof item === "string" ? item : item.text ?? "";
  li.appendChild(markedUp(text));

  const size = level === 0 ? style.sizePt : style.sizePt2 ?? style.sizePt * 0.85;
  if (size) li.style.fontSize = `${size * scale}px`;
  const colour = themeColour(theme, typeof item === "object" ? item.color : null);
  if (colour) li.style.color = colour;
  if (!style.bulleted) li.style.listStyle = "none";

  const children = typeof item === "object" ? item.items ?? [] : [];
  if (children.length) {
    const nested = document.createElement("ul");
    for (const child of children) {
      nested.appendChild(itemNode(child, level + 1, style, theme, scale));
    }
    li.appendChild(nested);
  }
  return li;
}

/** Render one region's value into its box. */
function fillRegion(box, value, style, theme, scale) {
  const size = style.sizePt ? style.sizePt * scale : null;
  box.style.textAlign = ALIGN[style.align] ?? "left";
  if (style.bold) box.style.fontWeight = "700";
  const colour = themeColour(theme, style.colorSlot) ?? style.color;
  if (colour) box.style.color = colour;

  // A plain string is one unadorned paragraph in the layout's own style.
  if (typeof value === "string") {
    const p = document.createElement("p");
    if (size) p.style.fontSize = `${size}px`;
    p.appendChild(markedUp(value));
    box.appendChild(p);
    return;
  }
  if (!value || typeof value !== "object") return;

  const regionColour = themeColour(theme, value.color);
  if (regionColour) box.style.color = regionColour;

  if (value.type === "ul" || value.type === "ol") {
    const list = document.createElement(value.type === "ol" ? "ol" : "ul");
    if (!style.bulleted) list.style.listStyle = "none";
    for (const item of value.items ?? []) {
      list.appendChild(itemNode(item, 0, style, theme, scale));
    }
    box.appendChild(list);
    return;
  }

  if (value.type === "p") {
    for (const line of String(value.text ?? "").split("\n")) {
      const p = document.createElement("p");
      if (size) p.style.fontSize = `${size}px`;
      p.appendChild(markedUp(line));
      box.appendChild(p);
    }
    return;
  }

  // Media: the schematic cannot fetch repo images, so it names what will
  // be there rather than pretending to show it.
  const placeholder = document.createElement("div");
  placeholder.className = "media";
  placeholder.textContent =
    value.type === "video"
      ? `▶ ${value.url || "hosted video"}`
      : value.type === "mermaid"
        ? `◈ ${value.src || "diagram"}`
        : `▨ ${value.src || "image"}`;
  box.appendChild(placeholder);
}

/**
 * Draw `slide` into `host` at the layout's real geometry.
 * Returns the set of regions the layout has no place for.
 */
export function drawSchematic(host, { geometry, layoutKey, slide, activeRegion }) {
  host.innerHTML = "";
  const layout = geometry?.layouts?.[layoutKey];
  const theme = geometry?.theme ?? {};

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
  stage.style.background = theme.bg1 || "#fff";
  stage.style.color = theme.tx1 || "#000";

  // Points-to-pixels for this rendering width, so 44pt in the template
  // looks like 44pt relative to the slide rather than a guessed size.
  const stageWidth = host.clientWidth || 420;
  const scale = stageWidth / (geometry.slide?.widthPt || 720);

  const unplaced = new Set();
  const drawn = new Set();

  for (const [region, value] of Object.entries(slide || {})) {
    const rect = layout.regions[region];
    if (!rect) {
      unplaced.add(region);
      continue;
    }
    drawn.add(region);
    const box = document.createElement("div");
    box.className = "region";
    if (region === activeRegion) box.classList.add("active");
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    box.dataset.region = region;
    fillRegion(box, value, rect.style ?? {}, theme, scale);
    stage.appendChild(box);
  }

  // Regions the layout offers but this slide leaves empty — outlined so an
  // author can see what is available without them competing with content.
  for (const [region, rect] of Object.entries(layout.regions)) {
    if (drawn.has(region)) continue;
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
