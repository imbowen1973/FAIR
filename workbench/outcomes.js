// The alignment map: outcomes, competencies, and the difference.
//
// These are two different kinds of thing and the editor says so:
//
//   A **learning outcome** belongs to one session. It is what that
//   session is for, and it is assessable inside it. So outcomes are
//   grouped under the session that owns them, and each carries a session
//   picker rather than floating free.
//
//   A **competency** is broader and builds across sessions. So it is not
//   edited here at all — it is shown as a progression: which sessions
//   develop it, in delivery order, at what level. A competency that
//   appears in one session is not building across anything, and the
//   panel says so plainly.
//
// An outcome nothing serves, and a competency confined to one session,
// are the two things nobody notices until an external reviewer asks.

const OUTCOMES_PATH = "outcomes.yaml";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Outcomes as a list the editor can walk, from the parsed YAML. */
export function outcomeList(doc) {
  const entries = doc?.outcomes;
  if (!entries || typeof entries !== "object") return [];
  return Object.entries(entries).map(([id, entry]) =>
    typeof entry === "string"
      ? { id, statement: entry, develops: [], dok: null }
      : {
          id,
          statement: String(entry?.statement ?? ""),
          develops: [...(entry?.develops ?? [])],
          dok: entry?.dok ?? null,
        }
  );
}

/** The list back into the shape outcomes.yaml holds. */
export function outcomeDoc(list) {
  const outcomes = {};
  for (const o of list) {
    if (!o.id) continue;
    const entry = { statement: o.statement };
    if (o.develops?.length) entry.develops = [...o.develops];
    if (o.dok) entry.dok = Number(o.dok);
    outcomes[o.id] = entry;
  }
  return { outcomes };
}

