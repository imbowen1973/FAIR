// Undo, for the things that lose work.
//
// The risk this exists for is structural: change a slide's layout, delete
// one, replace a deck on import, and the content is gone with no way
// back. Typing is not the danger — the browser's own undo already covers
// a contenteditable, and fighting it would make things worse.
//
// So this records whole snapshots of a block's slides rather than diffs.
// A deck is a few kilobytes of plain objects; sixty of them is nothing,
// and a snapshot cannot be subtly wrong the way a replayed diff can.
//
// A burst of typing is one step. Without coalescing, a sentence is forty
// undo steps and the feature is useless.

const LIMIT = 60;
const COALESCE_MS = 900;

export function newHistory() {
  return { stack: [], at: -1, lastKey: null, lastAt: 0 };
}

/**
 * Record the state as it is *now*, after whatever just changed it.
 *
 * `key` groups changes that should undo together — pass the same key for
 * successive keystrokes in one region and they collapse into one step.
 * Pass null for anything structural, which always earns its own.
 */
export function record(history, snapshot, key = null, now = Date.now()) {
  const coalescing =
    key !== null &&
    key === history.lastKey &&
    now - history.lastAt < COALESCE_MS &&
    history.at >= 0;

  if (coalescing) {
    // Replace the top rather than stacking: the step already exists and
    // this is a continuation of it.
    history.stack[history.at] = snapshot;
    history.lastAt = now;
    return history;
  }

  // Anything ahead of here is a redo tail, and it is now unreachable.
  history.stack.length = history.at + 1;
  history.stack.push(snapshot);
  if (history.stack.length > LIMIT) history.stack.shift();
  history.at = history.stack.length - 1;
  history.lastKey = key;
  history.lastAt = now;
  return history;
}

export function canUndo(history) {
  return history.at > 0;
}

export function canRedo(history) {
  return history.at >= 0 && history.at < history.stack.length - 1;
}

/** The previous snapshot, or null if there is none. */
export function undo(history) {
  if (!canUndo(history)) return null;
  history.at -= 1;
  // A step taken after an undo must not coalesce into the one before it.
  history.lastKey = null;
  return history.stack[history.at];
}

/** The snapshot undone from, or null if nothing was undone. */
export function redo(history) {
  if (!canRedo(history)) return null;
  history.at += 1;
  history.lastKey = null;
  return history.stack[history.at];
}
