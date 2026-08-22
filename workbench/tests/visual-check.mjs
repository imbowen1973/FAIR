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
  const { asListType, parseSlides } = await import("./library.js");
  const { blockDocuments } = await import("./documents.js");
  const { tabs } = await import("./tabs.js");
  const { markdownEditor } = await import("./mdeditor.js");
  const { splitQuestions, readQuestion } = await import("./assessment.js");
  const { questionForm } = await import("./assessmentui.js");
  const { outcomesEditor, outcomeList } = await import("./outcomes.js");
  const { slideMeta } = await import("./meta.js");
  const { resolveMedia, videoHost, videoThumb } = await import("./media.js");
  const { prepareImage } = await import("./attach.js");
  const { attributionEditor, repoLogos } = await import("./course.js");
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
  // Always on a list of our own: gating this on the deck's own content
  // meant it quietly ran on nothing.
  let tabbed = null;
  let untabbed = null;
  {
    let latest = null;
    drawSlide(host, {
      geometry, layoutKey: "Full",
      slide: { id: "t", layout: "Full", full: { type: "ul", items: ["one", "two", "three"] } },
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

  // All three list types draw as separate lines. "None" is the one that
  // can silently fail: a bare string is drawn as a single paragraph, so
  // several lines inside one would run together on the slide.
  const listTypes = {};
  for (const kind of ["ul", "ol", null]) {
    const value = asListType({ type: "ul", items: ["alpha", "beta", "gamma"] }, kind);
    drawSlide(host, {
      geometry, layoutKey: "Full",
      slide: { id: "t", layout: "Full", full: value },
      editable: true, onChange: () => {},
    });
    const box = host.querySelector(".region:not(.vacant)");
    const li = box.querySelector("li");
    const tops = [...box.querySelectorAll("p, li")].map((e) =>
      Math.round(e.getBoundingClientRect().top)
    );
    listTypes[kind ?? "none"] = {
      tag: box.querySelector("ol") ? "ol" : box.querySelector("ul") ? "ul" : "p",
      lines: new Set(tops).size,
      markerRoom: li
        ? Math.round(li.getBoundingClientRect().left - box.getBoundingClientRect().left)
        : null,
    };
  }

  // A block is a session: its documents are tabs, and each opens its own
  // editor. Layout only tells you whether they actually draw.
  const block = {
    id: "01-x",
    meta: {
      resources: [
        { type: "workbook", title: "Learner workbook", path: "workbook.md" },
        { type: "file", title: "Data", path: "files/data.xlsx" },
      ],
    },
  };
  const blockFiles = new Map([
    ["blocks/01-x/slides.md", ""],
    ["blocks/01-x/lessonplan.md", "# Plan"],
    ["blocks/01-x/workbook.md", "# Workbook"],
    ["blocks/01-x/files/data.xlsx", ""],
  ]);
  const tabHost = document.createElement("div");
  document.body.appendChild(tabHost);
  let openedTab = null;
  tabs(tabHost, {
    documents: blockDocuments(block, blockFiles),
    active: "slides",
    onOpen: (id) => (openedTab = id),
    onAdd: () => {},
    onRemove: () => {},
  });
  // By name, not by position: the strip gains tabs over time and an
  // index-based click quietly starts testing a different one.
  tabHost.querySelector('.tab[data-doc="workbook.md"]').click();
  // A block whose lesson plan has never been written: the strip has to
  // say so, or "there is no lesson plan" is invisible until you open it.
  const bareHost = document.createElement("div");
  document.body.appendChild(bareHost);
  tabs(bareHost, {
    documents: blockDocuments(block, new Map([["blocks/01-x/slides.md", ""]])),
    active: "slides",
    onOpen: () => {},
    onAdd: () => {},
    onRemove: () => {},
  });

  const tabbar = {
    labels: [...tabHost.querySelectorAll(".tab-label")].map((t) => t.textContent),
    opened: openedTab,
    // The deck and the lesson plan are required, so neither can be closed.
    closable: [...tabHost.querySelectorAll(".tab")]
      .filter((t) => t.querySelector(".tab-close"))
      .map((t) => t.dataset.doc),
    // Adding a resource is how every document after the first gets made,
    // so the button carries a word, not just a glyph.
    addLabel: bareHost.querySelector(".tab.addbtn")?.textContent.trim(),
    addOffers: (() => {
      bareHost.querySelector(".tab.addbtn").click();
      return [...bareHost.querySelectorAll(".kind-option .kind-label")].map(
        (m) => m.textContent
      );
    })(),
    // Hit testing, not a bounding box. The add pane once opened inside
    // the tab strip, which scrolls -- and `overflow-x: auto` forces
    // `overflow-y` to match, so the pane was clipped to the height of a
    // tab and opened invisibly. It still had a box, and a test that
    // clicked it still passed. Only asking "what is at this point"
    // catches that.
    addPaneHittable: (() => {
      const option = bareHost.querySelector(".kind-option");
      if (!option) return false;
      const r = option.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit && option.contains(hit));
    })(),
    uncreated: [...bareHost.querySelectorAll(".tab.uncreated .tab-label")].map(
      (t) => t.textContent
    ),
  };

  // The document editor: rich text by default, source a click away.
  // Both must work -- the source view is the fallback when the editor
  // cannot be fetched, and the escape hatch when it reformats something.
  const mdHost = document.createElement("div");
  document.body.appendChild(mdHost);
  const NL = String.fromCharCode(10);
  let mdText = null;
  let mdCalls = 0;
  markdownEditor(mdHost, {
    text: ["# Plan", "", "- one"].join(NL),
    onChange: (v) => {
      mdCalls += 1;
      mdText = v;
    },
  });
  // Give the editor time to fetch and mount before looking at it.
  await new Promise((done) => setTimeout(done, 4000));
  const rich = {
    tabs: [...mdHost.querySelectorAll(".viewtab")].map((t) => t.textContent),
    mounted: Boolean(mdHost.querySelector(".ProseMirror")),
    headings: mdHost.querySelectorAll(".ProseMirror h1").length,
    items: mdHost.querySelectorAll(".ProseMirror li").length,
    // Opening a document must not change a byte of it.
    changesOnLoad: mdCalls,
  };

  // Now the source view, and its toolbar.
  mdHost.querySelectorAll(".viewtab")[1].click();
  await new Promise((done) => setTimeout(done, 200));
  const area = mdHost.querySelector("textarea.mdsource");
  area.focus();
  area.setSelectionRange(2, 6);
  mdHost.querySelectorAll(".mdbar button")[3].dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true })
  );
  const mdeditor = {
    preview: mdHost.querySelector(".mdpreview").innerHTML,
    bolded: mdText,
  };

  // The question form: several edits in a row must all survive, which is
  // where a form that patches its original data quietly loses one.
  const qHost = document.createElement("div");
  document.body.appendChild(qHost);
  const quiz = splitQuestions(
    [
      "<quiz>",
      '  <question type="multichoice">',
      "    <name><text>q1</text></name>",
      '    <questiontext format="html"><text><![CDATA[<p>Which?</p>]]></text></questiontext>',
      '    <answer fraction="100"><text>Yes</text></answer>',
      "    <tags><tag><text>AP1</text></tag></tags>",
      "  </question>",
      "</quiz>",
      "",
    ].join(NL)
  );
  let qLatest = null;
  questionForm(qHost, {
    data: readQuestion(quiz.questions[0].source),
    competencies: { AP1: "a", AP2: "b" },
    onChange: (v) => (qLatest = v),
  });
  const stem = qHost.querySelector("textarea.q-text");
  stem.value = "<p>Rewritten</p>";
  stem.dispatchEvent(new Event("input", { bubbles: true }));
  qHost.querySelectorAll(".chip")[1].click();
  // Moodle's three kinds of feedback are not interchangeable, and the
  // form has to offer all of them or an import is silently poorer.
  const question = {
    stem: qLatest?.questiontext,
    tags: qLatest?.tags,
    showsSource: Boolean(qHost.querySelector(".q-source code")?.textContent),
    sections: [...qHost.querySelectorAll("h4")].map((h) => h.textContent),
    feedbackFields: [...qHost.querySelectorAll(".q-feedback label")].map(
      (l) => l.textContent
    ),
  };

  // The alignment map: an outcome nothing serves is a claim with no
  // content behind it, and the coverage column is how an author sees it.
  const catalogue = {
    outcomes: {
      O1: { statement: "Distinguish andragogy", develops: ["AP1"], dok: 2 },
      O2: { statement: "Nobody teaches this", develops: ["AP2"] },
    },
  };
  const outHost = document.createElement("div");
  document.body.appendChild(outHost);
  outcomesEditor(outHost, {
    outcomes: outcomeList(catalogue),
    competencies: { AP1: "a", AP2: "b" },
    blocks: [{ id: "b1", title: "First session" }, { id: "b2", title: "Second session" }],
    owner: { O1: "b1" },
    coverage: { O1: { slides: 3, questions: 1 } },
    onChange: () => {},
    onOwner: () => {},
  });
  const alignment = {
    // Outcome cards only: the progression rows below carry their own
    // coverage line, and counting both together measures nothing.
    coverage: [...outHost.querySelectorAll(".outcome .coverage")].map((c) => c.textContent),
    flagged: outHost.querySelectorAll(".outcome .coverage.none").length,
    groups: [...outHost.querySelectorAll(".outcome-group")].map((g) => g.textContent),
    // A competency built in one session is a learning outcome wearing a
    // competency's name, and the panel has to say so.
    confined: [...outHost.querySelectorAll(".progression")]
      .filter((r) => r.querySelector(".coverage.none"))
      .map((r) => r.querySelector(".prog-id")?.textContent),
  };

  // A slide's competencies are derived from its outcomes, and shown as
  // such -- an author should not have to work out what the slide claims.
  const metaHost = document.createElement("div");
  document.body.appendChild(metaHost);
  slideMeta(metaHost, {
    slide: { id: "s1", outcomes: ["O1"], develops: ["AP9"] },
    competencies: { AP1: "a", AP2: "b", AP9: "z" },
    outcomes: catalogue.outcomes,
    onChange: () => {},
  });
  const derived = {
    fromOutcome: [...metaHost.querySelectorAll(".chip.derived")].map((c) => c.textContent),
    lit: [...metaHost.querySelectorAll(".chip.on")].map((c) => c.textContent),
  };

  // Media is shown, not named. A picture is the one thing on a slide
  // whose effect cannot be judged from its file path, so a preview that
  // prints the path is not a preview of anything.
  const mediaHelpers = {
    resolve: (src) =>
      resolveMedia(src, {
        blockId: "b",
        repo: { owner: "o", repo: "r", defaultBranch: "main" },
        uploads: new Map(),
        urls: new Map(),
      }),
    thumb: videoThumb,
    host: videoHost,
  };
  const pictureLayout = Object.keys(geometry.layouts).find((key) =>
    Object.keys(geometry.layouts[key].regions || {}).some((n) => /picture|image/i.test(n))
  );
  let media = { skipped: true };
  if (pictureLayout) {
    const pictureRegion = Object.keys(geometry.layouts[pictureLayout].regions).find(
      (n) => /picture|image/i.test(n)
    );
    const mediaHost = document.createElement("div");
    mediaHost.style.width = "900px";
    document.body.appendChild(mediaHost);
    let opened = null;
    drawSlide(mediaHost, {
      geometry,
      layoutKey: pictureLayout,
      slide: { id: "m", layout: pictureLayout, [pictureRegion]: { type: "image", src: "media/x.png" } },
      editable: true,
      media: mediaHelpers,
      onChange: () => {},
      onMedia: (region, value, kind) => (opened = { region, kind }),
    });
    const videoHostEl = document.createElement("div");
    videoHostEl.style.width = "900px";
    document.body.appendChild(videoHostEl);
    drawSlide(videoHostEl, {
      geometry,
      layoutKey: pictureLayout,
      slide: {
        id: "v", layout: pictureLayout,
        [pictureRegion]: { type: "video", url: "https://youtu.be/dQw4w9WgXcQ" },
      },
      editable: true, media: mediaHelpers, onChange: () => {}, onMedia: () => {},
    });
    mediaHost.querySelector(".media")?.click();
    media = {
      skipped: false,
      image: Boolean(mediaHost.querySelector("img.media-image")),
      // A still for the video, and a mark saying it is one -- a frame of
      // a video and a picture are not the same thing to a reader.
      videoStill: Boolean(videoHostEl.querySelector("img.media-image")),
      playBadge: Boolean(videoHostEl.querySelector(".media-play")),
      opensPicker: opened,
    };
  }

  // The asset policy, enforced where the bytes are. A detailed photo at
  // one pass and 2000px lands well over the 500 KB the build allows, and
  // an upload that ignored that would commit a file CI then refuses --
  // a failure after the fact, and the worst moment to learn a limit.
  const canvas = document.createElement("canvas");
  canvas.width = 3000;
  canvas.height = 2000;
  const ctx = canvas.getContext("2d");
  const noise = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < noise.data.length; i += 4) {
    noise.data[i] = Math.random() * 255;
    noise.data[i + 1] = Math.random() * 255;
    noise.data[i + 2] = Math.random() * 255;
    noise.data[i + 3] = 255;
  }
  ctx.putImageData(noise, 0, 0);
  const big = await new Promise((done) =>
    canvas.toBlob((blob) => done(new File([blob], "big.jpg", { type: "image/jpeg" })), "image/jpeg", 1)
  );
  let assets = { skipped: true };
  try {
    const prepared = await prepareImage(big);
    assets = { skipped: false, kb: Math.round(prepared.bytes.length / 1024) };
  } catch (err) {
    assets = { skipped: false, refused: String(err.message).slice(0, 60) };
  }

  // The funder stamp goes on every slide, so it is drawn while authoring.
  // The emblem's height is in centimetres against the slide's real width,
  // because the EU emblem has a 1 cm minimum and that has to be checkable
  // on screen rather than only after a render.
  const stampHost = document.createElement("div");
  stampHost.style.width = "900px";
  document.body.appendChild(stampHost);
  drawSlide(stampHost, {
    geometry,
    layoutKey: Object.keys(geometry.layouts)[0],
    slide: { id: "s", layout: Object.keys(geometry.layouts)[0], title: "A slide" },
    attribution: {
      text: "Funded by the European Union",
      corner: "bottom-left",
      opacity: 0.45,
      logo_height_cm: 1,
      logoUrl:
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    },
    media: {},
  });
  await new Promise((done) => setTimeout(done, 200));
  const stampEl = stampHost.querySelector(".attr-stamp");
  const stampImg = stampEl?.querySelector("img");
  const slideCm = ((geometry.slide?.widthEmu ?? 9144000) / 914400) * 2.54;
  const stamp = {
    drawn: Boolean(stampEl),
    left: Boolean(stampEl?.classList.contains("left")),
    faded: stampEl?.style.opacity === "0.45",
    emblemPx: stampImg ? Math.round(stampImg.getBoundingClientRect().height) : 0,
    // What 1 cm should be on a 900px rendering of this slide.
    expectedPx: Math.round(900 / slideCm),
  };

  // An empty placeholder has to say what it can hold. A picture
  // placeholder that offers to add text is why there was no way to put
  // an image on a slide that did not already have one.
  const emptyHost = document.createElement("div");
  emptyHost.style.width = "900px";
  document.body.appendChild(emptyHost);
  const pictureLayoutKey = Object.keys(geometry.layouts).find((key) =>
    Object.values(geometry.layouts[key].regions || {}).some((r) => r.type === "picture")
  );
  let placeholders = { skipped: true };
  if (pictureLayoutKey) {
    const openedPicker = [];
    const madeText = [];
    drawSlide(emptyHost, {
      geometry,
      layoutKey: pictureLayoutKey,
      slide: { id: "empty", layout: pictureLayoutKey },
      editable: true,
      media: {},
      onChange: (region) => madeText.push(region),
      onMedia: (region, value, kind) => openedPicker.push({ region, kind }),
    });
    const boxes = [...emptyHost.querySelectorAll(".region.vacant")];
    for (const box of boxes) {
      const picture = box.querySelector(".vacant-media");
      if (picture) picture.click();
      else box.click();
    }
    placeholders = {
      skipped: false,
      labels: boxes.map((b) => b.querySelector(".region-name").textContent),
      openedPicker,
      madeText,
    };
  }

  const vacant = host.querySelectorAll(".region.vacant").length;
  return { fit, edited, markEdit, vacant, markerRoom, tabbed, untabbed, listTypes,
    tabbar, mdeditor, question, alignment, derived, rich, media, assets, stamp,
    placeholders };
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
for (const [kind, r] of Object.entries(result.listTypes)) {
  console.log(
    `  list "${kind}": <${r.tag}> ${r.lines} lines` +
      (r.markerRoom === null ? "" : `, marker room ${r.markerRoom}px`)
  );
}
console.log(`  tabs: ${result.tabbar.labels.join(" | ")}`);
console.log(`  opening a tab: ${result.tabbar.opened}`);
console.log(`  not created yet: ${result.tabbar.uncreated.join(", ") || "none"}`);
console.log(`  add button: "${result.tabbar.addLabel}" offering ` +
  `${result.tabbar.addOffers.length} kinds, pane hittable: ` +
  `${result.tabbar.addPaneHittable}`);
