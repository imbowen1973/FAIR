// A document, edited as markdown.
//
// Deliberately a source editor, not a WYSIWYG one, and the reason is the
// same reason the slide canvas *is* WYSIWYG: the template fixes how a
// slide looks, so showing it is honest. A workbook has no template. A
// WYSIWYG view would be inventing an appearance the artifact does not
// have, and an author would tune a layout that nothing downstream
// honours. So: the markdown on the left, what it means on the right.
//
// The toolbar inserts markdown rather than hiding it. An author who
// never touches it still gets a file they can read.

import { markdownToHtml } from "./markdown.js";
import { icon } from "./icons.js";

/**
 * What each button does to the selection.
 * `wrap` surrounds it; `line` prefixes every selected line.
 */
const TOOLS = [
  { label: "H1", title: "Heading 1", line: "# " },
  { label: "H2", title: "Heading 2", line: "## " },
  { label: "H3", title: "Heading 3", line: "### " },
  { label: "B", title: "Bold", wrap: "**", className: "bold" },
  { label: "I", title: "Italic", wrap: "*", className: "italic" },
  { label: "x²", title: "Superscript", wrap: "^" },
  { label: "x₂", title: "Subscript", wrap: "~" },
  { label: "S", title: "Strikethrough", wrap: "~~" },
  { label: "‹›", title: "Inline code", wrap: "`" },
  { label: "•", title: "Bulleted list", line: "- " },
  { label: "1.", title: "Numbered list", line: "1. " },
  { label: "❝", title: "Quote", line: "> " },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Replace the selection, keeping undo history and the caret sensible. */
function replace(area, text, selectFrom = null, selectTo = null) {
  const { selectionStart: start, selectionEnd: end } = area;
  // execCommand("insertText") is deprecated but is the only way to edit a
  // textarea without throwing away the browser's undo stack. Falling back
  // to setRangeText costs undo, which is worse than the deprecation.
  area.focus();
  if (!document.execCommand?.("insertText", false, text)) {
    area.setRangeText(text, start, end, "end");
  }
  if (selectFrom !== null) {
    area.selectionStart = start + selectFrom;
    area.selectionEnd = start + (selectTo ?? selectFrom);
  }
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyWrap(area, marker) {
  const { selectionStart: start, selectionEnd: end } = area;
  const selected = area.value.slice(start, end);
  if (!selected) {
    // Nothing selected: drop the markers in and put the caret between.
    replace(area, marker + marker, marker.length);
    return;
  }
  replace(area, marker + selected + marker, marker.length, marker.length + selected.length);
}

function applyLine(area, prefix) {
  const value = area.value;
  const from = value.lastIndexOf("\n", area.selectionStart - 1) + 1;
  let to = value.indexOf("\n", area.selectionEnd);
  if (to === -1) to = value.length;

  const lines = value.slice(from, to).split("\n");
  const numbered = /^\d+\.\s$/.test(prefix);
  // Already prefixed: take it off, so the button toggles.
  const marker = numbered ? /^\d+\.\s+/ : new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const has = lines.every((l) => marker.test(l));
  const next = lines
    .map((line, i) => {
      if (has) return line.replace(marker, "");
      const stripped = line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/, "");
      return (numbered ? `${i + 1}. ` : prefix) + stripped;
    })
    .join("\n");

  area.selectionStart = from;
  area.selectionEnd = to;
  replace(area, next, 0, next.length);
}

/**
 * Build the editor into `host`.
 *
 * text        the document's markdown
 * onChange(t) every edit
 * onAttach()  the attach button, when the caller can upload files
 * Returns { setText, focus, insertAtCaret } for the caller to drive.
 */
export function markdownEditor(host, { text, onChange, onAttach }) {
  host.innerHTML = "";

  const bar = el("div", "mdbar");
  const area = el("textarea", "mdsource");
  area.value = text ?? "";
  area.spellcheck = true;
  area.setAttribute("aria-label", "Document source");

  for (const tool of TOOLS) {
    const button = el("button", `mark ${tool.className ?? ""}`.trim(), tool.label);
    button.type = "button";
    button.title = tool.title;
    button.setAttribute("aria-label", tool.title);
    // mousedown, not click: click blurs the textarea first and the
    // selection the command applies to is already gone.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (tool.wrap) applyWrap(area, tool.wrap);
      else applyLine(area, tool.line);
    });
    bar.appendChild(button);
  }

  const link = el("button", "mark", "🔗");
  link.type = "button";
  link.title = "Link";
  link.setAttribute("aria-label", "Link");
  link.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const { selectionStart: s, selectionEnd: e } = area;
    const selected = area.value.slice(s, e) || "text";
    replace(area, `[${selected}](url)`, selected.length + 3, selected.length + 6);
  });
  bar.appendChild(link);

  if (onAttach) {
    const attach = el("button", "mark with-icon");
    attach.type = "button";
    attach.title = "Attach an image, spreadsheet or PDF and link it here";
    attach.setAttribute("aria-label", "Attach a file");
    attach.append(icon("add"), document.createTextNode("Attach"));
    attach.addEventListener("mousedown", (event) => {
      event.preventDefault();
      onAttach();
    });
    bar.appendChild(attach);
  }

  const split = el("div", "mdsplit");
  const left = el("div", "mdpane");
  const right = el("div", "mdpane mdpreview");
  right.setAttribute("aria-label", "Preview");
  left.appendChild(area);
  split.append(left, right);

  const draw = () => {
    right.innerHTML = markdownToHtml(area.value);
  };
  area.addEventListener("input", () => {
    draw();
    onChange?.(area.value);
  });

  // Tab indents rather than leaving the field: in a document editor the
  // next control is almost never what an author wants, and a markdown
  // list needs two spaces far more often.
  area.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    if (event.shiftKey) {
      const from = area.value.lastIndexOf("\n", area.selectionStart - 1) + 1;
      if (area.value.slice(from, from + 2) === "  ") {
        area.selectionStart = from;
        area.selectionEnd = from + 2;
        replace(area, "");
      }
      return;
    }
    replace(area, "  ");
  });

  host.append(bar, split);
  draw();

  return {
    focus: () => area.focus(),
    setText(next) {
      if (area.value === next) return;
      area.value = next ?? "";
      draw();
    },
    /** Put text where the caret is — how an attachment gets linked. */
    insertAtCaret(snippet) {
      area.focus();
      replace(area, snippet);
    },
  };
}
