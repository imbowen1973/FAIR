// The workbench: open a library repo, edit it, preview the real deck,
// save to a branch, submit a pull request.
//
// State lives in the repo, not here. Everything below is a projection of
// files fetched from git plus the edits not yet committed; closing the
// tab loses only the uncommitted edits, and the app says so.

import {
  brokerProvider,
  patProvider,
  persisting,
  setPersisting,
  signOut,
  storedLogin,
  storedToken,
} from "./auth.js";
import { BROKER_URL, CLIENT_ID } from "./config.js";
import { draftBranch, GitHub, parseRepo, resolveDraftBranch } from "./github.js";
import {
  forgetBranch,
  lastBranch,
  lastRepo,
  rememberBranch,
  rememberRepo,
} from "./prefs.js";
import { decorate } from "./icons.js";
import { needsAsking, relayoutPanel } from "./relayout.js";
import { provisionInto, provisionLibrary, repoNameFrom } from "./provision.js";
import {
  canRedo,
  canUndo,
  newHistory,
  record,
  redo as redoStep,
  undo as undoStep,
} from "./history.js";
import {
  asListType,
  TEXT_ONLY_REGIONS,
  withPlainTitle,
  blankSlide,
  flattenStructure,
  layoutRegions,
  isLibrary,
  layoutKeys,
  libraryPaths,
  placedBlocks,
  readLibrary,
  mintSlideIds,
  applyLayoutChange,
  renderSlidesFile,
  slideMark,
  workingSlides,
} from "./library.js";
import {
  activeBlockIndex,
  activeItemPath,
  drawSlide,
  paintTints,
  selectedItemPaths,
} from "./canvas.js";
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
import { linkFor, prepareUpload, safeName, toBase64 } from "./attach.js";
import {
  appendTo,
  canIndent,
  canMove,
  canOutdent,
  flatten,
  indent,
  insertAfter,
  moveWithinSiblings,
  newContainer,
  outdent,
  removeContainer,
  renameNode,
} from "./structure.js";
import {
  mediaPicker,
  repoImages,
  resolveMedia,
  videoHost,
  videoThumb,
} from "./media.js";
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
import { importPanel } from "./import.js";
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
  documentTemplate,
  hasOutcomesSection,
  refreshOutcomes,
} from "./summary.js";
import {
  attributionEditor,
  competencyEditor,
  courseHome,
  freeCompetencyId,
  repoLogos,
} from "./course.js";

const $ = (id) => document.getElementById(id);

const GEOMETRY_PATH = "layout-geometry.json";

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
  // Undo, per block: a stack of whole snapshots of the slides above.
  // Per block rather than global, so undo never silently jumps you into
  // a different session's deck.
  history: new Map(), // blockId -> {stack, at, lastKey, lastAt}
  // Which document each block was last left on, so switching away and
  // back returns you to the workbook rather than to the deck.
  docByBlock: new Map(), // blockId -> document id
  quizzes: new Map(), // assessment path -> {parsed, working}
  quizIndex: 0,
  // The course itself is a thing you can open, above the blocks: its
  // outcomes are library-wide, so they have no block to belong to.
  courseOpen: false,
  courseTab: "overview",
  tree: [], // every path in the repo, for reusing media already there
  // Object URLs for pending uploads, made once so the canvas does not
  // leak one per repaint or flicker as the image reloads.
  mediaUrls: new Map(),
  problems: [],
};

