// A question, as a form.
//
// Paired with a view of the XML that will actually be written. That
// pairing is the honest-preview rule applied here: the artifact is the
// XML Moodle imports, so a simulated learner view -- radio buttons and a
// Submit -- would be a picture of something this tool does not produce.
// The form is for editing; the source is the truth.

import { EDITABLE, TYPE_LABEL, competencyTags, toTags, writeQuestion } from "./assessment.js";

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
export function questionForm(host, { data, competencies, onChange }) {
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

    const feedback = el("textarea", "q-text");
    feedback.rows = 2;
    feedback.value = data.generalfeedback ?? "";
    feedback.addEventListener("input", () => change({ generalfeedback: feedback.value }));
    host.append(
      field("General feedback", feedback, "Shown to every learner after they answer.")
    );

    const grade = el("input", "text short");
    grade.type = "number";
    grade.step = "0.1";
    grade.min = "0";
    grade.value = String(data.defaultgrade ?? 1);
    grade.addEventListener("input", () => change({ defaultgrade: Number(grade.value) }));
    host.append(field("Default grade", grade));

    if (data.type === "multichoice") {
      const single = el("label", "check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = data.single !== false;
      box.addEventListener("change", () => change({ single: box.checked }));
      single.append(box, document.createTextNode(" One answer only"));
      host.append(single);
    }

    host.append(tagsBlock(data, latest, competencies, change));
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
function tagsBlock(data, latest, competencies, change) {
  const wrap = el("div", "q-tags");
  const { develops, dok } = competencyTags(data.tags);

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
      change({ tags: toTags(next, now.dok) });
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
        select.value ? Number(select.value) : null
      ),
    })
  );
  wrap.append(field("Depth of knowledge", select, "Written as a dok: tag Moodle carries through."));
  return wrap;
}
