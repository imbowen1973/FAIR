// The module's homepage.
//
// `course.yaml` is the orchestrator for the whole module: what it is,
// and which sessions it runs, in order. It holds no content itself —
// every session is a folder with its own plan, deck, outcomes and
// assessment — so this page is the module's identity plus a way into its
// sessions, and nothing else.
//
// The split it exists to make obvious:
//
//   The module is the repo. Description, and the competency framework —
//   competencies are the thread that runs across sessions.
//
//   A session holds its own learning outcomes. They are not here, and
//   the page says so rather than leaving you to wonder where they went.
//
// Adding a session writes both halves at once: the block folder and the
// entry in this YAML. A session that exists in one but not the other is
// the drift the orchestrator is supposed to prevent.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(label, control, hint) {
  const wrap = el("div", "q-field");
  const id = `c-${Math.random().toString(36).slice(2, 9)}`;
  const lab = el("label", null, label);
  lab.htmlFor = id;
  control.id = id;
  wrap.append(lab, control);
  if (hint) wrap.append(el("p", "hint", hint));
  return wrap;
}

/**
 * The module homepage.
 *
 * course     the parsed course.yaml
 * rows       flattenStructure output, blocks resolved to {title, id, counts}
 * onChange(course, {structural})  identity edited
 * onOpen(id)        a session card was clicked
 * onAddSession(trail)  add a session, to the container at `trail`
 * onAddModule()     add a container
 */
/**
 * `onChange(patch, {structural})` sends only what changed.
 *
 * It used to send `{...course, field}` — the course as it was when this
 * was built. Both fields write on every keystroke and neither rebuilds,
 * so typing a module name and then a description sent the description
 * merged into a course that still had no name, and the name was gone.
 */
export function courseHome(host, { course, rows, onChange, onOpen, onAddSession, onAddModule }) {
  host.innerHTML = "";

  const title = el("input", "text grow");
  title.type = "text";
  title.value = course.title ?? "";
  title.placeholder = "What is this module called?";
  title.addEventListener("input", () =>
    onChange({ title: title.value }, { structural: false })
  );
  host.append(field("Module", title));

  const description = el("textarea", "q-text");
  description.rows = 3;
  description.value = course.description ?? "";
  description.placeholder =
    "Two or three sentences on what this module covers, and who it is for.";
  description.addEventListener("input", () =>
    onChange({ description: description.value }, { structural: false })
  );
  host.append(
    field("Description", description, "Shown wherever the module is offered.")
  );

  host.append(el("h3", "outcome-group", "Sessions"));
  host.append(
    el(
      "p",
      "hint",
      "In delivery order. Each session holds its own learning outcomes, " +
        "lesson plan, deck and assessment — open one to edit them."
    )
  );

  const grid = el("div", "session-cards");
  let cards = 0;

  for (const row of rows) {
    if (row.kind !== "block") {
      const heading = el("div", "structure-row");
      heading.style.marginLeft = `${row.depth * 12}px`;
      heading.append(el("span", "structure-kind", row.kind));
      heading.append(document.createTextNode(row.title));
      const add = el("button", "link", "+ session here");
      add.type = "button";
      add.addEventListener("click", () => onAddSession?.(row.trail));
      heading.append(add);
      grid.append(heading);
      continue;
    }

    cards += 1;
    const card = el("button", "session-card");
    card.type = "button";
    card.style.marginLeft = `${row.depth * 12}px`;
    card.addEventListener("click", () => onOpen?.(row.block));

    card.append(el("span", "card-title", row.title || row.block));
    const facts = el("span", "card-facts");
    const bits = [];
    if (row.code) bits.push(row.code);
    if (row.duration) bits.push(`${row.duration} min`);
    bits.push(
      row.outcomes
        ? `${row.outcomes} outcome${row.outcomes === 1 ? "" : "s"}`
        : "no outcomes yet"
    );
    bits.push(row.slides ? `${row.slides} slides` : "no deck yet");
    if (!row.hasPlan) bits.push("no lesson plan");
    facts.textContent = bits.join(" · ");
    if (!row.outcomes || !row.hasPlan) facts.classList.add("thin");
    card.append(facts);
    grid.append(card);
  }

  if (!cards) {
    grid.append(
      el("p", "warn", "This module has no sessions yet.")
    );
  }
  host.append(grid);

  const actions = el("div", "card-actions");
  const addSession = el("button", "primary", "+ Add session");
  addSession.type = "button";
  addSession.addEventListener("click", () => onAddSession?.([]));
  const addModule = el("button", null, "+ Add a grouping");
  addModule.type = "button";
  addModule.title =
    "A module, day or week that holds sessions — whatever this course calls it";
  addModule.addEventListener("click", () => onAddModule?.());
  actions.append(addSession, addModule);
  host.append(actions);
}

