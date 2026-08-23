// The libraries a person has added, shared by every pane.
//
// Add a repo in the PowerPoint pane and it should be there in the Word
// pane. Both are served from the same origin, so they see the same
// localStorage — one key, one shape, one implementation, and the sharing
// follows from that rather than from any syncing.
//
// The caveat is Office's, not ours: each host app runs its own WebView2,
// and whether Word and PowerPoint share a storage partition is up to
// Office and its version. Within one app it is shared for certain.
// Where it is not, the list simply starts empty in the other app — the
// panes still work, they just do not know about each other yet. Nothing
// here breaks either way, and `sourcesAreShared()` reports what actually
// happened rather than guessing.

const STORE_KEY = "fair.sources";
const LAST_KEY = "fair.lastSource";
const PROBE_KEY = "fair.sharedProbe";

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // a private-mode webview: this session still works
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Everything remembered, oldest first, with anything malformed dropped. */
export function loadSources() {
  try {
    const parsed = JSON.parse(read(STORE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && typeof s.url === "string" && s.url);
  } catch {
    return [];
  }
}

export function storeSources(sources) {
  return write(STORE_KEY, JSON.stringify(sources));
}

/**
 * Add one, keeping the list a set.
 *
 * Returns the list as it now stands, so a caller never has to re-read to
 * find out what happened.
 */
export function addSource(source) {
  const sources = loadSources();
  if (!sources.some((s) => s.url === source.url)) {
    sources.push(source);
    storeSources(sources);
  }
  return sources;
}

export function removeSource(url) {
  const sources = loadSources().filter((s) => s.url !== url);
  storeSources(sources);
  return sources;
}

export function rememberLast(url) {
  write(LAST_KEY, url ?? "");
}

/** The library to open on launch: the last one used, else the first. */
export function initialSource(sources = loadSources()) {
  if (!sources.length) return null;
  const last = read(LAST_KEY);
  return sources.find((s) => s.url === last) ?? sources[0];
}

/** A repo the panes can both describe the same way. */
export function repoSource(owner, repo) {
  return { url: `wasm:${owner}/${repo}`, name: `${owner}/${repo}`, kind: "repo" };
}

/** owner/repo out of a source added by either pane, or null. */
export function repoOf(source) {
  const match = /^wasm:([^/]+)\/(.+)$/.exec(source?.url ?? "");
  return match ? { owner: match[1], repo: match[2] } : null;
}

/**
 * Whether this pane can see storage at all.
 *
 * Not a guess about Office's partitioning — a write and a read back. A
 * pane that cannot store is still usable, and should say so rather than
 * silently forgetting every repo the moment it closes.
 */
export function sourcesAreShared() {
  const stamp = String(Date.now());
  if (!write(PROBE_KEY, stamp)) return false;
  return read(PROBE_KEY) === stamp;
}
