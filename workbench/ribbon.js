// The formatting ribbon.
//
// Six marks and a layout picker. Nothing else, and the omissions are the
// design: no font, no size, no colour picker beyond the theme's own
// slots, no alignment. Those are the template's, and a ribbon that
// offered them would be inviting authors to override the one thing the
// whole pipeline exists to protect.
//
// It acts on whatever is selected in the editable slide, so it is a
// property of the canvas rather than of any one field.

import { icon } from "./icons.js";

const COMMANDS = {
  bold: ["B", "Bold", "bold"],
  italic: ["I", "Italic", "italic"],
  underline: ["U", "Underline", "underline"],
  strike: ["S", "Strikethrough", "strikeThrough"],
  superscript: ["x²", "Superscript", "superscript"],
  subscript: ["x₂", "Subscript", "subscript"],
};

const THEME_SLOTS = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, title, onDown, className = "mark", id = null) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  if (id) b.id = id;
  // A string label is text; a node is an icon, and the title carries the
  // meaning either way.
  if (label instanceof Node) b.appendChild(label);
  else b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  // mousedown, not click: click moves focus out of the slide first and
  // the selection the command applies to is already gone.
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    onDown();
  });
  return b;
}

/**
 * Build the ribbon into `host`.
 *
 * onCommand()   after any formatting change, so the canvas can re-read
 *               its own DOM and commit.
 * onLayout(key) when the layout is changed.
 * onColour(slot) when a theme colour is chosen for the selection's region.
 * onMedia()      a picture or video is wanted in the selected region.
 * onListType(kind) when the region becomes a "ul", an "ol", or null for none.
 * onUndo() / onRedo()  step the block's history.
 * onAddSlide() / onImport()  add a slide, or bring some in.
 */
