// One YAML implementation, reachable from both the browser and Node.
//
// The workbench is a static page with no build step, so the browser gets
// js-yaml as an ES module from a CDN. Node has no such resolution for a
// URL, and the tests need the same parser the app uses — running them
// against a different YAML would test nothing. So: try the bare
// specifier first (Node, where it is a devDependency), fall back to the
// CDN (the browser, where the bare specifier cannot resolve).
//
// Writing our own YAML subset was the alternative and is a trap: block
// scalars, quoting rules and anchors are exactly where a hand-rolled
// parser quietly corrupts someone's speaker notes.

const CDN = "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/+esm";

let impl;
try {
  impl = await import("js-yaml");
} catch {
  impl = await import(/* @vite-ignore */ CDN);
}

const yaml = impl.default ?? impl;

export function parse(text) {
  return yaml.load(repairInlinedLists(String(text ?? "")));
}

/*
  Undo a list this file once wrote badly.

  `inlineShortLists` used to stop at the first item it could not fold and
  inline the ones before it, leaving the rest as block entries under a
  flow sequence:

      items: [SAFFT4EU]
        - REGE FARMS
        - FARMS 5.0

  That is not YAML, so js-yaml refused the whole slide and it came back
  with no data: no layout, no cards, no notes. The writer no longer does
  it, but files already committed still hold it, and a deck cannot be
  mended by fixing the thing that broke it -- the bytes are on the
  branch.

  The damage is exactly reversible, because the old writer only ever
  inlined bare scalars: no commas, no quotes, no nesting. So a flow
  sequence directly followed by block entries at the item indent is
  unambiguously one list, and can be put back as one.

  This is safe to run over everything. The shape it repairs is invalid
  YAML in every case, so no valid document can be changed by it: if the
  pattern is there, the file was broken, and it was broken by us.
*/
function repairInlinedLists(text) {
  // A flow sequence has to be present for there to be anything to undo.
  if (!text.includes("[")) return text;

  const crlf = text.includes("\r\n");
  const lines = text.split(/\r?\n/);
  const out = [];
  let mended = false;

  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^(\s*)([\w.-]+):[ \t]*\[([^\]]*)\][ \t]*$/);
    if (!head) {
      out.push(lines[i]);
      continue;
    }

    const [, indent, key, inside] = head;
    const itemPattern = new RegExp("^" + indent + "  - (.*)$");
    const stranded = [];
    let j = i + 1;
    while (j < lines.length) {
      const m = lines[j].match(itemPattern);
      if (!m) break;
      stranded.push(m[1]);
      j += 1;
    }

    // No block entries under it: an ordinary, valid flow sequence.
    if (!stranded.length) {
      out.push(lines[i]);
      continue;
    }

    // The old writer only inlined bare scalars, so splitting on a comma
    // cannot break an item apart.
    const inlined = inside.trim() ? inside.split(",").map((s) => s.trim()) : [];
    out.push(`${indent}${key}:`);
    for (const item of [...inlined, ...stranded]) out.push(`${indent}  - ${item}`);
    i = j - 1;
    mended = true;
  }

  if (!mended) return text;
  return out.join(crlf ? "\r\n" : "\n");
}

/**
 * Emit YAML the way the repo already writes it: block scalars for
 * anything multi-line (so speaker notes stay readable in a diff), no
 * line wrapping (so a long sentence is one line, not three), and key
 * order preserved rather than alphabetised.
 */
export function stringify(value) {
  return inlineShortLists(
    yaml.dump(value, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
      quotingType: '"',
    })
  );
}

// js-yaml has no per-key style control, so `develops: [AP1, AP3]` comes
// back as a three-line block. Correct, but it turns a one-word title edit
// into a diff nobody wants to review. Collapse a list back to flow style
// only when every item is a bare scalar and the line stays short — never
// when an item is quoted, nested, or long enough that one line per item
// is genuinely easier to read.
function inlineShortLists(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^(\s*)([\w.-]+):\s*$/);
    if (!head) {
      out.push(lines[i]);
      continue;
    }
    const [, indent, key] = head;
    const items = [];
    let j = i + 1;
    // Every item in the list, bare or not. Reading only as far as the
    // first awkward one and inlining what came before it wrote
    //
    //     items: [SAFFT4EU]
    //       - REGE FARMS
    //
    // which is not YAML at all: a flow sequence with block entries
    // hanging off it. js-yaml then refused the whole slide, so a deck
    // that rendered perfectly lost a slide's entire body the moment it
    // was saved -- and the canvas blamed the geometry, because a slide
    // with no data has no layout to look up.
    const itemPattern = new RegExp("^" + indent + "  - (.*)$");
    const isBare = /^[\w.-]+$/;
    let allBare = true;
    while (j < lines.length) {
      const m = lines[j].match(itemPattern);
      if (!m) break;
      if (!isBare.test(m[1])) allBare = false;
      items.push(m[1]);
      j += 1;
    }
    const inline = `${indent}${key}: [${items.join(", ")}]`;
    // `allBare` is the whole rule: one item with a space, a quote or a
    // colon in it and the list stays as it is, entire.
    if (allBare && items.length >= 1 && j > i + 1 && inline.length <= 78) {
      out.push(inline);
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join("\n");
}