/**
 * The competency framework: the module's, not a session's.
 *
 * Shown with the progression beneath each one, because a competency is
 * only a competency if it builds across sessions — and that is a
 * property of the whole module, which is why it is edited here.
 */
export function competencyEditor(host, { competencies, onChange, onAdd, onRemove }) {
  host.innerHTML = "";
  host.append(
    el(
      "p",
      "hint",
      "Competencies belong to the module: they are the thread that runs " +
        "across its sessions. A session's learning outcomes say which of " +
        "these they develop, and are edited in the session."
    )
  );

  const list = Object.entries(competencies || {});
  if (!list.length) host.append(el("p", "warn", "No competencies defined yet."));

  for (const [id, label] of list) {
    const row = el("div", "competency-row");

    const key = el("input", "text id");
    key.type = "text";
    key.value = id;
    key.size = 6;
    key.setAttribute("aria-label", `Competency ${id} id`);
    key.title =
      "The id outcomes reference. Renaming it here does not update those references.";
    key.addEventListener("change", () => onChange?.(id, { id: key.value.trim() }));

    const text = el("input", "text grow");
    text.type = "text";
    text.value = label;
    text.placeholder = "What this competency is";
    text.setAttribute("aria-label", `Competency ${id} label`);
    text.addEventListener("input", () =>
      onChange?.(id, { label: text.value }, { structural: false })
    );

    const remove = el("button", "tool", "×");
    remove.type = "button";
    remove.title = `Remove ${id}`;
    remove.setAttribute("aria-label", `Remove competency ${id}`);
    remove.addEventListener("click", () => onRemove?.(id));

    row.append(key, text, remove);
    host.append(row);
  }

  const add = el("button", "add-slide", "+ competency");
  add.type = "button";
  add.addEventListener("click", () => onAdd?.());
  host.append(add);
}

