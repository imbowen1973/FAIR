// Unsaved work, kept in this browser until it is saved.
//
// Every edit lives in memory until Save commits it, so a reload, a
// closed tab or a crashed laptop lost the lot. Now the pending files are
// written here as they change -- per repository and branch, because a
// draft belongs to the version it was made against -- and offered back
// when that repository is opened again. Saving clears it.
//
// What is kept is exactly what Save would send: the changed text files,
// and pictures attached but not yet committed while they fit. Browser
// storage is a few megabytes; text always comes first, and pictures that
// would not fit are left out and said to be.
//
// Like prefs.js, this degrades to "nothing remembered" when storage is
// blocked (a private window): it must never be the reason an edit fails.

const PREFIX = "fair.wb.draft:";
// Leave room under the usual 5 MB origin quota for everything else.
const UPLOAD_BUDGET = 3_000_000;

const keyFor = (owner, repo, branch) => `${PREFIX}${owner}/${repo}@${branch}`;

/** A short content fingerprint: enough to tell "the branch moved". */
export function fingerprint(text) {
  let h = 2166136261;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Write the draft for one branch. `changed` is [{path, content}] for
 * text, `uploads` a Map of path -> bytes, `base` the fetched text of the
 * branch (to notice later if it moved). Returns what was kept.
 */
export function saveDraft(owner, repo, branch, { changed, uploads, base }, store = globalThis.localStorage) {
  const key = keyFor(owner, repo, branch);
  try {
    if (!changed.length && !uploads.size) {
      store.removeItem(key);
      return { files: 0, pictures: 0, left: 0 };
    }
    const files = {};
    for (const { path, content } of changed) {
      files[path] = { text: content, base: base.has(path) ? fingerprint(base.get(path)) : null };
    }
    const pictures = {};
    let budget = UPLOAD_BUDGET;
    let left = 0;
    for (const [path, bytes] of uploads) {
      const encoded = toBase64(bytes);
      if (encoded.length > budget) {
        left++;
        continue;
      }
      budget -= encoded.length;
      pictures[path] = encoded;
    }
    const record = { savedAt: new Date().toISOString(), files, pictures, left };
    try {
      store.setItem(key, JSON.stringify(record));
    } catch {
      // Over quota: keep the words, drop the pictures.
      store.setItem(key, JSON.stringify({ ...record, pictures: {}, left: left + Object.keys(pictures).length }));
      return { files: changed.length, pictures: 0, left: left + Object.keys(pictures).length };
    }
    return { files: changed.length, pictures: Object.keys(pictures).length, left };
  } catch {
    return null; // storage blocked: nothing remembered, nothing broken
  }
}

/**
 * The draft for a branch, checked against what the branch now holds.
 * Returns null, or {savedAt, files: Map path->text, uploads: Map
 * path->bytes, moved: [paths changed on the branch since], left}.
 */
export function loadDraft(owner, repo, branch, current, store = globalThis.localStorage) {
  let record;
  try {
    record = JSON.parse(store.getItem(keyFor(owner, repo, branch)) ?? "null");
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || typeof record.files !== "object") return null;
  const files = new Map();
  const moved = [];
  for (const [path, entry] of Object.entries(record.files)) {
    if (!entry || typeof entry.text !== "string") continue;
    // Already what the branch holds (saved from another tab, say).
    if (current.get(path) === entry.text) continue;
    const now = current.has(path) ? fingerprint(current.get(path)) : null;
    if (entry.base !== now) moved.push(path);
    files.set(path, entry.text);
  }
  const uploads = new Map();
  for (const [path, encoded] of Object.entries(record.pictures ?? {})) {
    try {
      uploads.set(path, fromBase64(encoded));
    } catch {
      /* a damaged picture is skipped, not fatal */
    }
  }
  if (!files.size && !uploads.size) return null;
  return { savedAt: record.savedAt ?? null, files, uploads, moved, left: record.left ?? 0 };
}

export function clearDraft(owner, repo, branch, store = globalThis.localStorage) {
  try {
    store.removeItem(keyFor(owner, repo, branch));
  } catch {
    /* nothing to clear */
  }
}
