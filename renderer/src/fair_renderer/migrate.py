"""fair-migrate: turn a flat sessions/ library into a course of blocks.

The old shape put every deck in `sessions/*.md` with the delivery
structure declared separately in `credentials/*.yaml`, and had nowhere
at all to put a lesson plan, a workbook or a question bank. The block
shape makes the filesystem the structure and gives each block a folder
its resources and media can live in.

    fair-migrate <library-root>

Moves each session to `blocks/<id>/slides.md`, writes a `block.yaml`
carrying what the session's frontmatter knew, and derives `course.yaml`
from the credential's modules/days/blocks so the delivery order
survives. Media referenced by a session moves into that block's
`media/` and the references are rewritten.

Non-destructive by default: it prints what it would do unless `--apply`
is given, and it never deletes anything it has not copied.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

import yaml

from .library import BLOCKS_DIR, COURSE_FILE


class MigrationError(Exception):
    pass


def _session_frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise MigrationError(f"{path}: no frontmatter")
    end = text.index("\n---", 3)
    data = yaml.safe_load(text[3:end])
    return data if isinstance(data, dict) else {}


def _block_id(session_id: str, title: str, index: int) -> str:
    """A folder name: ordered, readable, and cut at a word boundary."""
    words = re.sub(r"[^a-z0-9]+", "-", (title or session_id).lower()).strip("-").split("-")
    slug, length = [], 0
    for word in words:
        if slug and length + len(word) + 1 > 40:
            break
        slug.append(word)
        length += len(word) + 1
    return f"{index:02d}-{'-'.join(slug) or session_id}"


# The credential's own nesting keys, and the singular each becomes in the
# recipe. "blocks" there meant a teaching block, which is now the leaf.
_LEVEL_KIND = {"modules": "module", "days": "day", "blocks": "block-group"}


def _credential_order(root: Path) -> list[tuple[list[tuple[str, str]], str]]:
    """([(kind, title), ...], session id) in the credential's own order."""
    creds = sorted((root / "credentials").glob("*.yaml")) if (root / "credentials").is_dir() else []
    order: list[tuple[list[tuple[str, str]], str]] = []

    def walk(node, trail, kind):
        # kind is None at the credential root: its title names the course,
        # not a container, so it must not become a level in the tree.
        here = trail + ([(kind, node["title"])] if kind and node.get("title") else [])
        for key, child_kind in _LEVEL_KIND.items():
            children = node.get(key)
            if isinstance(children, list):
                for child in children:
                    walk(child, here, child_kind)
                return
        for sid in node.get("sessions") or []:
            order.append((here, str(sid)))

    for cred_path in creds:
        cred = yaml.safe_load(cred_path.read_text(encoding="utf-8")) or {}
        walk(cred, [], None)
    return order


def plan_migration(root: Path) -> dict:
    sessions_dir = root / "sessions"
    if not sessions_dir.is_dir():
        raise MigrationError(f"{root}: no sessions/ to migrate")
    if (root / COURSE_FILE).exists():
        raise MigrationError(f"{root}: {COURSE_FILE} already exists — already migrated?")

    session_files = sorted(sessions_dir.glob("*.md"))
    if not session_files:
        raise MigrationError(f"{sessions_dir}: no session files")

    order = _credential_order(root)
    placed = {sid: trail for trail, sid in order}
    sequence = [sid for _, sid in order]

    def sort_key(p: Path) -> tuple:
        meta = _session_frontmatter(p)
        sid = str(meta.get("session") or p.stem)
        # Credential order first, then anything it never mentioned.
        return (sequence.index(sid) if sid in sequence else len(sequence), p.name)

    moves = []
    for i, path in enumerate(sorted(session_files, key=sort_key), start=1):
        meta = _session_frontmatter(path)
        sid = str(meta.get("session") or path.stem)
        moves.append(
            {
                "session": sid,
                "source": path,
                "block_id": _block_id(sid, meta.get("title", ""), i),
                "title": meta.get("title") or sid,
                "duration": meta.get("duration_minutes"),
                "competencies": meta.get("competencies") or {},
                "trail": placed.get(sid, []),
            }
        )
    return {"root": root, "moves": moves}


