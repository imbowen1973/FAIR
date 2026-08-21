// The workbench: open a library repo, edit it, preview the real deck,
// save to a branch, submit a pull request.
//
// State lives in the repo, not here. Everything below is a projection of
// files fetched from git plus the edits not yet committed; closing the
// tab loses only the uncommitted edits, and the app says so.

import { brokerProvider, patProvider, signOut, storedLogin, storedToken } from "./auth.js";
import { BROKER_URL, CLIENT_ID } from "./config.js";
import { draftBranch, GitHub, parseRepo } from "./github.js";
import { decorate } from "./icons.js";
import {
  asListType,
  blankSlide,
  isLibrary,
  layoutKeys,
  libraryPaths,
  placedBlocks,
  readLibrary,
  renderSlidesFile,
  workingSlides,
} from "./library.js";
import { drawSlide } from "./canvas.js";
import { slideMeta } from "./meta.js";
import { paintListType, paintSwatches, ribbon } from "./ribbon.js";
import { renderDeck, validate } from "./preview.js";
import {
  blockDocuments,
  freePath,
  KINDS,
  withResource,
  withoutResource,
  FILES_DIR,
  MEDIA_DIR,
} from "./documents.js";
import { tabs } from "./tabs.js";
import { markdownEditor } from "./mdeditor.js";
import { parse as parseYaml, stringify as stringifyYaml } from "./yaml.js";
import { linkFor, prepareUpload, toBase64 } from "./attach.js";
import {
  blankQuestion,
  EDITABLE,
  readQuestion,
  renderQuizFile,
  splitQuestions,
  TYPE_LABEL,
  workingQuestions,
} from "./assessment.js";
import { questionForm } from "./assessmentui.js";

const $ = (id) => document.getElementById(id);

const state = {
  gh: null,
  login: null,
  repo: null, // {owner, repo, defaultBranch}
  files: new Map(), // path -> text, as fetched
  library: null,
  blockId: null,
  slideIndex: 0,
  edits: new Map(), // path -> new text
  // Files the author has attached but not yet committed. Kept apart
  // from state.binaries, which caches binaries *fetched* from the repo
  // for rendering -- mixing them would try to re-commit template.pptx.
  uploads: new Map(), // path -> Uint8Array
  working: new Map(), // blockId -> [{sourceIndex, data, dirty}]
  // Which document each block was last left on, so switching away and
  // back returns you to the workbook rather than to the deck.
  docByBlock: new Map(), // blockId -> document id
  quizzes: new Map(), // assessment path -> {parsed, working}
  quizIndex: 0,
  problems: [],
};

