"""edufair-import: rescue the knowledge out of an existing PowerPoint deck.

Reads any .pptx — tidy placeholders or free-positioned chaos — and emits
a block folder in the library format: `slides.md` in the session
grammar, `media/` put through the image policy, a `block.yaml` and
`lessonplan.md` stub, and `report.md` saying per slide how confident the
mapping is and what needs a human.

The job is to rescue the CONTENT — text, structure, images, notes — not
to replicate the old slide's appearance. The free-positioned arrangement
is what made legacy decks unreusable; shedding it is the conversion.
Extraction reads every shape regardless of placeholder membership;
classification works from geometry and type, because most legacy decks
never used placeholders at all.

    edufair-import old-course.pptx --out blocks/05-imported

The source deck is read and discarded; only markdown and policy-clean
images come out. Runs identically on the CLI and in the workbench's
browser runtime (Pyodide), so one extractor serves bulk migration and
drop-a-file-on-the-door alike.
"""

from __future__ import annotations

import hashlib
import io
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

# Geometry heuristics, as fractions of the slide.
TITLE_BAND = 0.30  # a title lives in the top of the slide
SIDE_GAP = 0.22  # two bodies this far apart (centre to centre) are columns
CAPTION_CHARS = 220
SECTION_WORDS = 7

MAX_EDGE = 2000
JPEG_QUALITY = 82


@dataclass
class _Text:
    paragraphs: list[dict]  # {text, level}
    left: int
    top: int
    width: int
    height: int
    is_title_ph: bool = False
    font_size: int = 0  # EMU-agnostic: pt * 100, 0 = unknown

    @property
    def chars(self) -> int:
        return sum(len(p["text"]) for p in self.paragraphs)


@dataclass
class _Pic:
    blob: bytes
    ext: str
    left: int
    top: int


@dataclass
class _Facts:
    number: int
    texts: list[_Text] = field(default_factory=list)
    pics: list[_Pic] = field(default_factory=list)
    tables: list[dict] = field(default_factory=list)  # {header, rows}
    notes: str | None = None
    oddities: list[str] = field(default_factory=list)


@dataclass
class IngestResult:
    title: str
    slides_md: str
    media: dict[str, bytes]  # path relative to the block dir -> bytes
    report: list[dict]  # {slide, id, layout, confidence, notes}


_BULLET_GLYPHS = re.compile(r"^[\s•‣◦·⁃\-–—o]+\s*")
_DIAGRAM_URI = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
_A_T = "{http://schemas.openxmlformats.org/drawingml/2006/main}t"


def _clean(text: str) -> str:
    return _BULLET_GLYPHS.sub("", text).strip()


def _run_text(run) -> str:
    text = run.text or ""
    if not text.strip():
        return text
    if run.font.bold:
        return f"**{text}**"
    return text


def _paragraphs(text_frame) -> list[dict]:
    out = []
    for para in text_frame.paragraphs:
        text = _clean("".join(_run_text(r) for r in para.runs))
        if text:
            out.append({"text": text, "level": para.level or 0})
    return out


def _font_size(text_frame) -> int:
    best = 0
    for para in text_frame.paragraphs:
        for run in para.runs:
            if run.font.size is not None:
                best = max(best, int(run.font.size.pt * 100))
    return best


