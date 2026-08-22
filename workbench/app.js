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
  flattenStructure,
  layoutRegions,
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
import {
  outcomeDoc,
  outcomeList,
  freeOutcomeId,
  outcomesEditor,
  sessionOutcomes,
  fillRole,
  openingSlides,
  roleRegions,
  OUTCOMES_PATH,
} from "./outcomes.js";
import {
  hasOutcomesSection,
  refreshOutcomes,
  summaryTemplate,
} from "./summary.js";
import { competencyEditor, courseHome, freeCompetencyId } from "./course.js";

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
  // The course itself is a thing you can open, above the blocks: its
  // outcomes are library-wide, so they have no block to belong to.
  courseOpen: false,
  courseTab: "overview",
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

/**
 * The two slides every session opens with.
 *
 * Neither carries any text: the title comes from block.yaml and the
 * outcomes from the catalogue, so a deck cannot drift from the course it
 * belongs to. Offered rather than forced, because a deck that already
 * has its own opening should keep it.
 */
function addOpeningSlides() {
  const list = working();
  const layouts = layoutKeys(state.library.layoutMap);
  const opening = openingSlides(nextSlideId()).filter((slide) =>
    layouts.includes(slide.layout)
  );
  if (!opening.length) {
    status("This template has no Title or Full layout to build them from.", "error");
    return;
  }
  list.unshift(...opening.map((data) => ({ sourceIndex: null, data, dirty: true })));
  state.slideIndex = 0;
  renderOutline();
  renderSlide();
  updateActions();
  status("Added a title slide and a learning outcomes slide.", "ok");
}