export function ribbon(host, {
  layouts, layout, onCommand, onLayout, onColour, onListType, onMedia,
  onUndo, onRedo, onAddSlide, onImport, onSave, onSubmit, onHistory,
  onLineMarker, slides = true, steps = slides,
}) {
  host.innerHTML = "";

  // Save is the first thing in the toolbar, before undo and redo, with
  // History beside it. Both are instant actions on the work as a whole
  // rather than on a slide, and both used to be text buttons in the bar
  // below -- which is not where a hand goes for them.
  //
  // These carry the ids `save`, `history` and `submit` because they *are*
  // those controls now, not copies of them: everything that enables,
  // disables or presses them goes on working unchanged.
  const commit = document.createElement("div");
  commit.className = "ribbon-group";
  commit.appendChild(
    button(icon("save2", { size: 16 }), "Save to the draft branch",
      () => onSave?.(), "mark with-icon", "save")
  );
  commit.appendChild(
    button(icon("history", { size: 16 }), "History: load an earlier version",
      () => onHistory?.(), "mark with-icon", "history")
  );
  commit.appendChild(
    button(icon("submit", { size: 16 }), "Submit for review",
      () => onSubmit?.(), "mark with-icon", "submit")
  );
  host.appendChild(commit);

  // Stepping back and forward through the work. Asked for separately
  // from `slides`, because one flag was doing two jobs: a document tab
  // wants neither, but the running order wants undo very much -- moving
  // twenty sessions and mis-clicking is exactly what it is for.
  if (steps) {
    const back = document.createElement("div");
    back.className = "ribbon-group";
    back.appendChild(
      button(icon("undo", { size: 16 }), "Undo", () => onUndo?.(), "mark with-icon", "undo")
    );
    back.appendChild(
      button(icon("redo", { size: 16 }), "Redo", () => onRedo?.(), "mark with-icon", "redo")
    );
    host.appendChild(back);
  }

  if (!slides) {
    // A document tab, or the running order: nothing below applies.
    return;
  }

  // Adding a slide and bringing one in are the two things an author does
  // between slides rather than within one, so they sit here rather than
  // in the rail -- which on a narrow screen is a drawer that has to be
  // opened first.
  const deck = document.createElement("div");
  deck.className = "ribbon-group";
  deck.appendChild(
    button(icon("slide", { size: 16 }), "Add a slide after this one",
      () => onAddSlide?.(), "mark with-icon", "add-slide-ribbon")
  );
  deck.appendChild(
    button(icon("import", { size: 16 }), "Import slides written elsewhere",
      () => onImport?.(), "mark with-icon", "import-ribbon")
  );
  host.appendChild(deck);

  const marks = document.createElement("div");
  marks.className = "ribbon-group";
  for (const [mark, [label, title, command]] of Object.entries(COMMANDS)) {
    marks.appendChild(
      button(label, title, () => {
        document.execCommand(command);
        onCommand?.();
      })
    );
  }

  marks.appendChild(
    button("‹›", "Inline code", () => {
      const selection = window.getSelection();
      if (!selection.rangeCount || selection.isCollapsed) return;
      const code = document.createElement("code");
      try {
        selection.getRangeAt(0).surroundContents(code);
        onCommand?.();
      } catch {
        /* selection crosses element boundaries: leave it alone */
      }
    })
  );
  host.appendChild(marks);

  // Whether a region is a list is a property of the region, not of a
  // selection inside it: the grammar has no half-list. So these set the
  // whole region, and "none" is a real choice rather than the absence of
  // one -- plenty of slides want plain lines with no markers at all.
  const lists = document.createElement("div");
  lists.className = "ribbon-group";
  const LISTS = [
    ["ul", "•", "Bulleted list"],
    ["ol", "1.", "Numbered list"],
    [null, "¶", "No list: plain lines"],
  ];
  lists.appendChild(el("span", "ribbon-label", "list"));
  for (const [kind, label, title] of LISTS) {
    const b = button(label, `${title} — the whole placeholder`,
      () => onListType?.(kind), "mark list");
    b.dataset.list = kind ?? "none";
    lists.appendChild(b);
  }
  host.appendChild(lists);

  // The same three, for the lines the selection touches. One control
  // doing both was ambiguous and broke the other: choosing "no list"
  // marked a single line instead of turning the placeholder back into
  // plain text, and there was then no way to do the latter at all.
  const lines = document.createElement("div");
  lines.className = "ribbon-group";
  lines.appendChild(el("span", "ribbon-label", "line"));
  for (const [kind, label, title] of LISTS) {
    const marker = kind === "ul" ? "bullet" : kind === "ol" ? "number" : "none";
    const b = button(label, `${title} — the selected lines only`,
      () => onLineMarker?.(marker), "mark line-marker");
    b.dataset.marker = marker;
    lines.appendChild(b);
  }
  host.appendChild(lines);

  // Media acts on the selected region, like colour and list type do.
  // Without this a picture could only go where a placeholder happened to
  // be empty -- a region with a paragraph in it could never become one.
  const mediaGroup = document.createElement("div");
  mediaGroup.className = "ribbon-group";
  mediaGroup.appendChild(
    button(
      icon("media", { size: 16 }),
      "Put a picture or a video in the selected region",
      () => onMedia?.(),
      "mark with-icon"
    )
  );
  host.appendChild(mediaGroup);

  const colours = document.createElement("div");
  colours.className = "ribbon-group";
  const swatchLabel = document.createElement("span");
  swatchLabel.className = "ribbon-label";
  swatchLabel.textContent = "Colour";
  colours.appendChild(swatchLabel);
  for (const slot of THEME_SLOTS) {
    const swatch = button("", slot, () => onColour?.(slot), "swatch");
    swatch.dataset.slot = slot;
    colours.appendChild(swatch);
  }
  colours.appendChild(button("⌀", "No colour", () => onColour?.(null), "swatch none"));
  host.appendChild(colours);

  const right = document.createElement("div");
  right.className = "ribbon-group right";
  const label = document.createElement("label");
  label.className = "ribbon-label";
  label.textContent = "Layout";
  label.htmlFor = "ribbon-layout";
  const select = document.createElement("select");
  select.id = "ribbon-layout";
  select.className = "layout";
  for (const key of layouts) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    select.appendChild(option);
  }
  select.value = layout ?? "";
  select.addEventListener("change", () => onLayout?.(select.value));
  right.append(label, select);
  host.appendChild(right);
}

/** Paint the swatches from the library's own theme. */
export function paintSwatches(host, theme) {
  for (const swatch of host.querySelectorAll(".swatch[data-slot]")) {
    const colour = theme?.[swatch.dataset.slot];
    if (colour) swatch.style.background = colour;
  }
}

/** Show which list type the region under the caret is. */
export function paintListType(host, type) {
  const want = type === "ul" || type === "ol" ? type : "none";
  for (const b of host.querySelectorAll(".mark.list")) {
    b.classList.toggle("on", b.dataset.list === want);
  }
}