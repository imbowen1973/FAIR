// Running inside a portal: the host owns identity, the frame does the work.
//
// The wrapper contract (docs/workbench-embedding.md). A portal embeds the
// workbench in an iframe and names itself in the URL:
//
//     <iframe src="https://…/workbench/index.html?host=https://portal.example.org">
//
// Exactly one origin may drive the frame — the one in `host` — and every
// message is checked against it, both ways. The conversation:
//
//     frame -> host   {type: "edufair:ready", version}
//     host  -> frame  {type: "edufair:auth", token, login?, repo?}
//     frame -> host   {type: "edufair:opened" | "edufair:dirty" |
//                      "edufair:saved" | "edufair:submitted" | …, …}
//
// The host re-sends `edufair:auth` whenever it likes — that is how
// short-lived tokens rotate without the author noticing. The token lives
// in this frame's memory only: never stored, never shown, gone with the
// frame. Nobody in a portal ever sees or pastes a key, which is the
// entire point of wrapping.
//
// Everything here is dependency-free and the parsing/validation is pure,
// so the contract itself is unit-testable without a browser.

/**
 * The one origin allowed to drive this frame, from `?host=…`.
 *
 * Null unless the page is actually embedded AND the parameter names a
 * plausible origin (https, or http on localhost for development). A full
 * URL is tolerated and reduced to its origin.
 */
export function parseHostOrigin(search, embedded) {
  if (!embedded) return null;
  const value = new URLSearchParams(search).get("host");
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return null;
  }
  return url.origin;
}

/** A host auth message's payload, or null when the shape is wrong. */
export function readAuth(data) {
  if (!data || typeof data !== "object") return null;
  if (data.type !== "edufair:auth") return null;
  if (typeof data.token !== "string" || !data.token.trim()) return null;
  return {
    token: data.token,
    login: typeof data.login === "string" ? data.login : null,
    repo: typeof data.repo === "string" ? data.repo : null,
  };
}

/**
 * Wire the frame to its host. Returns the host handle:
 *
 *   waitForAuth()   first credentials (a promise; no timeout — the portal
 *                   decides how long sign-in takes, not the frame)
 *   onAuth(cb)      every later credential refresh
 *   token()         the current token
 *   emit(type, d)   a lifecycle event to the portal, origin-pinned
 */
export function connectHost({ origin, win = window, version = "dev" }) {
  let current = null;
  const refreshers = [];
  let firstAuth;
  let resolveFirst;
  firstAuth = new Promise((resolve) => (resolveFirst = resolve));

  win.addEventListener("message", (event) => {
    if (event.origin !== origin) return;
    const auth = readAuth(event.data);
    if (!auth) return;
    const isFirst = current === null;
    current = auth;
    if (isFirst) resolveFirst(auth);
    else for (const cb of refreshers) cb(auth);
  });

  const emit = (type, data = {}) => {
    try {
      win.parent.postMessage({ type: `edufair:${type}`, ...data }, origin);
    } catch {
      /* a portal that went away is not the author's problem */
    }
  };

  emit("ready", { version });

  return {
    origin,
    waitForAuth: () => firstAuth,
    onAuth: (cb) => refreshers.push(cb),
    token: () => current?.token ?? null,
    emit,
  };
}