function status(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`.trim();
  el.hidden = !message;
}

/** Run work with the button disabled and the status bar showing progress. */
async function busy(button, label, work) {
  const el = $(button);
  const original = el.textContent;
  el.disabled = true;
  el.textContent = label;
  status(`${label}…`, "busy");
  try {
    return await work((message) => status(message || `${label}…`, "busy"));
  } finally {
    el.disabled = false;
    el.textContent = original;
  }
}

function dirty() {
  return changedFiles().length > 0;
}

window.addEventListener("beforeunload", (e) => {
  if (!dirty()) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---- sign in -----------------------------------------------------------

const broker = brokerProvider(BROKER_URL, CLIENT_ID);

async function signInWithToken() {
  const input = $("pat");
  try {
    status("Checking the token…");
    const { token, login } = await patProvider.signIn(input.value);
    input.value = "";
    await afterSignIn(token, login);
  } catch (err) {
    status(err.message, "error");
  }
}

async function afterSignIn(token, login) {
  state.gh = new GitHub(token);
  state.login = login;
  $("who").textContent = login;
  $("signed-out").hidden = true;
  $("signed-in").hidden = false;
  status("");
  await listRepos();
}

/** The library picker, in the bar, once one is open. */
function renderRepoSwitch(current) {
  const select = $("repo-switch");
  select.innerHTML = "";
  for (const option of [...$("repo").options]) {
    const copy = document.createElement("option");
    copy.value = option.value;
    copy.textContent = option.value;
    select.appendChild(copy);
  }
  if (![...select.options].some((o) => o.value === current)) {
    const extra = document.createElement("option");
    extra.value = current;
    extra.textContent = current;
    select.appendChild(extra);
  }
  select.value = current;
}

async function listRepos() {
  status("Loading your repositories…");
  const select = $("repo");
  select.innerHTML = "";
  const repos = await state.gh.repos();
  for (const repo of repos) {
    const option = document.createElement("option");
    option.value = repo.full_name;
    option.textContent = repo.full_name;
    select.appendChild(option);
  }
  status(`${repos.length} repositories you can push to.`);
}

// ---- open a library ----------------------------------------------------

async function openRepo(fullName) {
  const parsed = parseRepo(fullName);
  if (!parsed) {
    status("That is not an owner/repo.", "error");
    return;
  }
  status(`Reading ${fullName}…`);
  try {
    const { owner, repo } = parsed;
    const info = await state.gh.repo(owner, repo);
    const defaultBranch = info.default_branch;
    // Reading a public repo needs no permission, so a token with no write
    // access opens a library happily and then fails at Save. Say so now.
    state.canWrite = Boolean(info.permissions?.push);
    const paths = await state.gh.tree(owner, repo, defaultBranch);

    if (!isLibrary(paths)) {
      status(
        `${fullName} is not a library: it needs course.yaml and blocks/<id>/block.yaml.`,
        "error"
      );
      return;
    }

    const wanted = libraryPaths(paths).filter((p) => !p.endsWith(".pptx") && !/\.(png|jpe?g|gif|svg)$/i.test(p));
    const files = new Map();
    let done = 0;
    for (const path of wanted) {
      files.set(path, await state.gh.file(owner, repo, path, defaultBranch));
      status(`Reading ${fullName}… ${++done}/${wanted.length}`);
    }

    state.repo = { owner, repo, defaultBranch };
    state.files = files;
    state.library = readLibrary(files);
    state.edits = new Map();
    state.working = new Map();
    state.blockId = [...state.library.blocks.keys()][0] ?? null;
    state.slideIndex = 0;

    $("workspace").hidden = false;
    // The picker moves into the bar: once a library is open, the panel it
    // came from is a screenful of nothing between the header and the work.
    $("signed-in").hidden = true;
    $("course-title").textContent = state.library.course.title || fullName;
    renderRepoSwitch(fullName);
    renderOutline();
    renderSlide();
    if (state.canWrite) {
      status("");
    } else {
      status(
        `Read-only: this token cannot push to ${owner}. You can edit and ` +
          "preview, but Save and Submit will fail. Give the token Contents " +
          "and Pull requests write access on this repository — and if " +
          `${owner} is an organisation, have it approve the token.`,
        "error"
      );
    }
  } catch (err) {
    status(err.message, "error");
  }
}

// ---- outline -----------------------------------------------------------

function currentBlock() {
  return state.library?.blocks.get(state.blockId) ?? null;
}

/** The working list for a block, created from the file on first use. */
function working(blockId = state.blockId) {
  if (!state.working.has(blockId)) {
    const block = state.library.blocks.get(blockId);
    state.working.set(blockId, workingSlides(block.parsed));
  }
  return state.working.get(blockId);
}

function slideData(index) {
  return working()[index]?.data ?? {};
}

function nextSlideId() {
  const used = new Set(working().map((w) => w.data.id).filter(Boolean));
  const prefix = (working()[0]?.data.id || "s-01").replace(/\d+$/, "");
  for (let n = 1; n < 999; n += 1) {
    const candidate = `${prefix}${String(n).padStart(2, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  return `s-${Date.now()}`;
}

function addSlide() {
  const layouts = layoutKeys(state.library.layoutMap);
  const list = working();
  // Insert after the slide in focus, which is where an author means it.
  const at = Math.min(list.length, state.slideIndex + 1);
  list.splice(at, 0, blankSlide(layouts.includes("Full") ? "Full" : layouts[0], nextSlideId()));
  state.slideIndex = at;
  renderOutline();
  renderSlide();
  updateActions();
}

function deleteSlide(index) {
  const list = working();
  if (list.length <= 1) {
    status("A block needs at least one slide.", "error");
    return;
  }
  const data = list[index].data;
  if (!confirm(`Delete "${data.title ?? data.id ?? "this slide"}"?`)) return;
  list.splice(index, 1);
  state.slideIndex = Math.max(0, Math.min(index, list.length - 1));
  renderOutline();
  renderSlide();
  updateActions();
}

function moveSlide(index, delta) {
  const list = working();
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  const [entry] = list.splice(index, 1);
  list.splice(to, 0, entry);
  state.slideIndex = to;
  renderOutline();
  renderSlide();
  updateActions();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

function renderOutline() {
  const host = $("outline");
  host.innerHTML = "";
  const { library } = state;

  const ordered = placedBlocks(library.course.structure);
  const ids = [...library.blocks.keys()];
  const sequence = [...ordered.filter((id) => library.blocks.has(id)),
                    ...ids.filter((id) => !ordered.includes(id))];

  for (const id of sequence) {
    const block = library.blocks.get(id);
    const group = document.createElement("div");
    group.className = "block";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "block-head";
    head.textContent = block.meta.title || id;
    if (id === state.blockId) head.classList.add("on");
    head.addEventListener("click", () => {
      state.blockId = id;
      state.slideIndex = 0;
      renderOutline();
      renderSlide();
    });
    group.appendChild(head);

    // The slide strip belongs to the deck. On a workbook tab it would be
    // a list of things the pane on the right is not showing.
    if (id === state.blockId && activeDoc()?.editor === "slides") {
      working(id).forEach((entry, index) => {
        const data = entry.data;
        const row = document.createElement("div");
        row.className = "slide-row";
        if (index === state.slideIndex) row.classList.add("on");

        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = "slide-pick";
        pick.setAttribute(
          "aria-label",
          `Slide ${index + 1}: ${data.title ?? data.id ?? "untitled"} (${data.layout ?? "no layout"})`
        );

        const number = document.createElement("span");
        number.className = "slide-no";
        number.textContent = String(index + 1);

        // The thumbnail is the same renderer as the big preview, in
        // compact mode — so what the strip shows and what the pane shows
        // can never disagree about a slide.
        const thumb = document.createElement("span");
        thumb.className = "thumb";
        drawSlide(thumb, {
          geometry: state.library.geometry,
          layoutKey: data.layout,
          slide: data,
          compact: true,
        });

        const caption = document.createElement("span");
        caption.className = "thumb-caption";
        caption.textContent = data.title ?? data.id ?? "untitled";

        pick.append(number, thumb, caption);
        pick.addEventListener("click", () => {
          state.slideIndex = index;
          renderOutline();
          renderSlide();
        });
        row.appendChild(pick);

        if (entry.dirty) {
          const dot = document.createElement("span");
          dot.className = "dot";
          dot.title = "unsaved";
          dot.textContent = "•";
          row.appendChild(dot);
        }

        const tools = document.createElement("span");
        tools.className = "slide-tools";
        for (const [label, title, fn] of [
          ["↑", "move up", () => moveSlide(index, -1)],
          ["↓", "move down", () => moveSlide(index, 1)],
          ["×", "delete", () => deleteSlide(index)],
        ]) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "tool";
          b.textContent = label;
          b.title = title;
          b.setAttribute("aria-label", `${title}: slide ${index + 1}`);
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            fn();
          });
          tools.appendChild(b);
        }
        row.appendChild(tools);
        group.appendChild(row);
      });

      const add = document.createElement("button");
      add.type = "button";
      add.className = "add-slide";
      add.textContent = "+ slide";
      add.addEventListener("click", addSlide);
      group.appendChild(add);
    }

    // An assessment gets the same treatment as a deck: its questions in
    // the rail, the one you picked in the pane.
    if (id === state.blockId && activeDoc()?.editor === "assessment") {
      group.appendChild(questionRows(activeDoc()));
    }
    host.appendChild(group);
  }
}

