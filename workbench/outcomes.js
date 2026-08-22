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
    for (const comp of progression(outcomes, owner, blocks, competencies)) {
      host.append(progressionRow(comp));
    }
  }
}

function outcomeCard(outcome, { outcomes, competencies, blocks, owner, coverage, onChange, onOwner }) {
  const index = outcomes.findIndex((o) => o.id === outcome.id);
  const card = el("div", "outcome");
  const change = (patch) =>
    onChange(outcomes.map((o, i) => (i === index ? { ...o, ...patch } : o)));

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
  statement.addEventListener("input", () => change({ statement: statement.value }));
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
      change({ develops });
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
  dok.addEventListener("change", () => change({ dok: dok.value ? Number(dok.value) : null }));
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
