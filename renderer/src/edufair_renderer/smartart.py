"""SmartArt: read it out of a deck, write it back into one.

A SmartArt graphic is two different things stored together. One is
CONTENT -- a tree of short texts ("Receive, Verify, Store", a manager and
the people under them). The other is SHAPE -- which of PowerPoint's
diagram layouts draws that tree, in what style and colours. Import keeps
the two apart, the way the rest of FAIR-Ed does: the tree goes into the
markdown, where it can be read, diffed and edited, and the shape goes
into one small XML file in the block's media -- the layout, style and
colour definitions exactly as PowerPoint wrote them -- so the render can
hand PowerPoint a real, editable SmartArt again rather than a picture of
one.

What is written back is the data model PowerPoint itself writes: the
content points, their transitions, and the PRESENTATION points -- one per
shape the layout will draw, each tied to the content it shows. Office
2007 never wrote a drawing cache and PowerPoint lays the diagram out
from these on open; LibreOffice draws nothing without them. So they are
generated here by walking the layout definition against the tree:
`forEach`, `choose`/`if`, `presOf`, the lot -- the same walk PowerPoint
makes. tests/test_smartart.py holds this to the presentation trees
PowerPoint itself wrote for a dozen layouts.

The drawing cache (`drawingN.xml`, an Office 2010 addition) is never
written: it would describe the old frame's geometry, and every consumer
that matters lays the diagram out itself.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from lxml import etree

from .parser import SMARTART_FAMILIES as FAMILIES
from .parser import SmartArtNode

DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
DIAGRAM_URI = DGM  # the graphicData uri that marks a SmartArt frame

# The definition bundle: layout, style and colours in one file.
BUNDLE_NS = "urn:fair-ed:smartart"
BUNDLE_TAG = f"{{{BUNDLE_NS}}}smartart"

# What a diagram MEANS comes from the layout's own category list
# (FAMILIES, shared with the grammar). The workbench draws each family
# differently; nothing else depends on it.
# Categories that say nothing about meaning.
_NOT_FAMILIES = {"convert", "officeonline", "other", "picture"}

MAX_DEPTH = 5


class SmartArtError(Exception):
    pass


def _q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


# ---- the definition bundle -------------------------------------------------


@dataclass
class Definition:
    layout: etree._Element  # dgm:layoutDef
    style: etree._Element  # dgm:styleDef
    colors: etree._Element  # dgm:colorsDef

    @property
    def layout_id(self) -> str:
        return self.layout.get("uniqueId") or ""

    @property
    def layout_name(self) -> str:
        """The short name: `process3` for urn:...layout/process3."""
        return short_name(self.layout_id)

    @property
    def family(self) -> str:
        return family_of(self.layout)

    def to_bytes(self) -> bytes:
        root = etree.Element(BUNDLE_TAG, nsmap={"fair": BUNDLE_NS})
        root.set("version", "1")
        for part in (self.layout, self.style, self.colors):
            root.append(_copy(part))
        return etree.tostring(root, xml_declaration=True, encoding="UTF-8")


def _copy(el):
    return etree.fromstring(etree.tostring(el))


def short_name(unique_id: str) -> str:
    tail = (unique_id or "").rstrip("/").rsplit("/", 1)[-1]
    return re.sub(r"[^A-Za-z0-9_-]+", "-", tail) or "custom"


def family_of(layout_def) -> str:
    """The layout's leading category: lowest priority number wins.

    Radial cycles declare both `relationship` and `cycle`; the priority
    is how PowerPoint's own gallery files it, and therefore what the
    author chose it as.
    """
    cats = []
    for cat in layout_def.iter(_q(DGM, "cat")):
        kind = cat.get("type") or ""
        if kind in _NOT_FAMILIES:
            continue
        try:
            pri = int(cat.get("pri") or 0)
        except ValueError:
            pri = 0
        cats.append((pri, kind))
    for _, kind in sorted(cats):
        if kind in FAMILIES:
            return kind
    return "list"


def read_definition(data: bytes) -> Definition:
    try:
        root = etree.fromstring(data)
    except etree.XMLSyntaxError as e:
        raise SmartArtError(f"the SmartArt definition is not XML: {e}") from None
    if root.tag != BUNDLE_TAG:
        raise SmartArtError("not a FAIR-Ed SmartArt definition (expected <fair:smartart>)")
    found = {etree.QName(c).localname: c for c in root if isinstance(c.tag, str)}
    missing = [k for k in ("layoutDef", "styleDef", "colorsDef") if k not in found]
    if missing:
        raise SmartArtError(f"the SmartArt definition lacks {', '.join(missing)}")
    return Definition(found["layoutDef"], found["styleDef"], found["colorsDef"])


# ---- the content model -----------------------------------------------------


class _Point:
    __slots__ = ("id", "type", "paras", "children", "parent", "par_trans", "sib_trans",
                 "owner", "depth")

    def __init__(self, pid: str, ptype: str, paras=None):
        self.id = pid
        self.type = ptype  # doc, node, asst, parTrans, sibTrans
        self.paras = paras or []
        self.children: list[_Point] = []
        self.parent: _Point | None = None
        self.par_trans: _Point | None = None
        self.sib_trans: _Point | None = None
        self.owner: _Point | None = None  # a transition's node
        self.depth = 0


class _Model:
    """The content tree, with the transitions PowerPoint keeps beside it."""

    def __init__(self, ids):
        self._ids = ids
        self.doc = _Point(next(ids), "doc")
        self.points = [self.doc]
        self.cxns: list[tuple[str, _Point, _Point, int]] = []  # (id, parent, child, ord)

    def add(self, parent: _Point, ptype: str, paras, pid=None, par=None, sib=None, cxn=None):
        node = _Point(pid or next(self._ids), ptype, paras)
        node.parent = parent
        node.depth = parent.depth + 1
        cxn_id = cxn or next(self._ids)
        node.par_trans = _Point(par or next(self._ids), "parTrans")
        node.sib_trans = _Point(sib or next(self._ids), "sibTrans")
        for t in (node.par_trans, node.sib_trans):
            t.owner = node
            t.parent = parent
            t.depth = node.depth
        self.cxns.append((cxn_id, parent, node, len(parent.children)))
        parent.children.append(node)
        self.points += [node, node.par_trans, node.sib_trans]
        return node


def _ids_from(seed: str):
    """Deterministic GUID-shaped model ids: the same content renders the
    same bytes, which is what lets a render be byte-for-byte repeatable."""
    n = 0
    while True:
        h = hashlib.sha1(f"{seed}:{n}".encode()).hexdigest().upper()
        n += 1
        yield f"{{{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}}}"


def _model_from_nodes(nodes: list[SmartArtNode], seed: str) -> _Model:
    model = _Model(_ids_from(seed))

    def add(parent, items):
        for item in items:
            point = model.add(parent, "asst" if item.assistant else "node",
                              item.text.split("\n"))
            add(point, item.children)

    add(model.doc, nodes)
    return model


# ---- reading a deck's SmartArt --------------------------------------------


def _paras_of(pt) -> list[str]:
    """A point's text, paragraph by paragraph, bold kept as **bold**."""
    out = []
    t = pt.find(_q(DGM, "t"))
    if t is None:
        return out
    for p in t.iter(_q(A, "p")):
        pieces = []
        for r in p:
            tag = etree.QName(r).localname
            if tag == "r":
                text = "".join(x.text or "" for x in r.iter(_q(A, "t")))
                rpr = r.find(_q(A, "rPr"))
                if text.strip() and rpr is not None and rpr.get("b") in ("1", "true"):
                    text = f"**{text}**"
                pieces.append(text)
            elif tag == "br":
                pieces.append(" ")
        out.append("".join(pieces).strip())
    while out and not out[-1]:
        out.pop()
    return out


