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
  return yaml.load(text ?? "");
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
    // Bare scalars only: a quoted or nested item keeps its own line.
    const itemPattern = new RegExp("^" + indent + "  - ([\\w.-]+)$");
    while (j < lines.length) {
      const m = lines[j].match(itemPattern);
      if (!m) break;
      items.push(m[1]);
      j += 1;
    }
    const inline = `${indent}${key}: [${items.join(", ")}]`;
    if (items.length >= 1 && j > i + 1 && inline.length <= 78) {
      out.push(inline);
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join("\n");
}
