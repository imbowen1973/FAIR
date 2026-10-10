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

// Behind the "more" split button.
const MORE_MARKS = {
  strike: COMMANDS.strike,
  superscript: COMMANDS.superscript,
  subscript: COMMANDS.subscript,
  code: ["‹›", "Inline code", null],
};

const LIST_CHOICES = [
  { key: "box:ul", scope: "box", value: "ul", glyph: "•", name: "Bullets", title: "Bulleted list — the whole box" },
  { key: "box:ol", scope: "box", value: "ol", glyph: "1.", name: "Numbers", title: "Numbered list — the whole box" },
  { key: "box:none", scope: "box", value: null, glyph: "¶", name: "Plain lines", title: "No list: plain lines — the whole box" },
  { key: "lines:bullet", scope: "lines", value: "bullet", glyph: "•", name: "Bullet", title: "Bullet — the selected lines only" },
  { key: "lines:number", scope: "lines", value: "number", glyph: "1.", name: "Number", title: "Number — the selected lines only" },
  { key: "lines:none", scope: "lines", value: "none", glyph: "¶", name: "No marker", title: "No marker — the selected lines only" },
];

// What each split button's face repeats. Module state, not ribbon
// state: the ribbon is rebuilt on every slide change, and the last
// choice should outlive that.
let lastMark = "superscript";
let lastList = "box:ul";
let lastColour = "accent1";

function runList(key, onListType, onLineMarker) {
  const choice = LIST_CHOICES.find((c) => c.key === key);
  if (!choice) return;
  if (choice.scope === "box") onListType?.(choice.value);
  else onLineMarker?.(choice.value);
}

function applyMark(mark, onCommand) {
  if (mark === "code") {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;
    const code = document.createElement("code");
    try {
      selection.getRangeAt(0).surroundContents(code);
      onCommand?.();
    } catch {
      /* selection crosses element boundaries: leave it alone */
    }
    return;
  }
  document.execCommand(COMMANDS[mark][2]);
  onCommand?.();
  paintMarks();
}

function menuItemLabel(glyph, name) {
  const span = document.createElement("span");
  span.className = "menu-item-label";
  span.append(el("span", "menu-glyph", glyph), el("span", "menu-name", name));
  return span;
}

function colourFace(slot) {
  const span = document.createElement("span");
  span.className = "colour-face";
  const bar = el("span", "colour-bar");
  if (slot) bar.dataset.slot = slot;
  else bar.classList.add("none");
  span.append(el("span", "colour-letter", "A"), bar);
  return span;
}

/**
 * A split button: the face does the last thing chosen, the arrow opens
 * the rest. Both act on mousedown and prevent default, like every other
 * ribbon control, so opening the menu never moves the caret out of the
 * slide -- the selection a menu item acts on is still there.
 */
function splitButton({ name, menuLabel, face, onFace, build }) {
  const wrap = el("div", "split");
  wrap.dataset.split = name;
  const current = face();
  const faceButton = button(current.label, current.title, () => onFace?.(), "mark split-face");
  if (current.mark) faceButton.dataset.mark = current.mark;
  if (current.scope) faceButton.dataset.scope = current.scope;
  const arrow = button(icon("chevron", { size: 12 }), menuLabel, () => toggle(), "mark split-arrow");
  arrow.dataset.for = name;
  arrow.setAttribute("aria-haspopup", "menu");
  arrow.setAttribute("aria-expanded", "false");
  const menu = el("div", "split-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", menuLabel);
  menu.hidden = true;

  function close() {
    menu.hidden = true;
    arrow.setAttribute("aria-expanded", "false");
  }
  function toggle() {
    const opening = menu.hidden;
    closeMenus();
    if (opening) {
      menu.hidden = false;
      arrow.setAttribute("aria-expanded", "true");
      keepOnScreen(menu);
    }
  }
  build(menu, () => {
    close();
    // The face now repeats this choice.
    const next = face();
    faceButton.replaceChildren(
      next.label instanceof Node ? next.label : document.createTextNode(next.label)
    );
    faceButton.title = next.title;
    faceButton.setAttribute("aria-label", next.title);
    if (next.mark) faceButton.dataset.mark = next.mark;
    if (next.scope) faceButton.dataset.scope = next.scope;
    paintFaces();
    paintMarks();
  });
  wrap.append(faceButton, arrow, menu);
  return wrap;
}