def _parse_content(data_root) -> tuple[list[SmartArtNode], dict]:
    """The content tree of a data model, ignoring presentation points."""
    pts = {p.get("modelId"): p for p in data_root.iter(_q(DGM, "pt"))}
    kids: dict[str, list[tuple[int, str]]] = {}
    for c in data_root.iter(_q(DGM, "cxn")):
        if (c.get("type") or "parOf") == "parOf":
            kids.setdefault(c.get("srcId"), []).append((int(c.get("srcOrd") or 0), c.get("destId")))
    doc = next((pid for pid, p in pts.items() if p.get("type") == "doc"), None)
    if doc is None:
        raise SmartArtError("the SmartArt has no document point")

    def build(pid, depth):
        out = []
        for _, child in sorted(kids.get(pid, [])):
            p = pts.get(child)
            if p is None or (p.get("type") or "node") not in ("node", "asst"):
                continue
            text = "\n".join(_paras_of(p))
            node = SmartArtNode(text=text, assistant=p.get("type") == "asst")
            if depth < MAX_DEPTH:
                node.children = build(child, depth + 1)
            out.append(node)
        return out

    return build(doc, 1), {"doc": pts[doc]}


def read_frame(frame, part) -> tuple[list[SmartArtNode], Definition]:
    """A SmartArt graphicFrame on a slide -> (content tree, definition).

    `part` is the slide part, through which the frame's relationships
    resolve."""
    rel_ids = frame.find(f".//{_q(DGM, 'relIds')}")
    if rel_ids is None:
        raise SmartArtError("the SmartArt frame names no diagram parts")

    def load(attr):
        rid = rel_ids.get(_q(R, attr))
        if not rid:
            raise SmartArtError(f"the SmartArt frame has no {attr} part")
        try:
            return etree.fromstring(part.related_part(rid).blob)
        except KeyError:
            raise SmartArtError(f"the SmartArt's {attr} part is missing") from None

    data = load("dm")
    definition = Definition(load("lo"), load("qs"), load("cs"))
    nodes, _ = _parse_content(data)
    return nodes, definition


