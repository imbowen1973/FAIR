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
  if (!style.bulleted) list.style.listStyle = "none";

  for (const item of items) {
    const li = document.createElement("li");
    const text = typeof item === "string" ? item : item.text ?? "";
    li.appendChild(toNodes(text));
    itemOf.set(li, item);

    const colour = themeColour(theme, typeof item === "object" ? item.color : null);
    if (colour) li.style.color = colour;

    const children = typeof item === "object" ? item.items ?? [] : [];
    if (children.length) {
      li.appendChild(buildList(children, type, style, theme, scale, depth + 1));
    }
    list.appendChild(li);
  }
  return list;
}

/** Read a list back, nesting and all. */
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
function fillRegion(box, value, style, theme, scale, commit, editable, media0 = {}, onMedia) {
  const size = style.sizePt ? style.sizePt * scale : null;
  box.style.textAlign = ALIGN[style.align] ?? "left";
  if (style.bold) box.style.fontWeight = "700";
  const colour = themeColour(theme, style.colorSlot) ?? style.color;
  if (colour) box.style.color = colour;

  const isString = typeof value === "string" || value == null;
  const type = isString ? "text" : value.type;
  const regionColour = !isString ? themeColour(theme, value.color) : null;
  if (regionColour) box.style.color = regionColour;

  if (type === "text" || type === "p") {
    const lines = type === "text"
      ? [String(value ?? "")]
      : String(value.text ?? "").split("\n");
    for (const line of lines) box.appendChild(paragraph(line, size));

    if (editable) {
      box.contentEditable = "true";
      box.dataset.editable = "text";
      box.addEventListener("input", () => {
        const text = [...box.querySelectorAll("p")]
          .map((p) => fromElement(p))
          .join("\n");
        commit(type === "text" ? text : { ...value, text });
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
      box.addEventListener("input", () => commit({ ...value, items: readList(list) }));
      box.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        if (indent(list, event.shiftKey)) {
          commit({ ...value, items: readList(list) });
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
    // The template decides the shape of the hole; the picture fills it
    // the way PowerPoint fills a picture placeholder.
    img.className = "media-image";
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

  if (!layout) {
    host.innerHTML =
      '<p class="empty">No geometry for this layout. Run ' +
      "<code>edufair-template &lt;template&gt; --geometry layout-geometry.json</code> " +
      "in the library and commit the result.</p>";
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
      (value_, kind) => onMedia?.(region, value_, kind)
    );

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