/**
 * A menu opens below its button, and is nudged sideways if that would
 * put it off the screen -- on a phone the colour menu sits at the left
 * edge and the marks menu near the right, so no one fixed side works.
 */
function keepOnScreen(menu) {
  menu.style.left = "0px";
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const width = document.documentElement.clientWidth || window.innerWidth;
  let shift = 0;
  if (rect.right > width - margin) shift = width - margin - rect.right;
  if (rect.left + shift < margin) shift = margin - rect.left;
  menu.style.left = `${shift}px`;
}

function closeMenus() {
  for (const menu of document.querySelectorAll(".split-menu")) menu.hidden = true;
  for (const arrow of document.querySelectorAll(".split-arrow")) {
    arrow.setAttribute("aria-expanded", "false");
  }
}

// Menus close on a press anywhere else, and on Escape. Registered once
// for the page: the ribbon is rebuilt often and would otherwise stack
// listeners.
let listening = false;
function listenOnce() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest?.(".split")) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
  });
  // Which marks the selection already carries, shown on the buttons.
  document.addEventListener("selectionchange", () => paintMarks());
}

let lastTheme = null;
function paintFaces() {
  for (const bar of document.querySelectorAll(".ribbon .colour-bar[data-slot]")) {
    const colour = lastTheme?.[bar.dataset.slot];
    if (colour) bar.style.background = colour;
  }
}