def node_texts(nodes: list[SmartArtNode]):
    for n in nodes:
        yield n.text
        yield from node_texts(n.children)


# ---- the presentation walk -------------------------------------------------

_VAR_DEFAULTS = {
    "dir": "norm", "hierBranch": "std", "animLvl": "none", "animOne": "one",
    "bulletEnabled": "0", "chMax": "-1", "chPref": "-1", "orgChart": "0",
    "resizeHandles": "rel",
}


def _split(value: str | None) -> list[str]:
    return (value or "").split()


def _ints(value: str | None) -> list[int]:
    out = []
    for v in _split(value):
        try:
            out.append(int(v))
        except ValueError:
            out.append(0)
    return out


def _siblings(p: _Point) -> list[_Point]:
    """A point's parent's row: parTrans, node, sibTrans for each child."""
    parent = p.parent
    if parent is None:
        return [p]
    row = []
    for child in parent.children:
        row += [child.par_trans, child, child.sib_trans]
    return row


def _axis(p: _Point, axis: str) -> list[_Point]:
    if axis == "self":
        return [p]
    if axis == "ch":
        if p.type not in ("doc", "node", "asst"):
            return []
        row = []
        for child in p.children:
            row += [child.par_trans, child, child.sib_trans]
        return row
    if axis in ("des", "desOrSelf"):
        out = [p] if axis == "desOrSelf" else []

        def walk(q):
            for r in _axis(q, "ch"):
                out.append(r)
                if r.type in ("node", "asst"):
                    walk(r)

        walk(p)
        return out
    if axis == "par":
        return [p.parent] if p.parent is not None else []
    if axis in ("ancst", "ancstOrSelf"):
        out = [p] if axis == "ancstOrSelf" else []
        q = p.parent
        while q is not None:
            out.append(q)
            q = q.parent
        return out
    if axis == "root":
        q = p
        while q.parent is not None:
            q = q.parent
        return [q]
    if axis in ("followSib", "precedSib"):
        row = _siblings(p)
        i = next((k for k, q in enumerate(row) if q is p), None)
        if i is None:
            return []
        return row[i + 1:] if axis == "followSib" else row[:i]
    return []  # none, follow, preced: not used by the built-in layouts


def _matches(p: _Point, pt_type: str) -> bool:
    if pt_type in ("", "all"):
        return True
    if pt_type == "node":
        return p.type in ("node", "asst")
    if pt_type == "norm":
        return p.type == "node"
    if pt_type == "nonNorm":
        return p.type != "node"
    if pt_type == "nonAsst":
        return p.type == "node"
    return p.type == pt_type  # doc, asst, parTrans, sibTrans