function status(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`.trim();
  el.hidden = !message;
  // The action bar sticks below the chrome, and the chrome just changed
  // height.
  measureHeader();
}

/** Run work with the button disabled and the status bar showing progress. */
async function busy(button, label, work) {
  const el = $(button);
  // An icon button says what it is with a drawing, not with its text.
  // Replacing the text would delete the icon and leave a word in a
  // 28-pixel square.
  const isIcon = Boolean(el?.querySelector(".icon"));
  const original = isIcon ? null : el?.textContent;
  if (el) {
    el.disabled = true;
    if (!isIcon) el.textContent = label;
  }
  status(`${label}…`, "busy");
  try {
    return await work((message) => status(message || `${label}…`, "busy"));
  } finally {
    if (el) {
      el.disabled = false;
      if (!isIcon) el.textContent = original;
    }
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

/**
 * Tell the stylesheet how tall the header is.
 *
 * The status bar sticks below it, and a hard-coded offset would be wrong
 * the moment the header wraps -- which it does on a narrow screen.
 */
function measureHeader() {
  const header = document.querySelector("header");
  if (!header) return;
  const head = header.getBoundingClientRect().height;
  const bar = document.getElementById("status");
  // The status bar is usually hidden and takes no room; when it is
  // showing, everything below it has to start lower.
  const shown = bar && !bar.hidden ? bar.getBoundingClientRect().height : 0;
  // The action bar sticks below both, so anything scrolled into view has
  // to clear all three or it opens underneath them.
  const actions = document.querySelector(".bar");
  const barHeight =
    actions && !actions.closest("[hidden]") ? actions.getBoundingClientRect().height : 0;
  const root = document.documentElement.style;
  root.setProperty("--header-h", `${Math.round(head)}px`);
  root.setProperty("--chrome-h", `${Math.round(head + shown)}px`);
  root.setProperty("--sticky-h", `${Math.round(head + shown + barHeight)}px`);
  const toolbar = document.getElementById("ribbon");
  const toolbarHeight =
    toolbar && !toolbar.hidden ? toolbar.getBoundingClientRect().height : 0;
  root.setProperty(
    "--toolbar-h",
    `${Math.round(head + shown + barHeight + toolbarHeight)}px`
  );
}
measureHeader();
addEventListener("resize", measureHeader);

// The stage is drawn at a measured pixel width, and the type size is
// scaled from it. CSS keeps it inside its pane when the window changes;
// only a redraw makes the type right again.
let resizeTimer = null;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.library && state.blockId && activeDoc()?.editor === "slides") {
      renderCanvas();
    }
  }, 150);
});

// Enter inside a contenteditable inserts a <div> by default in Chromium
// and Safari. Everything that reads a region back expects paragraphs, and
// a <div> is both unstyled and easy to miss -- so ask for <p> once, here,
// rather than repairing the DOM afterwards on every keystroke.
try {
  document.execCommand("defaultParagraphSeparator", false, "p");
} catch {
  /* older engines: readBlocks copes with whatever they produce */
}

async function afterSignIn(token, login) {
  state.gh = new GitHub(token);
  state.login = login;
  $("who").textContent = login;
  // The button has existed since the beginning and nothing ever showed
  // it, so there was no way out of a session but to clear site data.
  $("signout").hidden = false;
  measureHeader();
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

    // Reopen where the work is. Save writes to a draft branch, and this
    // used to read the default one -- so a reload showed the published
    // version and the morning's work looked lost. It was not lost; it
    // was on a branch nothing was looking at.
    const remembered = lastBranch(owner, repo);
    const branch =
      remembered && remembered !== defaultBranch &&
      (await state.gh.branchExists(owner, repo, remembered))
        ? remembered
        : defaultBranch;
    if (remembered && branch === defaultBranch) forgetBranch(owner, repo);

    // A repository with no commits has no tree at all, and GitHub says so
    // with a 409. That is a repo waiting to be filled, not a failure.
    const paths = await state.gh.pathsOrEmpty(owner, repo, branch);
    state.tree = paths;

    if (!isLibrary(paths)) {
      // Not a dead end. An empty repo, or one with just a README, is
      // exactly what "make it on GitHub first" produces, and the useful
      // answer is to offer to fill it rather than to explain the format.
      offerSetup(owner, repo, paths.length);
      return;
    }

    const wanted = libraryPaths(paths).filter((p) => !p.endsWith(".pptx") && !/\.(png|jpe?g|gif|svg)$/i.test(p));
    const files = new Map();
    let done = 0;
    for (const path of wanted) {
      files.set(path, await state.gh.file(owner, repo, path, branch));
      status(`Reading ${fullName}… ${++done}/${wanted.length}`);
    }

    state.repo = { owner, repo, defaultBranch, branch };
    rememberRepo(`${owner}/${repo}`);
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
    renderBranchNote();
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

/**
 * Ids for `count` new slides in the current deck.
 *
 * Above everything the deck has ever handed out, not the lowest number
 * going spare: an id is burnt into every rendered copy of the slide, so
 * reissuing a deleted one points old artifacts at new content.
 */
function newSlideIds(count = 1) {
  const list = working();
  const block = state.library.blocks.get(state.blockId);
  return mintSlideIds(
    count,
    list.map((w) => w.data.id).filter(Boolean),
    slideMark(block?.parsed, list)
  ).ids;
}

function nextSlideId() {
  return newSlideIds(1)[0];
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
  const opening = openingSlides(newSlideIds(2)).filter((slide) =>
    layouts.includes(slide.layout)
  );
  if (!opening.length) {
    status("This template has no Title or Full layout to build them from.", "error");
    return;
  }
  list.unshift(...opening.map((data) => ({ sourceIndex: null, data, dirty: true })));
  state.slideIndex = 0;
  remember();
  renderOutline();
  renderSlide();
  updateActions();
  revealEditor();
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

/**
 * Bring slides in from outside.
 *
 * Content written elsewhere -- by a colleague, by an older course, by a
 * model asked to draft a session -- has one door into a library, and
 * that door checks against this template before anything is added.
 */
function openImport() {
  revealEditor();
  const host = $("panels");
  const panel = document.createElement("div");
  host.prepend(panel);
  panel.scrollIntoView({ block: "start" });

  const place = (slides, replace) => {
    const list = working();
    const entries = slides.map((data) => ({ sourceIndex: null, data, dirty: true }));
    if (replace) {
      list.splice(0, list.length, ...entries);
      state.slideIndex = 0;
    } else {
      const at = Math.min(list.length, state.slideIndex + 1);
      list.splice(at, 0, ...entries);
      state.slideIndex = at;
    }
    panel.remove();
    remember();
    renderOutline();
    renderSlide();
    updateActions();
    status(
      `${slides.length} slide${slides.length === 1 ? "" : "s"} ` +
        (replace ? "replaced the deck." : "added."),
      "ok"
    );
  };

  importPanel(panel, {
    layoutMap: state.library.layoutMap,
    geometry: state.library.geometry,
    existingIds: working().map((entry) => entry.data?.id).filter(Boolean),
    mark: slideMark(state.library.blocks.get(state.blockId)?.parsed, working()),
    onAdd: (slides) => place(slides, false),
    onReplace: (slides) => {
      if (
        working().length &&
        !window.confirm(
          `Replace all ${working().length} slides in this deck with ${slides.length}?`
        )
      ) return;
      place(slides, true);
    },
    onClose: () => panel.remove(),
  });
}

function addSlide() {
  const layouts = layoutKeys(state.library.layoutMap);
  const list = working();
  // Insert after the slide in focus, which is where an author means it.
  const at = Math.min(list.length, state.slideIndex + 1);
  list.splice(at, 0, blankSlide(layouts.includes("Full") ? "Full" : layouts[0], nextSlideId()));
  state.slideIndex = at;
  remember();
  renderOutline();
  renderSlide();
  updateActions();
  revealEditor();
}

/**
 * Copy a slide, with an id of its own.
 *
 * The id is minted rather than copied: two slides sharing one is a file
 * the renderer refuses outright, and slide-id-map.json is a mapping, so
 * the duplicate would silently take the original's place in every deck
 * already built from it.
 */
function duplicateSlide(index) {
  const list = working();
  const source = list[index];
  if (!source) return;
  const copy = structuredClone(source.data);
  copy.id = newSlideIds(1)[0];
  list.splice(index + 1, 0, { sourceIndex: null, data: copy, dirty: true });
  state.slideIndex = index + 1;
  remember();
  renderOutline();
  renderSlide();
  updateActions();
  status(`Duplicated as ${copy.id}.`, "ok");
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
  remember();
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
  remember();
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
      // Adding a slide and importing live in the ribbon, which is always
      // on screen while a deck is open. What stays here is the one that
      // is occasional and only sometimes offered: the opening pair.
      if (!hasOpeningSlides()) {
        const deckActions = document.createElement("div");
        deckActions.className = "deck-actions";
        const opening = document.createElement("button");
        opening.type = "button";
        opening.className = "add-slide";
        opening.textContent = "+ title and outcomes";
        opening.title =
          "A title slide and a learning outcomes slide, both filled from " +
          "the library rather than typed";
        opening.addEventListener("click", addOpeningSlides);
        deckActions.appendChild(opening);
        group.appendChild(deckActions);
      }

      working(id).forEach((entry, index) => {
        const data = entry.data;
        const row = document.createElement("div");
        row.className = "slide-row";
        // The id, not the position: what addresses this slide in
        // slide-id-map.json and in every deck already rendered from it.
        if (data.id) row.dataset.slideId = data.id;
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
          media: mediaHelpers(),
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
          ["⧉", "duplicate", () => duplicateSlide(index)],
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
function commitSlide(next, { step = null } = {}) {
  const entry = working()[state.slideIndex];
  // One rule, one place. The renderer takes a title as a plain string
  // and nothing else, and there are several ordinary ways to type one
  // that is not -- a second line is enough. Asking each control to
  // remember that is how one of them forgets.
  entry.data = withPlainTitle(next);
  entry.dirty = true;
  remember(step);
  renderOutline();
  updateActions();
}

// ---- undo --------------------------------------------------------------

/** The deck as it stands, deep enough that undo cannot alias it. */
function snapshot(blockId = state.blockId) {
  return {
    slideIndex: state.slideIndex,
    entries: working(blockId).map((e) => ({
      sourceIndex: e.sourceIndex,
      dirty: e.dirty,
      data: structuredClone(e.data),
    })),
  };
}

function historyFor(blockId = state.blockId) {
  if (!state.history.has(blockId)) {
    // Seed with the deck as opened, or the first undo has nothing to go
    // back to and the first edit is unrecoverable.
    state.history.set(blockId, record(newHistory(), snapshot(blockId)));
  }
  return state.history.get(blockId);
}

/**
 * Record the deck after a change.
 *
 * `step` groups keystrokes: successive edits to one region collapse into
 * a single undo step. Structural changes pass null and get their own.
 */
function remember(step = null) {
  if (!state.blockId) return;
  record(historyFor(), snapshot(), step);
  updateHistoryButtons();
}

function restore(snap) {
  if (!snap) return;
  const list = working();
  list.splice(
    0,
    list.length,
    ...snap.entries.map((e) => ({
      sourceIndex: e.sourceIndex,
      dirty: e.dirty,
      data: structuredClone(e.data),
    }))
  );
  state.slideIndex = Math.min(snap.slideIndex, Math.max(0, list.length - 1));
  renderOutline();
  renderSlide();
  updateActions();
  updateHistoryButtons();
}

function undo() {
  const course = state.courseOpen;
  const h = course ? courseHistory() : historyFor();
  if (!canUndo(h)) return status("Nothing to undo.", "");
  const step = undoStep(h);
  if (course) restoreCourse(step);
  else restore(step);
  status("Undone.", "ok");
}

function redo() {
  const course = state.courseOpen;
  const h = course ? courseHistory() : historyFor();
  if (!canRedo(h)) return status("Nothing to redo.", "");
  const step = redoStep(h);
  if (course) restoreCourse(step);
  else restore(step);
  status("Redone.", "ok");
}

// ---- undo, for the running order ---------------------------------------
//
// The history has always been per-block and slide-shaped: remember()
// returns early without a state.blockId, and a snapshot is the deck. So
// rearranging a course was the one bulk edit in the workbench with no
// way back, which is precisely the edit where a mis-click is costly and
// invisible — twenty sessions moved, and one of them now in the wrong
// module with nothing to say so.
//
// The course keeps its own history under a key no block id can collide
// with, and undo/redo route to it while the running order is on screen.

const COURSE_KEY = " course";

const courseSnapshot = () => structuredClone(courseDoc());

function courseHistory() {
  if (!state.history.has(COURSE_KEY)) {
    // Seeded with the course as opened, or the first undo has nothing to
    // go back to and the first move is unrecoverable.
    state.history.set(COURSE_KEY, record(newHistory(), courseSnapshot()));
  }
  return state.history.get(COURSE_KEY);
}

/** Record the course *after* a change, as the deck's history does. */
function rememberCourse(step = null) {
  record(courseHistory(), courseSnapshot(), step);
  updateHistoryButtons();
}

function restoreCourse(doc) {
  if (!doc) return;
  writeCourse(structuredClone(doc));
  renderCourse();
}

/**
 * Apply a change to the running order.
 *
 * Every transform returns the tree it was given when the move cannot be
 * made, so identity says whether anything happened — and a disabled
 * button that somehow fires costs nothing.
 */
function structureOp(fn, { redraw = true, step = null } = {}) {
  const course = courseDoc();
  const current = course.structure ?? [];
  const next = fn(current);
  if (next === current) return;
  writeCourse({ ...course, structure: next });
  rememberCourse(step);
  updateActions();
  if (redraw) renderCourse();
}

function updateHistoryButtons() {
  const h = state.courseOpen
    ? courseHistory()
    : state.blockId
      ? historyFor()
      : null;
  const set = (id, on) => {
    const button = document.getElementById(id);
    if (button) button.disabled = !on;
  };
  set("undo", Boolean(h) && canUndo(h));
  set("redo", Boolean(h) && canRedo(h));
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
    layoutRegions: layoutRegions(state.library.layoutMap, data.layout, state.library.geometry),
  });
}

/**
 * Content on a slide that this layout has no placeholder for.
 *
 * drawSlide has always returned these and both callers threw the value
 * away, so the region simply did not appear: the slide looked finished,
 * the words were still in the file, and the first anyone heard of it was
 * the renderer refusing the deck --
 *
 *   slide 'wp52-25': region 'full' is not declared for layout 'Picture';
 *   expected one of ['caption', 'picture', 'title']
 *
 * -- in a Python traceback, at preview time, naming a slide id rather
 * than a slide anybody can see. It is said here instead, on the slide it
 * belongs to, with the panel that already knows how to move it.
 */
function reportUnplaced(unplaced, data) {
  if (!unplaced || !unplaced.size) return;
  const regions = [...unplaced];
  const host = $("canvas");

  const note = document.createElement("p");
  note.className = "warn";
  note.dataset.unplacedRegions = regions.join(",");
  note.textContent =
    `${regions.join(" and ")} ${regions.length === 1 ? "has" : "have"} content, ` +
    `but the ${data.layout} layout has no placeholder for ` +
    `${regions.length === 1 ? "it" : "them"}. Nothing is lost — it is in the ` +
    "file — but the deck will not render until it has somewhere to go.";

  const fix = document.createElement("button");
  fix.type = "button";
  fix.className = "link";
  fix.id = "fix-unplaced";
  fix.textContent = "Say where it should go";
  fix.addEventListener("click", () => {
    const current = slideData(state.slideIndex);
    const panel = document.createElement("div");
    $("panels").prepend(panel);
    relayoutPanel(panel, {
      slide: current,
      layoutMap: state.library.layoutMap,
      // The layout is not changing: asking what this one does with the
      // slide as it stands is exactly the question, and layoutChange
      // already answers it.
      nextLayout: data.layout,
      onApply: (moves) => {
        panel.remove();
        commitSlide(applyLayoutChange(current, state.library.layoutMap, data.layout, moves));
        renderCanvas();
        renderOutline();
        const moved = Object.entries(moves).filter(([, to]) => to);
        status(
          moved.length
            ? `Moved ${moved.map(([f, t]) => `${f} → ${t}`).join(", ")}.`
            : "Dropped it.",
          "ok"
        );
      },
      onCancel: () => panel.remove(),
    });
  });

  note.append(" ", fix);
  host.appendChild(note);
}

function renderCanvas({ redraw = true } = {}) {
  // A session with no slides yet. There is nothing to draw and nothing
  // wrong: the deck has not been started. Saying anything about layouts
  // or geometry here sends an author to look at the wrong thing.
  if (!working().length) {
    const host = $("canvas");
    host.innerHTML = "";
    const note = document.createElement("p");
    note.className = "empty";
    note.textContent =
      "This session has no slides yet. Add one from the toolbar, or bring " +
      "some in with import.";
    host.appendChild(note);
    $("meta").innerHTML = "";
    return;
  }

  // A slide the file could not be read into. The content is not lost --
  // it is in the commit -- but it is not here, and nothing about the
  // layout or the geometry is wrong. Say which line, so it can be found.
  const broken = working()[state.slideIndex]?.error;
  if (broken) {
    const host = $("canvas");
    host.innerHTML = "";
    const note = document.createElement("p");
    note.className = "empty";
    note.dataset.unreadable = "1";
    note.textContent =
      "This slide could not be read from slides.md, so there is nothing " +
      "to draw. It is not a layout or a template problem. YAML says: " +
      String(broken).split(String.fromCharCode(10))[0] +
      ". Use the clock to open an earlier version, or paste the slide in again.";
    host.appendChild(note);
    $("meta").innerHTML = "";
    return;
  }

  const data = slideData(state.slideIndex);
  const shown = previewData(data);
  // A layout change can take the selected placeholder away without the
  // slide changing. Aiming at a region this layout does not offer is how
  // a picture ends up in a key the renderer will not accept.
  if (activeRegion) {
    const offered = layoutRegions(state.library.layoutMap, data.layout, state.library.geometry);
    if (offered.length && !offered.includes(activeRegion)) activeRegion = null;
  }
  if (redraw) {
    const unplaced = drawSlide($("canvas"), {
      geometry: state.library.geometry,
      layoutKey: data.layout,
      slide: shown,
      derived: roleRegions(data, layoutRegions(state.library.layoutMap, data.layout, state.library.geometry)),
      media: mediaHelpers(),
      attribution: attributionForCanvas(),
      onMedia: openMediaPicker,
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
        commitSlide(next, {
          step: structural ? null : `edit:${state.slideIndex}:${region}`,
        });
        if (structural) renderCanvas();
      },
      onSelectRegion: (region) => {
        activeRegion = region;
        paintListType($("ribbon"), regionType(region));
      },
    });
    reportUnplaced(unplaced, data);
  }
  offerGeometry();
  renderMeta();
}

/**
 * Offer to read the template's geometry when a layout has none.
 *
 * A library can name a layout in layout-map.yaml and have no rectangles
 * for it in layout-geometry.json -- an import validates against the map,
 * so the slide arrives fine and then cannot be drawn. Everything needed
 * to fix that is already here.
 */
function offerGeometry() {
  const note = $("canvas").querySelector("[data-missing-geometry]");
  if (!note || note.querySelector("button")) return;
  if (!state.canWrite) return;

  const row = document.createElement("p");
  const build = document.createElement("button");
  build.type = "button";
  build.id = "build-geometry";
  build.className = "primary";
  build.textContent = "Read it from the template";
  build.addEventListener("click", () =>
    busy("build-geometry", "Reading the template", async (say) => {
      try {
        const files = await withBinaries(say);
        const { buildGeometry } = await import("./preview.js");
        const json = await buildGeometry(files, say);
        state.edits.set(GEOMETRY_PATH, json);
        state.library = readLibrary(pendingFiles());
        updateActions();
        renderOutline();
        renderSlide();
        const count = Object.keys(JSON.parse(json).layouts ?? {}).length;
        status(
          `Read ${count} layouts from the template. Save to commit ` +
            "layout-geometry.json.",
          "ok"
        );
      } catch (err) {
        status(`Could not read the template: ${err.message}`, "error");
      }
    })
  );
  row.appendChild(build);
  note.after(row);
}

/**
 * The slide's identity, meaning and notes.
 *
 * The patch is merged into the slide *as it stands*, never into the copy
 * this panel was built from. That copy goes stale the moment anything is
 * typed on the canvas, and writing it back was silently undoing work.
 */
/**
 * Apply a patch to a live object: `undefined` removes the key.
 *
 * Every editor sends what changed rather than a whole object, because a
 * whole object is always the one the editor was built with — and writing
 * that back throws away everything done since.
 */
function patched(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

function renderMeta() {
  slideMeta($("meta"), {
    slide: slideData(state.slideIndex),
    live: () => slideData(state.slideIndex),
    competencies: state.library.competencies,
    outcomes: catalogueDoc().outcomes || {},
    onChange: (patch, { rebuild = false } = {}) => {
      const next = patched(slideData(state.slideIndex), patch);
      // Notes coalesce into one undo step per burst, as canvas typing
      // does; a chip or a select is its own step.
      commitSlide(next, {
        step: "notes" in patch ? `notes:${state.slideIndex}` : null,
      });
      // Metadata never changes the canvas, so the caret stays put.
      if (rebuild) renderMeta();
    },
  });
}

/**
 * The region as lines that can be formatted one at a time.
 *
 * A paragraph region keeps its lines in a single string, so there is
 * nothing to hang a colour or a marker on and formatting one line
 * formatted the placeholder. A list is the shape the grammar already has
 * for per-line properties, and a list whose lines carry `marker: none`
 * looks exactly like a paragraph -- so that is what a paragraph becomes
 * the moment a line is formatted on its own.
 *
 * Returns null when the region holds no text at all.
 */
function asLines(value) {
  if (value && Array.isArray(value.items)) return value;
  const text = typeof value === "string" ? value : value?.text;
  if (typeof text !== "string") return null;
  const lines = text.split(String.fromCharCode(10));
  return {
    ...(typeof value === "object" && value !== null ? value : {}),
    type: "ul",
    text: undefined,
    items: lines.map((line) => ({ text: line, marker: "none" })),
  };
}

/** Which line the caret is on, for either shape of region. */
function caretLine(box, value) {
  if (!box) return null;
  if (value && Array.isArray(value.items)) {
    const path = activeItemPath(box);
    return path ?? null;
  }
  const at = activeBlockIndex(box);
  return at === null ? null : [at];
}

/**
 * Colour the selected words in place, or report that nothing is selected.
 *
 * Wrapping the selection in a span is how every other inline mark works
 * here: the DOM is edited, the `input` handler reads it back, and the
 * markdown that comes out carries `[words]{accent2}`.
 */
function colourSelection(box, slot) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!box.contains(range.commonAncestorContainer)) return false;

  // Anything already coloured inside the selection is replaced, or
  // colouring over a coloured word would nest and the inner would win.
  const fragment = range.extractContents();
  for (const nested of fragment.querySelectorAll?.("span.tint") ?? []) {
    nested.replaceWith(...nested.childNodes);
  }
  if (slot) {
    const tint = document.createElement("span");
    tint.className = "tint";
    tint.dataset.colour = slot;
    tint.appendChild(fragment);
    range.insertNode(tint);
    // Keep the words selected, so a second colour replaces the first.
    selection.removeAllRanges();
    const after = document.createRange();
    after.selectNodeContents(tint);
    selection.addRange(after);
  } else {
    range.insertNode(fragment);
  }
  return true;
}

/** A copy of `items` with the one at `path` given a marker. */
function markItem(items, path, marker) {
  const [head, ...rest] = path;
  return items.map((item, i) => {
    if (i !== head) return item;
    const asObject = typeof item === "string" ? { text: item } : { ...item };
    if (rest.length) {
      return { ...asObject, items: markItem(asObject.items ?? [], rest, marker) };
    }
    // The older spelling, so a file does not end up carrying both.
    delete asObject.bullet;
    asObject.marker = marker;
    return asObject;
  });
}

/** A copy of `items` with the one at `path` recoloured. */
function colourItem(items, path, slot) {
  const [head, ...rest] = path;
  return items.map((item, i) => {
    if (i !== head) return item;
    const asObject = typeof item === "string" ? { text: item } : { ...item };
    if (rest.length) {
      return { ...asObject, items: colourItem(asObject.items ?? [], rest, slot) };
    }
    if (slot) asObject.color = slot;
    else delete asObject.color;
    // A string that carries nothing but words stays a string: the file
    // should not gain a mapping for a colour that was just cleared.
    return Object.keys(asObject).length === 1 && "text" in asObject
      ? asObject.text
      : asObject;
  });
}

/** The content type of a region on the current slide, or null. */
function regionType(region) {
  if (!region) return null;
  const value = slideData(state.slideIndex)[region];
  return typeof value === "object" && value !== null ? value.type : null;
}

function renderRibbon({ slides = true, steps = slides } = {}) {
  const data = slides ? slideData(state.slideIndex) : {};
  ribbon($("ribbon"), {
    slides,
    steps,
    onSave: save,
    onSubmit: submit,
    onHistory: showHistory,
    layouts: slides ? layoutKeys(state.library.layoutMap) : [],
    layout: data.layout,
    onCommand: () => {
      // The canvas listens for input, but execCommand does not always
      // raise one; read the surface back and commit.
      const box = $("canvas").querySelector(".region[data-editable]:focus-within");
      if (box) box.dispatchEvent(new Event("input", { bubbles: true }));
    },
    onLayout: (key) => {
      const current = slideData(state.slideIndex);
      const change = (next) => {
        commitSlide(next);
        renderCanvas();
        renderRibbon();
        renderOutline();
      };
      // Most changes fit and are silent. One that would leave content
      // with nowhere to go is the one that used to lose it.
      if (!needsAsking(current, state.library.layoutMap, key)) {
        change({ ...current, layout: key });
        return;
      }
      const host = $("panels");
      const panel = document.createElement("div");
      host.prepend(panel);
      relayoutPanel(panel, {
        slide: current,
        layoutMap: state.library.layoutMap,
        nextLayout: key,
        onApply: (moves) => {
          panel.remove();
          change(applyLayoutChange(current, state.library.layoutMap, key, moves));
          const moved = Object.entries(moves).filter(([, to]) => to);
          const dropped = Object.entries(moves).filter(([, to]) => !to);
          status(
            [
              `Layout is now ${key}.`,
              moved.length && moved.map(([f, t]) => `${f} → ${t}`).join(", ") + ".",
              dropped.length && `Dropped ${dropped.map(([f]) => f).join(", ")}.`,
            ]
              .filter(Boolean)
              .join(" "),
            dropped.length ? "error" : "ok"
          );
        },
        onCancel: () => {
          panel.remove();
          // Put the picker back to what the slide actually is.
          renderRibbon();
        },
      });
    },
    onColour: (slot) => {
      const region = activeRegion;
      if (!region) return;
      const current = slideData(state.slideIndex);
      const value = current[region];

      // One line if the caret is in one, the whole placeholder if it is
      // not. Colour was always a property of the region, so selecting a
      // single bullet and picking a colour recoloured every line in the
      // placeholder -- change one, change them all.
      const box = $("canvas").querySelector(`.region[data-region="${region}"]`);

      // Words first. Markdown carries an inline colour, so a selection
      // of two words in the middle of a line is exactly as colourable as
      // the line or the placeholder -- and it is the thing an author
      // reaches for most.
      if (box && colourSelection(box, slot)) {
        // Painted here rather than at the next draw: an inline edit does
        // not redraw the canvas, so the span would carry its slot and no
        // colour until something else happened.
        paintTints(box, state.library.geometry?.theme);
        // The canvas is the truth for the region's text; read it back
        // the way typing does.
        const editable = box.closest("[data-editable]") ?? box;
        editable.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      const path = caretLine(box, value);
      const lined = path ? asLines(value) : null;
      if (lined) {
        const next = { ...lined, items: colourItem(lined.items, path, slot) };
        delete next.text;
        commitSlide({ ...current, [region]: next });
        renderCanvas();
        return;
      }

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
    onMedia: () => {
      // A second press closes it. A button that only ever opens leaves
      // the panel to be dismissed some other way, and there is no other
      // way that is obvious.
      const open = $("panels").querySelector(".media-picker");
      if (open) {
        open.closest("#panels > *")?.remove();
        return;
      }
      const region = activeRegion;
      if (!region) {
        status("Click the region you want the picture in first.", "error");
        return;
      }
      if (TEXT_ONLY_REGIONS.has(region)) {
        status(
          `A ${region} is a single line of text — a picture cannot go there. ` +
            "Choose a content placeholder.",
          ""
        );
        return;
      }
      const current = slideData(state.slideIndex)[region];
      const kind = current?.type === "video" ? "video" : "image";
      openMediaPicker(region, current ?? {}, kind);
    },
    onUndo: undo,
    onRedo: redo,
    onAddSlide: addSlide,
    onImport: openImport,
    // The whole placeholder: is this region a list, and of what kind.
    onListType: (kind) => {
      const region = activeRegion;
      if (!region) return;
      if (kind && TEXT_ONLY_REGIONS.has(region)) {
        status(
          `A ${region} is a single line of text — the renderer will not take ` +
            "a list there. Put the points in a content placeholder instead.",
          ""
        );
        return;
      }
      const current = slideData(state.slideIndex);
      const next = asListType(current[region], kind);
      if (next === current[region]) return; // already that, or not text
      commitSlide({ ...current, [region]: next });
      renderCanvas();
      paintListType($("ribbon"), kind);

      // Say what just happened, and where the other thing lives. This
      // control acting on everything is correct and was still reported
      // as a bug three times: the per-line buttons sit beside it looking
      // identical, so an author who wanted one line had no way to know
      // they had pressed the wrong pair. Only worth saying when there is
      // more than one line -- otherwise the two are the same thing.
      const lines = asLines(next)?.items?.length ?? 0;
      if (lines > 1) {
        status(
          kind
            ? "The whole placeholder is now a list. To mark only some lines, " +
                "select them and use the tinted buttons under “selected lines”."
            : "The whole placeholder is plain lines now. To mark only some, " +
                "select them and use the tinted buttons under “selected lines”.",
          ""
        );
      }
    },

    // The lines the selection touches, which is how one placeholder
    // holds a lead-in, then the points, then the line that closes them.
    // Separate from onListType because one control doing both was
    // ambiguous, and it broke the other: choosing "no list" marked a
    // single line rather than turning the placeholder back into plain
    // text, and there was then no way to do the latter at all.
    onLineMarker: (marker) => {
      const region = activeRegion;
      if (!region) return;
      const current = slideData(state.slideIndex);
      const value = current[region];
      const box = $("canvas").querySelector(`.region[data-region="${region}"]`);
      const lined = asLines(value);
      if (!lined) {
        status("There is nothing in this placeholder to mark.", "");
        return;
      }
      // Every line the selection touches, whichever shape the region was
      // in: a paragraph becomes a list of unmarked lines so that one of
      // them can differ from the rest.
      const paths = value?.items
        ? selectedItemPaths(box)
        : [caretLine(box, value)].filter(Boolean);
      if (!paths.length) {
        status("Put the caret in a line first.", "");
        return;
      }
      let items = lined.items;
      for (const path of paths) items = markItem(items, path, marker);
      const next = { ...lined, items };
      delete next.text;
      commitSlide({ ...current, [region]: next });
      renderCanvas();
    },
  });
  paintSwatches($("ribbon"), state.library.geometry?.theme);
  paintListType($("ribbon"), regionType(activeRegion));
  updateHistoryButtons();
  measureHeader();
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

/**
 * Write block.yaml back.
 *
 * Takes a patch and merges it into the file as it stands -- `undefined`
 * removes a key -- so two fields edited in a row cannot overwrite each
 * other.
 */
function setBlockMeta(patch) {
  const { path, data } = blockMeta();
  const next = patched(data, patch);
  state.edits.set(path, stringifyYaml(next));
  // The library's own copy of the meta, so tabs redraw from it at once.
  currentBlock().meta = next;
  updateActions();
  return next;
}

function setBlockResources(resources) {
  return setBlockMeta({ resources });
}

/** Add a document of `kind` to this block, file and manifest together. */
/** A file name from what the author called it. */
function fileNameFor(title, kind) {
  const stem =
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || kind;
  const ext = (KINDS[kind]?.file ?? `${kind}.md`).replace(/^[^.]*/, "");
  return `${stem}${ext}`;
}

function addDocument(kind, { title: given } = {}) {
  const block = currentBlock();
  const taken = new Set(documents().map((d) => d.id));
  // Named by the author, so two workbooks are told apart in the strip
  // and in block.yaml rather than being "Workbook" and "Workbook 2".
  const title = (given || "").trim() || KINDS[kind]?.label || kind;
  const file = given
    ? freePath(kind, taken, fileNameFor(given, kind))
    : freePath(kind, taken);
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
  // Every markdown kind goes through one template function, so a new
  // kind gets a shape by being added there rather than special-cased
  // here.
  return documentTemplate({
    kind,
    title,
    block: {
      id: block.id,
      title: block.meta.title,
      code: block.meta.code,
      duration: block.meta.duration_minutes,
    },
    outcomes: ownedOutcomes(block.id),
    documents: documents().filter((d) => d.type !== kind),
  });
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
        { id: "funding", title: "Funding", type: "course" },
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
    onAdd: (kind, opts) =>
      kind === "attachment" ? attachFile() : addDocument(kind, opts),
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
  $("ribbon").hidden = false;
  // Rendered either way: on a document tab it carries only Save and
  // Submit, which are not slide actions and must not disappear with the
  // slide editor.
  if (!slides) {
    renderRibbon({ slides: false });
    }
  $("sidebar").hidden = !slides;

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

/** The recipe's rows, with each session's facts attached for the cards. */
function courseRows() {
  const rows = flatten(courseDoc().structure);
  const placed = new Set(rows.filter((r) => r.kind === "block").map((r) => r.block));
  for (const id of state.library.blocks.keys()) {
    // On disk, but the running order does not mention it. Marked rather
    // than given a position, because it has none: showing it at the top
    // with an empty path made every control on it a lie.
    if (!placed.has(id)) rows.push({ kind: "block", block: id, depth: 0, unplaced: true });
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
  $("sidebar").hidden = true;
  $("document").hidden = false;

  // Save, history, undo and redo belong here too. Hiding the whole
  // toolbar meant rearranging a course -- the one bulk edit in the tool
  // -- happened with no Save in front of you and no way back.
  $("ribbon").hidden = false;
  renderRibbon({ slides: false, steps: true });
  // Seed the history before anything can change it, so the first undo
  // has the course as it was opened to go back to.
  courseHistory();
  updateHistoryButtons();

  const host = $("document");
  host.innerHTML = "";

  if (state.courseTab === "source") return renderCourseSource(host);
  if (state.courseTab === "funding") return renderFunding(host);
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
      onChange: (patch, opts) => {
        writeCourse(patched(courseDoc(), patch));
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
      structure: courseDoc().structure ?? [],
      onMove: (path, delta) => structureOp((t) => moveWithinSiblings(t, path, delta)),
      onIndent: (path) => structureOp((t) => indent(t, path)),
      onOutdent: (path) => structureOp((t) => outdent(t, path)),
      onRemoveHeading: (path) => structureOp((t) => removeContainer(t, path)),
      onAddModuleAt: (path) => structureOp((t) => insertAfter(t, path, newContainer())),
      // Typing a heading's name must not redraw the row underneath the
      // caret, and a burst of keystrokes is one undo step, not forty.
      onHeading: (path, patch) =>
        structureOp((t) => renameNode(t, path, patch), {
          redraw: false,
          step: `heading:${path.join(".")}`,
        }),
      onPlace: (block) => structureOp((t) => appendTo(t, [], { block })),
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

/**
 * Funding and attribution: what goes on every slide.
 *
 * Repo level, beside the competency framework, because a grant covers a
 * course rather than a session.
 */
function renderFunding(host) {
  const heading = document.createElement("h2");
  heading.className = "course-heading";
  heading.textContent = "Funding and attribution";
  host.appendChild(heading);
  const body = document.createElement("div");
  host.appendChild(body);

  const path = "attribution.yaml";
  const read = () => parseYaml(state.edits.get(path) ?? state.files.get(path) ?? "") || {};
  const write = (next) => {
    // An empty credit line means no stamp at all, and the renderer reads
    // that from the file being absent rather than from an empty string.
    const cleaned = { ...next };
    for (const [key, value] of Object.entries(cleaned)) {
      if (value === "" || value === null || value === undefined) delete cleaned[key];
    }
    state.edits.set(path, cleaned.text ? stringifyYaml(cleaned) : "");
    updateActions();
  };

  const draw = () =>
    attributionEditor(body, {
      config: read(),
      logos: repoLogos([...state.tree, ...state.uploads.keys()]),
      // Emblems live at the repo root, not inside a block.
      resolve: (src) =>
        resolveMedia(src.startsWith("branding/") ? src : `branding/${src}`, {
          blockId: "",
          repo: state.repo,
          uploads: state.uploads,
          urls: state.mediaUrls,
        }),
      onChange: (patch, opts) => {
        write(patched(read(), patch));
        if (opts?.structural !== false) draw();
      },
      onClear: () => {
        const next = { ...read() };
        delete next.logo;
        write(next);
        draw();
      },
      onUpload: async (file) => {
        try {
          // Kept exactly as supplied. A photograph is resized and
          // re-encoded; an emblem must not be, because most of them carry
          // rules forbidding alteration -- the EU's among them.
          const name = safeName(file.name);
          const logo = `branding/${name}`;
          state.uploads.set(logo, new Uint8Array(await file.arrayBuffer()));
          write({ ...read(), logo });
          draw();
          status(`${name} added, unaltered.`, "ok");
        } catch (err) {
          status(err.message, "error");
        }
      },
    });
  draw();
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

// ---- media -------------------------------------------------------------
//
// A picture is the one thing on a slide whose effect cannot be judged
// from its file path, so the canvas shows it. Three ways one arrives:
// uploaded through the asset policy, reused from the repo, or linked.
// All three land in a placeholder the template defines.

/** The funder stamp, as the canvas needs it: config plus a logo URL. */
function attributionForCanvas() {
  const text = state.edits.get("attribution.yaml") ?? state.files.get("attribution.yaml") ?? "";
  let config;
  try {
    config = parseYaml(text) || {};
  } catch {
    return null; // half-typed YAML is not worth a broken canvas
  }
  if (!config.text) return null;
  const logo = config.logo
    ? resolveMedia(config.logo.startsWith("branding/") ? config.logo : `branding/${config.logo}`, {
        blockId: "",
        repo: state.repo,
        uploads: state.uploads,
        urls: state.mediaUrls,
      })
    : null;
  return { ...config, logoUrl: logo };
}

/** How the canvas turns a slide's src or url into something loadable. */
function mediaHelpers() {
  return {
    resolve: (src) =>
      resolveMedia(src, {
        blockId: state.blockId,
        repo: state.repo,
        uploads: state.uploads,
        urls: state.mediaUrls,
      }),
    thumb: (url) => videoThumb(url),
    host: (url) => videoHost(url),
  };
}

/** Images already in the repo, plus any staged but not yet committed. */
function availableImages() {
  const staged = [...state.uploads.keys()].filter((p) => /\.(png|jpe?g|gif|webp|svg)$/i.test(p));
  return [...new Set([...repoImages(state.tree), ...staged])];
}

/**
 * A media src as this block spells it.
 *
 * An upload writes `media/x.jpg` — relative to the block, which is how
 * the renderer resolves it. The picker offers every image in the
 * library and hands back the repo path, so choosing one already in this
 * block wrote `blocks/<id>/media/x.jpg`, and the renderer then looked
 * under `blocks/<id>/blocks/<id>/media/x.jpg` and refused the slide.
 *
 * The canvas draws both, which is why this survived: the picture
 * appeared, and the deck would not build.
 *
 * An image from another block keeps its full path — that is the only
 * way to say it, and the renderer now resolves it from the library root.
 */
function blockRelative(next) {
  const src = next?.src;
  if (typeof src !== "string" || !state.blockId) return {};
  const mine = `blocks/${state.blockId}/`;
  return src.startsWith(mine) ? { src: src.slice(mine.length) } : {};
}

/** Fill a placeholder: a panel above the slide, not a modal. */
function openMediaPicker(region, value, kind) {
  const host = $("panels");
  const panel = document.createElement("div");
  host.prepend(panel);
  panel.scrollIntoView({ block: "start" });

  const set = (next) => {
    const current = slideData(state.slideIndex);
    commitSlide({ ...current, [region]: next });
    renderCanvas();
    updateActions();
  };

  mediaPicker(panel, {
    region,
    kind,
    images: availableImages(),
    resolve: mediaHelpers().resolve,
    current: value,
    onFit: (fit) => {
      const now = slideData(state.slideIndex)[region];
      // Nothing to fit yet: remember it so the next picture arrives the
      // way the author already said they wanted it.
      set(typeof now === "object" && now ? { ...now, fit } : { ...value, fit });
    },
    onPick: (next) =>
      set({ ...(value?.fit ? { fit: value.fit } : {}), ...next, ...blockRelative(next) }),
    onClear: () => {
      const current = { ...slideData(state.slideIndex) };
      delete current[region];
      commitSlide(current);
      renderCanvas();
      updateActions();
    },
    onUpload: async (files) => {
      try {
        const upload = await prepareUpload(files[0]);
        if (!upload.isImage) {
          status("That is not a picture. Attach it to a document instead.", "error");
          return;
        }
        const rel = `${MEDIA_DIR}/${upload.name}`;
        const path = `blocks/${state.blockId}/${rel}`;
        state.uploads.set(path, upload.bytes);
        // Declared as well as committed, so the catalog carries it and a
        // portal can find the picture the slide uses.
        setBlockResources(
          withResource(blockMeta().data.resources, {
            type: "image",
            title: files[0].name,
            path: rel,
          })
        );
        set({ type: "image", src: rel });
        status(
          `${upload.name} added — resized and metadata stripped` +
            (upload.note ? `, and ${upload.note}` : "") +
            ".",
          "ok"
        );
      } catch (err) {
        status(err.message, "error");
      }
    },
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
    // What changes the form's own shape: a row added or removed, and the
    // toggles that reveal or hide a field. Anything else is typing, and
    // rebuilding then would cost the caret.
    const structural =
      (next.answers?.length ?? 0) !== (entry.data?.answers?.length ?? 0) ||
      (next.hints?.length ?? 0) !== (entry.data?.hints?.length ?? 0) ||
      next.single !== entry.data?.single ||
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
/**
 * The session's own facts: what it is called, its code, how long it runs.
 *
 * These fill the title slide, and until now nothing could change them.
 * The subtitle on a `role: title` slide is `code · N minutes` taken from
 * block.yaml, and the canvas marks it derived so it cannot be typed over
 * -- correctly, or it would drift from the session it describes. But
 * with no editor for block.yaml either, it was simply unreachable: text
 * on a slide that no part of the tool could change.
 */
function sessionDetails(host) {
  const meta = currentBlock()?.meta ?? {};
  const wrap = document.createElement("div");
  wrap.className = "session-details";

  const heading = document.createElement("h3");
  heading.className = "outcome-group";
  heading.textContent = "This session";
  wrap.appendChild(heading);

  wrap.appendChild(
    Object.assign(document.createElement("p"), {
      className: "hint",
      textContent:
        "The title slide is filled from these, which is why it cannot be " +
        "typed over on the canvas — change them here and every deck that " +
        "opens on this session follows.",
    })
  );

  const row = document.createElement("div");
  row.className = "meta-row";

  const add = (key, label, hint, { type = "text", min } = {}) => {
    const field = document.createElement("div");
    field.className = `meta-field${key === "title" ? " grow" : ""}`;
    const id = `session-${key}`;
    const tag = document.createElement("label");
    tag.htmlFor = id;
    tag.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.className = "text";
    input.type = type;
    if (min !== undefined) input.min = String(min);
    input.value = meta[key] ?? "";
    input.placeholder = hint;
    input.addEventListener("input", () => {
      const raw = input.value.trim();
      const value =
        raw === "" ? undefined : type === "number" ? Number(raw) : raw;
      setBlockMeta({ [key]: value });
      // The title slide and the rail caption both read this.
      renderOutline();
      renderTabs();
    });
    field.append(tag, input);
    row.appendChild(field);
  };

  add("title", "Session title", "What this session is called");
  add("code", "Code", "V130, optional");
  add("duration_minutes", "Minutes", "45", { type: "number", min: 1 });

  wrap.appendChild(row);
  host.appendChild(wrap);
  host.appendChild(document.createElement("hr"));
}

function renderSessionOutcomes(host) {
  const block = currentBlock();
  // Two panels, because sessionOutcomes clears the host it is given and
  // would take the details with it.
  const details = document.createElement("div");
  const panel = document.createElement("div");
  host.append(details, panel);
  sessionDetails(details);

  const draw = () => {
    const owned = new Set(blockOutcomes(block.id));
    sessionOutcomes(panel, {
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
  link.href = `https://github.com/${owner}/${repo}/blob/${workingBranch()}/${doc.path}`;
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
  // The selection belongs to a region on a slide, so moving to another
  // slide ends it. It never used to: activeRegion was set once and kept
  // for the session, so the picture button on a new slide aimed at a
  // placeholder from the last one -- which the new layout may not even
  // have, giving the renderer a region it refuses.
  activeRegion = null;
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
    out.set(path, renderSlidesFile(block.parsed, list, block));
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

/** The branch being worked on: a draft once saved, else the published one. */
function workingBranch() {
  return state.repo?.branch || state.repo?.defaultBranch;
}

/**
 * Say which branch is open, and offer the way back.
 *
 * Reopening on a draft is what an author wants and is also a thing they
 * have to be able to see -- otherwise "why does this not match GitHub"
 * has no answer on screen.
 */
function renderBranchNote() {
  const host = document.getElementById("branch-note");
  if (!host || !state.repo) return;
  const { owner, repo, defaultBranch } = state.repo;
  const branch = workingBranch();
  host.innerHTML = "";
  if (branch === defaultBranch) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const name = document.createElement("code");
  name.textContent = branch;
  const back = document.createElement("button");
  back.type = "button";
  back.className = "link";
  back.textContent = `open ${defaultBranch}`;
  back.title = `Discard nothing — reopen the published ${defaultBranch}`;
  back.addEventListener("click", () => {
    if (dirty() && !confirm("You have unsaved changes. Switch branch anyway?")) return;
    forgetBranch(owner, repo);
    openRepo(`${owner}/${repo}`);
  });
  host.append(document.createTextNode("editing "), name, back);
}

function updateActions() {
  const changed = changedFiles();
  $("dirty").textContent = changed.length
    ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed`
    : "no changes";
  const writable = state.canWrite !== false;
  const blocking = state.problems.filter((p) => p.level !== "warning").length;
  const why = !writable ? "This token cannot push to this repository." : "";
  // The toolbar is drawn only once a library is open, so these are
  // absent for the whole of the sign-in screen.
  const saveButton = document.getElementById("save");
  const submitButton = document.getElementById("submit");
  if (saveButton) {
    saveButton.disabled = changed.length === 0 || !writable;
    saveButton.classList.toggle("urgent", !saveButton.disabled);
    if (why) saveButton.title = why;
  }
  if (submitButton) {
    submitButton.disabled = changed.length === 0 || blocking > 0 || !writable;
    if (why) submitButton.title = why;
  }
  renderBranchNote();
}


// ---- validate and preview ---------------------------------------------

/**
 * One reported problem, as something to act on.
 *
 * `where` is a block id, or `block/slide-id`, or a file at the library
 * root. Printed as text it named a slide by an id that appears nowhere
 * on screen — the rail shows titles — so finding the slide meant reading
 * the file. Where it names something this workbench can open, it opens
 * it.
 */
function problemRow(problem) {
  const row = document.createElement("p");
  row.className = problem.level === "warning" ? "problem warn" : "problem";

  const where = String(problem.where ?? "");
  const [blockId, slideId] = where.split("/");
  const block = state.library.blocks.get(blockId);

  if (!block) {
    const label = document.createElement("strong");
    label.textContent = where;
    row.append(label, " ", problem.message);
    return row;
  }

  const link = document.createElement("button");
  link.type = "button";
  link.className = "link problem-where";
  // The block's own title, and the slide's if there is one: an id is
  // what the file calls it, not what the author does.
  const slides = state.working.get(blockId) ?? workingSlides(block.parsed);
  const at = slideId ? slides.findIndex((e) => e.data?.id === slideId) : -1;
  const slideTitle = at >= 0 ? String(slides[at].data.title ?? "").slice(0, 40) : "";
  link.textContent =
    at >= 0
      ? `${block.meta?.title || blockId} — slide ${at + 1}${slideTitle ? `: ${slideTitle}` : ""}`
      : block.meta?.title || blockId;
  link.title = where;
  link.addEventListener("click", () => {
    state.blockId = blockId;
    state.slideIndex = at >= 0 ? at : 0;
    state.courseOpen = false;
    renderOutline();
    renderSlide();
    revealEditor();
  });

  row.append(link, " ", problem.message);
  return row;
}

async function runValidate() {
  try {
    await busy("validate", "Checking", async (report) => {
      // The same files Preview renders from, pictures included. Checking
      // pendingFiles alone meant checking a library with no images in
      // it, so every picture a block declared was reported missing —
      // four of them, all present in the repository, none actionable.
      state.problems = await validate(await withBinaries(report), report);
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
        strip.appendChild(problemRow(problem));
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
  const { owner, repo } = state.repo;
  const branch = workingBranch();
  const files = pendingFiles();
  const paths = await state.gh.tree(owner, repo, branch);
  const binaries = libraryPaths(paths).filter((p) => !files.has(p));

  let done = 0;
  for (const path of binaries) {
    if (state.binaries?.has(path)) {
      files.set(path, state.binaries.get(path));
    } else {
      report(`Fetching ${path.split("/").pop()} (${++done}/${binaries.length})`);
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
      );
      if (!res.ok) throw new Error(`cannot fetch ${path} (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      state.binaries = state.binaries ?? new Map();
      state.binaries.set(path, bytes);
      files.set(path, bytes);
    }
  }

  // Pictures added in this session and not yet committed. They are held
  // apart from pendingFiles because that set is what gets written as
  // text, and these are bytes — but a slide referring to one is not
  // wrong just because the commit has not happened.
  for (const [path, bytes] of state.uploads) files.set(path, bytes);
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
  const branch = await resolveDraftBranch(state.gh, owner, repo, state.login);

  try {
    const saveButton = document.getElementById("save");
    if (saveButton) saveButton.disabled = true;
    status(`Saving to ${branch}…`);
    const created = await state.gh.ensureBranch(owner, repo, branch, defaultBranch);
    // Set if the commit had to be rebuilt on a head that arrived while
    // this save was in flight, so the report can say so.
    let rebasedOnto = null;
    state.gh.onRebased = (_, sha) => {
      rebasedOnto = sha;
    };
    const message =
      `Edit ${state.blockId}\n\n` +
      changed.map((f) => `- ${f.path}`).join("\n");
    const sha = await state.gh.commit(owner, repo, branch, message, changed);

    // The commit is now the truth: adopt it as the baseline so a second
    // save does not re-send unchanged files.
    //
    // Text only. An uploaded picture travels as `base64` and has no
    // `content`, so this stored `undefined` against its path — and the
    // next Check mounted that into Pyodide and died with "Unsupported
    // data type", naming nothing. The bytes are adopted below instead.
    for (const file of changed) {
      if (typeof file.content === "string") state.files.set(file.path, file.content);
    }
    for (const [path, bytes] of state.uploads) {
      state.files.set(path, bytes);
      if (!state.tree.includes(path)) state.tree.push(path);
    }
    // They are in the commit now, so they are not pending any more.
    state.uploads = new Map();
    state.working = new Map();
    state.edits = new Map();
    state.library = readLibrary(state.files);

    state.gh.onRebased = null;
    // So the next visit opens here rather than on the published version.
    rememberBranch(owner, repo, branch);
    state.repo.branch = branch;

    renderOutline();
    renderSlide();
    renderBranchNote();
    status(
      rebasedOnto
        ? `Saved to ${branch} (${sha.slice(0, 7)}). The branch had moved while ` +
            "this was saving, so your files went on top of what was already " +
            "there — anything you did not touch is untouched."
        : `Saved to ${branch} (${sha.slice(0, 7)})${created ? " — branch created" : ""}.`,
      "ok"
    );
    return true;
  } catch (err) {
    // The raw API text for this one is "Update is not a fast forward"
    // against a URL-encoded ref, which says nothing about what happened
    // or what to do. It means the branch moved while the save was in
    // flight and could not be caught up.
    const moved = err.status === 422 && /fast forward/i.test(err.message ?? "");
    status(
      moved
        ? `${branch} moved while this was saving, and kept moving — another ` +
            "tab, another person, or a merge on GitHub. Nothing here is lost: " +
            "press Save again, or use Submit to open a branch of your own."
        : `Save failed: ${err.message}`,
      "error"
    );
    return false;
  } finally {
    updateActions();
  }
}

