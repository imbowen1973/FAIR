"""Library discovery: the course recipe and its blocks.

A library repo is a course, not a pile of decks. `course.yaml` is the
recipe book — identity and delivery structure — and it holds no content
itself. It points at blocks, and a block is a folder of everything
needed to teach that part of the course:

    course.yaml
    blocks/
      01-foundations/
        block.yaml        title, duration, competencies, resources
        slides.md         the deck (one per block)
        lessonplan.md     \\
        workbook.md        > resources: carried and indexed, never parsed
        questions.xml     /
        media/            images the deck and resources share

Two things follow from that shape, and both are the point of it:

- The recipe is stable while content churns. Editing a slide does not
  touch `course.yaml`; adding a block does.
- A block versions as a unit. The deck, its lesson plan and its media
  move, branch and merge together, because they are one folder.

Resources are declared, copied and indexed, never interpreted. The
renderer has no opinion about a workbook beyond where it lives and what
it is called — which is exactly enough for a pane or a portal to offer
it alongside the slides.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

COURSE_FILE = "course.yaml"
BLOCKS_DIR = "blocks"
BLOCK_FILE = "block.yaml"
SLIDES_FILE = "slides.md"
LESSON_PLAN_FILE = "lessonplan.md"
MEDIA_DIR = "media"
FILES_DIR = "files"

# Containers may nest to any depth under whatever names a course uses —
# modules, days, weeks, units. Only the leaf is fixed: it names a block.
CHILDREN_KEY = "children"
BLOCK_REF_KEY = "block"


class LibraryError(Exception):
    pass


@dataclass
class Resource:
    type: str
    title: str
    path: str  # relative to the block directory


@dataclass
class Block:
    block_id: str  # the folder name
    directory: Path
    title: str
    duration_minutes: int | None = None
    competencies: dict[str, str] = field(default_factory=dict)
    resources: list[Resource] = field(default_factory=list)

    @property
    def slides(self) -> Path:
        return self.directory / SLIDES_FILE

    @property
    def has_slides(self) -> bool:
        return self.slides.is_file()


@dataclass
class Library:
    root: Path
    course: dict
    blocks: dict[str, Block]
    structure: list[dict]

    @property
    def title(self) -> str:
        return str(self.course.get("title") or self.root.name)


def _load_yaml(path: Path) -> dict:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise LibraryError(f"{path}: invalid YAML: {e}") from e
    if not isinstance(data, dict):
        raise LibraryError(f"{path}: expected a YAML mapping")
    return data


def _load_resources(block_dir: Path, declared) -> list[Resource]:
    if declared is None:
        return []
    if not isinstance(declared, list):
        raise LibraryError(f"{block_dir / BLOCK_FILE}: 'resources' must be a list")
    out: list[Resource] = []
    for entry in declared:
        if not isinstance(entry, dict) or "path" not in entry:
            raise LibraryError(
                f"{block_dir / BLOCK_FILE}: each resource needs at least a 'path'"
            )
        rel = str(entry["path"])
        target = block_dir / rel
        if not target.is_file():
            raise LibraryError(f"{block_dir / BLOCK_FILE}: no such resource: {rel}")
        out.append(
            Resource(
                type=str(entry.get("type") or target.suffix.lstrip(".") or "file"),
                title=str(entry.get("title") or target.stem.replace("-", " ").capitalize()),
                path=rel,
            )
        )
    return out


def load_block(block_dir: Path) -> Block:
    meta_path = block_dir / BLOCK_FILE
    meta = _load_yaml(meta_path) if meta_path.is_file() else {}

    competencies = meta.get("competencies") or {}
    if isinstance(competencies, list):
        # A bare list means "develops these", labels coming from the
        # framework; normalise so callers see one shape.
        competencies = {str(c): str(c) for c in competencies}
    if not isinstance(competencies, dict):
        raise LibraryError(f"{meta_path}: 'competencies' must be a mapping or a list")

    duration = meta.get("duration_minutes")
    if duration is not None and not isinstance(duration, int):
        raise LibraryError(f"{meta_path}: 'duration_minutes' must be an integer")

    return Block(
        block_id=block_dir.name,
        directory=block_dir,
        title=str(meta.get("title") or block_dir.name.replace("-", " ")),
        duration_minutes=duration,
        competencies={str(k): str(v) for k, v in competencies.items()},
        resources=_load_resources(block_dir, meta.get("resources")),
    )


def check_blocks(root: Path) -> list[dict]:
    """Problems with a library's blocks that are not grammar errors.

    Reported rather than raised: an author opening a library wants every
    problem at once, not the first one. `[{"where", "message"}]`, empty
    when clean.

    This lives here, not in a client, so `fair-corpus`, the pane and the
    workbench all apply the same rule. A rule enforced in one client is
    not a rule.
    """
    problems: list[dict] = []
    blocks_dir = root / BLOCKS_DIR
    if not blocks_dir.is_dir():
        return problems

    for block_dir in sorted(p for p in blocks_dir.iterdir() if p.is_dir()):
        # Every session is taught by someone, and the lesson plan is how.
        # A deck without one is a slideshow, not a session.
        if not (block_dir / LESSON_PLAN_FILE).is_file():
            problems.append({
                "where": block_dir.name,
                "message": f"no {LESSON_PLAN_FILE}: every block needs a lesson plan",
            })

        meta_path = block_dir / BLOCK_FILE
        try:
            meta = _load_yaml(meta_path) if meta_path.is_file() else {}
        except LibraryError as exc:
            problems.append({"where": block_dir.name, "message": str(exc)})
            continue

        # Every missing resource, not just the first: load_block stops at
        # the first because a build must fail hard, but an author wants
        # the whole list in one pass.
        declared = meta.get("resources") or []
        missing = []
        if isinstance(declared, list):
            for entry in declared:
                if isinstance(entry, dict) and "path" in entry:
                    rel = str(entry["path"])
                    if not (block_dir / rel).is_file():
                        missing.append(rel)
                        problems.append({
                            "where": block_dir.name,
                            "message": f"{BLOCK_FILE} declares {rel}, which is not there",
                        })

        # Whatever else load_block would reject: shape of competencies,
        # duration, a resources list that is not a list.
        try:
            load_block(block_dir)
        except LibraryError as exc:
            message = str(exc)
            if not any(f"no such resource: {rel}" in message for rel in missing):
                problems.append({"where": block_dir.name, "message": message})
    return problems


def _walk_structure(nodes, path: Path, seen: set[str]) -> list[dict]:
    """Normalise the recipe's tree, checking every block reference."""
    if not isinstance(nodes, list):
        raise LibraryError(f"{path}: 'structure' and '{CHILDREN_KEY}' must be lists")
    out = []
    for node in nodes:
        if not isinstance(node, dict):
            raise LibraryError(f"{path}: every structure entry must be a mapping")
        if BLOCK_REF_KEY in node:
            block_id = str(node[BLOCK_REF_KEY])
            seen.add(block_id)
            out.append({"kind": "block", "block": block_id})
            continue
        children = node.get(CHILDREN_KEY)
        if children is None:
            raise LibraryError(
                f"{path}: entry {node.get('title')!r} has neither "
                f"'{BLOCK_REF_KEY}' nor '{CHILDREN_KEY}'"
            )
        out.append(
            {
                # Free-form: module, day, week, unit — the course's own word.
                "kind": str(node.get("kind") or "group"),
                "title": str(node.get("title") or ""),
                CHILDREN_KEY: _walk_structure(children, path, seen),
            }
        )
    return out