def _select(points: list[_Point], st: int, cnt: int, step: int) -> list[_Point]:
    if not points:
        return []
    step = step or 1
    start = st - 1 if st > 0 else (len(points) + st if st < 0 else 0)
    if start < 0 or start >= len(points):
        return []
    picked = points[start::step] if step > 0 else points[start::step]
    return picked[:cnt] if cnt > 0 else picked


def _navigate(context: _Point, el) -> list[_Point]:
    """Evaluate an element's axis/ptType/st/cnt/step from a point."""
    axes = _split(el.get("axis"))
    if not axes:
        return []
    types = _split(el.get("ptType"))
    sts, cnts, steps = _ints(el.get("st")), _ints(el.get("cnt")), _ints(el.get("step"))
    current = [context]
    for i, axis in enumerate(axes):
        pt_type = types[i] if i < len(types) else "all"
        st = sts[i] if i < len(sts) else 1
        cnt = cnts[i] if i < len(cnts) else 0
        step = steps[i] if i < len(steps) else 1
        nxt = []
        for p in current:
            found = [q for q in _axis(p, axis) if _matches(q, pt_type)]
            nxt += _select(found, st, cnt, step)
        current = nxt
    return current


def _compare(op: str, left, right) -> bool:
    try:
        a, b = float(left), float(right)
    except (TypeError, ValueError):
        a, b = str(left), str(right)
    return {
        "equ": a == b, "neq": a != b, "gt": a > b, "lt": a < b, "gte": a >= b, "lte": a <= b,
    }.get(op, False)


class _Walk:
    def __init__(self, model: _Model, layout_def, ids):
        self.model = model
        self.layout_def = layout_def
        self.ids = ids
        self.pres: list[dict] = []  # generated presentation points, in order
        self.named = {
            f.get("name"): f for f in layout_def.iter(_q(DGM, "forEach")) if f.get("name")
        }
        self.depth_guard = 0

    # A presentation point's data, filled in as the walk goes.
    def new_pres(self, layout_node, context: _Point, parent: dict | None) -> dict:
        pres = {
            "id": next(self.ids), "name": layout_node.get("name") or "",
            "assoc": context, "parent": parent, "children": [],
            "of": [], "label": layout_node.get("styleLbl"), "node": layout_node,
        }
        if parent is not None:
            parent["children"].append(pres)
        self.pres.append(pres)
        return pres

    def var(self, scopes: list, name: str) -> str:
        for var_lst in reversed(scopes):
            el = var_lst.find(_q(DGM, name)) if var_lst is not None else None
            if el is not None:
                return el.get("val") or _VAR_DEFAULTS.get(name, "")
        return _VAR_DEFAULTS.get(name, "")

    def decide(self, cond, context: _Point, scopes) -> bool:
        func = cond.get("func")
        op, val = cond.get("op"), cond.get("val")
        if func == "var":
            return _compare(op, self.var(scopes, cond.get("arg") or ""), val)
        if func == "cnt":
            return _compare(op, len(_navigate(context, cond)), val)
        if func in ("pos", "revPos", "posEven", "posOdd"):
            targets = _navigate(context, cond) or [context]
            target = targets[0]
            row = [q for q in _siblings(target) if q.type == target.type]
            if target not in row:
                return False
            pos = row.index(target) + 1
            if func == "revPos":
                pos = len(row) - pos + 1
            if func == "posEven":
                return _compare(op, 1 if pos % 2 == 0 else 0, val)
            if func == "posOdd":
                return _compare(op, 1 if pos % 2 else 0, val)
            return _compare(op, pos, val)
        if func == "depth":
            targets = _navigate(context, cond) or [context]
            return _compare(op, targets[0].depth, val)
        if func == "maxDepth":
            axes = _split(cond.get("axis"))
            base = context
            if len(axes) > 1:
                head = etree.Element("x")
                for k in ("axis", "ptType", "st", "cnt", "step"):
                    vals = _split(cond.get(k))
                    if vals[:-1]:
                        head.set(k, " ".join(vals[:-1]))
                found = _navigate(context, head)
                base = found[0] if found else context
            points = [q for q in _navigate(context, cond) if q.type in ("node", "asst")]
            deepest = max((q.depth - base.depth for q in points), default=0)
            return _compare(op, deepest, val)
        return False  # an unknown function: take the else

    def visit(self, el, context: _Point, parent_pres: dict | None, scopes: list):
        self.depth_guard += 1
        if self.depth_guard > 400:
            raise SmartArtError("the SmartArt layout recursed too deeply")
        try:
            for child in el:
                if not isinstance(child.tag, str):
                    continue
                tag = etree.QName(child).localname
                if tag in ("presOf", "alg", "shape"):
                    # The layout node's own, wherever a choose put it:
                    # the first one the walk reaches is the one in force.
                    if parent_pres is not None and tag not in parent_pres:
                        parent_pres[tag] = (child, context)
                elif tag == "layoutNode":
                    self.layout_node(child, context, parent_pres, scopes)
                elif tag == "forEach":
                    self.for_each(child, context, parent_pres, scopes)
                elif tag == "choose":
                    for branch in child:
                        if not isinstance(branch.tag, str):
                            continue
                        kind = etree.QName(branch).localname
                        if kind == "else" or (
                            kind == "if" and self.decide(branch, context, scopes)
                        ):
                            self.visit(branch, context, parent_pres, scopes)
                            break
        finally:
            self.depth_guard -= 1

    def for_each(self, el, context, parent_pres, scopes):
        ref = el.get("ref")
        if ref:
            target = self.named.get(ref)
            if target is None:
                return
            el = target
        points = _navigate(context, el)
        if (el.get("hideLastTrans") or "1") not in ("0", "false"):
            points = [
                q for q in points
                if not (q.type == "sibTrans" and q.owner is q.parent.children[-1])
            ]
        for q in points:
            self.visit(el, q, parent_pres, scopes)

    def layout_node(self, el, context, parent_pres, scopes):
        pres = self.new_pres(el, context, parent_pres)
        scopes = scopes + [el.find(_q(DGM, "varLst"))]
        self.visit(el, context, pres, scopes)
        alg = pres.get("alg", (None, None))[0]
        if parent_pres is None:
            pres["of"] = [context]  # the root presents the document
        elif "presOf" in pres and (alg is None or alg.get("type") != "composite"):
            # A composite is a container: PowerPoint never ties content
            # to it, whatever its presOf says, or the text would be drawn
            # twice -- once by the container and once by its text shape.
            pres_of, at = pres["presOf"]
            pres["of"] = _navigate(at, pres_of)

    def run(self) -> dict:
        root = self.layout_def.find(_q(DGM, "layoutNode"))
        if root is None:
            raise SmartArtError("the SmartArt layout has no layout node")
        self.layout_node(root, self.model.doc, None, [])
        return self.pres[0]


