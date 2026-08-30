// The running order: moving sessions and the headings that group them.
//
// course.yaml holds a tree, and its order *is* the delivery order:
//
//   structure:
//     - kind: module
//       title: Foundations
//       children:
//         - block: 01-introduction
//         - block: 02-profiles
//     - block: 03-standalone
//
// A node is either a session -- {block: id} -- or a container, and the
// renderer is strict about the difference: a container whose `children`
// key is absent is a hard error, not an empty container. So every
// container this module makes or leaves behind carries `children`, even
// when it is empty. (library.py:_walk_structure)
//
// Everything here is a pure function over that tree. Nothing touches the
// DOM, nothing reaches for state, and every operation returns a new tree
// -- or the one it was given, unchanged, when the operation cannot be
// done. Callers use that identity to decide whether anything happened,
// which is the same convention asListType uses.
//
// Pure because the invariant that matters is not "did the button fire"
// but "is every session still there afterwards", and that is a property
// of these functions alone.

const CHILDREN = "children";

/** A path is the list of indices from the root down to a node. */
export function nodeAt(structure, path) {
  let node = null;
  let list = structure ?? [];
  for (const index of path ?? []) {
    node = list[index];
    if (!node) return null;
    list = node[CHILDREN] ?? [];
  }
  return node;
}

export const isContainer = (node) =>
  Boolean(node) && !("block" in node) && Array.isArray(node[CHILDREN]);

/** A fresh container. `children` is not optional — see the note above. */
export function newContainer(title = "", kind = "module") {
  return { kind: kind || "module", title: title ?? "", [CHILDREN]: [] };
}

/**
 * Rebuild the list at `path` through `change`, sharing every branch the
 * change does not touch.
 */
function withList(structure, path, change) {
  const list = structure ?? [];
  if (!path.length) return change(list);
  const [head, ...rest] = path;
  if (!list[head]) return list;
  return list.map((node, index) =>
    index === head
      ? { ...node, [CHILDREN]: withList(node[CHILDREN] ?? [], rest, change) }
      : node
  );
}

const parentOf = (path) => path.slice(0, -1);
const indexOf = (path) => path[path.length - 1];

/** The nodes a node sits among. */
function siblings(structure, path) {
  const parent = parentOf(path);
  return parent.length ? nodeAt(structure, parent)?.[CHILDREN] ?? [] : structure ?? [];
}

// ---- moving -------------------------------------------------------------

export function canMove(structure, path, delta) {
  if (!path?.length) return false;
  const to = indexOf(path) + delta;
  return to >= 0 && to < siblings(structure, path).length;
}

/** Swap with the sibling above or below. A container brings its children. */
export function moveWithinSiblings(structure, path, delta) {
  if (!canMove(structure, path, delta)) return structure;
  const at = indexOf(path);
  return withList(structure, parentOf(path), (list) => {
    const next = [...list];
    const [node] = next.splice(at, 1);
    next.splice(at + delta, 0, node);
    return next;
  });
}

// ---- indent and outdent -------------------------------------------------
//
// The one rule with no ambiguity: indenting puts a row inside the
// container immediately above it at its own level. There is never a
// question of which module it landed in, because there is only ever one
// candidate.

export function canIndent(structure, path) {
  if (!path?.length) return false;
  const at = indexOf(path);
  if (at === 0) return false;
  return isContainer(siblings(structure, path)[at - 1]);
}

/** Become the last child of the container immediately above. */
export function indent(structure, path) {
  if (!canIndent(structure, path)) return structure;
  const at = indexOf(path);
  return withList(structure, parentOf(path), (list) => {
    const next = [...list];
    const [node] = next.splice(at, 1);
    const host = next[at - 1];
    next[at - 1] = { ...host, [CHILDREN]: [...(host[CHILDREN] ?? []), node] };
    return next;
  });
}

export function canOutdent(structure, path) {
  // At the top level there is nothing to come out of.
  return Boolean(path?.length) && path.length > 1;
}

/** Leave the parent, and follow it as its next sibling. */
export function outdent(structure, path) {
  if (!canOutdent(structure, path)) return structure;
  const at = indexOf(path);
  const parentPath = parentOf(path);
  const parentAt = indexOf(parentPath);
  return withList(structure, parentOf(parentPath), (list) => {
    const next = [...list];
    const host = next[parentAt];
    const kept = [...(host[CHILDREN] ?? [])];
    const [node] = kept.splice(at, 1);
    next[parentAt] = { ...host, [CHILDREN]: kept };
    next.splice(parentAt + 1, 0, node);
    return next;
  });
}

// ---- headings -----------------------------------------------------------

/**
 * Remove a heading and keep everything under it.
 *
 * Its children take its place, at its position and its parent's level.
 * Deleting a grouping is a statement about the grouping, never about the
 * sessions in it -- so the button that looks destructive is not.
 */
export function removeContainer(structure, path) {
  const node = nodeAt(structure, path);
  if (!isContainer(node)) return structure;
  const at = indexOf(path);
  return withList(structure, parentOf(path), (list) => {
    const next = [...list];
    next.splice(at, 1, ...(node[CHILDREN] ?? []));
    return next;
  });
}

/** Change a heading's words. `kind` is the course's own, so it is free text. */
export function renameNode(structure, path, patch) {
  const node = nodeAt(structure, path);
  if (!isContainer(node)) return structure;
  const at = indexOf(path);
  return withList(structure, parentOf(path), (list) =>
    list.map((entry, index) => (index === at ? { ...entry, ...patch } : entry))
  );
}

/** Put `node` immediately after the one at `path`. */
export function insertAfter(structure, path, node) {
  if (!path?.length) return [...(structure ?? []), node];
  const at = indexOf(path);
  return withList(structure, parentOf(path), (list) => {
    const next = [...list];
    next.splice(at + 1, 0, node);
    return next;
  });
}

/** Put `node` at the end of the container at `parentPath` (root if empty). */
export function appendTo(structure, parentPath, node) {
  return withList(structure, parentPath ?? [], (list) => [...list, node]);
}

// ---- reading ------------------------------------------------------------

/**
 * Every row, in the order they are drawn, each knowing where it is.
 *
 * `path` addresses the node itself; `parent` addresses the container it
 * sits in, which is what "add something here" needs.
 */
export function flatten(structure, { depth = 0, trail = [] } = {}, out = []) {
  (structure ?? []).forEach((node, index) => {
    const path = [...trail, index];
    if ("block" in node) {
      out.push({ kind: "block", block: node.block, depth, path, parent: trail });
      return;
    }
    out.push({
      kind: node.kind || "group",
      title: node.title || "",
      depth,
      path,
      parent: trail,
      empty: !(node[CHILDREN] ?? []).length,
    });
    flatten(node[CHILDREN] ?? [], { depth: depth + 1, trail: path }, out);
  });
  return out;
}

/**
 * Every block id the tree holds, in order and with duplicates kept.
 *
 * The invariant every operation here is checked against: rearranging a
 * running order may change where a session is and must never change
 * which sessions there are.
 */
export function blockIds(structure, out = []) {
  for (const node of structure ?? []) {
    if ("block" in node) out.push(node.block);
    else blockIds(node[CHILDREN] ?? [], out);
  }
  return out;
}

/** Whether every container still declares its children. */
export function wellFormed(structure) {
  for (const node of structure ?? []) {
    if (node && "block" in node) continue;
    if (!isContainer(node)) return false;
    if (!wellFormed(node[CHILDREN])) return false;
  }
  return true;
}