def is_library(root: Path) -> bool:
    return (root / COURSE_FILE).is_file() and (root / BLOCKS_DIR).is_dir()


def load_library(root: Path) -> Library:
    course_path = root / COURSE_FILE
    if not course_path.is_file():
        raise LibraryError(f"not a library: no {COURSE_FILE} in {root}")
    course = _load_yaml(course_path)

    blocks_root = root / BLOCKS_DIR
    if not blocks_root.is_dir():
        raise LibraryError(f"not a library: no {BLOCKS_DIR}/ in {root}")

    blocks: dict[str, Block] = {}
    for block_dir in sorted(p for p in blocks_root.iterdir() if p.is_dir()):
        blocks[block_dir.name] = load_block(block_dir)
    if not blocks:
        raise LibraryError(f"no blocks in {blocks_root}")

    referenced: set[str] = set()
    structure = _walk_structure(course.get("structure") or [], course_path, referenced)

    unknown = sorted(referenced - set(blocks))
    if unknown:
        raise LibraryError(
            f"{course_path}: references unknown block(s) {unknown}; "
            f"available: {sorted(blocks)}"
        )

    # Blocks on disk but absent from the recipe are a drafting state, not
    # an error: they render and are findable, just unplaced in the course.
    unplaced = [b for b in sorted(blocks) if b not in referenced]
    if unplaced:
        structure = structure + [
            {
                "kind": "group",
                "title": "Unplaced blocks",
                CHILDREN_KEY: [{"kind": "block", "block": b} for b in unplaced],
            }
        ]

    return Library(root=root, course=course, blocks=blocks, structure=structure)