/** Light up the marks the current selection already has. */
export function paintMarks() {
  if (typeof document === "undefined") return;
  const inSlide = document.activeElement?.closest?.(".canvas, .rt");
  for (const b of document.querySelectorAll(".ribbon [data-mark]")) {
    const command = COMMANDS[b.dataset.mark]?.[2];
    let on = false;
    try {
      on = Boolean(inSlide && command && document.queryCommandState(command));
    } catch {
      on = false;
    }
    b.classList.toggle("on", on);
  }
}

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
  listenOnce();

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
    button(icon("slide", { size: 16 }), "Add a slide after this one (Ctrl+M)",
      () => onAddSlide?.(), "mark with-icon", "add-slide-ribbon")
  );
  deck.appendChild(
    button(icon("import", { size: 16 }), "Import slides written elsewhere",
      () => onImport?.(), "mark with-icon", "import-ribbon")
  );
  host.appendChild(deck);

  // Bold, italic and underline in front; the marks used less often --
  // strikethrough, super- and subscript, code -- behind one split button
  // whose face repeats the last of them, as Office does.
  const marks = document.createElement("div");
  marks.className = "ribbon-group";
  marks.appendChild(el("span", "ribbon-label", "Text"));
  for (const mark of ["bold", "italic", "underline"]) {
    const [label, title, command] = COMMANDS[mark];
    const b = button(label, title, () => applyMark(mark, onCommand), "mark");
    b.dataset.mark = mark;
    marks.appendChild(b);
  }
  const moreMarks = splitButton({
    name: "marks",
    menuLabel: "More text marks",
    face: () => {
      const [label, title] = MORE_MARKS[lastMark];
      return { label, title: `${title} (the last one used — the arrow has the rest)`, mark: lastMark };
    },
    onFace: () => applyMark(lastMark, onCommand),
    build: (menu, close) => {
      for (const [mark, [label, title]] of Object.entries(MORE_MARKS)) {
        const item = button(
          menuItemLabel(label, title), title,
          () => {
            lastMark = mark;
            applyMark(mark, onCommand);
            close();
          },
          "mark menu-item"
        );
        item.dataset.mark = mark;
        menu.appendChild(item);
      }
    },
  });
  marks.appendChild(moreMarks);
  host.appendChild(marks);

  // Lists: one split button. Its face repeats the last choice; its menu
  // holds both scopes, each under a heading that says what it acts on.
  //
  // Both scopes stay, because they do different things the grammar
  // needs: a region either is a list or is plain lines (there is no
  // half-list), and within one, a line can opt out of its marker. One
  // control guessing between them was tried, and "no list" then marked
  // a single line instead of returning the box to plain text -- with no
  // way left to do the latter. Two labelled sections in one menu keep
  // both, without two identical rows of glyphs on the ribbon.
  const lists = document.createElement("div");
  lists.className = "ribbon-group";
  lists.appendChild(
    splitButton({
      name: "list",
      menuLabel: "List style",
      face: () => {
        const choice = LIST_CHOICES.find((c) => c.key === lastList) ?? LIST_CHOICES[0];
        return {
          label: choice.glyph,
          title: `${choice.title} (the last one used — the arrow has the rest)`,
          scope: choice.scope === "box" ? "box" : "lines",
        };
      },
      onFace: () => runList(lastList, onListType, onLineMarker),
      build: (menu, close) => {
        for (const scope of ["box", "lines"]) {
          menu.appendChild(
            el("span", "ribbon-label menu-heading", scope === "box" ? "whole box" : "selected lines")
          );
          for (const choice of LIST_CHOICES.filter((c) => c.scope === scope)) {
            const item = button(
              menuItemLabel(choice.glyph, choice.name), choice.title,
              () => {
                lastList = choice.key;
                runList(choice.key, onListType, onLineMarker);
                close();
              },
              scope === "box" ? "mark list menu-item" : "mark line-marker menu-item"
            );
            if (scope === "box") item.dataset.list = choice.value ?? "none";
            else item.dataset.marker = choice.value;
            menu.appendChild(item);
          }
        }
      },
    })
  );
  host.appendChild(lists);

  // Media acts on the selected region, like colour and list type do.
  // Without this a picture could only go where a placeholder happened to
  // be empty -- a region with a paragraph in it could never become one.
  const mediaGroup = document.createElement("div");
  mediaGroup.className = "ribbon-group";
  // Icon AND word: the glyph alone was not read as "insert a picture".
  const pictureLabel = document.createElement("span");
  pictureLabel.append(icon("media", { size: 16 }), el("span", "mark-text", "Picture"));
  mediaGroup.appendChild(
    button(
      pictureLabel,
      "Insert a picture or a video into the selected region",
      () => onMedia?.(),
      "mark with-icon with-text",
      "insert-media"
    )
  );
  host.appendChild(mediaGroup);

  // Colour: the face applies the last theme colour, the arrow opens the
  // template's six and "none". Theme slots only -- the palette is the
  // template's, which is why there is no colour picker.
  const colours = document.createElement("div");
  colours.className = "ribbon-group";
  colours.appendChild(
    splitButton({
      name: "colour",
      menuLabel: "Theme colour",
      face: () => ({
        label: colourFace(lastColour),
        title: lastColour
          ? `Colour: ${lastColour} (the last one used — the arrow has the rest)`
          : "No colour (the arrow has the theme's colours)",
      }),
      onFace: () => onColour?.(lastColour),
      build: (menu, close) => {
        const row = el("div", "swatch-row");
        for (const slot of THEME_SLOTS) {
          const swatch = button("", slot, () => {
            lastColour = slot;
            onColour?.(slot);
            close();
          }, "swatch");
          swatch.dataset.slot = slot;
          row.appendChild(swatch);
        }
        row.appendChild(
          button("⌀", "No colour", () => {
            lastColour = null;
            onColour?.(null);
            close();
          }, "swatch none")
        );
        menu.appendChild(row);
      },
    })
  );
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
  lastTheme = theme ?? lastTheme;
  for (const swatch of host.querySelectorAll(".swatch[data-slot]")) {
    const colour = theme?.[swatch.dataset.slot];
    if (colour) swatch.style.background = colour;
  }
  paintFaces();
}

/** Show which list type the region under the caret is. */
export function paintListType(host, type) {
  const want = type === "ul" || type === "ol" ? type : "none";
  for (const b of host.querySelectorAll(".mark.list")) {
    b.classList.toggle("on", b.dataset.list === want);
  }
  // On the split button's arrow too, so the state shows with the menu shut.
  const arrow = host.querySelector('.split-arrow[data-for="list"]');
  if (arrow) arrow.dataset.state = want;
}