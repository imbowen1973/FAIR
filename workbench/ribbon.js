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

const COMMANDS = {
  bold: ["B", "Bold", "bold"],
  italic: ["I", "Italic", "italic"],
  underline: ["U", "Underline", "underline"],
  strike: ["S", "Strikethrough", "strikeThrough"],
  superscript: ["x²", "Superscript", "superscript"],
  subscript: ["x₂", "Subscript", "subscript"],
};

const THEME_SLOTS = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];

function button(label, title, onDown, className = "mark") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
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
 * onListType(kind) when the region becomes a "ul", an "ol", or null for none.
 */
export function ribbon(host, { layouts, layout, onCommand, onLayout, onColour, onListType }) {
  host.innerHTML = "";

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
  for (const [kind, label, title] of LISTS) {
    const b = button(label, title, () => onListType?.(kind), "mark list");
    b.dataset.list = kind ?? "none";
    lists.appendChild(b);
  }
  host.appendChild(lists);

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
