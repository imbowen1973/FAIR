// The slide, editable in place.
//
// The preview and the editor are the same surface: you click a region and
// type into it, at the template's own geometry, type size and colours.
// There is no separate form to keep in step, and no moment where what you
// see and what you are editing are different objects.
//
// What it deliberately does not offer: moving or resizing a region,
// choosing a font, picking a raw colour. Those belong to the template.
// A canvas that let an author drag a box would look like PowerPoint and
// quietly destroy the reason this pipeline exists.

import { fromElement, toHtml, toNodes } from "./markdom.js";
import { plainText } from "./marks.js";

const ALIGN = { l: "left", ctr: "center", r: "right", just: "justify" };

function themeColour(theme, slot) {
  return slot ? (theme?.[slot] ?? null) : null;
}

/**
 * A placeholder's own background, from the geometry.
 *
 * PowerPoint paints this itself, so the deck was always right. The canvas
 * drew only the text -- and the Cards layout puts white headings on
 * accent-coloured tabs, so they were white on white and invisible while
 * the rendered deck looked correct.
 */
function fillColour(theme, fill) {
  if (!fill) return null;
  let base = fill.hex ?? themeColour(theme, fill.slot);
  if (!base) return null;
  // Tints, shades and luminance modifiers: a card often sits a lighter
  // body under a stronger tab, and ignoring them draws both the same.
  const rgb = hexToRgb(base);
  if (!rgb) return base;
  let [r, g, b] = rgb;
  if (fill.lumMod !== undefined) [r, g, b] = [r, g, b].map((c) => c * fill.lumMod);
  if (fill.lumOff !== undefined) [r, g, b] = [r, g, b].map((c) => c + 255 * fill.lumOff);
  if (fill.tint !== undefined) {
    [r, g, b] = [r, g, b].map((c) => c * fill.tint + 255 * (1 - fill.tint));
  }
  if (fill.shade !== undefined) [r, g, b] = [r, g, b].map((c) => c * fill.shade);
  const clamp = (c) => Math.max(0, Math.min(255, Math.round(c)));
  const alpha = fill.alpha ?? 1;
  return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${alpha})`;
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ""));
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance, for deciding whether text can be read. */
function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * A text colour that can actually be read on this canvas.
 *
 * The Cards layout puts white headings on accent-coloured tabs. The deck
 * is right, because PowerPoint paints the placeholder's fill. The canvas
 * paints it too now -- but only if the library's layout-geometry.json
 * carries it, and one generated before that was captured does not. So a
 * library with an older geometry drew white on white and the headings
 * were simply not there.
 *
 * Rather than require every library to regenerate its geometry, the
 * canvas refuses to draw text it could not read: where the contrast
 * against what is actually behind it is hopeless, it falls back to the
 * slide's own foreground. The deck keeps the template's colour, which is
 * the one that is correct there.
 */
function legible(colour, background, theme) {
  if (!colour) return colour;
  const behind = background || theme?.bg1 || "#ffffff";
  const ratio = contrast(colour, behind);
  // 2 is well below the 4.5 of a reading standard: this is for text that
  // has all but disappeared, not for text that is merely low contrast,
  // because the template's choice is the template's to make.
  if (ratio === null || ratio >= 2) return colour;
  const dark = theme?.tx1 || "#000000";
  const light = theme?.bg1 || "#ffffff";
  const onDark = contrast(light, behind);
  const onLight = contrast(dark, behind);
  return (onDark ?? 0) > (onLight ?? 0) ? light : dark;
}

/**
 * PowerPoint's shrink-on-overflow, emulated: it reduces type size and
 * line spacing together, so doing only one reaches a fit later than the
 * deck will and under-reports how full a slide is.
 */
function shrinkToFit(box, minScale = 0.35) {
  const overflowing = () => box.scrollHeight > box.clientHeight + 1;
  const sized = [...box.querySelectorAll("p, li")];
  if (!sized.length || !overflowing()) return 1;

  // Read the sizes the layout set; never clear them first. They are the
  // template's own point sizes, not leftovers from an earlier pass — and
  // drawSlide rebuilds this DOM anyway, so there is nothing stale to reset.
  const base = sized.map((el) => parseFloat(getComputedStyle(el).fontSize) || 0);
  const steps = [
    [1, 0.95], [0.92, 0.9], [0.85, 0.9], [0.78, 0.85], [0.7, 0.85],
    [0.62, 0.8], [0.55, 0.8], [0.48, 0.8], [0.42, 0.8], [minScale, 0.8],
  ];
  for (const [fontScale, leading] of steps) {
    sized.forEach((el, i) => {
      if (base[i]) el.style.fontSize = `${base[i] * fontScale}px`;
      el.style.lineHeight = String(1.2 * leading);
    });
    if (!overflowing()) return fontScale;
  }
  return minScale;
}

// Which item each <li> came from, so colour and any other key survives a
// round trip through the DOM. Reading the text back is easy; guessing
// that a red bullet meant `color: accent2` is not.
const itemOf = new WeakMap();

/** Build a list, at whatever depth, from the grammar's items. */
function buildList(items, type, style, theme, scale, depth) {
  const list = document.createElement(type === "ol" ? "ol" : "ul");
  const size = depth === 0 ? style.sizePt : style.sizePt2 ?? style.sizePt * 0.85;
  // The marker is drawn at the item's font size, but a padding in `em` on
  // the list resolves against the list's own. Leave them mismatched and
  // "10." is clipped by the region's edge.
  if (size) list.style.fontSize = `${size * scale}px`;
  // `false`, not merely absent. The geometry only carries `bulleted` when
  // the template has a list style to report -- a template whose master
  // has no bodyStyle produces no key at all, and treating that as "no
  // bullets" hid every marker on the canvas while the rendered deck drew
  // them. Absent means the template has no opinion, which is bulleted.
  if (style.bulleted === false) list.style.listStyle = "none";

  for (const item of items) {
    const li = document.createElement("li");
    const text = typeof item === "string" ? item : item.text ?? "";
    li.appendChild(toNodes(text));
    itemOf.set(li, item);

    const colour = themeColour(theme, typeof item === "object" ? item.color : null);
    if (colour) li.style.color = colour;

    // Per line: what it is marked with, and how it is aligned. The
    // region says what the list is; a line may say otherwise, which is
    // how one placeholder holds a lead-in, then the points, then the
    // sentence that closes them. The canvas has to show it the way the
    // deck will, or the two disagree about the same slide.
    if (typeof item === "object") {
      const marker =
        item.marker ?? (item.bullet === false ? "none" : null);
      if (marker === "none") {
        li.style.listStyleType = "none";
        li.style.marginLeft = "-1em";
      } else if (marker === "number") {
        li.style.listStyleType = "decimal";
      } else if (marker === "bullet") {
        li.style.listStyleType = "disc";
      }
      if (marker) li.dataset.marker = marker;
      if (item.align) {
        li.style.textAlign = item.align === "justify" ? "justify" : item.align;
        li.dataset.align = item.align;
      }
    }

    const children = typeof item === "object" ? item.items ?? [] : [];
    if (children.length) {
      li.appendChild(buildList(children, type, style, theme, scale, depth + 1));
    }
    list.appendChild(li);
  }
  return list;
}

/** Read a list back, nesting and all. */
/**
 * Every block of text in an editable region, however the browser made it.
 *
 * The reader used to be `box.querySelectorAll("p")`. Press Enter in a
 * contenteditable and Chromium inserts a `div`, not a `p` -- so a new
 * line was invisible here and was dropped on the next commit. The text
 * was on the screen and absent from the file, which is the worst
 * possible pair: nothing looked wrong until a reload.
 */
function readBlocks(box) {
  const out = [];
  for (const node of box.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      // A bare text node is what typing into a region that held nothing
      // produces, before the browser wraps it in anything at all.
      if (node.textContent.trim()) out.push(node.textContent);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.nodeName.toLowerCase();
    if (tag === "br") continue;
    if (tag === "ul" || tag === "ol") continue; // read as a list instead
    // An empty paragraph is held open by a lone <br>, which fromElement
    // reads as a newline -- and the join adds another, so one blank line
    // typed came back as two. It is an empty line, not a line break.
    out.push(node.textContent.trim() ? fromElement(node) : "");
  }

  // Browsers leave empty wrappers behind while rewrapping what was
  // typed, and those are artefacts. A blank line *between* two lines is
  // not: somebody pressed Enter twice on purpose, and dropping it
  // rewrote what they wrote. So the ends are trimmed and the middle is
  // left alone.
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * Which line the caret is in, as a path of indices into `items`.
 *
 * Colour was a property of the whole placeholder, so selecting one
 * bullet and picking a colour recoloured every line in it. The grammar
 * has carried a per-item colour all along; nothing exposed it.
 *
 * Returns null when the selection is not inside a list item, which is
 * when the region as a whole is the right target.
 */
/**
 * Every line the selection touches, as paths into `items`.
 *
 * A caret in one line gives one path; a selection dragged over three
 * gives three. Without this, "make these numbered" could only mean the
 * whole placeholder.
 */
export function selectedItemPaths(box) {
  const selection = box.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  const paths = [];
  for (const li of box.querySelectorAll("li")) {
    if (!range.intersectsNode(li)) continue;
    // A parent li intersects because its child does; only take the
    // deepest, or a nested change would move its parent too.
    if (li.querySelector("li") && [...li.querySelectorAll("li")].some((n) => range.intersectsNode(n))) {
      continue;
    }
    const path = [];
    let node = li;
    while (node && node !== box) {
      if (node.nodeName === "LI") path.unshift([...node.parentNode.children].indexOf(node));
      node = node.parentNode;
    }
    if (path.length) paths.push(path);
  }
  return paths;
}

/**
 * Which top-level block the caret is in, counting from zero.
 *
 * A paragraph region holds its lines as one string, so there is no item
 * to attach a colour or a marker to. The index says which line the
 * caret is on, which is what turns "this placeholder" into "this line".
 */
/**
 * Paint every inline colour span from the theme.
 *
 * The slot travels in the markdown and through the DOM; only here is
 * there a theme to turn accent2 into a colour. Doing it at draw time
 * rather than at parse time is what lets a rebrand recolour a deck
 * without touching a word of it.
 */
export function paintTints(root, theme) {
  for (const tint of root.querySelectorAll("span.tint[data-colour]")) {
    const colour = themeColour(theme, tint.dataset.colour);
    if (colour) tint.style.color = colour;
  }
}

export function activeBlockIndex(box) {
  const selection = box.ownerDocument.getSelection?.();
  if (!selection || !selection.anchorNode) return null;
  let node = selection.anchorNode;
  if (!box.contains(node)) return null;
  while (node && node.parentNode !== box) node = node.parentNode;
  if (!node) return null;
  const blocks = [...box.childNodes].filter(
    (n) => n.nodeType === Node.ELEMENT_NODE && n.nodeName !== "BR"
  );
  const at = blocks.indexOf(node);
  return at >= 0 ? at : null;
}

export function activeItemPath(box) {
  const selection = box.ownerDocument.getSelection?.();
  if (!selection || !selection.anchorNode) return null;
  let node = selection.anchorNode;
  if (!box.contains(node)) return null;

  const path = [];
  while (node && node !== box) {
    if (node.nodeName === "LI") {
      const list = node.parentNode;
      path.unshift([...list.children].indexOf(node));
    }
    node = node.parentNode;
  }
  return path.length ? path : null;
}

function readList(list) {
  return [...list.children].map((li) => {
    const own = document.createElement("div");
    let nested = null;
    for (const node of li.childNodes) {
      const tag = node.nodeName.toLowerCase();
      if (tag === "ul" || tag === "ol") {
        nested = node;
        continue;
      }
      own.appendChild(node.cloneNode(true));
    }
    const text = fromElement(own);
    const original = itemOf.get(li);
    const children = nested ? readList(nested) : [];

    // Keep whatever the item carried besides its words.
    const extras =
      typeof original === "object" && original !== null
        ? Object.fromEntries(
            Object.entries(original).filter(([k]) => k !== "text" && k !== "items")
          )
        : {};

    if (!children.length && !Object.keys(extras).length) return text;
    return { ...extras, text, ...(children.length ? { items: children } : {}) };
  });
}

/** The <li> the caret is in, or null. */
function currentItem(list) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const li = node.closest?.("li");
  return li && list.contains(li) ? li : null;
}

/**
 * Tab nests the current item under the one above it; Shift+Tab lifts it
 * back out. This is how every outliner behaves, and typing a level of
 * hierarchy is far more common than needing a literal tab character.
 *
 * Returns true when something moved.
 */
function indent(list, outdent) {
  const li = currentItem(list);
  if (!li) return false;
  const parentList = li.parentElement;

  if (outdent) {
    const parentItem = parentList.closest("li");
    if (!parentItem) return false; // already at the top level
    // Everything after it comes with it, or the order would scramble.
    const following = [];
    for (let next = li.nextElementSibling; next; next = next.nextElementSibling) {
      following.push(next);
    }
    parentItem.after(li);
    for (const node of following.reverse()) li.after(node);
    if (!parentList.children.length) parentList.remove();
    place(li);
    return true;
  }

  const previous = li.previousElementSibling;
  if (!previous) return false; // nothing to nest under
  let sublist = [...previous.children].find((c) =>
    ["ul", "ol"].includes(c.tagName.toLowerCase())
  );
  if (!sublist) {
    sublist = document.createElement(parentList.tagName.toLowerCase());
    sublist.style.fontSize = parentList.style.fontSize;
    sublist.style.listStyle = parentList.style.listStyle;
    previous.appendChild(sublist);
  }
  sublist.appendChild(li);
  place(li);
  return true;
}

/** Put the caret back at the end of `li` after it has moved. */
function place(li) {
  const range = document.createRange();
  range.selectNodeContents(li);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A paragraph, sized from the layout's own style. */
function paragraph(text, sizePx) {
  const p = document.createElement("p");
  if (sizePx) p.style.fontSize = `${sizePx}px`;
  p.appendChild(toNodes(text));
  return p;
}

/**
 * Fill a region box and, when it holds text, make it editable.
 * `commit(value)` is called with the region's new value on every edit.
 */
function fillRegion(box, value, style, theme, scale, commit, editable, media0 = {}, onMedia, painted = null) {
  const size = style.sizePt ? style.sizePt * scale : null;
  // On the box as well as on each paragraph. The per-element size is what
  // the template says; this is what anything the *browser* creates
  // inherits -- press Enter and the new block carried no size at all, so
  // fresh text rendered at the page default and looked like a different
  // document.
  if (size) box.style.fontSize = `${size}px`;
  box.style.textAlign = ALIGN[style.align] ?? "left";
  if (style.bold) box.style.fontWeight = "700";
  const colour = legible(themeColour(theme, style.colorSlot) ?? style.color, painted, theme);
  if (colour) box.style.color = colour;

  const isString = typeof value === "string" || value == null;
  const type = isString ? "text" : value.type;
  const regionColour = !isString
    ? legible(themeColour(theme, value.color), painted, theme)
    : null;
  if (regionColour) box.style.color = regionColour;

  if (type === "text" || type === "p") {
    // A bare string was drawn as exactly one paragraph however many
    // lines it held, so typing a second line into a card and then
    // touching anything that redraws merged them back into one. Both
    // kinds split.
    const raw = String((type === "text" ? value : value.text) ?? "");
    const lines = raw.split(String.fromCharCode(10));
    for (const line of lines) box.appendChild(paragraph(line, size));

    if (editable) {
      box.contentEditable = "true";
      box.dataset.editable = "text";
      box.addEventListener("input", () => {
        const text = readBlocks(box).join(String.fromCharCode(10));
        // A bare string is shorthand for a single line. The moment there
        // are two it becomes a paragraph region, which is what the
        // grammar has for multi-line text and what survives being
        // written to YAML and read back.
        const multiline = text.includes(String.fromCharCode(10));
        commit(
          type === "text" ? (multiline ? { type: "p", text } : text) : { ...value, text }
        );
      });
    }
    return;
  }

  if (type === "ul" || type === "ol") {
    const list = buildList(value.items ?? [""], type, style, theme, scale, 0);
    box.appendChild(list);

    if (editable) {
      box.contentEditable = "true";
      box.dataset.editable = "list";
      // The live list, not the one drawn: the browser can replace it
      // outright when the last item is deleted and retyped, and reading
      // the detached original returned nothing.
      const items = () => {
        const live = box.querySelector("ul, ol") ?? list;
        // Anything the browser put outside the list is still the
        // author's text, so it joins the end rather than vanishing.
        return [...readList(live), ...readBlocks(box)];
      };
      box.addEventListener("input", () => commit({ ...value, items: items() }));
      box.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        if (indent(box.querySelector("ul, ol") ?? list, event.shiftKey)) {
          commit({ ...value, items: items() });
        }
      });
    }
    return;
  }

  // Media, shown rather than named. A picture is the one thing on a slide
  // whose effect cannot be judged from its file path, so a preview that
  // prints "▨ media/x.jpg" is not a preview of anything.
  const media = document.createElement("div");
  media.className = "media";

  const source =
    type === "video"
      ? media0.thumb?.(value.url) ?? null
      : media0.resolve?.(value.src) ?? null;

  if (source) {
    const img = document.createElement("img");
    img.src = source;
    img.alt = "";
    img.loading = "lazy";
    // The template decides the shape of the hole; `fit` decides how the
    // picture meets it, and the preview has to agree with the deck or it
    // is showing a crop that will not happen.
    img.className = "media-image";
    const fit = value.fit || "cover";
    if (fit === "width") {
      img.style.width = "100%";
      img.style.height = "auto";
    } else if (fit === "height") {
      img.style.height = "100%";
      img.style.width = "auto";
    } else {
      img.style.objectFit = fit === "contain" ? "contain" : "cover";
    }
    media.appendChild(img);
    // A poster that cannot load says so rather than leaving a gap: a
    // broken path is exactly what an author needs to see.
    img.addEventListener("error", () => {
      img.remove();
      media.classList.add("broken");
      media.textContent =
        type === "video" ? `▶ ${value.url}` : `▨ ${value.src} — not found`;
    });
  } else {
    media.textContent =
      type === "video"
        ? `▶ ${value.url ? media0.host?.(value.url) ?? "video" : "hosted video"}`
        : type === "mermaid"
          ? `◈ ${value.src || "diagram"}`
          : `▨ ${value.src || "picture"}`;
  }

  if (type === "video" && source) {
    // Marked as video, because a still of a video and a picture are not
    // the same thing to whoever is looking at the slide.
    const badge = document.createElement("span");
    badge.className = "media-play";
    badge.textContent = "▶";
    media.appendChild(badge);
  }

  box.appendChild(media);
  if (editable) {
    box.dataset.editable = "media";
    media.title = "Click to choose a picture or a video";
    media.addEventListener("click", () => onMedia?.(value, type));
  }
}

/**
 * Draw a slide.
 *
 * `editable` makes every text region an editing surface; `compact` is the
 * thumbnail mode — no empty-region outlines, no fit measuring, since at
 * 150px an outline reads as content and measuring every slide on every
 * keystroke is what makes an editor stutter.
 */
export function drawSlide(
  host,
  {
    geometry, layoutKey, slide, activeRegion,
    editable = false, compact = false, maxHeightPx = null,
    // Regions filled from the library rather than typed. Shown, because
    // the deck will show them; not editable, because typing here would
    // silently make a second copy of something the library already holds.
    derived = [],
    // How to turn a slide's `src` or `url` into something a browser can
    // load, and what to do when a placeholder is clicked.
    media = {},
    // The funder stamp the renderer burns into every slide. Shown here
    // because it is on every slide -- an author who cannot see it will
    // put a picture under it.
    attribution = null,
    onChange, onSelectRegion, onMedia,
  }
) {
  host.innerHTML = "";
  const layout = geometry?.layouts?.[layoutKey];
  const theme = geometry?.theme ?? {};

  if (!layoutKey) {
    // No layout to look up, which is not the geometry's fault. Blaming
    // it sent an author to read a template that had nothing to do with
    // the problem.
    host.innerHTML = "";
    const note = document.createElement("p");
    note.className = "empty";
    note.textContent =
      "This slide has no layout, so there is nothing to draw it into. " +
      "Choose one from the toolbar.";
    host.appendChild(note);
    return new Set(Object.keys(slide || {}));
  }

  if (!layout) {
    // The caller offers to build it. Telling somebody to install a
    // command-line tool is a dead end in a workbench whose whole claim
    // is that nothing needs installing -- and the renderer that reads a
    // template is already running here.
    host.innerHTML = "";
    const note = document.createElement("p");
    note.className = "empty";
    note.dataset.missingGeometry = layoutKey ?? "";
    // Say what the geometry does hold. "Nothing for Cards" is true and
    // useless: it does not distinguish a template that was never read
    // from one read on a different branch, or from a geometry file that
    // loaded as nothing at all -- and those want different answers. The
    // list is the diagnosis, so the first report of a problem carries it.
    const known = Object.keys(geometry?.layouts ?? {});
    note.dataset.knownLayouts = known.join(",");
    note.textContent =
      `This library's layout-geometry.json has nothing for ${layoutKey}. ` +
      (known.length
        ? `It has ${known.join(", ")}. If ${layoutKey} should be there, the ` +
          "template on this branch is not the one it was read from."
        : "It has no layouts at all, so either the file did not load or it " +
          "is not on this branch. This is not a problem with the slide.");
    host.appendChild(note);
    return new Set(Object.keys(slide || {}));
  }

  /** Show which region the ribbon will act on. */
  const select = (box) => {
    for (const other of stage.querySelectorAll(".region.active")) {
      other.classList.remove("active");
    }
    box.classList.add("active");
  };

  const stage = document.createElement("div");
  stage.className = "stage" + (editable ? " editable" : "");
  stage.style.aspectRatio = String(geometry.slide?.aspect || 1.7778);
  stage.style.background = theme.bg1 || "#fff";
  stage.style.color = theme.tx1 || "#000";

  const aspect = geometry.slide?.aspect || 1.7778;
  // Fit the room available. A slide sized only by width fills the pane
  // and pushes the notes below the fold, which is where they get
  // forgotten — and they are the longest thing an author writes.
  const available = host.clientWidth || (compact ? 150 : 640);
  const stageWidth = maxHeightPx
    ? Math.min(available, Math.round(maxHeightPx * aspect))
    : available;
  stage.style.width = `${stageWidth}px`;
  const scale = stageWidth / (geometry.slide?.widthPt || 720);

  const unplaced = new Set();
  const drawn = new Set();
  const boxes = [];

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
    const paint = fillColour(theme, rect.fill);
    if (paint) box.style.background = paint;
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    box.dataset.region = region;
    // PowerPoint insets text inside a placeholder — a tenth of an inch by
    // default, which is most of the gutter between two columns. Without
    // it, side-by-side regions look like they collide.
    const inset = rect.inset;
    if (inset) {
      box.style.padding =
        `${inset.t * stageWidth / aspect}px ${inset.r * stageWidth}px ` +
        `${inset.b * stageWidth / aspect}px ${inset.l * stageWidth}px`;
    }

    const fromLibrary = derived.includes(region);
    if (fromLibrary) {
      box.classList.add("derived");
      box.title =
        "Filled from the library — edit the session title or its outcomes " +
        "rather than typing them here.";
    }

    fillRegion(
      box,
      value,
      rect.style ?? {},
      theme,
      scale,
      (next) => onChange?.(region, next),
      editable && !fromLibrary,
      media,
      (value_, kind) => onMedia?.(region, value_, kind),
      // What was actually painted behind it, so the text colour can be
      // judged against the thing it will sit on.
      paint
    );
    paintTints(box, theme);

    if (editable && !fromLibrary) {
      box.setAttribute("aria-label", `${region}: ${plainText(
        typeof value === "string" ? value : value?.text ?? ""
      ).slice(0, 60)}`);
      box.addEventListener("focusin", () => {
        // Move the selection now, not at the next redraw. The outline is
        // the only thing telling an author which region the ribbon will
        // act on, and one that never moves says nothing at all.
        select(box);
        onSelectRegion?.(region);
      });
      // A media region is not contenteditable, so it never takes focus.
      // It still has to be selectable, or a picture cannot be replaced
      // from the ribbon.
      box.addEventListener("mousedown", () => {
        select(box);
        onSelectRegion?.(region);
      });
    }
    stage.appendChild(box);
    boxes.push(box);
  }

  // Empty regions the layout offers. In edit mode they are clickable, so
  // adding content is a click on the slide rather than a hunt in a form.
  for (const [region, rect] of Object.entries(layout.regions)) {
    if (drawn.has(region) || compact) continue;
    const box = document.createElement("div");
    box.className = "region vacant";
    const paint = fillColour(theme, rect.fill);
    if (paint) box.style.background = paint;
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    // What this placeholder is for, from the template itself. A picture
    // placeholder that offers to add text is the reason there was no way
    // to put an image on a slide that did not already have one.
    const holds = rect.type === "picture" ? "picture" : rect.type === "object" ? "either" : "text";

    const name = document.createElement("span");
    name.className = "region-name";
    name.textContent = editable
      ? holds === "picture" ? "+ picture or video" : `+ ${region}`
      : region;
    box.appendChild(name);

    if (editable) {
      if (holds === "picture") {
        box.title = `Add a picture or a video to ${region}`;
        box.addEventListener("click", () => onMedia?.(region, {}, "image"));
      } else {
        box.title = `Add ${region}`;
        box.addEventListener("click", () => onChange?.(region, ""));
      }

      // A content placeholder takes either, and text is the common case
      // -- so text is the click and the picture is offered beside it.
      if (holds === "either") {
        const media = document.createElement("button");
        media.type = "button";
        media.className = "vacant-media";
        media.textContent = "▨";
        media.title = `Put a picture or a video in ${region} instead`;
        media.setAttribute("aria-label", `Add a picture to ${region}`);
        media.addEventListener("click", (event) => {
          event.stopPropagation(); // or the text handler fires as well
          onMedia?.(region, {}, "image");
        });
        box.appendChild(media);
      }
    }
    stage.appendChild(box);
  }

  // The attribution stamp, drawn over the regions exactly as the
  // renderer layers it: locked shapes on top of the content.
  if (attribution?.text) {
    const stamp = document.createElement("div");
    stamp.className = "attr-stamp " + (attribution.corner === "bottom-left" ? "left" : "right");
    stamp.style.opacity = String(attribution.opacity ?? 1);
    if (attribution.logoUrl) {
      const img = document.createElement("img");
      img.src = attribution.logoUrl;
      img.alt = "";
      img.style.opacity = String(attribution.logo_opacity ?? 1);
      // Sized in centimetres against the slide's real width, so the
      // height shown here is the height the deck will use. The EU
      // emblem has a 1 cm minimum and that has to be checkable on
      // screen, not only after a render.
      const cm = attribution.logo_height_cm;
      const slideCm = ((geometry.slide?.widthEmu ?? 9144000) / 914400) * 2.54;
      if (cm) img.style.height = `${(cm / slideCm) * stageWidth}px`;
      stamp.appendChild(img);
    }
    const words = document.createElement("span");
    words.textContent = attribution.text;
    words.style.fontSize = `${9 * (attribution.scale ?? 1) * scale}px`;
    stamp.appendChild(words);
    stage.appendChild(stamp);
  }

  host.appendChild(stage);

  if (!compact) {
    for (const box of boxes) {
      const applied = shrinkToFit(box);
      box.classList.toggle("overfull", applied < 0.8);
      if (applied < 0.8) {
        box.title = `Too long for the ${box.dataset.region} placeholder — PowerPoint will shrink it to about ${Math.round(applied * 100)}%.`;
      }
    }
  }
  return unplaced;
}