/** A free id for a new outcome: O1, O2, … */
export function freeOutcomeId(taken) {
  for (let n = 1; n < 999; n += 1) {
    const candidate = `O${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `O${taken.size + 1}`;
}

/**
 * How each competency is built, from the outcomes and their owners.
 *
 * `[{id, label, sessions: [{blockId, title, dok}], confined}]` in
 * delivery order. `confined` marks a competency that never leaves one
 * session — which is a learning outcome wearing a competency's name.
 */
export function progression(outcomes, owner, blocks, competencies) {
  const order = new Map(blocks.map((b, i) => [b.id, i]));
  const byCompetency = new Map();
  for (const outcome of outcomes) {
    const blockId = owner?.[outcome.id];
    if (!blockId) continue;
    for (const cid of outcome.develops) {
      if (!byCompetency.has(cid)) byCompetency.set(cid, new Map());
      const seen = byCompetency.get(cid);
      const dok = outcome.dok ?? null;
      // The highest level any of that session's outcomes reaches.
      const prev = seen.get(blockId);
      if (prev === undefined || (dok ?? 0) > (prev ?? 0)) seen.set(blockId, dok);
    }
  }

  return Object.entries(competencies || {}).map(([id, label]) => {
    const seen = byCompetency.get(id) ?? new Map();
    const sessions = [...seen.entries()]
      .sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99))
      .map(([blockId, dok]) => ({
        blockId,
        title: blocks.find((b) => b.id === blockId)?.title ?? blockId,
        dok,
      }));
    return { id, label, sessions, confined: sessions.length === 1 };
  });
}

/**
 * Build the catalogue editor.
 *
 * outcomes      from outcomeList()
 * competencies  {id: label} from the framework
 * blocks        [{id, title}] in delivery order
 * owner         {outcomeId: blockId} — which session claims each
 * coverage      {outcomeId: {slides, questions}} — where it is taught
 * onChange(list)          the catalogue changed
 * onOwner(id, blockId)    an outcome moved to another session
 */
export function outcomesEditor(host, {
  outcomes, competencies, blocks = [], owner = {}, coverage, onChange, onOwner,
}) {
  host.innerHTML = "";

  host.append(
    el(
      "p",
      "hint",
      "A learning outcome belongs to one session — it is what that session " +
        "is for. A competency is broader and builds across sessions. Slides " +
        "and questions point at outcomes, and the competencies they develop " +
        "follow from that."
    )
  );

  const entries = Object.entries(competencies || {});
  if (!entries.length) {
    host.append(
      el("p", "warn", "This library has no competencies/framework.yaml, so outcomes have nothing to develop yet.")
    );
  }

  // The working copy the cards mutate, so the progression panel can be
  // refreshed without rebuilding a card somebody is typing into.
  let live = outcomes;

  // ---- outcomes, grouped by the session that owns them ----------------
  const groups = [
    ...blocks.map((b) => ({ ...b, list: outcomes.filter((o) => owner[o.id] === b.id) })),
    {
      id: null,
      title: "Not yet assigned to a session",
      list: outcomes.filter((o) => !owner[o.id]),
    },
  ];

  for (const group of groups) {
    if (!group.list.length && group.id !== null) continue;
    if (!group.list.length && group.id === null) continue;

    const heading = el("h3", "outcome-group", group.title);
    if (group.id === null) heading.classList.add("unassigned");
    host.append(heading);

    for (const outcome of group.list) {
      host.append(outcomeCard(outcome, {
        outcomes, competencies: entries, blocks, owner, coverage, onChange, onOwner,
        refresh: () => {
          const panel = host.querySelector(".progressions");
          if (panel) drawProgressions(panel, live, owner, blocks, competencies);
        },
      }));
    }
  }

  const add = el("button", "add-slide", "+ outcome");
  add.type = "button";
  add.addEventListener("click", () => {
    const id = freeOutcomeId(new Set(outcomes.map((o) => o.id)));
    onChange([...outcomes, { id, statement: "", develops: [], dok: null }]);
  });
  host.append(add);

  // ---- competencies, as progressions ----------------------------------
  if (entries.length) {
    host.append(el("h3", "outcome-group", "Competencies, and where they build"));
    host.append(
      el(
        "p",
        "hint",
        "Not edited here: a competency is the thread through the course, " +
          "and it is made of the outcomes that develop it."
      )
    );
    const panel = el("div", "progressions");
    host.append(panel);
    drawProgressions(panel, outcomes, owner, blocks, competencies);
  }
}

/** Redraw just the progression panel, leaving the cards alone. */
function drawProgressions(panel, outcomes, owner, blocks, competencies) {
  panel.innerHTML = "";
  for (const comp of progression(outcomes, owner, blocks, competencies)) {
    panel.append(progressionRow(comp));
  }
}

function outcomeCard(outcome, {
  outcomes, competencies, blocks, owner, coverage, onChange, onOwner, refresh,
}) {
  const index = outcomes.findIndex((o) => o.id === outcome.id);
  const card = el("div", "outcome");
  const change = (patch, structural = true) => {
    const next = outcomes.map((o, i) => (i === index ? { ...o, ...patch } : o));
    onChange(next, { structural });
    return next;
  };

  const head = el("div", "outcome-head");
  const id = el("input", "text id");
  id.type = "text";
  id.value = outcome.id;
  id.size = 6;
  id.setAttribute("aria-label", `Outcome ${outcome.id} id`);
  id.title = "The id slides and questions reference. Renaming it here does not update those references.";
  id.addEventListener("change", () => change({ id: id.value.trim() }));

  // An outcome belongs to one session, so this is a single choice.
  const session = el("select", "session");
  session.setAttribute("aria-label", `Session for outcome ${outcome.id}`);
  const none = el("option", null, "no session");
  none.value = "";
  session.append(none);
  for (const block of blocks) {
    const option = el("option", null, block.title);
    option.value = block.id;
    session.append(option);
  }
  session.value = owner[outcome.id] ?? "";
  session.addEventListener("change", () => onOwner?.(outcome.id, session.value || null));

  const where = coverage?.[outcome.id];
  const cover = el("span", "coverage");
  if (!where || !where.slides) {
    cover.classList.add("none");
    cover.textContent = owner[outcome.id]
      ? "no slide serves it"
      : "not taught anywhere";
  } else {
    cover.textContent =
      `${where.slides} slide${where.slides === 1 ? "" : "s"}` +
      (where.questions ? `, ${where.questions} question${where.questions === 1 ? "" : "s"}` : "");
  }

  const remove = el("button", "tool", "×");
  remove.type = "button";
  remove.title = `Remove ${outcome.id}`;
  remove.setAttribute("aria-label", `Remove outcome ${outcome.id}`);
  remove.addEventListener("click", () => {
    if (where?.slides && !window.confirm(
      `${outcome.id} is used by ${where.slides} slide(s). Remove it anyway?`
    )) return;
    onChange(outcomes.filter((_, i) => i !== index));
  });

  head.append(id, session, cover, remove);
  card.append(head);

  const statement = el("textarea", "q-text");
  statement.rows = 2;
  statement.value = outcome.statement;
  statement.placeholder = "By the end of this session, learners will be able to…";
  statement.setAttribute("aria-label", `Outcome ${outcome.id} statement`);
  // Not structural: rebuilding the editor on every keystroke takes the
  // caret with it, which makes the field unusable.
  statement.addEventListener("input", () =>
    change({ statement: statement.value }, false)
  );
  card.append(statement);

  const foot = el("div", "outcome-foot");
  const chips = el("div", "chips");
  for (const [cid, label] of competencies) {
    const chip = el("button", "chip", cid);
    chip.type = "button";
    chip.title = label;
    if (outcome.develops.includes(cid)) chip.classList.add("on");
    chip.addEventListener("click", () => {
      const develops = outcome.develops.includes(cid)
        ? outcome.develops.filter((c) => c !== cid)
        : [...outcome.develops, cid];
      // Toggled in place and the progressions redrawn: a chip is a
      // button, and losing the page under it on every press is jarring.
      chip.classList.toggle("on", develops.includes(cid));
      outcome.develops = develops;
      refresh?.();
      change({ develops }, false);
    });
    chips.append(chip);
  }
  foot.append(chips);

  const dokWrap = el("label", "check");
  dokWrap.append(el("span", null, "Level"));
  const dok = el("select", "dok");
  for (const level of ["", "1", "2", "3", "4"]) {
    const option = el("option", null, level || "not set");
    option.value = level;
    dok.append(option);
  }
  dok.value = outcome.dok ? String(outcome.dok) : "";
  dok.addEventListener("change", () => {
    outcome.dok = dok.value ? Number(dok.value) : null;
    refresh?.();
    change({ dok: outcome.dok }, false);
  });
  dokWrap.append(dok);
  foot.append(dokWrap);
  card.append(foot);
  return card;
}

function progressionRow(comp) {
  const row = el("div", "progression");
  const head = el("div", "progression-head");
  head.append(el("span", "prog-id", comp.id));
  head.append(el("span", "prog-label", comp.label));
  row.append(head);

  if (!comp.sessions.length) {
    row.append(el("span", "coverage none", "no outcome develops this"));
    return row;
  }

  const track = el("div", "prog-track");
  for (const [index, session] of comp.sessions.entries()) {
    if (index) track.append(el("span", "prog-arrow", "→"));
    const step = el("span", "prog-step");
    step.append(el("span", "prog-session", session.title));
    step.append(el("span", "prog-dok", session.dok ? `DOK ${session.dok}` : "level not set"));
    track.append(step);
  }
  row.append(track);

  if (comp.confined) {
    // The user's distinction, made visible: this is not building across
    // anything, whatever it is called.
    row.append(
      el(
        "span",
        "coverage none",
        "built in one session only — a competency should build across " +
          "sessions; this may really be a learning outcome"
      )
    );
  }
  return row;
}

export { OUTCOMES_PATH };

// ---- slides that are filled rather than typed ---------------------------
//
// Mirrors outcomes.fill_roles in the renderer. The canvas has to show
// what the deck will actually say, or a role slide looks empty in the
// editor and full in the artifact — which is exactly the kind of lie the
// honest-preview rule exists to prevent.

/** The region a body of text belongs in, for a given layout. */
function firstContentRegion(regions) {
  return (regions || []).find((name) => name !== "title" && name !== "subtitle") ?? null;
}

/**
 * A slide with its role filled in, for preview.
 *
 * Returns the slide unchanged when it has no role, and never overwrites
 * anything the author wrote — a role fills what is absent.
 */
export function fillRole(slide, { blockMeta, catalogue, layoutRegions }) {
  const role = slide?.role;
  if (!role) return slide;
  const filled = { ...slide };
  const regions = layoutRegions || [];
  const owned = (blockMeta?.outcomes ?? []).map(String);

  if (role === "title") {
    if (filled.title === undefined && blockMeta?.title) filled.title = blockMeta.title;
    if (filled.subtitle === undefined && regions.includes("subtitle")) {
      const bits = [];
      if (blockMeta?.code) bits.push(String(blockMeta.code));
      if (blockMeta?.duration_minutes) bits.push(`${blockMeta.duration_minutes} minutes`);
      if (bits.length) filled.subtitle = bits.join(" · ");
    }
    return filled;
  }

  if (role === "outcomes") {
    if (filled.title === undefined) filled.title = "Learning outcomes";
    const body = firstContentRegion(regions);
    if (body && filled[body] === undefined) {
      const items = owned
        .map((oid) => catalogue?.[oid]?.statement)
        .filter(Boolean);
      if (items.length) filled[body] = { type: "ul", items };
    }
  }
  return filled;
}

/** Which regions a role fills, so the editor can mark them as derived. */
export function roleRegions(slide, layoutRegions) {
  if (!slide?.role) return [];
  const filled = [];
  if (slide.title === undefined) filled.push("title");
  if (slide.role === "title") {
    if (slide.subtitle === undefined && (layoutRegions || []).includes("subtitle")) {
      filled.push("subtitle");
    }
  } else if (slide.role === "outcomes") {
    const body = firstContentRegion(layoutRegions);
    if (body && slide[body] === undefined) filled.push(body);
  }
  return filled;
}

/** The two slides every session opens with, filled from the library. */
export function openingSlides(firstId = "s-01") {
  const stem = String(firstId).replace(/\d+$/, "") || "s-";
  return [
    { id: `${stem}01`, layout: "Title", role: "title" },
    { id: `${stem}02`, layout: "Full", role: "outcomes" },
  ];
}

/**
 * A session's own learning outcomes, edited in the session.
 *
 * Outcomes are written where they belong: a learning outcome is what
 * THIS session is for, so it is authored here rather than in a
 * course-wide list with a session picker. They are still stored in one
 * catalogue at the repo root, because slides and questions reference
 * them by id and ids have to be unique — but that is storage, and it is
 * not where an author should have to go to write one.
 *
 * The repo is the module: it holds the description and the competency
 * framework. A session holds outcomes. Keeping the two apart is the
 * whole point of the split.
 *
 * outcomes      this session's, as [{id, statement, develops, dok}]
 * competencies  {id: label} from the framework — repo level, not edited here
 * coverage      {outcomeId: {slides, questions}}
 * onChange(list, {structural})  an outcome was edited
 * onAdd()       a new outcome for this session
 * onRemove(id)  drop one
 */
export function sessionOutcomes(host, {
  outcomes, competencies, coverage, sessionTitle, onChange, onAdd, onRemove,
}) {
  host.innerHTML = "";

  host.append(
    el(
      "p",
      "hint",
      `What a learner will be able to do by the end of ${sessionTitle || "this session"}. ` +
        "Slides and questions point at these, and the competencies they " +
        "develop follow from them. Competencies are course-wide and live " +
        "with the course, not here."
    )
  );

  const entries = Object.entries(competencies || {});
  if (!entries.length) {
    host.append(
      el("p", "warn", "This course has no competency framework yet, so outcomes have nothing to develop.")
    );
  }

  if (!outcomes.length) {
    host.append(
      el("p", "warn", "This session has no learning outcomes yet.")
    );
  }

  for (const [index, outcome] of outcomes.entries()) {
    const card = el("div", "outcome");
    const change = (patch, structural = true) =>
      onChange(
        outcomes.map((o, i) => (i === index ? { ...o, ...patch } : o)),
        { structural }
      );

    const head = el("div", "outcome-head");
    const id = el("span", "prog-id", outcome.id);
    id.title = "The id slides and questions reference.";

    const where = coverage?.[outcome.id];
    const cover = el("span", "coverage");
    if (!where || !where.slides) {
      cover.classList.add("none");
      cover.textContent = "no slide serves it yet";
    } else {
      cover.textContent =
        `${where.slides} slide${where.slides === 1 ? "" : "s"}` +
        (where.questions ? `, ${where.questions} question${where.questions === 1 ? "" : "s"}` : "");
    }

    const remove = el("button", "tool", "×");
    remove.type = "button";
    remove.title = `Remove ${outcome.id}`;
    remove.setAttribute("aria-label", `Remove outcome ${outcome.id}`);
    remove.addEventListener("click", () => {
      if (where?.slides && !window.confirm(
        `${outcome.id} is used by ${where.slides} slide(s). Remove it anyway?`
      )) return;
      onRemove?.(outcome.id);
    });

    head.append(id, cover, remove);
    card.append(head);

    const statement = el("textarea", "q-text");
    statement.rows = 2;
    statement.value = outcome.statement;
    statement.placeholder = "By the end of this session, participants will be able to…";
    statement.setAttribute("aria-label", `Outcome ${outcome.id}`);
    // Not structural: rebuilding on every keystroke takes the caret.
    statement.addEventListener("input", () =>
      change({ statement: statement.value }, false)
    );
    card.append(statement);

    const foot = el("div", "outcome-foot");
    const chips = el("div", "chips");
    for (const [cid, label] of entries) {
      const chip = el("button", "chip", cid);
      chip.type = "button";
      chip.title = label;
      if (outcome.develops.includes(cid)) chip.classList.add("on");
      chip.addEventListener("click", () => {
        const develops = outcome.develops.includes(cid)
          ? outcome.develops.filter((c) => c !== cid)
          : [...outcome.develops, cid];
        chip.classList.toggle("on", develops.includes(cid));
        outcome.develops = develops;
        change({ develops }, false);
      });
      chips.append(chip);
    }
    foot.append(chips);

    const dokWrap = el("label", "check");
    dokWrap.append(el("span", null, "Level"));
    const dok = el("select", "dok");
    for (const level of ["", "1", "2", "3", "4"]) {
      const option = el("option", null, level || "not set");
      option.value = level;
      dok.append(option);
    }
    dok.value = outcome.dok ? String(outcome.dok) : "";
    dok.addEventListener("change", () => {
      outcome.dok = dok.value ? Number(dok.value) : null;
      change({ dok: outcome.dok }, false);
    });
    dokWrap.append(dok);
    foot.append(dokWrap);
    card.append(foot);
    host.append(card);
  }

  const add = el("button", "add-slide", "+ learning outcome");
  add.type = "button";
  add.addEventListener("click", () => onAdd?.());
  host.append(add);
}