async function submit() {
  const { owner, repo, defaultBranch } = state.repo;
  const branch = await resolveDraftBranch(state.gh, owner, repo, state.login);
  try {
    // No point asking for a pull request against a branch that never landed.
    if (changedFiles().length && !(await save())) return;
    const existing = await state.gh.pullForBranch(owner, repo, branch);
    if (existing) {
      status(`Already open for review: ${existing.html_url}`, "ok");
      window.open(existing.html_url, "_blank", "noopener");
      return;
    }
    const pull = await state.gh.openPull(owner, repo, {
      head: branch,
      base: defaultBranch,
      // The branch holds everything this author has changed in the
      // library, which may be several sessions.
      title: `Update ${state.library.course.title || repo}`,
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

/**
 * What has happened to this session, and a way back into any of it.
 *
 * A link to github.com was not history, it was a way of leaving. What an
 * author wants is the version itself: to read what a slide said last
 * Tuesday, or to take back a change made three commits ago. So each
 * entry loads that commit's files into the editor, as unsaved changes --
 * nothing is written and nothing is reverted in the repository. Saving
 * is still the only thing that writes, which makes looking safe.
 */
async function showHistory() {
  const { owner, repo } = state.repo;
  const block = state.library.blocks.get(state.blockId);
  const host = $("problems");
  try {
    const commits = await state.gh.commits(owner, repo, {
      branch: workingBranch(),
      path: block.slidesPath ?? `blocks/${block.id}`,
      limit: 20,
    });
    host.innerHTML = "";
    const heading = document.createElement("h3");
    heading.textContent = `History of ${block.meta?.title || block.id}`;
    host.appendChild(heading);
    if (!commits.length) {
      host.appendChild(
        Object.assign(document.createElement("p"), {
          className: "hint",
          textContent: "Nothing committed here yet.",
        })
      );
      return;
    }
    host.appendChild(
      Object.assign(document.createElement("p"), {
        className: "hint",
        textContent:
          "Open one to load it into the editor as unsaved changes. Nothing " +
          "is written until you Save, so looking costs nothing — and Undo " +
          "takes you back to where you were.",
      })
    );

    for (const commit of commits) {
      const row = document.createElement("div");
      row.className = "commit";
      const when = new Date(commit.commit.author.date).toLocaleString();

      const open = document.createElement("button");
      open.type = "button";
      open.className = "link commit-open";
      open.textContent = commit.sha.slice(0, 7);
      open.title = "Load this version into the editor";
      open.addEventListener("click", () => loadVersion(commit));
      row.appendChild(open);

      row.appendChild(
        Object.assign(document.createElement("span"), {
          className: "commit-message",
          textContent: " " + commit.commit.message.split(String.fromCharCode(10))[0],
        })
      );
      row.appendChild(
        Object.assign(document.createElement("span"), {
          className: "muted",
          textContent: ` ${commit.commit.author.name} · ${when} `,
        })
      );

      const away = document.createElement("a");
      away.href = commit.html_url;
      away.target = "_blank";
      away.rel = "noopener";
      away.className = "muted";
      away.textContent = "on GitHub";
      row.appendChild(away);
      host.appendChild(row);
    }
    // Pressing History should show you the history. The panel lives
    // below the panes, so without this it opened off the bottom of the
    // screen and nothing appeared to happen.
    host.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (err) {
    status(err.message, "error");
  }
}

/**
 * Load one commit's version of this session into the editor.
 *
 * As unsaved changes, deliberately. A history that reverted the
 * repository would make reading it dangerous; this way the worst that
 * can happen is a Save you did not mean, and Undo is already there.
 */
async function loadVersion(commit) {
  const { owner, repo } = state.repo;
  const block = state.library.blocks.get(state.blockId);
  const sha = commit.sha;
  await busy("history", "Loading", async (say) => {
    try {
      // Only this session's files: a commit may touch the whole library,
      // and pulling all of it back would undo work in other sessions.
      const prefix = `blocks/${block.id}/`;
      const paths = (await state.gh.tree(owner, repo, sha)).filter((p) =>
        p.startsWith(prefix)
      );
      if (!paths.length) {
        status(`${sha.slice(0, 7)} has nothing for this session.`, "error");
        return;
      }
      let done = 0;
      const loaded = new Map();
      for (const path of paths) {
        loaded.set(path, await state.gh.file(owner, repo, path, sha));
        say(`Loading ${sha.slice(0, 7)}… ${++done}/${paths.length}`);
      }

      // Into the pending edits, which is what the editor reads and what
      // a Save would send. state.files stays as the branch has it, so
      // the change count is honest about what would be written.
      for (const [path, text] of loaded) {
        if (state.files.get(path) === text) state.edits.delete(path);
        else state.edits.set(path, text);
      }
      state.working.delete(state.blockId);
      state.library = readLibrary(pendingFiles());
      state.slideIndex = 0;
      renderTabs();
      renderOutline();
      renderSlide();
      updateActions();
      const changed = [...loaded.keys()].filter((p) => state.edits.has(p)).length;
      status(
        changed
          ? `Loaded ${sha.slice(0, 7)}: ${changed} file${changed === 1 ? "" : "s"} ` +
            "differ from the branch. Nothing is written until you Save."
          : `${sha.slice(0, 7)} is identical to what you have.`,
        "ok"
      );
    } catch (err) {
      status(`Could not load ${sha.slice(0, 7)}: ${err.message}`, "error");
    }
  });
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
    // Straight back to work. Signing in and then being asked which
    // library, every time, is a question with the same answer.
    const previous = lastRepo();
    if (previous) await openRepo(previous);
  }
}

$("broker-signin").addEventListener("click", () => broker.start());
// Set before signing in, so the very first token lands in the store the
// author chose rather than being moved there afterwards.
const persist = $("pat-persist");
if (persist) {
  persist.checked = persisting();
  persist.addEventListener("change", () => {
    if (!setPersisting(persist.checked)) {
      persist.checked = false;
      status("This browser will not let the page store anything.", "error");
      return;
    }
    status(
      persist.checked
        ? "The token will be kept on this device until you sign out."
        : "The token is held for this tab only.",
      "ok"
    );
  });
}

$("pat-signin").addEventListener("click", signInWithToken);
$("pat").addEventListener("keydown", (e) => {
  if (e.key === "Enter") signInWithToken();
});
/**
 * Forget the token and ask for another.
 *
 * Everything the workbench holds is either in the repository or on its
 * way there, except unsaved edits -- which live only in this tab and go
 * with it. Signing out is the one action here that can lose work without
 * touching a file, so it asks first.
 *
 * The reload is the point rather than laziness: it drops the in-memory
 * GitHub client, the working copies, the pending uploads and the undo
 * history in one go. Unpicking those by hand is how a signed-out tab
 * ends up still holding the last user's draft.
 */
function signOutNow() {
  if (
    dirty() &&
    !confirm(
      "You have unsaved changes, and they are only in this tab. " +
        "Sign out and lose them?"
    )
  ) return;
  signOut();
  rememberRepo(null);
  location.reload();
}

$("signout").addEventListener("click", signOutNow);
$("open").addEventListener("click", () => openRepo($("repo").value));
$("repo-switch").addEventListener("change", (e) => {
  if (dirty() && !confirm("You have unsaved changes. Switch library anyway?")) {
    e.target.value = `${state.repo.owner}/${state.repo.repo}`;
    return;
  }
  openRepo(e.target.value);
});

// Save, History and Submit draw their own icons in the toolbar.
for (const [id, name] of [
  ["validate", "check"],
  ["preview", "preview"],
  ["open", "open"],
  ["open-manual", "open"],
]) {
  decorate($(id), name);
}
/** Whether the browser's own undo should have this keystroke instead. */
function inTextSurface(node) {
  const el = node instanceof Element ? node : node?.parentElement;
  return Boolean(el?.closest('input, textarea, [contenteditable="true"]'));
}

/**
 * A form field, as opposed to the slide itself.
 *
 * A shortcut that acts on the deck should still work while an author is
 * typing on a slide -- PowerPoint's do -- but not while they are filling
 * in a repository name or pasting into the import box, where the deck
 * changing under them would take the focus with it.
 */
function inFormField(node) {
  const el = node instanceof Element ? node : node?.parentElement;
  return Boolean(el?.closest("input, textarea"));
}

document.addEventListener("keydown", (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (!meta || e.altKey) return;
  const key = e.key.toLowerCase();
  const onADeck = Boolean(state.blockId) && activeDoc()?.editor === "slides";

  if (key === "z") {
    if (!onADeck) return;
    // Typing has its own undo, and it is the right one: it restores the
    // caret as well as the words.
    if (inTextSurface(e.target)) return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }

  // PowerPoint's own shortcut for a new slide, and it works there while
  // the caret is in a placeholder -- so it works here too. Only a form
  // field is excluded.
  if (key === "m") {
    if (!onADeck || inFormField(e.target)) return;
    e.preventDefault();
    addSlide();
  }
});

// ---- starting a library ------------------------------------------------
//
// Two ways in, one form. Either the repository does not exist and gets
// created, or it exists and is empty -- which is what somebody who made
// it on GitHub first arrives with -- and only what is missing is added.

/** The repo to fill, when setting one up rather than creating one. */
let setupTarget = null;

/** Offer to fill a repo that turned out not to be a library. */
function offerSetup(owner, repo, fileCount) {
  // Offering to fill a repository this token cannot push to would fail
  // on the first write, after the seed had been fetched and the author
  // had filled in a form. Say it now instead.
  if (!state.canWrite) {
    setupTarget = null;
    $("setup-offer").hidden = true;
    status(
      `${owner}/${repo} is not a library, and this token cannot push to it. ` +
        "Give the token Contents: read and write for this repository — and if " +
        `${owner} is an organisation, have it approve the token.`,
      "error"
    );
    return;
  }
  setupTarget = { owner, repo };
  status(
    fileCount === 0
      ? `${owner}/${repo} is empty. It can be set up as a library.`
      : `${owner}/${repo} is not a library yet. It can be set up as one, ` +
        "keeping everything already in it.",
    ""
  );
  $("setup-offer").hidden = false;
  $("setup-repo").textContent = `Set up ${owner}/${repo}`;
}

/** Back to creating a new one. */
function clearSetup() {
  setupTarget = null;
  $("setup-offer").hidden = true;
  $("new-repo-field").hidden = false;
  $("create-library").textContent = "Create it";
}

// Closing the form leaves setup mode, or a later "create a new one"
// would silently write into the repo that was offered.
$("new-library")?.addEventListener("toggle", () => {
  if (!$("new-library").open && setupTarget) clearSetup();
});

$("setup-repo")?.addEventListener("click", () => {
  if (!setupTarget) return;
  const details = $("new-library");
  details.open = true;
  // The repository is decided, so asking for a name again would be a
  // question with one answer.
  $("new-repo-field").hidden = true;
  $("new-repo").value = setupTarget.repo;
  if (!$("new-title").value.trim()) {
    $("new-title").value = setupTarget.repo.replace(/[-_]/g, " ");
  }
  $("create-library").textContent = `Set up ${setupTarget.owner}/${setupTarget.repo}`;
  $("new-title").focus();
});

const newTitle = $("new-title");
const newRepo = $("new-repo");
const newBlock = $("new-block");

if (newTitle && newRepo) {
  // The repository is named after the module until the author says
  // otherwise -- and once they have, it stops following.
  let repoEdited = false;
  newRepo.addEventListener("input", () => {
    repoEdited = newRepo.value.trim() !== "";
  });
  newTitle.addEventListener("input", () => {
    if (!repoEdited) newRepo.value = repoNameFrom(newTitle.value);
  });
}

$("create-library")?.addEventListener("click", () =>
  busy("create-library", "Creating", async (say) => {
    const title = newTitle.value.trim();
    const name = (newRepo.value.trim() || repoNameFrom(title));
    const blockTitle = newBlock.value.trim() || "Session one";
    if (!title) {
      status("Give the module a name.", "error");
      return;
    }
    try {
      const made = setupTarget
        ? await provisionInto(state.gh, {
            owner: setupTarget.owner,
            name: setupTarget.repo,
            title,
            blockTitle,
            status: say,
          })
        : await provisionLibrary(state.gh, {
            login: state.login,
            name,
            title,
            description: "",
            blockTitle,
            isPrivate: $("new-private").checked,
            status: say,
          });
      status(
        (setupTarget
          ? `Set up ${made.owner}/${made.repo}: ${made.files.length} files added` +
            (made.kept ? `, ${made.kept} already there and left alone` : "")
          : `Created ${made.owner}/${made.repo} with ${made.files.length} files`) +
          ". Opening it…",
        "ok"
      );
      clearSetup();
      // Straight in, rather than telling somebody to go and open the
      // thing that was just made for them.
      await openRepo(`${made.owner}/${made.repo}`);
      state.blockId = made.blockId;
      $("new-library").open = false;
    } catch (err) {
      status(err.message, "error");
    }
  })
);

$("open-manual").addEventListener("click", () => openRepo($("manual-repo").value));
$("validate").addEventListener("click", runValidate);
$("preview").addEventListener("click", previewDeck);

boot();