def _harvest(shape, facts: _Facts, offset=(0, 0)) -> None:
    from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER

    kind = shape.shape_type
    left = (shape.left or 0) + offset[0]
    top = (shape.top or 0) + offset[1]

    if kind == MSO_SHAPE_TYPE.GROUP:
        # Children keep their own coordinate space; the group's position
        # is a fair approximation for classification.
        for child in shape.shapes:
            _harvest(child, facts, (left, top))
        return

    if kind == MSO_SHAPE_TYPE.PICTURE:
        try:
            facts.pics.append(
                _Pic(blob=shape.image.blob, ext=shape.image.ext, left=left, top=top)
            )
        except Exception:
            facts.oddities.append("a picture could not be read and was dropped")
        return

    if getattr(shape, "has_table", False) and shape.has_table:
        rows = [
            [_clean(cell.text) for cell in row.cells] for row in shape.table.rows
        ]
        header = rows[0] if len(rows) > 1 else None
        body = rows[1:] if len(rows) > 1 else rows
        # The deck's own column proportions, kept as whole percentages:
        # they say what the columns hold, which is content. The font size
        # is deliberately not kept -- it is usually inherited rather than
        # set, and a size that suited the old frame is wrong for the new
        # one. The renderer fits the type to the frame instead.
        raw_widths = [int(col.width or 0) for col in shape.table.columns]
        total = sum(raw_widths)
        widths = None
        if total > 0 and all(raw_widths) and len(set(raw_widths)) > 1:
            widths = [max(1, round(100 * w / total)) for w in raw_widths]
        facts.tables.append({"header": header, "rows": body, "widths": widths})
        return

    if getattr(shape, "has_chart", False) and shape.has_chart:
        facts.oddities.append(
            "a live chart was found; its data was not extracted — rebuild as a table"
        )
        return

    if kind == MSO_SHAPE_TYPE.PLACEHOLDER or shape.has_text_frame:
        element_xml = shape._element.xml if hasattr(shape, "_element") else ""
        if _DIAGRAM_URI in element_xml:
            texts = [
                _clean(t.text or "") for t in shape._element.iter(_A_T)
            ]
            texts = [t for t in texts if t]
            if texts:
                facts.texts.append(
                    _Text(
                        paragraphs=[{"text": t, "level": 0} for t in texts],
                        left=left, top=top,
                        width=shape.width or 0, height=shape.height or 0,
                    )
                )
            facts.oddities.append(
                "SmartArt flattened to a list — redraw as Mermaid if the shape mattered"
            )
            return
        if not shape.has_text_frame:
            return
        paragraphs = _paragraphs(shape.text_frame)
        if not paragraphs:
            return
        is_title = False
        if shape.is_placeholder:
            ph = shape.placeholder_format.type
            is_title = ph in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE)
        facts.texts.append(
            _Text(
                paragraphs=paragraphs,
                left=left, top=top,
                width=shape.width or 0, height=shape.height or 0,
                is_title_ph=is_title,
                font_size=_font_size(shape.text_frame),
            )
        )


def extract(source) -> tuple[list[_Facts], tuple[int, int], str | None]:
    """Everything worth keeping, slide by slide, placeholders or not."""
    from pptx import Presentation

    prs = Presentation(io.BytesIO(source) if isinstance(source, bytes) else str(source))
    deck_title = None
    slides = []
    for n, slide in enumerate(prs.slides, start=1):
        facts = _Facts(number=n)
        for shape in slide.shapes:
            _harvest(shape, facts)
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            facts.notes = notes or None
        slides.append(facts)
        if deck_title is None:
            for t in facts.texts:
                if t.is_title_ph and t.paragraphs:
                    deck_title = t.paragraphs[0]["text"].replace("**", "")
                    break
    return slides, (prs.slide_width, prs.slide_height), deck_title


def _pick_title(facts: _Facts, slide_h: int) -> _Text | None:
    for t in facts.texts:
        if t.is_title_ph:
            return t
    in_band = [t for t in facts.texts if t.top < slide_h * TITLE_BAND]
    if not in_band:
        return None
    # Largest declared type wins; ties go to the topmost.
    in_band.sort(key=lambda t: (-t.font_size, t.top))
    best = in_band[0]
    if len(facts.texts) > 1 and best.chars > 120:
        return None  # a wall of text is content, not a title
    return best


def _items(paragraphs: list[dict]):
    """Nested grammar items from levelled paragraphs."""
    root: list = []
    stack = [(0, root)]
    for para in paragraphs:
        level = max(0, min(4, para["level"]))
        while stack and stack[-1][0] > level:
            stack.pop()
        while stack[-1][0] < level:
            siblings = stack[-1][1]
            if not siblings:
                break  # a child with no parent: flatten up
            parent = siblings[-1]
            if isinstance(parent, str):
                siblings[-1] = parent = {"text": parent, "items": []}
            elif "items" not in parent:
                parent["items"] = []
            stack.append((stack[-1][0] + 1, parent["items"]))
        stack[-1][1].append(para["text"])
    return root


def _text_region(body: _Text):
    if len(body.paragraphs) == 1 and body.chars <= CAPTION_CHARS:
        return {"type": "p", "text": body.paragraphs[0]["text"]}
    return {"type": "ul", "items": _items(body.paragraphs)}