// ---- the slide ---------------------------------------------------------

let activeRegion = null;

/** Record an edit to the slide in focus and redraw what depends on it. */
function commitSlide(next) {
  const entry = working()[state.slideIndex];
  entry.data = next;
  entry.dirty = true;
  renderOutline();
  updateActions();
}

/**
 * Redraw the canvas without losing the caret.
 *
 * Typing in a region rewrites the slide data, and redrawing from that
 * data would rebuild the very node being typed into. So an edit that came
 * from the canvas commits and leaves the DOM alone; only a structural
 * change — a new layout, a region added or cleared — redraws.
 */
function renderCanvas({ redraw = true } = {}) {
  const data = slideData(state.slideIndex);
  if (redraw) {
    drawSlide($("canvas"), {
      geometry: state.library.geometry,
      layoutKey: data.layout,
      slide: data,
      activeRegion,
      editable: true,
      // Leave room for the metadata and notes beneath, or they sit below
      // the fold and get forgotten.
      // Beside the notes on a wide screen, above them on a narrow one —
      // so the slide can take more height when it is not competing.
      maxHeightPx: Math.max(
        260,
        Math.round(window.innerHeight * (window.innerWidth >= 1180 ? 0.62 : 0.44))
      ),
      onChange: (region, value) => {
        const current = slideData(state.slideIndex);
        const next = { ...current };
        if (value === "" && !(region in current)) next[region] = "";
        else next[region] = value;
        const structural = !(region in current);
        commitSlide(next);
        if (structural) renderCanvas();
      },
      onSelectRegion: (region) => {
        activeRegion = region;
        paintListType($("ribbon"), regionType(region));
      },
    });
  }
  slideMeta($("meta"), {
    slide: data,
    competencies: state.library.competencies,
    onChange: (next) => {
      commitSlide(next);
      // Metadata never changes the canvas, so leave the caret where it is.
    },
  });
}

/** The content type of a region on the current slide, or null. */
function regionType(region) {
  if (!region) return null;
  const value = slideData(state.slideIndex)[region];
  return typeof value === "object" && value !== null ? value.type : null;
}