def _conn_dim(pres: dict) -> str:
    alg = pres.get("alg", (None, None))[0]
    if alg is None or alg.get("type") != "conn":
        return "2D"
    for param in alg.iter(_q(DGM, "param")):
        if param.get("type") == "dim":
            return param.get("val") or "2D"
    return "2D"


def _style_labels(pres_points: list[dict]) -> None:
    """Fill each presentation point's style label, index and count.

    A layout node that names no label gets PowerPoint's default for what
    it presents: node1..node4 by depth, asst for assistants, parChTrans
    for a parent-child connector, sibTrans between siblings. The index
    is that of the content point among all points sharing the label --
    which is what makes a colour scheme step through accent colours.
    """
    for pres in pres_points:
        if pres["label"] or not pres["of"]:
            continue
        shown = pres["of"][0]
        depth = max(1, min(4, shown.depth))
        if shown.type == "node":
            pres["label"] = f"node{depth}"
        elif shown.type == "asst":
            pres["label"] = f"asst{max(0, min(4, shown.depth - 1))}"
        elif shown.type == "parTrans":
            pres["label"] = f"parChTrans{_conn_dim(pres)}{depth}"
        elif shown.type == "sibTrans":
            pres["label"] = f"sibTrans{_conn_dim(pres)}1"
    # A shape with its geometry hidden (a text box laid over another
    # shape) draws nothing to colour, so it claims no index of its own.
    # It takes its content's index if a visible shape has already
    # claimed one earlier in the walk, and 0 otherwise -- which is
    # exactly what PowerPoint writes.
    def hidden(pres):
        shape = pres.get("shape", (None, None))[0]
        return shape is not None and shape.get("hideGeom") in ("1", "true")

    by_label: dict[str, list] = {}
    for pres in pres_points:
        if not pres["label"]:
            continue
        seen = by_label.setdefault(pres["label"], [])
        key = (pres["of"] or [pres["assoc"]])[0]
        if not hidden(pres) and key not in seen:
            seen.append(key)
        pres["idx"] = seen.index(key) if key in seen else 0
    for pres in pres_points:
        if pres["label"]:
            pres["cnt"] = len(by_label[pres["label"]])