def _media_for(session_path: Path, text: str) -> list[Path]:
    """Files the session references relatively, that actually exist."""
    found = []
    for rel in re.findall(r"src:\s*([^\s\"']+)", text):
        target = (session_path.parent / rel).resolve()
        if target.is_file():
            found.append(target)
    return found


def apply_migration(plan: dict) -> list[str]:
    root: Path = plan["root"]
    actions: list[str] = []
    blocks_root = root / BLOCKS_DIR
    blocks_root.mkdir(exist_ok=True)

    for move in plan["moves"]:
        block_dir = blocks_root / move["block_id"]
        (block_dir / "media").mkdir(parents=True, exist_ok=True)

        text = move["source"].read_text(encoding="utf-8")
        for asset in _media_for(move["source"], text):
            shutil.copy2(asset, block_dir / "media" / asset.name)
            # Rewrite the reference to the block-local copy.
            text = re.sub(
                r"src:\s*\S*" + re.escape(asset.name),
                f"src: media/{asset.name}",
                text,
            )
            actions.append(f"  media  {asset.name} -> {move['block_id']}/media/")

        (block_dir / "slides.md").write_text(text, encoding="utf-8")
        actions.append(f"  slides {move['source'].name} -> {move['block_id']}/slides.md")

        meta = {"title": move["title"]}
        if move["duration"] is not None:
            meta["duration_minutes"] = move["duration"]
        if move["competencies"]:
            meta["competencies"] = move["competencies"]
        meta["resources"] = []
        (block_dir / "block.yaml").write_text(
            yaml.safe_dump(meta, sort_keys=False, allow_unicode=True), encoding="utf-8"
        )
        actions.append(f"  meta   {move['block_id']}/block.yaml")

    # course.yaml: rebuild the delivery tree the credential described.
    structure: list[dict] = []
    for move in plan["moves"]:
        node = {"block": move["block_id"]}
        cursor = structure
        for kind, title in move["trail"]:
            existing = next(
                (c for c in cursor if c.get("title") == title and "children" in c), None
            )
            if existing is None:
                existing = {"kind": kind, "title": title, "children": []}
                cursor.append(existing)
            cursor = existing["children"]
        cursor.append(node)

    # Prefer the credential's own identity over the folder name: a repo
    # called "Clinical-Educator-" is not what the course is called.
    identity = {}
    creds = sorted((root / "credentials").glob("*.yaml")) if (root / "credentials").is_dir() else []
    if creds:
        first = yaml.safe_load(creds[0].read_text(encoding="utf-8")) or {}
        identity = {k: first[k] for k in ("id", "title") if first.get(k)}

    course = {
        "id": identity.get("id") or root.name.strip("-").lower(),
        "title": identity.get("title") or root.name.replace("-", " ").strip(),
        "structure": structure or [{"block": m["block_id"]} for m in plan["moves"]],
    }
    (root / COURSE_FILE).write_text(
        yaml.safe_dump(course, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )
    actions.append(f"  course {COURSE_FILE}")
    return actions


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="fair-migrate",
        description="Convert a flat sessions/ library into a course of blocks",
    )
    ap.add_argument("library", type=Path)
    ap.add_argument("--apply", action="store_true",
                    help="write the changes (otherwise only prints the plan)")
    args = ap.parse_args(argv)

    try:
        plan = plan_migration(args.library)
    except MigrationError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    print(f"{len(plan['moves'])} session(s) -> blocks/")
    for move in plan["moves"]:
        trail = " / ".join(t for _, t in move["trail"]) or "(unplaced)"
        print(f"  {move['source'].name:24} -> {move['block_id']:32} [{trail}]")

    if not args.apply:
        print("\nnothing written — re-run with --apply")
        return 0

    for line in apply_migration(plan):
        print(line)
    print(
        f"\nwrote {COURSE_FILE} and {BLOCKS_DIR}/. "
        "sessions/ is left in place; delete it once you have checked the build."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