def _columns(a: _Text, b: _Text, slide_w: int) -> bool:
    ca = a.left + (a.width or 0) / 2
    cb = b.left + (b.width or 0) / 2
    return abs(ca - cb) > slide_w * SIDE_GAP


def classify(facts: _Facts, size, media_ref) -> tuple[dict, str, list[str]]:
    """One slide's facts -> (slide dict, confidence, notes)."""
    slide_w, slide_h = size
    notes = list(facts.oddities)
    title = _pick_title(facts, slide_h)
    bodies = [t for t in facts.texts if t is not title]
    bodies.sort(key=lambda t: (t.left, t.top))
    out: dict = {}
    if title:
        out["title"] = title.paragraphs[0]["text"].replace("**", "")
        for extra in title.paragraphs[1:]:
            bodies.append(_Text(paragraphs=[extra], left=title.left, top=title.top,
                                width=title.width, height=title.height))

    def done(layout, confidence):
        out_full = {"layout": layout, **out}
        return out_full, confidence, notes

    if facts.tables:
        table = facts.tables[0]
        region = {"type": "table", "rows": table["rows"]}
        if table["header"]:
            region["header"] = table["header"]
        if table.get("widths"):
            region["widths"] = table["widths"]
        out["full"] = region
        if len(facts.tables) > 1:
            notes.append(f"{len(facts.tables) - 1} further table(s) dropped — split into their own slides")
        if bodies or facts.pics:
            notes.append("table kept; other content on this slide set aside")
        return done("Full", "medium")

    if not bodies and not facts.pics:
        if not title:
            notes.append("nothing extractable — slide skipped content")
            return done("TitleOnly", "low")
        words = len(out.get("title", "").split())
        return done("Section" if words <= SECTION_WORDS else "TitleOnly", "high")

    if not facts.pics:
        if len(bodies) == 1:
            out["full"] = _text_region(bodies[0])
            return done("Full", "high" if bodies[0].is_title_ph or title else "medium")
        if len(bodies) == 2 and _columns(bodies[0], bodies[1], slide_w):
            out["left"] = _text_region(bodies[0])
            out["right"] = _text_region(bodies[1])
            return done("Split", "medium")
        merged = [p for b in bodies for p in b.paragraphs]
        out["full"] = {"type": "ul", "items": _items(merged)}
        notes.append(f"{len(bodies)} text areas merged — free-form layout approximated")
        return done("Full", "low")

    pic_ref = media_ref(facts.pics[0], facts.number)
    if len(facts.pics) > 1:
        for i, pic in enumerate(facts.pics[1:], start=2):
            kept = media_ref(pic, facts.number, index=i)
            notes.append(f"extra picture saved as {kept} — place it on its own slide")

    if pic_ref is None:
        notes.append("picture in an unsupported format was dropped")
        if bodies:
            out["full"] = _text_region(bodies[0])
            return done("Full", "low")
        return done("TitleOnly", "low")

    if not bodies:
        out["picture"] = {"type": "image", "src": pic_ref}
        return done("Picture", "medium")

    body = bodies[0]
    if body.chars <= CAPTION_CHARS and len(bodies) == 1:
        out["picture"] = {"type": "image", "src": pic_ref}
        out["caption"] = _text_region(body)
        return done("Picture", "medium")

    out["left"] = _text_region(body)
    out["right"] = {"type": "image", "src": pic_ref}
    if len(bodies) > 1:
        merged = [p for b in bodies for p in b.paragraphs]
        out["left"] = {"type": "ul", "items": _items(merged)}
        notes.append("several text areas merged beside the picture")
    return done("Split", "medium" if _columns(body, _Text([], facts.pics[0].left, facts.pics[0].top, 0, 0), slide_w) else "low")


def _prepare_image(blob: bytes, ext: str) -> tuple[bytes, str] | None:
    """The asset policy at the door: resize, re-encode, strip metadata."""
    from PIL import Image

    try:
        im = Image.open(io.BytesIO(blob))
        im.load()
    except Exception:
        return None
    edge = max(im.size)
    if edge > MAX_EDGE:
        scale = MAX_EDGE / edge
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    buf = io.BytesIO()
    if has_alpha:
        im.convert("RGBA").save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "png"
    im.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return buf.getvalue(), "jpg"


