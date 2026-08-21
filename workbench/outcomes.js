// The outcome catalogue, edited as a table.
//
// Outcomes are course-level, so this is not a per-block document: it is
// the alignment map for the whole library, and the one place to see what
// the course claims to teach against where it teaches it.
//
// The coverage column is the reason the catalogue is worth keeping. An
// outcome nothing addresses is a claim with no content behind it, and
// that is precisely the thing nobody notices until an external reviewer
// asks.

const OUTCOMES_PATH = "outcomes.yaml";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Outcomes as a list the table can walk, from the parsed YAML. */
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
 * Build the catalogue editor.
 *
 * outcomes      from outcomeList()
 * competencies  {id: label} from the framework
 * coverage      {outcomeId: {blocks: n, slides: n}} — where it is taught
 * onChange(list) every edit
 */
export function outcomesEditor(host, { outcomes, competencies, coverage, onChange }) {
  host.innerHTML = "";

  const intro = el("p", "hint");
  intro.textContent =
    "Outcomes are what this course claims to teach. Slides and questions " +
    "point at them, and the competencies a slide develops come from the " +
    "outcomes it serves — so a slide can never claim more than its outcomes do.";
  host.append(intro);

  const entries = Object.entries(competencies || {});
  if (!entries.length) {
    host.append(
      el(
        "p",
        "warn",
        "This library has no competencies/framework.yaml, so outcomes have " +
          "nothing to develop yet."
      )
    );
  }

  const change = (next) => onChange(next);

  for (const [index, outcome] of outcomes.entries()) {
    const card = el("div", "outcome");

    const head = el("div", "outcome-head");
    const id = el("input", "text id");
    id.type = "text";
    id.value = outcome.id;
    id.size = 6;
    id.setAttribute("aria-label", `Outcome ${index + 1} id`);
    id.title =
      "The id slides and questions reference. Renaming it here does not " +
      "update those references.";
    id.addEventListener("change", () => {
      const next = outcomes.map((o, i) => (i === index ? { ...o, id: id.value.trim() } : o));
      change(next);
    });

    const where = coverage?.[outcome.id];
    const cover = el("span", "coverage");
    if (!where || !where.slides) {
      cover.classList.add("none");
      cover.textContent = where?.blocks
        ? `declared by ${where.blocks} block${where.blocks === 1 ? "" : "s"}, no slide serves it`
        : "not addressed anywhere";
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
      change(outcomes.filter((_, i) => i !== index));
    });

    head.append(id, cover, remove);
    card.append(head);

    const statement = el("textarea", "q-text");
    statement.rows = 2;
    statement.value = outcome.statement;
    statement.placeholder = "By the end of this course, learners will be able to…";
    statement.setAttribute("aria-label", `Outcome ${outcome.id} statement`);
    statement.addEventListener("input", () => {
      const next = outcomes.map((o, i) =>
        i === index ? { ...o, statement: statement.value } : o
      );
      change(next);
    });
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
        change(outcomes.map((o, i) => (i === index ? { ...o, develops } : o)));
      });
      chips.append(chip);
    }
    foot.append(chips);

    const dokWrap = el("label", "check");
    dokWrap.append(el("span", null, "Target level"));
    const dok = el("select", "dok");
    for (const level of ["", "1", "2", "3", "4"]) {
      const option = el("option", null, level || "not set");
      option.value = level;
      dok.append(option);
    }
    dok.value = outcome.dok ? String(outcome.dok) : "";
    dok.addEventListener("change", () => {
      const value = dok.value ? Number(dok.value) : null;
      change(outcomes.map((o, i) => (i === index ? { ...o, dok: value } : o)));
    });
    dokWrap.append(dok);
    foot.append(dokWrap);
    card.append(foot);

    host.append(card);
  }

  const add = el("button", "add-slide", "+ outcome");
  add.type = "button";
  add.addEventListener("click", () => {
    const id = freeOutcomeId(new Set(outcomes.map((o) => o.id)));
    change([...outcomes, { id, statement: "", develops: [], dok: null }]);
  });
  host.append(add);
}

export { OUTCOMES_PATH };
