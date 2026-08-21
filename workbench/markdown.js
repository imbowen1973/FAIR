// Markdown to HTML, for previewing a document while editing it.
//
// Small on purpose. This exists so an author can see the shape of a
// lesson plan as they write it -- headings, lists, a table -- and for
// nothing else. It is not a spec-complete CommonMark implementation and
// should not grow into one.
//
// Inline marks come from marks.js, so the six the renderer understands
// are the six the preview shows. Writing a second inline parser here is
// the one thing guaranteed to make the preview lie.
//
// String in, string out, with no DOM: the same code then runs in the
// browser and under `node --test`.

import { MARKS, parseMarks } from "./marks.js";
import { TAG } from "./markdom.js";

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A URL safe to put in href/src. Refuses javascript: and friends. */
function safeUrl(url) {
  const trimmed = String(url).trim();
  // Anything with a scheme must use one that cannot execute. Relative
  // paths -- which is what a link to media/ is -- have no scheme at all.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (!/^(https?|mailto|tel):/i.test(trimmed)) return "";
  }
  return escapeHtml(trimmed).replace(/"/g, "&quot;");
}

/** Marked-up text to HTML, without links: marks.js owns this grammar. */
function marksToHtml(text) {
  let out = "";
  for (const span of parseMarks(text ?? "")) {
    let html = escapeHtml(span.text);
    for (const mark of MARKS) {
      if (span[mark]) html = `<${TAG[mark]}>${html}</${TAG[mark]}>`;
    }
    out += html;
  }
  return out;
}

// Images before links: ![alt](src) starts with the link pattern.
const LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;

/** One line of markdown to inline HTML: marks, links and images. */
export function inlineToHtml(text) {
  let out = "";
  let cursor = 0;
  for (const match of String(text ?? "").matchAll(LINK)) {
    out += marksToHtml(text.slice(cursor, match.index));
    const [whole, bang, label, url, title] = match;
    const href = safeUrl(url);
    const titleAttr = title ? ` title="${escapeHtml(title).replace(/"/g, "&quot;")}"` : "";
    if (!href) {
      // A URL we will not emit: show the author their own text rather
      // than dropping it, so nothing disappears silently.
      out += marksToHtml(whole);
    } else if (bang) {
      out += `<img src="${href}" alt="${escapeHtml(label).replace(/"/g, "&quot;")}"${titleAttr}/>`;
    } else {
      out += `<a href="${href}"${titleAttr} rel="noopener">${marksToHtml(label)}</a>`;
    }
    cursor = match.index + whole.length;
  }
  return out + marksToHtml(String(text ?? "").slice(cursor));
}

/** How deep a list item is indented, in levels of two spaces. */
function depthOf(indent) {
  return Math.floor(indent.replace(/\t/g, "  ").length / 2);
}

function renderTable(rows) {
  const cells = (line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  let out = "<table><thead><tr>";
  for (const c of head) out += `<th>${inlineToHtml(c)}</th>`;
  out += "</tr></thead><tbody>";
  for (const row of body) {
    out += "<tr>";
    for (const c of row) out += `<td>${inlineToHtml(c)}</td>`;
    out += "</tr>";
  }
  return out + "</tbody></table>";
}

const TABLE_RULE = /^\s*\|?[\s:-]*-[\s:|-]*$/;

/**
 * A markdown document to HTML.
 *
 * Handles headings, paragraphs, unordered and ordered lists with
 * nesting, fenced code, blockquotes, tables and horizontal rules.
 * Anything else is treated as paragraph text, which is what markdown
 * does anyway.
 */
export function markdownToHtml(source) {
  const lines = String(source ?? "").split(/\r?\n/);
  const out = [];
  const listStack = []; // {tag, depth}
  let paragraph = [];
  let quote = [];

  const closeLists = (toDepth = -1) => {
    while (listStack.length && listStack[listStack.length - 1].depth > toDepth) {
      const done = listStack.pop();
      // A nested list belongs inside the item it hangs off, so the item
      // it reopened is closed here. A bare <ul> inside a <ul> renders,
      // but it is not valid HTML and screen readers read it as a stray.
      out.push(done.inLi ? `</${done.tag}></li>` : `</${done.tag}>`);
    }
  };
  /** Open a list, tucked inside the previous item when it is nested. */
  const openList = (tag, depth) => {
    const last = out.length - 1;
    const nested = listStack.length > 0 && out[last]?.endsWith("</li>");
    if (nested) out[last] = out[last].slice(0, -"</li>".length);
    listStack.push({ tag, depth, inLi: nested });
    out.push(`<${tag}>`);
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inlineToHtml(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
    quote = [];
  };
  const flushAll = (toDepth = -1) => {
    flushParagraph();
    flushQuote();
    closeLists(toDepth);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Fenced code: taken verbatim to the closing fence, marks and all.
    const fence = line.match(/^\s*```+\s*([\w-]*)\s*$/);
    if (fence) {
      flushAll();
      const language = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      const cls = language ? ` class="language-${escapeHtml(language)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineToHtml(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushAll();
      out.push("<hr/>");
      continue;
    }

    const blockquote = line.match(/^\s*>\s?(.*)$/);
    if (blockquote) {
      flushParagraph();
      closeLists();
      quote.push(blockquote[1]);
      continue;
    }
    flushQuote();

    // A table needs its separator row to be a table at all.
    if (line.includes("|") && TABLE_RULE.test(lines[i + 1] ?? "")) {
      flushAll();
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(lines[i]);
        i += 1;
      }
      i -= 1;
      out.push(renderTable(rows));
      continue;
    }

    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushParagraph();
      const [, indent, marker, text] = item;
      const depth = depthOf(indent);
      const tag = /^\d/.test(marker) ? "ol" : "ul";
      closeLists(depth);
      const top = listStack[listStack.length - 1];
      if (!top || top.depth < depth) {
        openList(tag, depth);
      } else if (top.tag !== tag) {
        // Bullets turning into numbers at the same level: a new list.
        closeLists(depth - 1);
        openList(tag, depth);
      }
      out.push(`<li>${inlineToHtml(text)}</li>`);
      continue;
    }

    closeLists();
    paragraph.push(line.trim());
  }

  flushAll();
  return out.join("");
}