function renderRibbon() {
  const data = slideData(state.slideIndex);
  ribbon($("ribbon"), {
    layouts: layoutKeys(state.library.layoutMap),
    layout: data.layout,
    onCommand: () => {
      // The canvas listens for input, but execCommand does not always
      // raise one; read the surface back and commit.
      const box = $("canvas").querySelector(".region[data-editable]:focus-within");
      if (box) box.dispatchEvent(new Event("input", { bubbles: true }));
    },
    onLayout: (key) => {
      commitSlide({ ...slideData(state.slideIndex), layout: key });
      renderCanvas();
      renderRibbon();
    },
    onColour: (slot) => {
      const region = activeRegion;
      if (!region) return;
      const current = slideData(state.slideIndex);
      const value = current[region];

      // Colour belongs to the region, not to a run: the grammar has no
      // inline colour, precisely so a rebrand can recolour every deck.
      // A bare string has nowhere to carry one, so colouring a title
      // promotes it to a paragraph — same words, same look, now with a
      // place to put the slot.
      let next;
      if (typeof value === "object" && value !== null) {
        next = { ...value };
      } else if (slot) {
        next = { type: "p", text: String(value ?? "") };
      } else {
        return; // a bare string has no colour to clear
      }
      if (slot) next.color = slot;
      else delete next.color;
      commitSlide({ ...current, [region]: next });
      renderCanvas();
    },
    onListType: (kind) => {
      const region = activeRegion;
      if (!region) return;
      const current = slideData(state.slideIndex);
      const next = asListType(current[region], kind);
      if (next === current[region]) return; // already that, or not text
      commitSlide({ ...current, [region]: next });
      renderCanvas();
      paintListType($("ribbon"), kind);
    },
  });
  paintSwatches($("ribbon"), state.library.geometry?.theme);
  paintListType($("ribbon"), regionType(activeRegion));
}

// ---- documents ---------------------------------------------------------
//
// A block is a session, not a deck. The tab strip is its contents, and
// the deck is the first tab rather than the only one.

/** The documents in the current block, over the pending file map. */
function documents() {
  return blockDocuments(currentBlock(), pendingFiles());
}

/** The document on screen, defaulting to the deck. */
function activeDoc() {
  const list = documents();
  const wanted = state.docByBlock.get(state.blockId);
  return list.find((d) => d.id === wanted) ?? list[0] ?? null;
}

/** A document's current text: the edited version if there is one. */
function docText(doc) {
  return state.edits.get(doc.path) ?? state.files.get(doc.path) ?? "";
}

function openDoc(id) {
  state.docByBlock.set(state.blockId, id);
  renderOutline();
  renderBlock();
}

/** block.yaml for the current block, as data. */
function blockMeta() {
  const block = currentBlock();
  const path = `blocks/${block.id}/block.yaml`;
  const text = state.edits.get(path) ?? state.files.get(path) ?? "";
  return { path, data: parseYaml(text) || {} };
}

/** Write block.yaml back after changing its resources. */
function setBlockResources(resources) {
  const { path, data } = blockMeta();
  const next = { ...data, resources };
  state.edits.set(path, stringifyYaml(next));
  // The library's own copy of the meta, so tabs redraw from it at once.
  currentBlock().meta = next;
}

/** Add a document of `kind` to this block, file and manifest together. */
function addDocument(kind) {
  const block = currentBlock();
  const taken = new Set(documents().map((d) => d.id));
  const file = freePath(kind, taken);
  const title = KINDS[kind]?.label ?? kind;
  const path = `blocks/${block.id}/${file}`;

  // The file and its manifest entry in one step: a document that exists
  // but is undeclared would not survive a reload, and a declaration with
  // no file is a broken link in the catalog.
  state.edits.set(path, starterFor(kind, title, block));
  setBlockResources(withResource(blockMeta().data.resources, { type: kind, title, path: file }));

  state.docByBlock.set(block.id, file);
  renderOutline();
  renderBlock();
  updateActions();
  status(`Added ${title.toLowerCase()}`, "ok");
}

/** Opening text for a new document, so the file is never blank. */
function starterFor(kind, title, block) {
  if (kind === "assessment") {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<quiz>",
      "</quiz>",
      "",
    ].join("\n");
  }
  const heading = `# ${title}: ${block.meta.title || block.id}`;
  if (kind === "lessonplan") {
    return [
      heading,
      "",
      "## Learning outcomes",
      "",
      "By the end of this session learners will be able to:",
      "",
      "- ",
      "",
      "## Before the session",
      "",
      "## Running the session",
      "",
      "| Time | Activity | Notes |",
      "|---|---|---|",
      "|  |  |  |",
      "",
      "## After the session",
      "",
    ].join("\n");
  }
  return [heading, "", ""].join("\n");
}

function removeDocument(id) {
  const doc = documents().find((d) => d.id === id);
  if (!doc) return;
  // The manifest entry goes; the file is left in the repo. Dropping a
  // tab should not delete an author's work, and an undeclared file is
  // simply not carried into the catalog.
  setBlockResources(withoutResource(blockMeta().data.resources, id));
  if (state.docByBlock.get(state.blockId) === id) {
    state.docByBlock.delete(state.blockId);
  }
  renderOutline();
  renderBlock();
  updateActions();
  status(`${doc.title} removed from block.yaml; the file is still in the repo`, "ok");
}