console.log(`  document views: ${result.rich.tabs.join(" | ")}`);
console.log(`  rich editor mounted: ${result.rich.mounted}` +
  ` (${result.rich.headings} heading, ${result.rich.items} items),` +
  ` changes on load: ${result.rich.changesOnLoad}`);
console.log(`  markdown bold: ${JSON.stringify(result.mdeditor.bolded)}`);
console.log(`  question edits kept: ${JSON.stringify({ stem: result.question.stem, tags: result.question.tags })}`);
console.log(`  question sections: ${result.question.sections.join(" | ")}`);
console.log(`  feedback offered: ${result.question.feedbackFields.join(" | ")}`);
console.log(`  outcome coverage: ${result.alignment.coverage.join(" / ")}`);
console.log(`  grouped by session: ${result.alignment.groups.join(" | ")}`);
console.log(`  competencies confined to one session: ${result.alignment.confined.join(", ") || "none"}`);
console.log(`  derived from outcome: ${JSON.stringify(result.derived.fromOutcome)}`);
console.log(`  media: ${JSON.stringify(result.media)}`);
console.log(`  empty placeholders: ${result.placeholders.labels?.join(" | ")}`);
console.log(`  picker opened for: ${JSON.stringify(result.placeholders.openedPicker)}`);
console.log(`  worst-case upload: ${JSON.stringify(result.assets)}`);
console.log(`  funder stamp: ${JSON.stringify(result.stamp)}`);
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
  Object.values(result.listTypes).some((r) => r.lines !== 3) ||
  Object.values(result.listTypes).some((r) => r.markerRoom !== null && r.markerRoom < 12) ||
  result.tabbar.opened !== "workbook.md" ||
  result.tabbar.closable.includes("slides") ||
  result.tabbar.closable.includes("lessonplan.md") ||
  result.tabbar.addLabel !== "Add" ||
  result.tabbar.addOffers.length < 4 ||
  !result.tabbar.addOffers.includes("Assessment") ||
  !result.tabbar.addOffers.includes("Teacher resources") ||
  !result.tabbar.addPaneHittable ||
  !result.tabbar.uncreated.includes("Lesson plan") ||
  !result.mdeditor.preview.includes("<h1>") ||
  !String(result.mdeditor.bolded).includes("**Plan**") ||
  !result.rich.mounted ||
  result.rich.headings !== 1 ||
  result.rich.changesOnLoad !== 0 ||
  result.question.stem !== "<p>Rewritten</p>" ||
  !result.question.tags?.includes("AP2") ||
  !result.question.tags?.includes("AP1") ||
  !result.question.showsSource ||
  !result.question.sections.includes("Feedback") ||
  !result.question.sections.includes("Hints between attempts") ||
  result.question.feedbackFields.length !== 4 ||
  result.alignment.flagged !== 1 ||
  !result.alignment.groups.includes("First session") ||
  !result.alignment.groups.includes("Not yet assigned to a session") ||
  !result.alignment.confined.includes("AP1") ||
  !result.alignment.coverage[0].includes("3 slides") ||
  JSON.stringify(result.derived.fromOutcome) !== JSON.stringify(["AP1"]) ||
  !result.derived.lit.includes("O1") ||
  !result.derived.lit.includes("AP9") ||
  (!result.assets.skipped && !(result.assets.kb <= 500)) ||
  (!result.placeholders.skipped &&
    (!result.placeholders.labels.some((l) => l.includes("picture")) ||
      !result.placeholders.openedPicker.length)) ||
  !result.stamp.drawn ||
  !result.stamp.left ||
  !result.stamp.faded ||
  Math.abs(result.stamp.emblemPx - result.stamp.expectedPx) > 2 ||
  (!result.media.skipped &&
    (!result.media.image ||
      !result.media.videoStill ||
      !result.media.playBadge ||
      !result.media.opensPicker)) ||
  !Array.isArray(result.tabbed?.items?.[0]?.items) ||
  JSON.stringify(result.untabbed?.items) !== JSON.stringify(["one", "two", "three"]);
console.log(failed ? "\nFAIL" : "\nPASS");
process.exit(failed ? 1 : 0);
