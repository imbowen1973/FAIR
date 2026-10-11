// The question bank, as a form: a card per question, with the fields its
// type needs, the outcomes it tests as chips, and what is still wrong
// with it said underneath. The YAML is one click away (Text) for anyone
// who wants it, and is what is saved either way.
//
// Typing never rebuilds the form -- only adding, removing, moving or
// retyping does -- so the cursor stays where the author left it.

import {
  TYPES,
  TYPE_NAMES,
  bankProblems,
  blankQuestion,
  changeType,
  clozePreview,
  nextId,
  readBank,
  writeBank,
} from "./questionbank.js";
import { checkQuestions } from "./companion.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let uid = 0;
function field(label, control, hint) {
  const wrap = el("div", "q-field");
  const id = `qb-${++uid}`;
  const lab = el("label", null, label);
  lab.htmlFor = id;
  control.id = id;
  wrap.append(lab, control);
  if (hint) wrap.append(el("p", "hint", hint));
  return wrap;
}

function input(value, { placeholder = "", type = "text", className = "text grow", label } = {}) {
  const node = el("input", className);
  node.type = type;
  node.value = value ?? "";
  if (placeholder) node.placeholder = placeholder;
  if (label) node.setAttribute("aria-label", label);
  return node;
}

function tool(text, title, onClick) {
  const b = el("button", "tool", text);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

function addButton(text, onClick) {
  const b = el("button", "add-slide", text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** A number from a field, or undefined when it is blank or not one. */
const numberFrom = (value) => (String(value).trim() === "" || Number.isNaN(Number(value)) ? undefined : Number(value));

/** Set a key, or remove it when the value is blank: optional fields stay out of the file. */
function setOptional(target, key, value) {
  if (value === undefined || value === null || value === "") delete target[key];
  else target[key] = value;
}

// The view an author last chose, for the next bank they open.
let preferred = "form";

/**
 * questionsEditor(host, {text, outcomes, known, onChange})
 *
 * text      the bank's YAML
 * outcomes  [{id, statement, own}] -- this session's first (own: true)
 * known     Set of every outcome id the course defines, or null
 * onChange  (text) on every edit
 */
export function questionsEditor(host, { text, outcomes = [], known = null, onChange }) {
  let source = String(text ?? "");
  let bank = null;
  const wrap = el("div", "questions-editor");
  host.appendChild(wrap);

  const bar = el("div", "qb-bar");
  const views = el("div", "qb-views");
  views.setAttribute("role", "group");
  views.setAttribute("aria-label", "View");
  const formTab = el("button", "qb-view", "Form");
  const textTab = el("button", "qb-view", "Text");
  for (const b of [formTab, textTab]) b.type = "button";
  views.append(formTab, textTab);
  const summary = el("span", "qb-summary");
  bar.append(views, summary);
  const body = el("div", "qb-body");
  wrap.append(bar, body);

  const emit = () => {
    source = writeBank(bank);
    onChange(source);
  };

  function show(view) {
    if (view === "form") {
      const read = readBank(source);
      if (read.problem) {
        // The form can only edit what reads; the text view shows why.
        showText(read.problem);
        return;
      }
      bank = read;
      preferred = "form";
      showForm();
    } else {
      preferred = "text";
      showText();
    }
  }

  // ---- the form --------------------------------------------------------

  let cards = [];

  function showForm() {
    formTab.classList.add("on");
    textTab.classList.remove("on");
    formTab.setAttribute("aria-pressed", "true");
    textTab.setAttribute("aria-pressed", "false");
    body.innerHTML = "";
    cards = [];
    const list = el("ol", "qb-list");
    bank.questions.forEach((q, index) => {
      const card = questionCard(q, index);
      cards.push(card);
      list.appendChild(card.node);
    });
    body.appendChild(list);
    if (!bank.questions.length) {
      body.appendChild(el("p", "hint", "No questions yet. Choose a kind of question and add the first."));
    }

    const add = el("div", "qb-add");
    const kind = el("select", "qb-kind");
    kind.setAttribute("aria-label", "Kind of question");
    for (const t of TYPES) {
      const o = el("option", null, t.label);
      o.value = t.type;
      o.title = t.note;
      kind.appendChild(o);
    }
    kind.value = lastType;
    kind.addEventListener("change", () => (lastType = kind.value));
    const button = addButton("+ Add question", () => {
      bank.questions.push(blankQuestion(kind.value, bank.questions));
      emit();
      showForm();
      const last = body.querySelector(".qb-card:last-of-type textarea");
      last?.focus();
      last?.scrollIntoView?.({ block: "center" });
    });
    add.append(kind, button);
    body.appendChild(add);
    refresh();
  }

  let lastType = "mcq";

  /** Every card's problems, and the summary: duplicate ids span cards. */
  function refresh() {
    const all = bankProblems(bank.questions, { outcomes: known });
    let bad = 0;
    all.forEach((problems, i) => {
      if (problems.length) bad++;
      cards[i]?.showProblems(problems);
    });
    const n = bank.questions.length;
    summary.className = `qb-summary ${bad ? "bad" : "ok"}`;
    summary.textContent = !n
      ? "No questions yet"
      : `${n} question${n === 1 ? "" : "s"}` +
        (bad ? ` · ${bad} need${bad === 1 ? "s" : ""} attention` : " · all ready");
  }

  /** An edit that changes only words: save it, re-check, keep the cursor. */
  const typed = () => {
    emit();
    refresh();
  };
  /** An edit that changes the shape: save it and rebuild. */
  const rebuilt = () => {
    emit();
    showForm();
  };

  function questionCard(q, index) {
    const node = el("li", "qb-card");
    node.dataset.id = String(q.id ?? "");

    // Head: number, kind, id, points, and the card's tools.
    const head = el("div", "qb-head");
    head.appendChild(el("span", "qb-num", String(index + 1)));
    const kind = el("select", "qb-type");
    kind.setAttribute("aria-label", "Kind of question");
    for (const t of TYPES) {
      const o = el("option", null, t.label);
      o.value = t.type;
      kind.appendChild(o);
    }
    if (!TYPE_NAMES[q.type]) {
      const o = el("option", null, `${q.type ?? "no type"} (unknown)`);
      o.value = String(q.type ?? "");
      kind.appendChild(o);
    }
    kind.value = String(q.type ?? "");
    kind.addEventListener("change", () => {
      bank.questions[index] = changeType(q, kind.value);
      rebuilt();
    });
    const id = input(q.id, { className: "text qb-id", label: "Question id" });
    id.title = "Its id: Moodle matches re-imports on it, so keep it once the question is in use.";
    id.addEventListener("input", () => {
      q.id = id.value.trim();
      node.dataset.id = q.id;
      typed();
    });
    const points = input(q.points ?? "", { type: "number", className: "text qb-points", placeholder: "1", label: "Points" });
    points.min = "0";
    points.step = "any";
    points.addEventListener("input", () => {
      setOptional(q, "points", numberFrom(points.value));
      typed();
    });
    const pointsWrap = el("label", "qb-inline", "Points ");
    pointsWrap.appendChild(points);
    const tools = el("span", "qb-tools");
    const up = tool("↑", "Move up", () => {
      [bank.questions[index - 1], bank.questions[index]] = [bank.questions[index], bank.questions[index - 1]];
      rebuilt();
    });
    up.disabled = index === 0;
    const down = tool("↓", "Move down", () => {
      [bank.questions[index + 1], bank.questions[index]] = [bank.questions[index], bank.questions[index + 1]];
      rebuilt();
    });
    down.disabled = index === bank.questions.length - 1;
    const copy = tool("⧉", "Duplicate", () => {
      const twin = structuredClone(q);
      twin.id = nextId(bank.questions);
      bank.questions.splice(index + 1, 0, twin);
      rebuilt();
    });
    const remove = tool("×", "Delete question", () => {
      const words = String(q.stem ?? q.text ?? "").trim();
      if (words && !confirm(`Delete question ${index + 1}?\n\n${words.slice(0, 120)}`)) return;
      bank.questions.splice(index, 1);
      rebuilt();
    });
    tools.append(up, down, copy, remove);
    head.append(kind, id, pointsWrap, tools);
    node.appendChild(head);

    if (!TYPE_NAMES[q.type]) {
      node.appendChild(
        el("p", "hint", "Choose a kind above to edit it here; until then it is kept exactly as written.")
      );
      const problems = el("ul", "qb-problems");
      node.appendChild(problems);
      return { node, showProblems: (list) => showProblems(problems, list) };
    }

    node.appendChild(outcomeChips(q));

    // The question's words.
    if (q.type === "cloze") {
      const area = el("textarea", "q-text");
      area.rows = 4;
      area.value = q.text ?? "";
      area.placeholder = "Antibiotics should be used as [[little]] as possible and as [[much]] as necessary.";
      const preview = el("p", "qb-preview");
      const paint = () => (preview.textContent = q.text ? `Learners see: ${clozePreview(q.text)}` : "");
      area.addEventListener("input", () => {
        q.text = area.value;
        paint();
        typed();
      });
      paint();
      node.appendChild(field("Text with gaps", area, "Write each gap as its answer in double brackets: [[answer]]."));
      node.appendChild(preview);
    } else {
      const area = el("textarea", "q-text");
      area.rows = 2;
      area.value = q.stem ?? "";
      area.placeholder = q.type === "truefalse" ? "A statement learners judge true or false" : "The question";
      area.addEventListener("input", () => {
        q.stem = area.value;
        typed();
      });
      node.appendChild(field(q.type === "truefalse" ? "Statement" : "Question", area));
    }

    const answers = typeAnswers(q);
    if (answers) node.appendChild(answers);

    const feedback = input(q.feedback, { placeholder: "Shown after answering, right or wrong (optional)" });
    feedback.addEventListener("input", () => {
      setOptional(q, "feedback", feedback.value);
      typed();
    });
    node.appendChild(field("Feedback", feedback));

    const problems = el("ul", "qb-problems");
    node.appendChild(problems);
    return { node, showProblems: (list) => showProblems(problems, list) };
  }

  function showProblems(target, list) {
    target.innerHTML = "";
    target.className = `qb-problems ${list.length ? "bad" : "ok"}`;
    if (!list.length) {
      target.appendChild(el("li", null, "✓ Ready"));
      return;
    }
    for (const p of list) target.appendChild(el("li", null, p));
  }

  /** Which outcomes it tests: this session's as chips, any other by choice. */
  function outcomeChips(q) {
    if (!Array.isArray(q.assesses)) q.assesses = [];
    const box = el("div", "q-field qb-tests");
    box.appendChild(el("span", "qb-label", "Tests"));
    const chips = el("div", "chips");
    const shown = new Set();
    const chip = (id, title) => {
      shown.add(id);
      const b = el("button", "chip", id);
      b.type = "button";
      b.title = title || id;
      const on = q.assesses.map(String).includes(id);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      if (known && !known.has(id)) b.classList.add("unknown");
      b.addEventListener("click", () => {
        const now = q.assesses.map(String);
        q.assesses = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
        const isOn = q.assesses.includes(id);
        b.classList.toggle("on", isOn);
        b.setAttribute("aria-pressed", String(isOn));
        typed();
      });
      chips.appendChild(b);
    };
    for (const o of outcomes.filter((o) => o.own)) chip(o.id, o.statement);
    // Anything it already tests from elsewhere in the course, or not in it.
    for (const id of q.assesses.map(String)) {
      if (!shown.has(id)) chip(id, outcomes.find((o) => o.id === id)?.statement);
    }
    const others = outcomes.filter((o) => !shown.has(o.id));
    if (others.length) {
      const more = el("select", "qb-more");
      more.setAttribute("aria-label", "Another outcome");
      more.appendChild(el("option", null, outcomes.some((o) => o.own) ? "+ another outcome…" : "+ outcome…"));
      more.firstChild.value = "";
      for (const o of others) {
        const opt = el("option", null, `${o.id} — ${o.statement ?? ""}`.slice(0, 90));
        opt.value = o.id;
        more.appendChild(opt);
      }
      more.addEventListener("change", () => {
        if (!more.value) return;
        q.assesses = [...q.assesses.map(String), more.value];
        rebuilt();
      });
      chips.appendChild(more);
    }
    if (!outcomes.length) chips.appendChild(el("span", "hint", "The course has no learning outcomes yet."));
    box.appendChild(chips);
    return box;
  }

  /** The answer fields for each kind of question. */
  function typeAnswers(q) {
    const box = el("div", "q-answers");
    if (q.type === "mcq" || q.type === "multi") {
      if (!Array.isArray(q.options)) q.options = [];
      box.appendChild(el("h4", null, q.type === "mcq" ? "Answers — choose the right one" : "Answers — tick every right one"));
      const group = `qb-${++uid}`;
      q.options.forEach((opt, i) => {
        if (!opt || typeof opt !== "object") q.options[i] = opt = { text: String(opt ?? "") };
        const row = el("div", "q-answer qb-choice");
        const right = el("input", "qb-right");
        right.type = q.type === "mcq" ? "radio" : "checkbox";
        right.name = group;
        right.checked = opt.correct === true;
        right.setAttribute("aria-label", `Answer ${i + 1} is correct`);
        right.title = "Correct";
        right.addEventListener("change", () => {
          if (q.type === "mcq") {
            q.options.forEach((o, j) => (j === i ? (o.correct = true) : delete o.correct));
          } else if (right.checked) opt.correct = true;
          else delete opt.correct;
          typed();
        });
        const text = input(opt.text, { placeholder: `Answer ${i + 1}`, label: `Answer ${i + 1}` });
        text.addEventListener("input", () => {
          opt.text = text.value;
          typed();
        });
        const why = input(opt.feedback, { placeholder: "Feedback for this answer (optional)", label: `Feedback for answer ${i + 1}` });
        why.addEventListener("input", () => {
          setOptional(opt, "feedback", why.value);
          typed();
        });
        const drop = tool("×", `Remove answer ${i + 1}`, () => {
          q.options.splice(i, 1);
          rebuilt();
        });
        row.append(right, text, why, drop);
        box.appendChild(row);
      });
      box.appendChild(addButton("+ answer", () => {
        q.options.push({ text: "" });
        rebuilt();
      }));
    } else if (q.type === "truefalse") {
      box.appendChild(el("h4", null, "The statement is"));
      const row = el("div", "q-answer");
      const group = `qb-${++uid}`;
      for (const [value, label] of [[true, "True"], [false, "False"]]) {
        const lab = el("label", "qb-inline");
        const radio = el("input");
        radio.type = "radio";
        radio.name = group;
        radio.checked = q.answer === value;
        radio.addEventListener("change", () => {
          q.answer = value;
          typed();
        });
        lab.append(radio, ` ${label}`);
        row.appendChild(lab);
      }
      box.appendChild(row);
    } else if (q.type === "short") {
      if (!Array.isArray(q.answers)) q.answers = [];
      box.appendChild(el("h4", null, "Accepted answers — any one scores"));
      q.answers.forEach((a, i) => {
        const row = el("div", "q-answer");
        const text = input(a, { placeholder: "An answer to accept", label: `Accepted answer ${i + 1}` });
        text.addEventListener("input", () => {
          q.answers[i] = text.value;
          typed();
        });
        const drop = tool("×", `Remove accepted answer ${i + 1}`, () => {
          q.answers.splice(i, 1);
          rebuilt();
        });
        row.append(text, drop);
        box.appendChild(row);
      });
      box.appendChild(addButton("+ accepted answer", () => {
        q.answers.push("");
        rebuilt();
      }));
      const lab = el("label", "qb-inline");
      const caseBox = el("input");
      caseBox.type = "checkbox";
      caseBox.checked = q.case === true;
      caseBox.addEventListener("change", () => {
        setOptional(q, "case", caseBox.checked ? true : undefined);
        typed();
      });
      lab.append(caseBox, " Capitals matter");
      box.appendChild(lab);
    } else if (q.type === "numeric") {
      const row = el("div", "q-answer");
      const answer = input(q.answer ?? "", { type: "number", className: "text", label: "Right answer" });
      answer.step = "any";
      answer.addEventListener("input", () => {
        setOptional(q, "answer", numberFrom(answer.value));
        typed();
      });
      const tolerance = input(q.tolerance ?? "", { type: "number", className: "text", placeholder: "0", label: "Tolerance" });
      tolerance.step = "any";
      tolerance.min = "0";
      tolerance.addEventListener("input", () => {
        setOptional(q, "tolerance", numberFrom(tolerance.value));
        typed();
      });
      const a = el("label", "qb-inline", "Right answer ");
      a.appendChild(answer);
      const t = el("label", "qb-inline", "give or take ");
      t.appendChild(tolerance);
      row.append(a, t);
      box.appendChild(row);
    } else if (q.type === "match") {
      if (!Array.isArray(q.pairs)) q.pairs = [];
      box.appendChild(el("h4", null, "Pairs — learners match each prompt to its answer"));
      q.pairs.forEach((pair, i) => {
        if (!pair || typeof pair !== "object") q.pairs[i] = pair = {};
        const row = el("div", "q-answer");
        const prompt = input(pair.prompt, { placeholder: "Prompt", label: `Prompt ${i + 1}` });
        prompt.addEventListener("input", () => {
          pair.prompt = prompt.value;
          typed();
        });
        const answer = input(pair.answer, { placeholder: "Its answer", label: `Answer ${i + 1}` });
        answer.addEventListener("input", () => {
          pair.answer = answer.value;
          typed();
        });
        const drop = tool("×", `Remove pair ${i + 1}`, () => {
          q.pairs.splice(i, 1);
          rebuilt();
        });
        row.append(prompt, el("span", "qb-arrow", "→"), answer, drop);
        box.appendChild(row);
      });
      box.appendChild(addButton("+ pair", () => {
        q.pairs.push({ prompt: "", answer: "" });
        rebuilt();
      }));
    } else {
      return null;
    }
    return box;
  }

  // ---- the text --------------------------------------------------------

  function showText(blocked) {
    textTab.classList.add("on");
    formTab.classList.remove("on");
    textTab.setAttribute("aria-pressed", "true");
    formTab.setAttribute("aria-pressed", "false");
    body.innerHTML = "";
    if (blocked) {
      body.appendChild(el("p", "qb-blocked", `The form can't open this yet. ${blocked} Fix it here and the form will open.`));
    }
    const area = el("textarea");
    area.value = source;
    area.spellcheck = false;
    area.setAttribute("aria-label", "Question bank (questions.yaml)");
    const verdict = el("div", "bank-check");
    const check = () => {
      const { items, problems } = checkQuestions(area.value, { outcomes: known });
      verdict.className = `bank-check ${problems.length ? "bad" : "ok"}`;
      verdict.innerHTML = "";
      const n = items.length;
      summary.className = `qb-summary ${problems.length ? "bad" : "ok"}`;
      summary.textContent = `${n} question${n === 1 ? "" : "s"}`;
      if (problems.length) {
        verdict.append(`${problems.length} thing${problems.length === 1 ? "" : "s"} to fix:`);
        const ul = el("ul");
        for (const p of problems.slice(0, 12)) ul.appendChild(el("li", null, p));
        verdict.appendChild(ul);
      } else {
        verdict.textContent = `${n} question${n === 1 ? "" : "s"}, all well formed.`;
      }
    };
    let timer = null;
    area.addEventListener("input", () => {
      source = area.value;
      onChange(source);
      clearTimeout(timer);
      timer = setTimeout(check, 300);
    });
    const help = el(
      "p",
      "hint",
      "The bank as it is saved: questions.yaml (docs/questions-format.md). " +
        "Edits made in the form rewrite this text, without comments."
    );
    body.append(area, verdict, help);
    check();
  }

  formTab.addEventListener("click", () => show("form"));
  textTab.addEventListener("click", () => show("text"));
  show(preferred);
}