def ingest_pptx(source, block_id: str, title: str | None = None) -> IngestResult:
    slides, size, deck_title = extract(source)
    media: dict[str, bytes] = {}
    by_hash: dict[str, str] = {}

    def media_ref(pic: _Pic, slide_no: int, index: int = 1) -> str | None:
        digest = hashlib.sha1(pic.blob).hexdigest()[:10]
        if digest in by_hash:
            return by_hash[digest]
        prepared = _prepare_image(pic.blob, pic.ext)
        if prepared is None:
            return None
        data, ext = prepared
        name = f"media/img-{slide_no:02d}-{index}.{ext}"
        media[name] = data
        by_hash[digest] = name
        return name

    blocks: list[str] = []
    report: list[dict] = []
    first_title: str | None = None
    for facts in slides:
        slide_dict, confidence, notes = classify(facts, size, media_ref)
        if first_title is None and slide_dict.get("title"):
            first_title = slide_dict["title"]
        sid = f"s-{facts.number:02d}"
        ordered = {"id": sid, "layout": slide_dict.pop("layout")}
        ordered.update(slide_dict)
        if facts.notes:
            ordered["notes"] = facts.notes
        body = yaml.safe_dump(
            ordered, sort_keys=False, allow_unicode=True, width=76
        ).rstrip()
        blocks.append(f"--- slide\n{body}\n---")
        report.append(
            {"slide": facts.number, "id": sid, "layout": ordered["layout"],
             "confidence": confidence, "notes": notes}
        )

    final_title = title or deck_title or first_title or block_id
    front = yaml.safe_dump(
        {"session": block_id, "title": final_title, "version": "0.1.0"},
        sort_keys=False, allow_unicode=True,
    ).rstrip()
    slides_md = f"---\n{front}\n---\n\n" + "\n\n".join(blocks) + "\n"
    return IngestResult(title=final_title, slides_md=slides_md, media=media, report=report)


def write_block(result: IngestResult, out_dir: Path, source_name: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "slides.md").write_text(result.slides_md, encoding="utf-8")
    (out_dir / "block.yaml").write_text(
        yaml.safe_dump({"title": result.title}, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    lesson = out_dir / "lessonplan.md"
    if not lesson.exists():
        lesson.write_text(
            f"# {result.title}\n\n*Imported from {source_name}. "
            "Write the lesson plan: the deck alone is not the session.*\n",
            encoding="utf-8",
        )
    for rel, data in result.media.items():
        target = out_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    low = sum(1 for r in result.report if r["confidence"] == "low")
    lines = [
        f"# Import report: {source_name}",
        "",
        f"{len(result.report)} slides; {low} need a human "
        "(low confidence). Review before submitting.",
        "",
        "| Slide | Id | Layout | Confidence | Notes |",
        "|---|---|---|---|---|",
    ]
    for r in result.report:
        lines.append(
            f"| {r['slide']} | {r['id']} | {r['layout']} | {r['confidence']} | "
            f"{'; '.join(r['notes']) or '—'} |"
        )
    (out_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="edufair-import",
        description="Rescue an existing .pptx into a block of markdown + policy-clean media",
    )
    ap.add_argument("pptx", type=Path)
    ap.add_argument("--out", type=Path, default=None,
                    help="block folder to write (default: blocks/<deck name>)")
    ap.add_argument("--id", dest="block_id", default=None,
                    help="block id (default: the deck's file name, slugified)")
    ap.add_argument("--title", default=None)
    args = ap.parse_args(argv)

    if not args.pptx.exists():
        print(f"error: {args.pptx} not found", file=sys.stderr)
        return 1
    slug = args.block_id or re.sub(r"[^a-z0-9]+", "-", args.pptx.stem.lower()).strip("-")
    out_dir = args.out or Path("blocks") / slug

    result = ingest_pptx(args.pptx, slug, title=args.title)
    write_block(result, out_dir, args.pptx.name)

    low = sum(1 for r in result.report if r["confidence"] == "low")
    print(f"{args.pptx.name}: {len(result.report)} slides -> {out_dir}")
    print(f"  {len(result.media)} image(s) through the policy; "
          f"{low} slide(s) flagged for review — see {out_dir / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