function renderTabs() {
  const doc = activeDoc();
  tabs($("tabs"), {
    documents: documents(),
    active: doc?.id,
    onOpen: openDoc,
    onAdd: (kind) => (kind === "attachment" ? attachFile() : addDocument(kind)),
    onRemove: removeDocument,
  });
}

/** Draw whichever editor the active document needs. */
function renderBlock() {
  if (!currentBlock()) return;
  renderTabs();
  const doc = activeDoc();
  const slides = doc?.editor === "slides";

  $("slidesview").hidden = !slides;
  $("document").hidden = slides;
  $("ribbon").hidden = !slides;

  if (slides) {
    renderRibbon();
    renderCanvas();
    return;
  }
  renderDocument(doc);
}

function renderDocument(doc) {
  const host = $("document");
  host.innerHTML = "";

  if (doc.missing) {
    const warn = document.createElement("p");
    warn.className = "warn";
    warn.textContent =
      `block.yaml declares ${doc.path.split("/").pop()}, but it is not in the repo. ` +
      "Type below to create it, or remove the tab to drop the declaration.";
    host.appendChild(warn);
  }

  if (doc.editor === "attachment") {
    renderAttachment(host, doc);
    return;
  }

  if (doc.editor === "assessment") {
    renderQuestion(host, doc);
    return;
  }

  // A required document that is not there yet opens on its template
  // rather than on an empty box — the rule is then something an author
  // can act on, not just something the validator complains about.
  const existing = docText(doc);
  const seeded = existing || starterFor(doc.type, doc.title, currentBlock());
  if (!existing) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent =
      `${doc.path.split("/").pop()} does not exist yet. This is a starting ` +
      "point — it is written to the repo once you edit it.";
    host.appendChild(note);
  }

  const editorHost = document.createElement("div");
  host.appendChild(editorHost);
  markdownEditor(editorHost, {
    text: seeded,
    onChange: (text) => {
      state.edits.set(doc.path, text);
      updateActions();
    },
    onAttach: attachFile,
  });
}

// ---- assessments -------------------------------------------------------

/** The question list for the rail: one row each, in file order. */
function questionRows(doc) {
  const wrap = document.createElement("div");
  const { working } = quiz(doc);

  working.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "slide-row question-row";
    if (index === state.quizIndex) row.classList.add("on");

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "slide-pick";
    const number = document.createElement("span");
    number.className = "slide-no";
    number.textContent = String(index + 1);

    const label = document.createElement("span");
    label.className = "q-row-label";
    // Reading every question just to label the list would parse the whole
    // file on open. The name is cheap to pull out of the source instead.
    const name =
      entry.data?.name ??
      (parsedName(quiz(doc).parsed.questions[entry.sourceIndex]?.source) || `Question ${index + 1}`);
    const kind = document.createElement("span");
    kind.className = "q-row-type";
    kind.textContent = TYPE_LABEL[entry.type] ?? entry.type;
    if (!EDITABLE.includes(entry.type)) kind.classList.add("readonly");
    label.append(document.createTextNode(name), kind);

    pick.append(number, label);
    pick.setAttribute("aria-label", `Question ${index + 1}: ${name}`);
    pick.addEventListener("click", () => {
      state.quizIndex = index;
      renderOutline();
      renderBlock();
    });
    row.appendChild(pick);

    if (entry.dirty) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.title = "unsaved";
      dot.textContent = "•";
      row.appendChild(dot);
    }

    const tools = document.createElement("span");
    tools.className = "slide-tools";
    for (const [text, title, fn] of [
      ["↑", "move up", () => moveQuestion(doc, index, -1)],
      ["↓", "move down", () => moveQuestion(doc, index, 1)],
      ["×", "delete", () => deleteQuestion(doc, index)],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool";
      b.textContent = text;
      b.title = title;
      b.setAttribute("aria-label", `${title}: question ${index + 1}`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      tools.appendChild(b);
    }
    row.appendChild(tools);
    wrap.appendChild(row);
  });

  const add = document.createElement("div");
  add.className = "add-question";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Question type to add");
  for (const type of EDITABLE) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = TYPE_LABEL[type];
    select.appendChild(option);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "add-slide";
  button.textContent = "+ question";
  button.addEventListener("click", () => addQuestion(doc, select.value));
  add.append(select, button);
  wrap.appendChild(add);
  return wrap;
}

/** A question's name straight out of its source, without a full parse. */
function parsedName(source) {
  if (!source) return "";
  const match = source.match(/<name>\s*<text>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/text>/i);
  return match ? match[1].trim() : "";
}

/**
 * The working state for an assessment file, split on first use.
 *
 * Questions are read lazily: an untouched question is never parsed, so
 * it can only ever be written back byte-identical.
 */