# ---- writing the data model -----------------------------------------------


def _sub(parent, ns, tag, **attrs):
    el = etree.SubElement(parent, _q(ns, tag))
    for k, v in attrs.items():
        if v is not None:
            el.set(k, str(v))
    return el


def _text_body(pt, paras: list[str], write_paragraph):
    t = _sub(pt, DGM, "t")
    _sub(t, A, "bodyPr")
    _sub(t, A, "lstStyle")
    if not paras:
        p = _sub(t, A, "p")
        _sub(p, A, "endParaRPr", lang="en-GB")
        return
    for text in paras:
        p = _sub(t, A, "p")
        write_paragraph(p, text)


def _plain_paragraph(p, text: str) -> None:
    r = _sub(p, A, "r")
    _sub(r, A, "rPr", lang="en-GB")
    _sub(r, A, "t").text = text


def build_data_model(
    nodes: list[SmartArtNode], definition: Definition, seed: str, write_paragraph=None
) -> bytes:
    """The dgm:dataModel for a content tree under a definition."""
    if not nodes:
        raise SmartArtError("a SmartArt needs at least one node")
    write_paragraph = write_paragraph or _plain_paragraph
    model = _model_from_nodes(nodes, seed)
    return _write_model(model, definition, _ids_from(seed + ":pres"), write_paragraph)


def _write_model(model: _Model, definition: Definition, ids, write_paragraph) -> bytes:
    walk = _Walk(model, definition.layout, ids)
    walk.run()
    _style_labels(walk.pres)
    layout_id = definition.layout_id

    root = etree.Element(_q(DGM, "dataModel"), nsmap={"dgm": DGM, "a": A})
    pt_lst = _sub(root, DGM, "ptLst")

    def first_cat(el):
        cat = el.find(f".//{_q(DGM, 'cat')}")
        return cat.get("type") if cat is not None else None

    doc = _sub(pt_lst, DGM, "pt", modelId=model.doc.id, type="doc")
    _sub(
        doc, DGM, "prSet",
        loTypeId=layout_id, loCatId=definition.family,
        qsTypeId=definition.style.get("uniqueId"), qsCatId=first_cat(definition.style),
        csTypeId=definition.colors.get("uniqueId"), csCatId=first_cat(definition.colors),
    )
    _sub(doc, DGM, "spPr")
    _text_body(doc, [], write_paragraph)

    cxn_of = {child.id: cxn_id for cxn_id, _, child, _ in model.cxns}
    for point in model.points[1:]:
        if point.type in ("node", "asst"):
            pt = _sub(pt_lst, DGM, "pt", modelId=point.id,
                      type="asst" if point.type == "asst" else None)
            _sub(pt, DGM, "prSet", phldrT="[Text]")
            _sub(pt, DGM, "spPr")
            _text_body(pt, point.paras, write_paragraph)
        else:
            pt = _sub(pt_lst, DGM, "pt", modelId=point.id, type=point.type,
                      cxnId=cxn_of[point.owner.id])
            _sub(pt, DGM, "prSet")
            _sub(pt, DGM, "spPr")
            _text_body(pt, [], write_paragraph)

    for pres in walk.pres:
        pt = _sub(pt_lst, DGM, "pt", modelId=pres["id"], type="pres")
        pr_set = _sub(
            pt, DGM, "prSet",
            presAssocID=pres["assoc"].id, presName=pres["name"],
            presStyleLbl=pres["label"],
            presStyleIdx=pres.get("idx") if pres["label"] else None,
            presStyleCnt=pres.get("cnt", 0) if pres["label"] else 0,
        )
        var_lst = pres["node"].find(_q(DGM, "varLst"))
        if var_lst is not None and len(var_lst):
            lv = _sub(pr_set, DGM, "presLayoutVars")
            for var in var_lst:
                if isinstance(var.tag, str):
                    lv.append(_copy(var))
        _sub(pt, DGM, "spPr")

    cxn_lst = _sub(root, DGM, "cxnLst")
    for cxn_id, parent, child, order in model.cxns:
        _sub(cxn_lst, DGM, "cxn", modelId=cxn_id, srcId=parent.id, destId=child.id,
             srcOrd=order, destOrd=0, parTransId=child.par_trans.id,
             sibTransId=child.sib_trans.id)
    for pres in walk.pres:
        for order, shown in enumerate(pres["of"]):
            # destOrd, not srcOrd, is the order of the texts within the
            # shape: a list layout showing a node and its sub-points
            # reads them in this order.
            _sub(cxn_lst, DGM, "cxn", modelId=next(ids), type="presOf", srcId=shown.id,
                 destId=pres["id"], srcOrd=0, destOrd=order, presId=layout_id)
        for order, child in enumerate(pres["children"]):
            _sub(cxn_lst, DGM, "cxn", modelId=next(ids), type="presParOf",
                 srcId=pres["id"], destId=child["id"], srcOrd=order, destOrd=0,
                 presId=layout_id)
    _sub(root, DGM, "bg")
    _sub(root, DGM, "whole")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def regenerate(data_xml: bytes, definition: Definition, seed: str = "check") -> bytes:
    """A data model rebuilt from its own content -- what a render would
    write for it. Exists for the tests, which hold the generated
    presentation points to the ones PowerPoint wrote."""
    nodes, _ = _parse_content(etree.fromstring(data_xml))
    return build_data_model(nodes, definition, seed)


