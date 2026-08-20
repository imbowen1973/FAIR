// Drive the editor in a real browser and check what only layout can tell.
//
// Two questions no amount of reasoning answers: does text fit its
// placeholder, and does typing into a region actually change the slide
// data. Both need a layout engine, so this drives Edge against the dev
// server.
//
//   node tests/visual-check.mjs [screenshot.png]
//
// Not part of `npm test`: it needs a browser and a running server.

import { chromium } from "playwright-core";

const BASE = process.env.WB || "https://localhost:3000/workbench/";
const shot = process.argv[2];

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({
  ignoreHTTPSErrors: true,
  viewport: { width: 1500, height: 1000 },
});

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e.message)));

await page.goto(BASE, { waitUntil: "networkidle" });

const result = await page.evaluate(async () => {
  const { drawSlide } = await import("./canvas.js");
  const { parseSlides } = await import("./library.js");
  const raw = (p) =>
    fetch(
      `https://raw.githubusercontent.com/Agrifoodskills/Andragogy-Pedagogy/HEAD/${p}`
    ).then((r) => r.text());

  const geometry = JSON.parse(await raw("layout-geometry.json"));
  const parsed = parseSlides(
    await raw("blocks/01-the-paradigm-shift-from-pedagogy-to/slides.md")
  );

  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.style.width = "820px";
  document.body.appendChild(host);

  const fit = [];
  for (const slide of parsed.slides) {
    drawSlide(host, {
      geometry,
      layoutKey: slide.data.layout,
      slide: slide.data,
      editable: true,
      onChange: () => {},
    });
    for (const box of host.querySelectorAll(".region:not(.vacant)")) {
      fit.push({
        slide: slide.data.id,
        region: box.dataset.region,
        overflowPx: Math.max(0, box.scrollHeight - box.clientHeight),
        editable: box.getAttribute("contenteditable") === "true",
      });
    }
  }

  // Editing: type into a region and check the change reaches the data.
  const comparison = parsed.slides.find((s) => s.data.layout === "Comparison");
  let edited = null;
  drawSlide(host, {
    geometry,
    layoutKey: comparison.data.layout,
    slide: comparison.data,
    editable: true,
    onChange: (region, value) => {
      edited = { region, value };
    },
  });
  const head = host.querySelector('.region[data-region="left_head"]');
  head.focus();
  const p = head.querySelector("p");
  p.textContent = "Pedagogy: rewritten";
  head.dispatchEvent(new Event("input", { bubbles: true }));

  // And a mark applied through the DOM, to prove serialisation survives.
  const body = host.querySelector('.region[data-region="left"]');
  const firstP = body.querySelector("p");
  let markEdit = null;
  drawSlide(host, {
    geometry,
    layoutKey: comparison.data.layout,
    slide: comparison.data,
    editable: true,
    onChange: (region, value) => {
      markEdit = { region, value };
    },
  });
  const target = host.querySelector('.region[data-region="left"] p');
  target.innerHTML = 'CO<sub>2</sub> at 37 <sup>o</sup>C';
  host
    .querySelector('.region[data-region="left"]')
    .dispatchEvent(new Event("input", { bubbles: true }));

  // Numbered lists: the marker is drawn at the item's size, so a padding
  // in em on the list clips "10." unless the sizes agree.
  let markerRoom = null;
  const numbered = parsed.slides.find((s) =>
    Object.values(s.data).some((v) => v && v.type === "ol")
  );
  if (numbered) {
    drawSlide(host, {
      geometry, layoutKey: numbered.data.layout, slide: numbered.data,
      editable: true, onChange: () => {},
    });
    const li = host.querySelector("li");
    if (li) {
      const box = li.closest(".region");
      markerRoom = Math.round(
        li.getBoundingClientRect().left - box.getBoundingClientRect().left
      );
    }
  }

  // Tab nests an item under the one above it; Shift+Tab lifts it back.
  let tabbed = null;
  let untabbed = null;
  const listSlide = {
    id: "t", layout: numbered?.data.layout ?? "Full",
    ...(numbered ? {} : { full: { type: "ul", items: ["one", "two", "three"] } }),
  };
  if (!numbered) {
    let latest = null;
    drawSlide(host, {
      geometry, layoutKey: listSlide.layout, slide: listSlide,
      editable: true, onChange: (r, v) => (latest = v),
    });
    const lis = [...host.querySelectorAll("li")];
    const box = lis[0]?.closest(".region");
    if (box && lis[1]) {
      const range = document.createRange();
      range.selectNodeContents(lis[1]);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      tabbed = JSON.parse(JSON.stringify(latest));
      box.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })
      );
      untabbed = JSON.parse(JSON.stringify(latest));
    }
  }

  const vacant = host.querySelectorAll(".region.vacant").length;
  return { fit, edited, markEdit, vacant, markerRoom, tabbed, untabbed };
});

/** A region's value is a string or a typed object; both carry text. */
function markText(edit) {
  const value = edit?.value;
  if (typeof value === "string") return value;
  return String(value?.text ?? "");
}

const overflowing = result.fit.filter((r) => r.overflowPx > 1);
const notEditable = result.fit.filter((r) => !r.editable);

console.log(`regions drawn: ${result.fit.length}`);
console.log(`  overflowing: ${overflowing.length}`);
for (const r of overflowing) {
  console.log(`    ${r.slide}/${r.region} by ${r.overflowPx}px`);
}
console.log(`  not editable: ${notEditable.length}` +
  (notEditable.length ? ` (${notEditable.map((r) => r.region).join(", ")})` : ""));
console.log(`  empty regions offered: ${result.vacant}`);
if (result.markerRoom !== null) {
  console.log(`  list marker room: ${result.markerRoom}px`);
}
if (result.tabbed) {
  console.log(`  Tab nests:      ${JSON.stringify(result.tabbed.items)}`);
  console.log(`  Shift+Tab lifts:${JSON.stringify(result.untabbed.items)}`);
}
console.log(`typing reached the data:`, JSON.stringify(result.edited));
console.log(`marks survived serialisation:`, JSON.stringify(result.markEdit));
if (errors.length) console.log("console errors:", errors.slice(0, 5));

if (shot) {
  await page.locator(".stage").first().screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);
}
await browser.close();

const failed =
  overflowing.length > 0 ||
  errors.length > 0 ||
  !result.edited ||
  !markText(result.markEdit).includes("~2~") ||
  !markText(result.markEdit).includes("^o^") ||
  (result.markerRoom !== null && result.markerRoom < 12) ||
  (result.tabbed && !Array.isArray(result.tabbed.items[0]?.items));
console.log(failed ? "\nFAIL" : "\nPASS");
process.exit(failed ? 1 : 0);