function quiz(doc) {
  if (!state.quizzes.has(doc.path)) {
    const parsed = splitQuestions(docText(doc));
    state.quizzes.set(doc.path, { parsed, working: workingQuestions(parsed) });
  }
  return state.quizzes.get(doc.path);
}

/** Commit the working list back to the file. */
function commitQuiz(doc) {
  const { parsed, working } = quiz(doc);
  state.edits.set(doc.path, renderQuizFile(parsed, working));
  updateActions();
}

/** A question's data, parsed the first time it is opened. */
function questionData(doc, index) {
  const { parsed, working } = quiz(doc);
  const entry = working[index];
  if (!entry) return null;
  if (!entry.data) {
    entry.data = readQuestion(parsed.questions[entry.sourceIndex].source) ?? {
      type: entry.type,
      name: "",
      answers: [],
      tags: [],
    };
  }
  return entry.data;
}

function addQuestion(doc, type) {
  const { working } = quiz(doc);
  const used = new Set(working.map((w) => w.data?.name).filter(Boolean));
  let name = `Q${working.length + 1}`;
  for (let n = working.length + 1; used.has(name); n += 1) name = `Q${n}`;
  working.push({ sourceIndex: null, type, data: blankQuestion(type, name), dirty: true });
  state.quizIndex = working.length - 1;
  commitQuiz(doc);
  renderOutline();
  renderBlock();
}

function deleteQuestion(doc, index) {
  const { working } = quiz(doc);
  const data = questionData(doc, index);
  if (!window.confirm(`Delete "${data?.name || `question ${index + 1}`}"?`)) return;
  working.splice(index, 1);
  state.quizIndex = Math.max(0, Math.min(state.quizIndex, working.length - 1));
  commitQuiz(doc);
  renderOutline();
  renderBlock();
}

function moveQuestion(doc, index, delta) {
  const { working } = quiz(doc);
  const to = index + delta;
  if (to < 0 || to >= working.length) return;
  const [entry] = working.splice(index, 1);
  working.splice(to, 0, entry);
  state.quizIndex = to;
  commitQuiz(doc);
  renderOutline();
  renderBlock();
}

function renderQuestion(host, doc) {
  const { working } = quiz(doc);
  if (!working.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent =
      "No questions yet. Add one from the list on the left — it is written as " +
      "Moodle XML, which Moodle imports directly.";
    host.appendChild(empty);
    return;
  }
  const index = Math.min(state.quizIndex, working.length - 1);
  const data = questionData(doc, index);
  const form = document.createElement("div");
  form.className = "question";
  host.appendChild(form);

  let view;
  const onChange = (next) => {
    const entry = working[index];
    const structural =
      (next.answers?.length ?? 0) !== (entry.data?.answers?.length ?? 0) ||
      JSON.stringify(next.tags) !== JSON.stringify(entry.data?.tags);
    entry.data = next;
    entry.dirty = true;
    commitQuiz(doc);
    view.updateSource(next);
    // Adding an answer or a tag changes the form's own shape, so it is
    // rebuilt. Typing does not, and rebuilding then would cost the caret.
    if (structural) {
      view = questionForm(form, {
        data: next,
        competencies: state.library.competencies,
        onChange,
      });
    }
    renderQuestionList();
  };

  view = questionForm(form, {
    data,
    competencies: state.library.competencies,
    onChange,
  });
}

/** Refresh just the question list, so a renamed question re-labels. */
function renderQuestionList() {
  const doc = activeDoc();
  if (doc?.editor === "assessment") renderOutline();
}