# ---- writing a SmartArt onto a slide ---------------------------------------


def add_to_slide(slide, left, top, width, height, nodes, definition: Definition,
                 seed: str, write_paragraph=None, name: str = "Diagram"):
    """Real SmartArt on a python-pptx slide: four parts and a frame."""
    from pptx.opc.constants import CONTENT_TYPE as CT
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    from pptx.opc.package import Part
    from pptx.opc.packuri import PackURI

    package = slide.part.package
    data = build_data_model(nodes, definition, seed, write_paragraph)

    def xml(el):
        return etree.tostring(el, xml_declaration=True, encoding="UTF-8", standalone=True)

    rids = {}
    for key, template, ct, rt, blob in (
        ("dm", "/ppt/diagrams/data%d.xml", CT.DML_DIAGRAM_DATA, RT.DIAGRAM_DATA, data),
        ("lo", "/ppt/diagrams/layout%d.xml", CT.DML_DIAGRAM_LAYOUT, RT.DIAGRAM_LAYOUT,
         xml(definition.layout)),
        ("qs", "/ppt/diagrams/quickStyle%d.xml", CT.DML_DIAGRAM_STYLE, RT.DIAGRAM_QUICK_STYLE,
         xml(definition.style)),
        ("cs", "/ppt/diagrams/colors%d.xml", CT.DML_DIAGRAM_COLORS, RT.DIAGRAM_COLORS,
         xml(definition.colors)),
    ):
        new = Part(PackURI(package.next_partname(template)), ct, package, blob)
        rids[key] = slide.part.relate_to(new, rt)

    shape_id = slide.shapes._next_shape_id
    frame = etree.fromstring(
        f'<p:graphicFrame xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}" xmlns:dgm="{DGM}">'
        f'<p:nvGraphicFramePr><p:cNvPr id="{shape_id}" name="{name} {shape_id}"/>'
        "<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>"
        f'<p:xfrm><a:off x="{int(left)}" y="{int(top)}"/>'
        f'<a:ext cx="{int(width)}" cy="{int(height)}"/></p:xfrm>'
        f'<a:graphic><a:graphicData uri="{DIAGRAM_URI}">'
        f'<dgm:relIds r:dm="{rids["dm"]}" r:lo="{rids["lo"]}" '
        f'r:qs="{rids["qs"]}" r:cs="{rids["cs"]}"/>'
        "</a:graphicData></a:graphic></p:graphicFrame>"
    )
    slide.shapes._spTree.append(frame)
    return frame
