// The workbench: open a library repo, edit it, preview the real deck,
// save to a branch, submit a pull request.
//
// State lives in the repo, not here. Everything below is a projection of
// files fetched from git plus the edits not yet committed; closing the
// tab loses only the uncommitted edits, and the app says so.

import { brokerProvider, patProvider, signOut, storedLogin, storedToken } from "./auth.js";
import { BROKER_URL, CLIENT_ID } from "./config.js";
import { draftBranch, GitHub, parseRepo } from "./github.js";
import {
  isLibrary,
  libraryPaths,
  placedBlocks,
  readLibrary,
  writeSlides,
} from "./library.js";
import { slideForm } from "./form.js";
import { drawSchematic } from "./schematic.js";
import { renderDeck, validate } from "./preview.js";

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
  slideEdits: new Map(), // blockId -> Map(index -> data)
  problems: [],
};

function status(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`.trim();
  el.hidden = !message;
}

function dirty() {
  return state.edits.size > 0 || [...state.slideEdits.values()].some((m) => m.size);
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
    const defaultBranch = await state.gh.defaultBranch(owner, repo);
    const paths = await state.gh.tree(owner, repo, defaultBranch);

    if (!isLibrary(paths)) {
      status(
        `${fullName} is not a library: it needs course.yaml and blocks/<id>/slides.md.`,
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
    state.slideEdits = new Map();
    state.blockId = [...state.library.blocks.keys()][0] ?? null;
    state.slideIndex = 0;

    $("workspace").hidden = false;
    $("course-title").textContent = state.library.course.title || fullName;
    renderOutline();
    renderSlide();
    status("");
  } catch (err) {
    status(err.message, "error");
  }
}

// ---- outline -----------------------------------------------------------

function currentBlock() {
  return state.library?.blocks.get(state.blockId) ?? null;
}

function slideData(index) {
  const edits = state.slideEdits.get(state.blockId);
  if (edits?.has(index)) return edits.get(index);
  return currentBlock()?.parsed.slides[index]?.data ?? {};
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

    if (id === state.blockId) {
      block.parsed.slides.forEach((slide, index) => {
        const data = slideData(index);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "slide-row";
        if (index === state.slideIndex) row.classList.add("on");
        const edited = state.slideEdits.get(id)?.has(index);
        row.innerHTML = `<span class="layout">${data.layout ?? "?"}</span>` +
          `<span class="t">${(data.title ?? data.id ?? "untitled")}</span>` +
          (edited ? '<span class="dot" title="edited">•</span>' : "");
        row.addEventListener("click", () => {
          state.slideIndex = index;
          renderOutline();
          renderSlide();
        });
        group.appendChild(row);
      });
    }
    host.appendChild(group);
  }
}

// ---- the slide ---------------------------------------------------------

let activeRegion = null;

function renderSlide() {
  const block = currentBlock();
  if (!block) return;
  const data = slideData(state.slideIndex);

  slideForm($("form"), {
    slide: data,
    layoutMap: state.library.layoutMap,
    competencies: state.library.competencies,
    onChange: (next) => {
      if (!state.slideEdits.has(state.blockId)) {
        state.slideEdits.set(state.blockId, new Map());
      }
      state.slideEdits.get(state.blockId).set(state.slideIndex, next);
      renderOutline();
      drawSchematic($("schematic"), {
        geometry: state.library.geometry,
        layoutKey: next.layout,
        slide: next,
        activeRegion,
      });
      updateActions();
    },
    onFocusRegion: (region) => {
      activeRegion = region;
      drawSchematic($("schematic"), {
        geometry: state.library.geometry,
        layoutKey: slideData(state.slideIndex).layout,
        slide: slideData(state.slideIndex),
        activeRegion,
      });
    },
  });

  drawSchematic($("schematic"), {
    geometry: state.library.geometry,
    layoutKey: data.layout,
    slide: data,
    activeRegion,
  });
  updateActions();
}

// ---- pending files -----------------------------------------------------

/** The library as it would be committed: fetched files plus edits. */
function pendingFiles() {
  const out = new Map(state.files);
  for (const [blockId, edits] of state.slideEdits) {
    if (!edits.size) continue;
    const block = state.library.blocks.get(blockId);
    out.set(block.slidesPath, writeSlides(block.parsed, edits));
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
  return changed;
}

function updateActions() {
  const changed = changedFiles();
  $("dirty").textContent = changed.length
    ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed`
    : "no changes";
  $("save").disabled = changed.length === 0;
  $("submit").disabled = changed.length === 0 || state.problems.length > 0;
}

// ---- validate and preview ---------------------------------------------

async function runValidate() {
  try {
    // The template is binary and was not fetched as text; validation needs
    // only the parser and the layout map, so it runs without it.
    state.problems = await validate(pendingFiles(), status);
    const strip = $("problems");
    strip.innerHTML = "";
    if (!state.problems.length) {
      strip.innerHTML = '<p class="ok">No problems.</p>';
    } else {
      for (const problem of state.problems) {
        const row = document.createElement("p");
        row.className = "problem";
        row.innerHTML = `<strong>${problem.where}</strong> ${problem.message}`;
        strip.appendChild(row);
      }
    }
    updateActions();
  } catch (err) {
    status(`Validation could not run: ${err.message}`, "error");
  }
}

async function previewDeck() {
  try {
    const { owner, repo, defaultBranch } = state.repo;
    const files = pendingFiles();
    // The template and any media are binary: fetch them now, only when a
    // real render is asked for, so opening a library stays fast.
    status("Fetching the template…");
    const paths = await state.gh.tree(owner, repo, defaultBranch);
    for (const path of libraryPaths(paths)) {
      if (files.has(path)) continue;
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${path}`
      );
      files.set(path, new Uint8Array(await res.arrayBuffer()));
    }

    const { blob, filename } = await renderDeck(files, state.blockId, status);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status("Deck rendered — check your downloads.", "ok");
  } catch (err) {
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
    state.slideEdits = new Map();
    state.edits = new Map();
    state.library = readLibrary(state.files);

    renderOutline();
    renderSlide();
    status(
      `Saved to ${branch} (${sha.slice(0, 7)})${created ? " — branch created" : ""}.`,
      "ok"
    );
  } catch (err) {
    status(`Save failed: ${err.message}`, "error");
  } finally {
    updateActions();
  }
}

async function submit() {
  const { owner, repo, defaultBranch } = state.repo;
  const branch = draftBranch(state.login, state.blockId);
  try {
    if (changedFiles().length) await save();
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
    const commits = await state.gh.commits(owner, repo, {
      path: block.slidesPath,
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
$("open-manual").addEventListener("click", () => openRepo($("manual-repo").value));
$("validate").addEventListener("click", runValidate);
$("preview").addEventListener("click", previewDeck);
$("save").addEventListener("click", save);
$("submit").addEventListener("click", submit);
$("history").addEventListener("click", showHistory);

boot();
