// The block's documents, as a tab strip.
//
// One tab per document rather than per category: the strip is then a
// straight answer to "what is in this session", and everything is one
// click away. It gets crowded past eight or so documents, which is the
// point at which a session probably wants splitting anyway.
//
// Same shape as ribbon.js: build into a host, take callbacks, hold no
// state of its own.

import { icon } from "./icons.js";
import { KINDS } from "./documents.js";

/** What the + menu offers, in the order an author usually needs them. */
const ADD = [
  ["assessment", "Add assessment"],
  ["assignment", "Add assignment"],
  ["workbook", "Add workbook"],
  ["instructorguide", "Add instructor guide"],
  ["handout", "Add resource"],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Draw the strip.
 *
 * documents  from blockDocuments()
 * active     the current document id
 * onOpen(id) a tab was chosen
 * onAdd(kind) the + menu was used; "attachment" means a file upload
 * onRemove(id) a document was dropped from the manifest
 */
export function tabs(host, { documents, active, onOpen, onAdd, onRemove }) {
  host.innerHTML = "";
  const strip = el("div", "tabstrip");
  strip.setAttribute("role", "tablist");

  for (const doc of documents) {
    const tab = el("button", "tab");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.dataset.doc = doc.id;
    tab.setAttribute("aria-selected", String(doc.id === active));
    if (doc.id === active) tab.classList.add("on");
    if (doc.missing) {
      tab.classList.add("missing");
      // Shown rather than hidden: a manifest pointing at a file that is
      // not there is exactly the thing an author needs to see.
      tab.title = `${doc.path} is declared in block.yaml but is not in the repo`;
    } else if (doc.uncreated) {
      tab.classList.add("uncreated");
      tab.title = `${doc.path} has not been created yet`;
    }
    tab.append(el("span", "tab-label", doc.title));

    // The deck and the lesson plan are required, so neither offers a
    // close button -- an author cannot remove them by accident.
    if (!["slides", "lessonplan", "outcomes", "course", "back"].includes(doc.type)) {
      const close = el("button", "tab-close");
      close.type = "button";
      close.title = `Remove ${doc.title} from this block`;
      close.setAttribute("aria-label", `Remove ${doc.title}`);
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation(); // or the tab opens as it is removed
        onRemove?.(doc.id);
      });
      tab.appendChild(close);
    }

    tab.addEventListener("click", () => onOpen?.(doc.id));
    strip.appendChild(tab);
  }

  const add = el("div", "tab-add");
  const button = el("button", "tab addbtn");
  button.type = "button";
  button.title = "Add a document to this block";
  button.setAttribute("aria-label", "Add a document");
  button.setAttribute("aria-expanded", "false");
  // Labelled, not just an icon: this is how every resource after the
  // first gets made, and an unlabelled + is easy to miss entirely.
  button.append(icon("add"), document.createTextNode("Add"));
  const menu = el("div", "tab-menu");
  menu.hidden = true;

  for (const [kind, label] of ADD) {
    const item = el("button", "menu-item", label);
    item.type = "button";
    item.addEventListener("click", () => {
      close();
      onAdd?.(kind);
    });
    menu.appendChild(item);
  }
  menu.appendChild(el("div", "menu-rule"));
  const attach = el("button", "menu-item", "Attach a file…");
  attach.type = "button";
  attach.title = "A spreadsheet, a PDF, an image: carried with the block and linked";
  attach.addEventListener("click", () => {
    close();
    onAdd?.("attachment");
  });
  menu.appendChild(attach);

  function close() {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onAway, true);
  }
  function onAway(event) {
    if (!add.contains(event.target)) close();
  }
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = menu.hidden;
    menu.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
    if (opening) document.addEventListener("click", onAway, true);
    else document.removeEventListener("click", onAway, true);
  });

  add.append(button, menu);
  strip.appendChild(add);
  host.appendChild(strip);
}

/** The default title for a kind, for the label of a document just added. */
export function kindLabel(kind) {
  return KINDS[kind]?.label ?? kind;
}