/** Whether the deck already opens with the standard two. */
function hasOpeningSlides() {
  const roles = working()
    .slice(0, 3)
    .map((entry) => entry.data?.role)
    .filter(Boolean);
  return roles.includes("title") && roles.includes("outcomes");
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

/**
 * A heading in the rail, so what belongs to the repo and what belongs to
 * a session are visibly different things.
 *
 * The course holds the description and the competency framework. A
 * session holds its learning outcomes, its plan and its deck. Flat, that
 * distinction was invisible, and a plan looked as though it hung off the
 * course.
 */
function railHeading(title, note) {
  const row = document.createElement("div");
  row.className = "rail-heading";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("span");
  small.textContent = note;
  row.append(strong, small);
  return row;
}

function renderOutline() {
  paintRailToggle();
  const host = $("outline");
  host.innerHTML = "";
  const { library } = state;

  // The course, above its blocks. Outcomes are library-wide, so they
  // belong to the course rather than to any one session.
  const courseGroup = document.createElement("div");
  courseGroup.className = "block course-entry";
  courseGroup.appendChild(railHeading("This course", "the whole repo"));
  const courseHead = document.createElement("button");
  courseHead.type = "button";
  courseHead.className = "block-head";
  courseHead.textContent = library.course.title || "This course";
  if (state.courseOpen) courseHead.classList.add("on");
  courseHead.addEventListener("click", () => {
    state.courseOpen = true;
    renderOutline();
    renderCourse();
    revealEditor();
  });
  courseGroup.appendChild(courseHead);
  host.appendChild(courseGroup);

  host.appendChild(railHeading("Sessions", "each has its own outcomes and plan"));

  // The recipe's own shape, so a lesson visibly sits inside its module.
  // Flat, the levels were invisible and a lesson plan looked as though
  // it hung off the module rather than the lesson.
  const placed = placedBlocks(library.course.structure);
  const rows = flattenStructure(library.course.structure).filter(
    (row) => row.kind !== "block" || library.blocks.has(row.block)
  );
  for (const id of library.blocks.keys()) {
    if (!placed.includes(id)) rows.push({ kind: "block", block: id, depth: 0 });
  }

  for (const row of rows) {
    if (row.kind !== "block") {
      const heading = document.createElement("div");
      heading.className = "structure-row";
      heading.style.paddingLeft = `${row.depth * 10}px`;
      const kind = document.createElement("span");
      kind.className = "structure-kind";
      kind.textContent = row.kind;
      heading.append(kind, document.createTextNode(row.title));
      host.appendChild(heading);
      continue;
    }

    const id = row.block;
    const block = library.blocks.get(id);
    const group = document.createElement("div");
    group.className = "block";
    group.style.marginLeft = `${row.depth * 10}px`;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "block-head";
    head.textContent = block.meta.title || id;
    if (id === state.blockId) head.classList.add("on");
    head.addEventListener("click", () => {
      state.blockId = id;
      state.slideIndex = 0;
      state.courseOpen = false;
      renderOutline();
      renderSlide();
      revealEditor();
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
          slide: previewData(data),
          compact: true,
        });

        const caption = document.createElement("span");
        caption.className = "thumb-caption";
        caption.textContent =
          previewData(data).title ?? data.id ?? "untitled";

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

      if (!hasOpeningSlides()) {
        const opening = document.createElement("button");
        opening.type = "button";
        opening.className = "add-slide";
        opening.textContent = "+ title and outcomes";
        opening.title =
          "A title slide and a learning outcomes slide, both filled from " +
          "the library rather than typed";
        opening.addEventListener("click", addOpeningSlides);
        group.appendChild(opening);
      }
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
/** A slide as the deck will render it, with any role filled in. */
function previewData(data) {
  return fillRole(data, {
    blockMeta: currentBlock()?.meta,
    catalogue: catalogueDoc().outcomes || {},
    layoutRegions: layoutRegions(state.library.layoutMap, data.layout),
  });
}

function renderCanvas({ redraw = true } = {}) {
  const data = slideData(state.slideIndex);
  const shown = previewData(data);
  if (redraw) {
    drawSlide($("canvas"), {
      geometry: state.library.geometry,
      layoutKey: data.layout,
      slide: shown,
      derived: roleRegions(data, layoutRegions(state.library.layoutMap, data.layout)),
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
    outcomes: catalogueDoc().outcomes || {},
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

// ---- new lessons and modules -------------------------------------------
//
// A lesson is a block: its own folder, its own plan, its own deck. A
// module is a container in course.yaml holding lessons. Both are made
// here, because a course that cannot grow in the tool is a course that
// gets edited somewhere else.

/** A folder name from a title: lowercase, hyphens, no surprises. */
function slugFor(title, taken) {
  const base =
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lesson";
  const numbered = `${String(taken.size + 1).padStart(2, "0")}-${base}`;
  if (!taken.has(numbered)) return numbered;
  for (let n = 2; n < 99; n += 1) {
    if (!taken.has(`${numbered}-${n}`)) return `${numbered}-${n}`;
  }
  return `${numbered}-${Date.now()}`;
}

/** course.yaml as data, edits included. */
function courseDoc() {
  const text = state.edits.get("course.yaml") ?? state.files.get("course.yaml") ?? "";
  return parseYaml(text) || {};
}

function writeCourse(next) {
  state.edits.set("course.yaml", stringifyYaml(next));
  state.library.course = next;
}

/** Append a node to the container at `trail`, or to the root. */
function addToStructure(structure, trail, node) {
  if (!trail.length) return [...(structure || []), node];
  const [head, ...rest] = trail;
  return (structure || []).map((entry, index) =>
    index === head
      ? { ...entry, children: addToStructure(entry.children, rest, node) }
      : entry
  );
}

/** Every container in the recipe, as {title, trail} for a picker. */
function containers(structure, trail = [], out = []) {
  (structure || []).forEach((node, index) => {
    if (node.block) return;
    out.push({ title: node.title || node.kind || "group", trail: [...trail, index] });
    containers(node.children, [...trail, index], out);
  });
  return out;
}

/**
 * A new lesson: a block folder with a manifest, placed in the recipe.
 *
 * Only block.yaml is written. A lesson with no plan and no deck is
 * exactly what a new lesson is, and the tabs then offer to create both.
 */
function addLesson(trail) {
  const title = window.prompt("What is this lesson called?");
  if (title === null) return;
  const id = slugFor(title, new Set(state.library.blocks.keys()));
  const path = `blocks/${id}/block.yaml`;
  const meta = { title: title.trim() || id };
  state.edits.set(path, stringifyYaml(meta));

  const course = courseDoc();
  writeCourse({
    ...course,
    structure: addToStructure(course.structure, trail ?? [], { block: id }),
  });

  state.library.blocks.set(id, { id, meta, slidesPath: null, parsed: null });
  state.blockId = id;
  state.slideIndex = 0;
  state.courseOpen = false;
  state.docByBlock.delete(id);
  renderOutline();
  renderSlide();
  updateActions();
  status(`Added ${title}. Its lesson plan and deck are waiting on the tabs.`, "ok");
}

/** A new module: a container in the recipe, holding lessons. */
function addModule() {
  const title = window.prompt("What is this module called?");
  if (title === null) return;
  const course = courseDoc();
  writeCourse({
    ...course,
    structure: addToStructure(course.structure, [], {
      kind: "module",
      title: title.trim() || "Module",
      children: [],
    }),
  });
  renderOutline();
  updateActions();
  status(`Added the module ${title}. Add lessons to it from the rail.`, "ok");
}

// ---- the session drawer ------------------------------------------------
//
// On a phone the session list stacks above the editor, and a course's
// worth of sessions and thumbnails puts the editor below the fold. A tab
// could then be tapped and nothing would appear to happen. So on narrow
// screens the list is a drawer: closed by default, and closing itself
// whenever a choice is made.

const NARROW = "(max-width: 1100px)";

function narrow() {
  return window.matchMedia?.(NARROW).matches ?? false;
}

function setRail(open) {
  document.querySelector(".panes")?.classList.toggle("rail-open", open);
  $("rail-toggle").setAttribute("aria-expanded", String(open));
}

/** Label the drawer with where you actually are. */
function paintRailToggle() {
  const button = $("rail-toggle");
  if (!button) return;
  const block = currentBlock();
  button.textContent = state.courseOpen
    ? state.library?.course?.title || "This course"
    : block?.meta?.title || block?.id || "Sessions";
}

/**
 * After choosing a session or a document, put the editor where the eye
 * is. Narrow screens only: on a desktop nothing moved.
 */
function revealEditor() {
  if (!narrow()) return;
  setRail(false);
  $("tabs")?.scrollIntoView({ block: "start", behavior: "smooth" });
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
  revealEditor();
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
    return summaryTemplate({
      block: {
        id: block.id,
        title: block.meta.title,
        code: block.meta.code,
        duration: block.meta.duration_minutes,
      },
      outcomes: ownedOutcomes(block.id),
      documents: documents().filter((d) => d.type !== "lessonplan"),
    });
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
  if (state.courseOpen) {
    // The course has its own tabs, not the last block's -- and a way
    // back, because an empty strip was a dead end.
    const back = currentBlock();
    tabs($("tabs"), {
      documents: [
        { id: "overview", title: "Module", type: "course" },
        { id: "competencies", title: "Competencies", type: "course" },
        { id: "source", title: "course.yaml", type: "course" },
        ...(back
          ? [{ id: "back", title: `← ${back.meta?.title || back.id}`, type: "back" }]
          : []),
      ],
      active: state.courseTab,
      onOpen: (id) => {
        if (id === "back") {
          state.courseOpen = false;
          renderOutline();
          renderSlide();
          revealEditor();
          return;
        }
        state.courseTab = id;
        renderCourse();
      },
      onAdd: () => {},
      onRemove: () => {},
    });
    return;
  }
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
  if (state.courseOpen) return renderCourse();
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

/**
 * Write a document's file, and declare it.
 *
 * Explicit, not a side effect of opening the tab: browsing a session
 * should not commit files. And explicit rather than "type something and
 * it appears", because with a WYSIWYG editor a template on screen looks
 * exactly like a document that already exists.
 */
function createDocument(doc) {
  const block = currentBlock();
  const text =
    doc.editor === "assessment"
      ? starterFor("assessment", doc.title, block)
      : starterFor(doc.type, doc.title, block);
  state.edits.set(doc.path, text);
  // The quiz cache holds a parse of the file as it was, which was empty.
  state.quizzes.delete(doc.path);

  // Declared as well as written, or it is not carried into the catalog.
  // The deck is the exception: slides.md is fixed by convention.
  if (doc.type !== "slides") {
    setBlockResources(
      withResource(blockMeta().data.resources, {
        type: doc.type,
        title: doc.title,
        path: doc.file ?? doc.id,
      })
    );
  }
  renderOutline();
  renderBlock();
  updateActions();
  status(`Created ${doc.path.split("/").pop()}.`, "ok");
}

/** The banner offering to create a document that is not there yet. */
function createBanner(doc) {
  const row = document.createElement("div");
  row.className = "create-row";
  const words = document.createElement("p");
  words.className = "warn";
  const name = doc.path.split("/").pop();
  words.textContent = doc.missing
    ? `block.yaml declares ${name}, but the file is not in the repo.`
    : `${name} does not exist yet.`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.textContent = `Create ${doc.title.toLowerCase()}`;
  button.addEventListener("click", () => createDocument(doc));
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Below is what will be written. Nothing is saved until you create it " +
    "or start editing.";
  row.append(words, button, hint);
  return row;
}

function renderDocument(doc) {
  const host = $("document");
  host.innerHTML = "";

  if (doc.editor === "attachment") {
    renderAttachment(host, doc);
    return;
  }

  if (doc.editor === "assessment") {
    if (doc.uncreated) host.appendChild(createBanner(doc));
    renderQuestion(host, doc);
    return;
  }

  if (doc.editor === "outcomes") {
    renderSessionOutcomes(host);
    return;
  }

  // A document that is not there yet opens on its template rather than
  // on an empty box, so the rule is something an author can act on.
  const existing = docText(doc);
  const seeded = existing || starterFor(doc.type, doc.title, currentBlock());
  if (!existing) host.appendChild(createBanner(doc));

  // The outcomes section is generated from the catalogue, so it can be
  // brought back into step without touching a word of the prose around
  // it. Only offered when the markers are still there: a summary
  // somebody rewrote by hand is theirs.
  if (doc.type === "lessonplan" && hasOutcomesSection(seeded)) {
    const owned = ownedOutcomes(currentBlock().id);
    const current = refreshOutcomes(seeded, owned);
    if (current !== seeded) {
      const row = document.createElement("p");
      row.className = "hint";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link";
      button.textContent = "Update the outcomes section";
      button.addEventListener("click", () => {
        state.edits.set(doc.path, refreshOutcomes(docText(doc) || seeded, owned));
        updateActions();
        renderBlock();
      });
      row.append(
        document.createTextNode(
          "The learning outcomes here differ from the ones this session owns. "
        ),
        button
      );
      host.appendChild(row);
    }
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

// ---- the course --------------------------------------------------------

/** The catalogue as data: the edited copy if there is one. */
function catalogueDoc() {
  const text = state.edits.get(OUTCOMES_PATH) ?? state.files.get(OUTCOMES_PATH) ?? "";
  return parseYaml(text) || {};
}

/**
 * Where each outcome is actually taught.
 *
 * An outcome nothing serves is a claim with no content behind it, which
 * is the thing nobody notices until someone external asks. Counting it
 * here puts it in front of the author instead.
 */
function outcomeCoverage() {
  const coverage = {};
  const bump = (oid, key) => {
    coverage[oid] = coverage[oid] || { blocks: 0, slides: 0, questions: 0 };
    coverage[oid][key] += 1;
  };
  for (const [id, block] of state.library.blocks) {
    const slides = state.working.get(id) ?? workingSlides(block.parsed);
    for (const entry of slides) {
      for (const oid of entry.data?.outcomes ?? []) bump(String(oid), "slides");
    }
  }
  return coverage;
}

/** The outcomes a session owns, as {id, statement} in catalogue order. */
function ownedOutcomes(blockId) {
  const owned = new Set(blockOutcomes(blockId));
  return outcomeList(catalogueDoc()).filter((o) => owned.has(o.id));
}

/** Blocks in delivery order, for the session pickers. */
function blocksInOrder() {
  const ordered = placedBlocks(state.library.course.structure);
  const ids = [...state.library.blocks.keys()];
  const sequence = [
    ...ordered.filter((id) => state.library.blocks.has(id)),
    ...ids.filter((id) => !ordered.includes(id)),
  ];
  return sequence.map((id) => ({
    id,
    title: state.library.blocks.get(id).meta?.title || id,
  }));
}

/**
 * Which session owns each outcome.
 *
 * An outcome belongs to one session, so the first block to claim it
 * wins. check_alignment reports a second claim as an error rather than
 * this quietly picking one.
 */
function outcomeOwners() {
  const owner = {};
  for (const [id, block] of state.library.blocks) {
    for (const oid of blockOutcomes(id)) {
      if (!(oid in owner)) owner[String(oid)] = id;
    }
  }
  return owner;
}

/** A block's declared outcomes, edits included. */
function blockOutcomes(blockId) {
  const path = `blocks/${blockId}/block.yaml`;
  const text = state.edits.get(path) ?? state.files.get(path) ?? "";
  const meta = parseYaml(text) || {};
  return Array.isArray(meta.outcomes) ? meta.outcomes.map(String) : [];
}

/** Move an outcome to a session — or to none. */
function setOutcomeOwner(outcomeId, blockId, { stay = false } = {}) {
  for (const [id] of state.library.blocks) {
    const path = `blocks/${id}/block.yaml`;
    const text = state.edits.get(path) ?? state.files.get(path) ?? "";
    const meta = parseYaml(text) || {};
    const had = blockOutcomes(id);
    const wants = id === blockId;
    const has = had.includes(outcomeId);
    if (wants === has) continue;
    const next = wants ? [...had, outcomeId] : had.filter((o) => o !== outcomeId);
    const nextMeta = { ...meta };
    if (next.length) nextMeta.outcomes = next;
    else delete nextMeta.outcomes;
    state.edits.set(path, stringifyYaml(nextMeta));
    state.library.blocks.get(id).meta = nextMeta;
  }
  updateActions();
  if (!stay) renderCourse();
}

/** flattenStructure, plus the path to each node so a caller can add to it. */
function withTrails(structure, trail = [], depth = 0, out = []) {
  (structure || []).forEach((node, index) => {
    if (node.block) {
      out.push({ kind: "block", block: node.block, depth, trail });
      return;
    }
    out.push({
      kind: node.kind || "group",
      title: node.title || "",
      depth,
      trail: [...trail, index],
    });
    withTrails(node.children, [...trail, index], depth + 1, out);
  });
  return out;
}

/** The recipe's rows, with each session's facts attached for the cards. */
function courseRows() {
  const rows = withTrails(courseDoc().structure);
  const placed = new Set(rows.filter((r) => r.kind === "block").map((r) => r.block));
  for (const id of state.library.blocks.keys()) {
    if (!placed.has(id)) rows.push({ kind: "block", block: id, depth: 0, trail: [] });
  }
  const owners = outcomeOwners();
  const files = pendingFiles();
  return rows
    .filter((row) => row.kind !== "block" || state.library.blocks.has(row.block))
    .map((row) => {
      if (row.kind !== "block") return row;
      const block = state.library.blocks.get(row.block);
      return {
        ...row,
        title: block.meta?.title,
        code: block.meta?.code,
        duration: block.meta?.duration_minutes,
        outcomes: Object.values(owners).filter((b) => b === row.block).length,
        slides: (state.working.get(row.block) ?? workingSlides(block.parsed)).length,
        hasPlan: files.has(`blocks/${row.block}/lessonplan.md`),
      };
    });
}

function renderCourse() {
  renderTabs();
  $("slidesview").hidden = true;
  $("ribbon").hidden = true;
  $("document").hidden = false;

  const host = $("document");
  host.innerHTML = "";

  if (state.courseTab === "source") return renderCourseSource(host);
  if (state.courseTab === "competencies") return renderCompetencies(host);

  const heading = document.createElement("h2");
  heading.className = "course-heading";
  heading.textContent = "Module";
  host.appendChild(heading);
  const body = document.createElement("div");
  host.appendChild(body);

  const draw = () =>
    courseHome(body, {
      course: courseDoc(),
      rows: courseRows(),
      onChange: (next, opts) => {
        writeCourse(next);
        updateActions();
        if (opts?.structural !== false) draw();
      },
      onOpen: (id) => {
        state.blockId = id;
        state.slideIndex = 0;
        state.courseOpen = false;
        renderOutline();
        renderSlide();
        revealEditor();
      },
      onAddSession: addLesson,
      onAddModule: addModule,
    });
  draw();
}

/** The competency framework — the module's, not a session's. */
function renderCompetencies(host) {
  const heading = document.createElement("h2");
  heading.className = "course-heading";
  heading.textContent = "Competencies";
  host.appendChild(heading);
  const body = document.createElement("div");
  host.appendChild(body);

  const path = "competencies/framework.yaml";
  const read = () => parseYaml(state.edits.get(path) ?? state.files.get(path) ?? "") || {};
  const labels = () => {
    const out = {};
    for (const [id, entry] of Object.entries(read().competencies || {})) {
      out[id] = typeof entry === "string" ? entry : entry?.label ?? id;
    }
    return out;
  };
  const write = (next) => {
    const doc = read();
    state.edits.set(path, stringifyYaml({ ...doc, competencies: next }));
    state.library.competencies = Object.fromEntries(
      Object.entries(next).map(([id, e]) => [id, typeof e === "string" ? e : e.label])
    );
    updateActions();
  };

  const draw = () =>
    competencyEditor(body, {
      competencies: labels(),
      onChange: (id, patch, opts) => {
        const current = read().competencies || {};
        const next = {};
        for (const [key, entry] of Object.entries(current)) {
          const value = typeof entry === "string" ? { label: entry } : { ...entry };
          if (key !== id) {
            next[key] = value;
            continue;
          }
          if (patch.label !== undefined) value.label = patch.label;
          next[patch.id ?? key] = value;
        }
        write(next);
        if (opts?.structural !== false) draw();
      },
      onAdd: () => {
        const current = read().competencies || {};
        const id = freeCompetencyId(new Set(Object.keys(current)));
        write({ ...current, [id]: { label: "" } });
        draw();
      },
      onRemove: (id) => {
        const current = { ...(read().competencies || {}) };
        delete current[id];
        write(current);
        draw();
      },
    });
  draw();

  // Where each competency builds is a module-level question, so the
  // alignment map belongs here rather than in a session.
  host.appendChild(document.createElement("hr"));
  const sub = document.createElement("h3");
  sub.className = "outcome-group";
  sub.textContent = "Where each one builds";
  host.appendChild(sub);
  const panel = document.createElement("div");
  host.appendChild(panel);
  outcomesEditor(panel, {
    outcomes: outcomeList(catalogueDoc()),
    competencies: state.library.competencies,
    blocks: blocksInOrder(),
    owner: outcomeOwners(),
    coverage: outcomeCoverage(),
    onChange: () => {},
    onOwner: setOutcomeOwner,
  });
}

/** course.yaml as text: the orchestrator, edited directly. */
function renderCourseSource(host) {
  const heading = document.createElement("h2");
  heading.className = "course-heading";
  heading.textContent = "course.yaml";
  host.appendChild(heading);
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent =
    "The module's orchestrator: what it is, and which sessions it runs, " +
    "in order. Adding a session from the Module tab writes here too.";
  host.appendChild(note);

  const problem = document.createElement("p");
  problem.className = "warn";
  problem.hidden = true;
  const area = document.createElement("textarea");
  area.className = "mdsource";
  area.spellcheck = false;
  area.setAttribute("aria-label", "course.yaml source");
  area.value = state.edits.get("course.yaml") ?? state.files.get("course.yaml") ?? "";
  area.addEventListener("input", () => {
    state.edits.set("course.yaml", area.value);
    try {
      state.library.course = parseYaml(area.value) || {};
      problem.hidden = true;
    } catch (err) {
      // The text is kept, not reverted: losing an author's work to a
      // half-typed line would be worse than showing them the error.
      problem.hidden = false;
      problem.textContent = err.message;
    }
    updateActions();
  });
  host.append(problem, area);
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
        outcomes: catalogueDoc().outcomes || {},
        onChange,
      });
    }
    renderQuestionList();
  };

  view = questionForm(form, {
    data,
    competencies: state.library.competencies,
    outcomes: catalogueDoc().outcomes || {},
    onChange,
  });
}

/** Refresh just the question list, so a renamed question re-labels. */
function renderQuestionList() {
  const doc = activeDoc();
  if (doc?.editor === "assessment") renderOutline();
}

/**
 * This session's learning outcomes.
 *
 * Written to the repo-wide catalogue and claimed by this block, so the
 * author edits them where they belong while the ids stay unique across
 * the course.
 */
function renderSessionOutcomes(host) {
  const block = currentBlock();
  const draw = () => {
    const owned = new Set(blockOutcomes(block.id));
    sessionOutcomes(host, {
      outcomes: outcomeList(catalogueDoc()).filter((o) => owned.has(o.id)),
      competencies: state.library.competencies,
      coverage: outcomeCoverage(),
      sessionTitle: block.meta?.title || block.id,
      onChange: (list, opts) => {
        // Only this session's outcomes were on screen, so the rest of
        // the catalogue is carried through untouched.
        const others = outcomeList(catalogueDoc()).filter(
          (o) => !list.some((mine) => mine.id === o.id)
        );
        const merged = outcomeDoc([...others, ...list]);
        state.edits.set(OUTCOMES_PATH, stringifyYaml(merged));
        state.library.outcomes = merged;
        updateActions();
        if (opts?.structural !== false) draw();
      },
      onAdd: () => {
        const all = outcomeList(catalogueDoc());
        const id = freeOutcomeId(new Set(all.map((o) => o.id)));
        const merged = outcomeDoc([
          ...all,
          { id, statement: "", develops: [], dok: null },
        ]);
        state.edits.set(OUTCOMES_PATH, stringifyYaml(merged));
        state.library.outcomes = merged;
        setOutcomeOwner(id, block.id, { stay: true });
        draw();
        updateActions();
      },
      onRemove: (id) => {
        const kept = outcomeList(catalogueDoc()).filter((o) => o.id !== id);
        const merged = outcomeDoc(kept);
        state.edits.set(OUTCOMES_PATH, stringifyYaml(merged));
        state.library.outcomes = merged;
        setOutcomeOwner(id, null, { stay: true });
        draw();
        updateActions();
      },
    });
  };
  draw();
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
  const blocking = state.problems.filter((p) => p.level !== "warning").length;
  $("submit").disabled = changed.length === 0 || blocking > 0 || !writable;
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
    // Warnings are gaps in the alignment map: worth seeing, not reasons
    // to stop. Only errors hold Submit back.
    const errors = state.problems.filter((p) => p.level !== "warning");
    const warnings = state.problems.filter((p) => p.level === "warning");
    if (!state.problems.length) {
      strip.innerHTML = '<p class="ok">No problems.</p>';
      status("Checked: no problems.", "ok");
    } else {
      for (const problem of [...errors, ...warnings]) {
        const row = document.createElement("p");
        row.className = problem.level === "warning" ? "problem warn" : "problem";
        row.innerHTML = `<strong>${escapeHtml(problem.where)}</strong> ${escapeHtml(problem.message)}`;
        strip.appendChild(row);
      }
      const parts = [];
      if (errors.length) parts.push(`${errors.length} problem${errors.length === 1 ? "" : "s"}`);
      if (warnings.length) parts.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
      status(`${parts.join(", ")} — see below.`, errors.length ? "error" : "");
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

  $("rail-toggle").addEventListener("click", () => {
    const panes = document.querySelector(".panes");
    setRail(!panes.classList.contains("rail-open"));
  });

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
