// A question, as a form.
//
// Paired with a view of the XML that will actually be written. That
// pairing is the honest-preview rule applied here: the artifact is the
// XML Moodle imports, so a simulated learner view -- radio buttons and a
// Submit -- would be a picture of something this tool does not produce.
// The form is for editing; the source is the truth.

import { EDITABLE, TYPE_LABEL, competencyTags, toTags, writeQuestion } from "./assessment.js";

/** Types Moodle gives combined feedback and hint options to. */
const COMBINED_TYPES = ["multichoice"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(label, control, hint) {
  const wrap = el("div", "q-field");
  const id = `q-${Math.random().toString(36).slice(2, 9)}`;
  const lab = el("label", null, label);
  lab.htmlFor = id;
  control.id = id;
  wrap.append(lab, control);
  if (hint) wrap.append(el("p", "hint", hint));
  return wrap;
}

/** A percentage credit, as Moodle writes it. */
const FRACTIONS = ["100", "50", "33.33333", "25", "20", "0", "-25", "-50", "-100"];

/**
 * Build the editor for one question.
 *
 * data          the question, from readQuestion() or blankQuestion()
 * competencies  {id: label} from the framework, for the tag chips
 * onChange(next) every edit
 */
export function questionForm(host, { data, competencies, outcomes, onChange }) {
  host.innerHTML = "";
  const editable = EDITABLE.includes(data.type);

  const head = el("div", "q-head");
  head.append(el("span", "q-type", TYPE_LABEL[data.type] ?? data.type));
  if (!editable) {
    // Carried through untouched rather than lost. Losing an author's
    // matching question would be far worse than declining to edit it.
    head.append(
      el(
        "span",
        "warn",
        `This editor does not understand ${TYPE_LABEL[data.type] ?? data.type} ` +
          "questions, so it shows the source and writes it back unchanged."
      )
    );
  }
  host.append(head);

  // Every field patches the *latest* question, not the one the form was
  // built with. Without this, typing a stem and then clicking a
  // competency chip silently throws the stem away -- each handler would
  // start from its own stale copy.
  let current = data;
  const change = (patch) => {
    current = { ...current, ...patch };
    onChange(current);
  };
  const latest = () => current;

  if (editable) {
    const name = el("input", "text");
    name.type = "text";
    name.value = data.name ?? "";
    name.addEventListener("input", () => change({ name: name.value }));
    host.append(field("Question name", name, "How it is listed in Moodle's question bank."));

    const stem = el("textarea", "q-text");
    stem.rows = 4;
    stem.value = data.questiontext ?? "";
    stem.addEventListener("input", () => change({ questiontext: stem.value }));
    host.append(field("Question", stem, "HTML, as Moodle stores it. <p>…</p> is the usual wrapper."));

    if (data.type !== "essay") host.append(answersBlock(data, latest, change));

    host.append(feedbackBlock(data, latest, change));
    host.append(hintsBlock(data, latest, change));

    const grade = el("input", "text short");
    grade.type = "number";
    grade.step = "0.1";
    grade.min = "0";
    grade.value = String(data.defaultgrade ?? 1);
    grade.addEventListener("input", () => change({ defaultgrade: Number(grade.value) }));
    host.append(field("Default grade", grade));

    host.append(settingsBlock(data, change));

    host.append(tagsBlock(data, latest, competencies, outcomes, change));
  }

  // The source, always: what will be written, not a rendering of it.
  const details = el("details", "q-source");
  details.append(el("summary", null, "XML that will be written"));
  const code = el("code", null, writeQuestion(data));
  const pre = el("pre");
  pre.append(code);
  details.append(pre);
  if (!editable) details.open = true;
  host.append(details);

  // The caller keeps the source view current without rebuilding the
  // form: rebuilding on every keystroke loses the caret, and restoring
  // it by hand is the sort of thing that works until it does not.
  return {
    updateSource(next) {
      code.textContent = writeQuestion(next);
    },
  };
}

function answersBlock(data, latest, change) {
  const wrap = el("div", "q-answers");
  wrap.append(el("h4", null, data.type === "shortanswer" ? "Accepted answers" : "Answers"));

  const answers = data.answers ?? [];
  answers.forEach((answer, index) => {
    const row = el("div", "q-answer");
    const text = el("input", "text grow");
    text.type = "text";
    text.value = answer.text ?? "";
    text.setAttribute("aria-label", `Answer ${index + 1}`);
    // True/false answers are the words Moodle expects, not free text.
    if (data.type === "truefalse") text.disabled = true;
    text.addEventListener("input", () => {
      const next = [...latest().answers];
      next[index] = { ...next[index], text: text.value };
      change({ answers: next });
    });

    const fraction = el("select", "fraction");
    fraction.setAttribute("aria-label", `Credit for answer ${index + 1}`);
    for (const value of FRACTIONS) {
      const option = el("option", null, `${value}%`);
      option.value = value;
      fraction.append(option);
    }
    if (![...fraction.options].some((o) => o.value === String(answer.fraction))) {
      const extra = el("option", null, `${answer.fraction}%`);
      extra.value = String(answer.fraction);
      fraction.append(extra);
    }
    fraction.value = String(answer.fraction ?? "0");
    fraction.addEventListener("change", () => {
      const next = [...latest().answers];
      next[index] = { ...next[index], fraction: fraction.value };
      change({ answers: next });
    });

    const feedback = el("input", "text grow");
    feedback.type = "text";
    feedback.placeholder = "Feedback for this answer";
    feedback.value = answer.feedback ?? "";
    feedback.setAttribute("aria-label", `Feedback for answer ${index + 1}`);
    feedback.addEventListener("input", () => {
      const next = [...latest().answers];
      next[index] = { ...next[index], feedback: feedback.value };
      change({ answers: next });
    });

    row.append(text, fraction, feedback);

    if (data.type !== "truefalse") {
      const remove = el("button", "tool", "×");
      remove.type = "button";
      remove.title = "Remove this answer";
      remove.setAttribute("aria-label", `Remove answer ${index + 1}`);
      remove.addEventListener("click", () =>
        change({ answers: latest().answers.filter((_, i) => i !== index) })
      );
      row.append(remove);
    }
    wrap.append(row);
  });

  if (data.type !== "truefalse") {
    const add = el("button", "add-slide", "+ answer");
    add.type = "button";
    add.addEventListener("click", () =>
      change({ answers: [...latest().answers, { text: "", fraction: "0", feedback: "" }] })
    );
    wrap.append(add);
  }
  return wrap;
}

/**
 * Competencies and depth of knowledge, as Moodle tags.
 *
 * Tags rather than a sidecar file: Moodle imports them natively, so the
 * mapping survives the trip into the LMS instead of being lost at the
 * border.
 */
function tagsBlock(data, latest, competencies, outcomes, change) {
  const wrap = el("div", "q-tags");
  const { develops, dok, outcomes: serves } = competencyTags(data.tags);

  // What the question assesses. Same chain as a slide: the question
  // serves an outcome, the outcome develops competencies.
  const outEntries = Object.entries(outcomes || {});
  if (outEntries.length) {
    wrap.append(el("h4", null, "Assesses outcomes"));
    const outChips = el("div", "chips");
    for (const [oid, outcome] of outEntries) {
      const chip = el("button", "chip", oid);
      chip.type = "button";
      chip.title = outcome.statement || oid;
      if (serves.includes(oid)) chip.classList.add("on");
      chip.addEventListener("click", () => {
        const now = competencyTags(latest().tags);
        const next = now.outcomes.includes(oid)
          ? now.outcomes.filter((o) => o !== oid)
          : [...now.outcomes, oid];
        change({ tags: toTags(now.develops, now.dok, next) });
      });
      outChips.append(chip);
    }
    wrap.append(outChips);
  }

  wrap.append(el("h4", null, "Develops"));
  const chips = el("div", "chips");
  const entries = Object.entries(competencies || {});
  if (!entries.length) {
    chips.append(el("span", "hint", "No competencies/framework.yaml in this library."));
  }
  for (const [id, label] of entries) {
    const chip = el("button", "chip", id);
    chip.type = "button";
    chip.title = label;
    if (develops.includes(id)) chip.classList.add("on");
    chip.addEventListener("click", () => {
      const now = competencyTags(latest().tags);
      const next = now.develops.includes(id)
        ? now.develops.filter((c) => c !== id)
        : [...now.develops, id];
      change({ tags: toTags(next, now.dok, now.outcomes) });
    });
    chips.append(chip);
  }
  wrap.append(chips);

  const select = el("select", "dok");
  for (const level of ["", "1", "2", "3", "4"]) {
    const option = el("option", null, level || "not set");
    option.value = level;
    select.append(option);
  }
  select.value = dok ? String(dok) : "";
  select.addEventListener("change", () =>
    change({
      tags: toTags(
        competencyTags(latest().tags).develops,
        select.value ? Number(select.value) : null,
        competencyTags(latest().tags).outcomes
      ),
    })
  );
  wrap.append(field("Depth of knowledge", select, "Written as a dok: tag Moodle carries through."));
  return wrap;
}

/**
 * Feedback, as Moodle structures it.
 *
 * Three kinds, and they are not interchangeable:
 *
 *   General      everyone sees it, whatever they answered. Where the
 *                explanation goes.
 *   Combined     one of three, by how they did. This is what makes a
 *                quiz teach rather than only score.
 *   Per answer   attached to a single option, and written beside it.
 *
 * Moodle's own default wording is used for the combined three, so a
 * question written here imports looking like one written there.
 */
function feedbackBlock(data, latest, change) {
  const wrap = el("div", "q-feedback");
  wrap.append(el("h4", null, "Feedback"));

  const general = el("textarea", "q-text");
  general.rows = 2;
  general.value = data.generalfeedback ?? "";
  general.addEventListener("input", () => change({ generalfeedback: general.value }));
  wrap.append(
    field("Everyone sees", general, "Shown after answering, whatever they chose.")
  );

  if (!COMBINED_TYPES.includes(data.type)) return wrap;

  for (const [key, label, hint] of [
    ["correctfeedback", "When they are right", null],
    [
      "partiallycorrectfeedback",
      "When they are partly right",
      "Only reachable when more than one answer can be chosen.",
    ],
    ["incorrectfeedback", "When they are wrong", null],
  ]) {
    const box = el("input", "text grow");
    box.type = "text";
    box.value = data[key] ?? "";
    box.addEventListener("input", () => change({ [key]: box.value }));
    wrap.append(field(label, box, hint));
  }

  if (data.single === false) {
    const line = el("label", "check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = Boolean(data.shownumcorrect);
    box.addEventListener("change", () => change({ shownumcorrect: box.checked }));
    line.append(box, document.createTextNode(" Tell them how many they got right"));
    wrap.append(line);
  }
  return wrap;
}

/**
 * Hints: what a quiz shows between attempts.
 *
 * They only appear in Moodle's interactive and adaptive modes, which is
 * worth saying — an author who adds three hints and never sees them in a
 * plain quiz would reasonably conclude the editor is broken.
 */
function hintsBlock(data, latest, change) {
  const wrap = el("div", "q-hints");
  wrap.append(el("h4", null, "Hints between attempts"));
  wrap.append(
    el(
      "p",
      "hint",
      "Shown one at a time when a learner tries again — in Moodle's " +
        "interactive or adaptive modes only."
    )
  );

  const hints = data.hints ?? [];
  hints.forEach((hint, index) => {
    const row = el("div", "q-hint");
    const text = el("input", "text grow");
    text.type = "text";
    text.value = hint.text ?? "";
    text.placeholder = `Hint ${index + 1}`;
    text.setAttribute("aria-label", `Hint ${index + 1}`);
    text.addEventListener("input", () => {
      const next = [...latest().hints];
      next[index] = { ...next[index], text: text.value };
      change({ hints: next });
    });
    row.append(text);

    if (COMBINED_TYPES.includes(data.type)) {
      for (const [key, label, title] of [
        ["shownumcorrect", "count", "Show how many are right so far"],
        ["clearwrong", "clear", "Clear the wrong choices before they try again"],
        ["options", "hide", "Remove the wrong options entirely"],
      ]) {
        const toggle = el("label", "check tight");
        const box = el("input");
        box.type = "checkbox";
        box.checked = Boolean(hint[key]);
        box.title = title;
        box.addEventListener("change", () => {
          const next = [...latest().hints];
          next[index] = { ...next[index], [key]: box.checked };
          change({ hints: next });
        });
        toggle.append(box, document.createTextNode(` ${label}`));
        row.append(toggle);
      }
    }

    const remove = el("button", "tool", "×");
    remove.type = "button";
    remove.title = `Remove hint ${index + 1}`;
    remove.setAttribute("aria-label", `Remove hint ${index + 1}`);
    remove.addEventListener("click", () =>
      change({ hints: latest().hints.filter((_, i) => i !== index) })
    );
    row.append(remove);
    wrap.append(row);
  });

  const add = el("button", "add-slide", "+ hint");
  add.type = "button";
  add.addEventListener("click", () =>
    change({ hints: [...(latest().hints ?? []), { text: "" }] })
  );
  wrap.append(add);
  return wrap;
}

/**
 * The settings that belong to one question type.
 *
 * Kept together and kept small: Moodle offers a great many per-type
 * options, and most of them are defaults nobody should have to think
 * about. These are the ones that change what a learner actually
 * experiences.
 */
function settingsBlock(data, change) {
  const wrap = el("div", "q-settings");

  if (data.type === "multichoice") {
    const single = el("label", "check");
    const one = el("input");
    one.type = "checkbox";
    one.checked = data.single !== false;
    one.addEventListener("change", () => change({ single: one.checked }));
    single.append(one, document.createTextNode(" One answer only"));

    const shuffle = el("label", "check");
    const mix = el("input");
    mix.type = "checkbox";
    mix.checked = data.shuffleanswers !== false;
    mix.addEventListener("change", () => change({ shuffleanswers: mix.checked }));
    shuffle.append(mix, document.createTextNode(" Shuffle the answers"));

    const numbering = el("select", "dok");
    for (const [value, label] of [
      ["abc", "a. b. c."],
      ["ABCD", "A. B. C."],
      ["123", "1. 2. 3."],
      ["none", "no numbering"],
    ]) {
      const option = el("option", null, label);
      option.value = value;
      numbering.append(option);
    }
    numbering.value = data.answernumbering || "abc";
    numbering.addEventListener("change", () =>
      change({ answernumbering: numbering.value })
    );
    wrap.append(single, shuffle, field("Numbering", numbering));
    return wrap;
  }

  if (data.type === "shortanswer") {
    const line = el("label", "check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = Boolean(data.usecase);
    box.addEventListener("change", () => change({ usecase: box.checked }));
    line.append(box, document.createTextNode(" Capital letters must match"));
    wrap.append(line);
    return wrap;
  }

  if (data.type === "essay") {
    const lines = el("input", "text short");
    lines.type = "number";
    lines.min = "1";
    lines.value = String(data.responsefieldlines ?? 10);
    lines.addEventListener("input", () =>
      change({ responsefieldlines: Number(lines.value) })
    );
    wrap.append(field("Lines in the answer box", lines));

    const attachments = el("select", "dok");
    for (const value of ["0", "1", "2", "3"]) {
      const option = el("option", null, value === "0" ? "none" : value);
      option.value = value;
      attachments.append(option);
    }
    attachments.value = String(data.attachments ?? 0);
    attachments.addEventListener("change", () =>
      change({ attachments: Number(attachments.value) })
    );
    wrap.append(field("Files they may attach", attachments));

    const grader = el("textarea", "q-text");
    grader.rows = 2;
    grader.value = data.graderinfo ?? "";
    grader.addEventListener("input", () => change({ graderinfo: grader.value }));
    wrap.append(
      field("Notes for the marker", grader, "Never shown to the learner.")
    );
    return wrap;
  }
  return wrap;
}
