// What went wrong, in words an author can act on.
//
// GitHub's own answers are written for programmers:
//
//   PATCH /repos/o/r/git/refs/heads/main failed (422): Update is not a fast forward
//
// which names a URL, a status code and a git concept, and says nothing
// about what happened or what to do. Every request the workbench makes
// is turned into one sentence here -- what happened, in this repository,
// and what to do next -- and the original is kept, so it can still be
// shown on request and pasted into a bug report.
//
// Pure: no DOM, no network. tests/errors-check.mjs holds the wording.

/** What a request was doing, from its method and path. */
export function actionOf(method, path) {
  const p = String(path || "");
  const m = String(method || "GET").toUpperCase();
  if (/\/git\/refs?\/heads\//.test(p)) {
    if (m === "PATCH") return "move your branch to the new version";
    if (m === "DELETE") return "delete the branch";
    return "check the branch";
  }
  if (/\/git\/refs$/.test(p) && m === "POST") return "create your branch";
  if (/\/git\/matching-refs\//.test(p)) return "list the branches";
  if (/\/git\/(blobs|trees|commits)$/.test(p) && m === "POST") return "upload your changes";
  if (/\/git\/commits\//.test(p)) return "read a saved version";
  if (/\/git\/trees\//.test(p)) return "read the repository's files";
  if (/\/contents\//.test(p)) return m === "PUT" ? "write the file" : "read a file";
  if (/\/pulls/.test(p)) return m === "POST" ? "open the review" : "look for an open review";
  if (/\/commits/.test(p)) return "read the history";
  if (/^\/user\/repos/.test(p) && m === "POST") return "create the repository";
  if (/^\/user\/repos/.test(p)) return "list your repositories";
  if (/^\/user$/.test(p)) return "check who you are signed in as";
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return "open the repository";
  return "talk to GitHub";
}

export function repoOf(path) {
  const m = String(path || "").match(/\/repos\/([^/]+\/[^/?]+)/);
  return m ? m[1] : null;
}

export function branchOf(path) {
  const m = String(path || "").match(/\/heads\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * One sentence (or two) for a failed GitHub request.
 *
 * status  the HTTP status, 0 when GitHub could not be reached
 * method  the HTTP method
 * path    the API path, e.g. /repos/o/r/git/refs/heads/main
 * detail  GitHub's own message, if it gave one
 */
export function explain({ status = 0, method = "GET", path = "", detail = "" } = {}) {
  const action = actionOf(method, path);
  const repo = repoOf(path);
  const where = repo ? ` in ${repo}` : "";
  const branch = branchOf(path);
  const said = String(detail || "");

  if (!status) {
    return "Couldn't reach GitHub. Check your internet connection and try again — nothing is lost.";
  }
  if (status === 401) {
    return (
      "GitHub didn't accept your sign-in: the token may have expired or been revoked. " +
      "Sign out, then sign in again with a current token."
    );
  }
  if (status === 403) {
    return (
      `GitHub wouldn't let you ${action}${where}. Your token needs access to ` +
      `${repo ?? "this repository"} with Contents and Pull requests set to "Read and write".`
    );
  }
  if (status === 404) {
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      return (
        `${repo} wasn't found. Check the spelling — or, if it's private, ` +
        "give your token access to it."
      );
    }
    if (branch && /GET/i.test(method)) {
      return `The branch ${branch} doesn't exist${where} yet.`;
    }
    return (
      `GitHub couldn't find what it needed to ${action}${where}. If the ` +
      "repository is private, make sure your token includes it."
    );
  }
  if (status === 409 && /empty/i.test(said)) {
    return (
      `${repo ?? "This repository"} is empty — it has no files or branches yet, so ` +
      `there was nothing to ${action}. Saving into it makes its first version.`
    );
  }
  if (status === 409) {
    return (
      `${repo ?? "The repository"} changed on GitHub while you were working, so ` +
      `GitHub wouldn't ${action}. Reload to pick up the latest version; your ` +
      "unsaved changes are kept in this browser."
    );
  }
  if (status === 422 && /fast forward/i.test(said)) {
    return (
      `Someone else saved to ${branch ?? "this branch"} at the same moment — another ` +
      "tab, a colleague, or a merge on GitHub. Nothing is lost: press Save again."
    );
  }
  if (status === 422 && /already exists/i.test(said) && /pull/i.test(path)) {
    return "A review is already open for these changes on GitHub.";
  }
  if (status === 422 && /no commits between/i.test(said)) {
    return "There's nothing new to review: your branch already matches the published version.";
  }
  if (status === 422 && /already exists/i.test(said)) {
    return `That already exists${where}, so GitHub wouldn't ${action}.`;
  }
  if (status === 422 && /too large|too big/i.test(said)) {
    return `A file is too large for GitHub to ${action}. Make it smaller and try again.`;
  }
  if (status >= 500) {
    return (
      `GitHub is having problems right now and couldn't ${action}. Wait a ` +
      "minute and try again — nothing is lost."
    );
  }
  return `GitHub couldn't ${action}${where}${said ? `: ${said}` : ""}.`;
}

/** The raw line a developer wants, kept for "Technical details". */
export function technical({ status = 0, method = "GET", path = "", detail = "" } = {}) {
  return `${String(method).toUpperCase()} ${path} → ${status || "no response"}${detail ? `: ${detail}` : ""}`;
}

// Exceptions whose message was written for an author: the renderer's own
// refusals, which already say which slide and what to change.
const AUTHORED = /^(RenderError|SessionParseError|CorpusError|LibraryError|LayoutMapError|QuestionsError|SmartArtError|MermaidError|AttributionError|IngestError|ValueError): /;

/**
 * A Python failure as one sentence, the traceback kept as its technical
 * details. Pyodide's message is the whole traceback, which put forty
 * lines of Python in the status bar to say "slide s-04 uses a layout the
 * template does not have".
 */
export function pythonError(err, doing) {
  const text = String(err?.message ?? err ?? "");
  if (!/Traceback|Error: /.test(text)) return err;
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || text;
  let message;
  if (AUTHORED.test(last)) {
    message = last.replace(AUTHORED, "");
  } else if (/^ModuleNotFoundError: /.test(last)) {
    message =
      `The renderer did not finish loading, so it couldn't ${doing}. Reload the page; ` +
      "if it happens again, the site has been published incompletely.";
  } else if (/^(FileNotFoundError|OSError): /.test(last)) {
    message = `A file the renderer needed was missing, so it couldn't ${doing}: ${last.replace(/^\w+: /, "")}`;
  } else {
    message = `Something went wrong inside the renderer while trying to ${doing}: ${last.replace(/^\w+: /, "")}`;
  }
  const out = new Error(message);
  out.technical = text;
  return out;
}