/** A file we carry but do not edit: say what it is and where it lives. */
function renderAttachment(host, doc) {
  const { owner, repo, defaultBranch } = state.repo;
  const card = document.createElement("div");
  card.className = "attachment";
  const name = doc.path.split("/").pop();
  const title = document.createElement("h3");
  title.textContent = doc.title;
  const where = document.createElement("p");
  where.className = "muted";
  where.textContent =
    `${doc.path} — carried with the block and linked from its documents. ` +
    "Binary files are not edited here.";
  const link = document.createElement("a");
  link.href = `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${doc.path}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `Open ${name} on GitHub`;
  card.append(title, where, link);
  host.appendChild(card);
}

/**
 * Attach files to this block: prepared, committed alongside, and linked
 * from the document on screen if it takes markdown.
 */
function attachFile() {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = true;
  picker.accept = "image/*,.pdf,.xlsx,.xls,.csv,.docx,.pptx,.zip";
  picker.addEventListener("change", async () => {
    const block = currentBlock();
    const doc = activeDoc();
    const added = [];
    try {
      for (const file of picker.files) {
        const upload = await prepareUpload(file);
        const rel = `${upload.dir}/${upload.name}`;
        const path = `blocks/${block.id}/${rel}`;
        state.uploads.set(path, upload.bytes);
        // Declared as well as committed, or the catalog will not carry it.
        setBlockResources(
          withResource(blockMeta().data.resources, {
            type: upload.isImage ? "image" : "file",
            title: file.name,
            path: rel,
          })
        );
        added.push({ upload, file });
      }
    } catch (err) {
      status(err.message, "error");
      return;
    }
    if (!added.length) return;

    // Link them where the author was typing. A markdown document gets
    // the links inline; anywhere else they are reachable by their tab.
    if (doc && doc.editor === "markdown") {
      const links = added.map(({ upload, file }) => linkFor(upload, file.name)).join("\n");
      const text = docText(doc);
      state.edits.set(doc.path, text.endsWith("\n") ? `${text}${links}\n` : `${text}\n${links}\n`);
    }
    renderOutline();
    renderBlock();
    updateActions();
    const names = added.map(({ upload }) => upload.name).join(", ");
    const shrunk = added.some(({ upload }) => upload.isImage);
    status(
      `Attached ${names}${shrunk ? " — images resized and metadata stripped" : ""}`,
      "ok"
    );
  });
  picker.click();
}

/** Kept for callers that only mean the deck. */
function renderSlide() {
  renderBlock();
}

// ---- pending files -----------------------------------------------------

/** The library as it would be committed: fetched files plus edits. */
function pendingFiles() {
  const out = new Map(state.files);
  for (const [blockId, list] of state.working) {
    const block = state.library.blocks.get(blockId);
    // A block with no deck only gains a slides.md once it has a slide;
    // writing an empty one would commit a file nobody asked for.
    if (!block.slidesPath && !list.length) continue;
    const path = block.slidesPath ?? `blocks/${blockId}/slides.md`;
    out.set(path, renderSlidesFile(block.parsed, list));
  }
  for (const [path, text] of state.edits) out.set(path, text);
  return out;
}

function changedFiles() {
  const pending = pendingFiles();
  const changed = [];
  for (const [path, text] of pending) {
    if (state.files.get(path) !== text) changed.push({ path, content: text });
  }
  // Attachments travel in the same commit as the document that links
  // them: a workbook referencing an image that landed in a later commit
  // is broken for everyone who reads the branch in between.
  for (const [path, bytes] of state.uploads) {
    changed.push({ path, base64: toBase64(bytes) });
  }
  return changed;
}

function updateActions() {
  const changed = changedFiles();
  $("dirty").textContent = changed.length
    ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed`
    : "no changes";
  const writable = state.canWrite !== false;
  $("save").disabled = changed.length === 0 || !writable;
  $("submit").disabled =
    changed.length === 0 || state.problems.length > 0 || !writable;
  const why = !writable ? "This token cannot push to this repository." : "";
  $("save").title = why;
  $("submit").title = why;
}

// ---- validate and preview ---------------------------------------------

async function runValidate() {
  try {
    await busy("validate", "Checking", async (report) => {
      state.problems = await validate(pendingFiles(), report);
    });
    const strip = $("problems");
    strip.innerHTML = "";
    if (!state.problems.length) {
      strip.innerHTML = '<p class="ok">No problems.</p>';
      status("Checked: no problems.", "ok");
    } else {
      for (const problem of state.problems) {
        const row = document.createElement("p");
        row.className = "problem";
        row.innerHTML = `<strong>${escapeHtml(problem.where)}</strong> ${escapeHtml(problem.message)}`;
        strip.appendChild(row);
      }
      status(`${state.problems.length} problem(s) — see below.`, "error");
    }
    updateActions();
  } catch (err) {
    status(`Could not check: ${err.message}`, "error");
  }
}

/**
 * Binary files (the template, images) are fetched only when a real render
 * is asked for, so opening a library stays fast. They are cached on the
 * state so a second preview does not re-download the template.
 */
