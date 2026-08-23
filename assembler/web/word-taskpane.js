// The Word task pane: pick a library, pick a document, put it in Word.
//
// Deliberately smaller than the PowerPoint pane. That one assembles a
// deck out of individual slides chosen by competency, so it needs a
// catalog. A document is a document: the useful operation is "put this
// one in front of me", and anything more would be ceremony.

import {
  bytesToBase64,
  fetchDocument,
  listDocuments,
  renderMarkdownToDocx,
} from "./word-renderer.js";

const $ = (id) => document.getElementById(id);

let repo = null; // {owner, repo}

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`.trim();
  el.hidden = !message;
}

// A pane that throws while starting shows nothing at all, and Office says
// only that the add-in could not be started.
window.addEventListener("error", (e) =>
  setStatus(`The pane hit an error: ${e.message}`, "error")
);
window.addEventListener("unhandledrejection", (e) =>
  setStatus(`The pane hit an error: ${e.reason?.message ?? e.reason}`, "error")
);

export function parseRepo(text) {
  const clean = String(text ?? "").trim().replace(/^https:\/\/github\.com\//, "");
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(clean);
  if (!match) throw new Error("give a repository as owner/repo");
  return { owner: match[1], repo: match[2] };
}

/** A document's name as a human would say it, not as a path. */
export function documentLabel(path) {
  const parts = path.split("/");
  const file = parts.pop().replace(/\.md$/, "");
  const pretty = file.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const block = parts.find((p) => p !== "blocks") ?? "";
  return block ? `${pretty} — ${block.replace(/[-_]/g, " ")}` : pretty;
}

async function open() {
  try {
    repo = parseRepo($("repo").value);
  } catch (err) {
    return setStatus(err.message, "error");
  }
  setStatus(`Reading ${repo.owner}/${repo.repo}…`);
  try {
    const paths = await listDocuments(repo.owner, repo.repo);
    if (!paths.length) {
      $("step-pick").hidden = true;
      return setStatus("That repository has no markdown documents.", "error");
    }
    const select = $("document");
    select.innerHTML = "";
    for (const path of paths) {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = documentLabel(path);
      option.title = path;
      select.appendChild(option);
    }
    $("step-pick").hidden = false;
    setStatus(`${paths.length} document${paths.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function insert() {
  if (!repo) return;
  const path = $("document").value;
  const button = $("insert");
  button.disabled = true;
  try {
    const markdown = await fetchDocument(repo.owner, repo.repo, path);
    const bytes = await renderMarkdownToDocx(
      markdown,
      { title: documentLabel(path), project: `${repo.owner}/${repo.repo}` },
      setStatus
    );
    setStatus("Putting it into Word…");
    const base64 = bytesToBase64(bytes);
    const where = $("replace").checked ? "Replace" : "End";
    await Word.run(async (ctx) => {
      ctx.document.body.insertFileFromBase64(base64, where);
      await ctx.sync();
    });
    setStatus(`Inserted ${path}.`, "ok");
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    button.disabled = false;
  }
}

Office.onReady((info) => {
  try {
    start(info);
  } catch (err) {
    setStatus(`The pane could not start: ${err.message}`, "error");
  }
});

function start(info) {
  if (info.host !== Office.HostType.Word) {
    return setStatus("This add-in only runs in Word.", "error");
  }
  // Checked here rather than gated in the manifest: a requirement the
  // host does not meet stops Office loading the add-in at all, and the
  // only thing it then says is that it could not be started.
  if (!Office.context.requirements.isSetSupported("WordApi", "1.1")) {
    return setStatus(
      "This Word build is too old for the add-in API. Update Office.",
      "error"
    );
  }
  $("open").addEventListener("click", open);
  $("insert").addEventListener("click", insert);
  $("repo").addEventListener("keydown", (e) => {
    if (e.key === "Enter") open();
  });
}