/** A free competency id: C1, C2, … or the course's own prefix. */
export function freeCompetencyId(taken, prefix = "C") {
  for (let n = 1; n < 999; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}${taken.size + 1}`;
}

/**
 * Funding and attribution: the stamp burnt into every slide.
 *
 * Repo level, like the competency framework, and for the same reason —
 * a grant covers a course, not a session. The renderer puts it on every
 * slide as locked shapes: they cannot be selected, moved or deleted in
 * PowerPoint's UI, so a deck cannot quietly lose its funder credit on
 * its way through three people's laptops.
 *
 * The logo is sized and faded on its own terms rather than following the
 * text, and that is not fussiness. An EU emblem carries rules the wording
 * does not — a 1 cm minimum height, and no alteration — so it has to be
 * able to sit at full strength beside text that is small and faded.
 */
export function attributionEditor(host, { config, logos, resolve, onChange, onUpload, onClear }) {
  host.innerHTML = "";
  const data = config || {};
  // The patch goes up on its own. Merging it into `data` here meant
  // merging into the configuration as it was when this was built: the
  // text field writes on every keystroke and does not rebuild, so typing
  // a funding statement and then picking a logo sent the logo merged
  // into a configuration with no text in it.
  const change = (patch, structural = true) => onChange(patch, { structural });

  host.append(
    el(
      "p",
      "hint",
      "Put on every slide of every session, as shapes PowerPoint will not " +
        "let anyone select, move or delete. Leave the text empty and no " +
        "stamp is applied at all."
    )
  );

  const text = el("input", "text grow");
  text.type = "text";
  text.value = data.text ?? "";
  text.placeholder = "Funded by … · CC-BY 4.0";
  text.addEventListener("input", () => change({ text: text.value }, false));
  host.append(
    field("Credit line", text, "The wording, exactly as the funder requires it.")
  );

  // ---- the logo ---------------------------------------------------------
  const logoBlock = el("div", "attr-logo");
  logoBlock.append(el("h4", null, "Emblem"));

  if (data.logo) {
    const current = el("div", "attr-current");
    const img = el("img");
    img.src = resolve?.(data.logo) ?? "";
    img.alt = "";
    const path = el("span", "hint", data.logo);
    const drop = el("button", "tool", "×");
    drop.type = "button";
    drop.title = "Use no emblem";
    drop.setAttribute("aria-label", "Remove the emblem");
    drop.addEventListener("click", () => onClear?.());
    current.append(img, path, drop);
    logoBlock.append(current);
  }

  const file = el("input");
  file.type = "file";
  file.accept = "image/*";
  file.id = "attr-logo-upload";
  const label = el("label", "media-droplabel", data.logo ? "Replace the emblem" : "Upload an emblem");
  label.htmlFor = file.id;
  file.addEventListener("change", () => {
    if (file.files?.length) onUpload?.(file.files[0]);
  });
  logoBlock.append(label, file);
  logoBlock.append(
    el(
      "p",
      "hint",
      "Kept as it is: an emblem is not resized or re-encoded the way a " +
        "photograph is, because most of them may not be altered."
    )
  );

  if (logos?.length) {
    const grid = el("div", "media-grid");
    for (const path of logos) {
      const button = el("button", "media-thumb");
      button.type = "button";
      button.title = path;
      const img = el("img");
      img.src = resolve?.(path) ?? "";
      img.alt = "";
      button.append(img, el("span", null, path.split("/").pop()));
      button.addEventListener("click", () => change({ logo: path }));
      grid.append(button);
    }
    logoBlock.append(grid);
  }
  host.append(logoBlock);

  // ---- placement --------------------------------------------------------
  const corner = el("select", "dok");
  for (const [value, label_] of [
    ["bottom-right", "bottom right"],
    ["bottom-left", "bottom left"],
  ]) {
    const option = el("option", null, label_);
    option.value = value;
    corner.append(option);
  }
  corner.value = data.corner || "bottom-right";
  corner.addEventListener("change", () => change({ corner: corner.value }));
  host.append(field("Corner", corner));

  const numbers = el("div", "attr-numbers");
  for (const [key, label_, hint, min, max, step, fallback] of [
    ["opacity", "Text opacity", "How far the wording fades back.", 0.1, 1, 0.05, 1],
    ["scale", "Text size", "Multiplies the stamp's own size.", 0.5, 4, 0.1, 1],
    [
      "logo_height_cm",
      "Emblem height (cm)",
      "The EU emblem has a 1 cm minimum.",
      0.3,
      10,
      0.1,
      "",
    ],
    ["logo_opacity", "Emblem opacity", "Usually left at 1: most may not be altered.", 0.1, 1, 0.05, 1],
  ]) {
    const input = el("input", "text short");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = data[key] ?? fallback;
    input.addEventListener("input", () => {
      // undefined removes the key, so an emptied box does not leave one
      // behind with nothing in it.
      const value = input.value === "" ? undefined : Number(input.value);
      onChange({ [key]: value }, { structural: false });
    });
    numbers.append(field(label_, input, hint));
  }
  host.append(numbers);
}

/** Emblems already in the repo. */
export function repoLogos(paths) {
  return (paths || []).filter((p) => /^branding\/.+\.(png|jpe?g|gif|svg)$/i.test(p));
}