async function withBinaries(report) {
  const { owner, repo, defaultBranch } = state.repo;
  const files = pendingFiles();
  const paths = await state.gh.tree(owner, repo, defaultBranch);
  const binaries = libraryPaths(paths).filter((p) => !files.has(p));

  let done = 0;
  for (const path of binaries) {
    if (state.binaries?.has(path)) {
      files.set(path, state.binaries.get(path));
    } else {
      report(`Fetching ${path.split("/").pop()} (${++done}/${binaries.length})`);
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${path}`
      );
      if (!res.ok) throw new Error(`cannot fetch ${path} (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      state.binaries = state.binaries ?? new Map();
      state.binaries.set(path, bytes);
      files.set(path, bytes);
    }
  }
  return files;
}

async function previewDeck() {
  try {
    await busy("preview", "Rendering", async (report) => {
      const files = await withBinaries(report);
      const { blob, filename } = await renderDeck(files, state.blockId, report);

      // A detached anchor is enough in every browser Office and the desktop
      // use, and avoids a popup blocker eating window.open.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
    status("Deck rendered — check your downloads.", "ok");
  } catch (err) {
    console.error(err);
    status(`Preview failed: ${err.message}`, "error");
  }
}

// ---- save and submit ---------------------------------------------------

async function save() {
  const changed = changedFiles();
  if (!changed.length) return;
  const { owner, repo, defaultBranch } = state.repo;
  const branch = draftBranch(state.login, state.blockId);

  try {
    $("save").disabled = true;
    status(`Saving to ${branch}…`);
    const created = await state.gh.ensureBranch(owner, repo, branch, defaultBranch);
    const message =
      `Edit ${state.blockId}\n\n` +
      changed.map((f) => `- ${f.path}`).join("\n");
    const sha = await state.gh.commit(owner, repo, branch, message, changed);

    // The commit is now the truth: adopt it as the baseline so a second
    // save does not re-send unchanged files.
    for (const file of changed) state.files.set(file.path, file.content);
    state.working = new Map();
    state.edits = new Map();
    state.library = readLibrary(state.files);

    renderOutline();
    renderSlide();
    status(
      `Saved to ${branch} (${sha.slice(0, 7)})${created ? " — branch created" : ""}.`,
      "ok"
    );
    return true;
  } catch (err) {
    status(`Save failed: ${err.message}`, "error");
    return false;
  } finally {
    updateActions();
  }
}

async function submit() {
  const { owner, repo, defaultBranch } = state.repo;
  const branch = draftBranch(state.login, state.blockId);
  try {
    // No point asking for a pull request against a branch that never landed.
    if (changedFiles().length && !(await save())) return;
    const existing = await state.gh.pullForBranch(owner, repo, branch);
    if (existing) {
      status(`Already open for review: ${existing.html_url}`, "ok");
      window.open(existing.html_url, "_blank", "noopener");
      return;
    }
    const block = state.library.blocks.get(state.blockId);
    const pull = await state.gh.openPull(owner, repo, {
      head: branch,
      base: defaultBranch,
      title: `Update ${block.meta.title || state.blockId}`,
      body:
        "Authored in the FAIR workbench.\n\n" +
        "Review and merge here; the deck is rendered from this markdown at " +
        "the point of use and is never stored.",
    });
    status(`Opened for review: ${pull.html_url}`, "ok");
    window.open(pull.html_url, "_blank", "noopener");
  } catch (err) {
    status(`Submit failed: ${err.message}`, "error");
  }
}

async function showHistory() {
  const { owner, repo } = state.repo;
  const block = state.library.blocks.get(state.blockId);
  try {
    // The document on screen, or the whole block when it has no deck.
    const commits = await state.gh.commits(owner, repo, {
      path: block.slidesPath ?? `blocks/${block.id}`,
      limit: 20,
    });
    const host = $("problems");
    host.innerHTML = "<h3>History</h3>";
    for (const commit of commits) {
      const row = document.createElement("p");
      row.className = "commit";
      const when = new Date(commit.commit.author.date).toLocaleString();
      row.innerHTML =
        `<a href="${commit.html_url}" target="_blank" rel="noopener">` +
        `${commit.sha.slice(0, 7)}</a> ${commit.commit.message.split("\n")[0]} ` +
        `<span class="muted">${commit.commit.author.name} · ${when}</span>`;
      host.appendChild(row);
    }
  } catch (err) {
    status(err.message, "error");
  }
}

// ---- wiring ------------------------------------------------------------

async function boot() {
  $("broker-signin").hidden = !broker.available();

  try {
    const returned = await broker.complete();
    if (returned) {
      await afterSignIn(returned.token, returned.login);
      return;
    }
  } catch (err) {
    status(err.message, "error");
  }

  const token = storedToken();
  if (token) {
    await afterSignIn(token, storedLogin() || "signed in");
  }
}

$("broker-signin").addEventListener("click", () => broker.start());
$("pat-signin").addEventListener("click", signInWithToken);
$("pat").addEventListener("keydown", (e) => {
  if (e.key === "Enter") signInWithToken();
});
$("signout").addEventListener("click", () => {
  signOut();
  location.reload();
});
$("open").addEventListener("click", () => openRepo($("repo").value));
$("repo-switch").addEventListener("change", (e) => {
  if (dirty() && !confirm("You have unsaved changes. Switch library anyway?")) {
    e.target.value = `${state.repo.owner}/${state.repo.repo}`;
    return;
  }
  openRepo(e.target.value);
});

for (const [id, name] of [
  ["validate", "check"],
  ["preview", "preview"],
  ["history", "history"],
  ["save", "save"],
  ["submit", "submit"],
  ["open", "open"],
  ["open-manual", "open"],
]) {
  decorate($(id), name);
}
$("open-manual").addEventListener("click", () => openRepo($("manual-repo").value));
$("validate").addEventListener("click", runValidate);
$("preview").addEventListener("click", previewDeck);
$("save").addEventListener("click", save);
$("submit").addEventListener("click", submit);
$("history").addEventListener("click", showHistory);

boot();
