"""fair-track: the curriculum in SQLite, and completion against it.

Two kinds of table live here, and the difference is the whole design:

**Curriculum tables are a projection.** courses, blocks, slides,
competencies, credentials — all derived from a rendered `catalog.json`,
which is derived from git. Drop them and re-sync and nothing is lost.
They exist so completion has something to point at, and so questions
like "who has evidence for CE3 at DOK 3" can be asked in SQL rather than
by walking JSON.

**The events table is the store of record.** It is append-only and holds
the only data that is not in git: who was assigned what, who completed
what, when. Losing it loses activity history, never content.

That asymmetry is deliberate. Content lives in git; the database holds
what happened. It never becomes a second place where a slide lives.

    fair-track sync catalog.json --db curriculum.db
    fair-track complete --learner ada --block 01-foundations --db curriculum.db
    fair-track report --db curriculum.db
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
PRAGMA foreign_keys = ON;

-- ---- curriculum: derived from catalog.json, safe to rebuild ----------
CREATE TABLE IF NOT EXISTS courses (
    course_id    TEXT PRIMARY KEY,
    title        TEXT,
    description  TEXT,
    synced_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
    block_id         TEXT PRIMARY KEY,
    course_id        TEXT NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
    title            TEXT,
    duration_minutes INTEGER,
    position         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS slides (
    block_id  TEXT NOT NULL REFERENCES blocks(block_id) ON DELETE CASCADE,
    slide_id  TEXT NOT NULL,
    title     TEXT,
    dok       INTEGER,
    position  INTEGER NOT NULL,
    PRIMARY KEY (block_id, slide_id)
);

CREATE TABLE IF NOT EXISTS competencies (
    competency_id TEXT PRIMARY KEY,
    label         TEXT
);

CREATE TABLE IF NOT EXISTS slide_competencies (
    block_id      TEXT NOT NULL,
    slide_id      TEXT NOT NULL,
    competency_id TEXT NOT NULL REFERENCES competencies(competency_id) ON DELETE CASCADE,
    PRIMARY KEY (block_id, slide_id, competency_id),
    FOREIGN KEY (block_id, slide_id) REFERENCES slides(block_id, slide_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resources (
    block_id TEXT NOT NULL REFERENCES blocks(block_id) ON DELETE CASCADE,
    path     TEXT NOT NULL,
    type     TEXT,
    title    TEXT,
    PRIMARY KEY (block_id, path)
);

CREATE TABLE IF NOT EXISTS credentials (
    credential_id TEXT PRIMARY KEY,
    course_id     TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
    title         TEXT,
    ects          REAL
);

CREATE TABLE IF NOT EXISTS credential_requires (
    credential_id TEXT NOT NULL REFERENCES credentials(credential_id) ON DELETE CASCADE,
    competency_id TEXT NOT NULL,
    min_dok       INTEGER,
    PRIMARY KEY (credential_id, competency_id)
);

-- ---- the store of record: append-only, not in git --------------------
CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    learner       TEXT NOT NULL,
    kind          TEXT NOT NULL,          -- assigned | completed | assessed
    course_id     TEXT,
    block_id      TEXT,
    credential_id TEXT,
    occurred_at   TEXT NOT NULL,
    source        TEXT,                   -- what observed it: pr, assessment, manual
    detail        TEXT
);

CREATE INDEX IF NOT EXISTS events_learner ON events(learner);
CREATE INDEX IF NOT EXISTS events_block ON events(block_id);

-- Competency evidence, derived: completing a block evidences every
-- competency its slides develop, at the highest DOK those slides reach.
CREATE VIEW IF NOT EXISTS learner_competency AS
SELECT
    e.learner            AS learner,
    sc.competency_id     AS competency_id,
    MAX(s.dok)           AS dok,
    MIN(e.occurred_at)   AS first_evidenced
FROM events e
JOIN slides s              ON s.block_id = e.block_id
JOIN slide_competencies sc ON sc.block_id = s.block_id AND sc.slide_id = s.slide_id
WHERE e.kind = 'completed'
GROUP BY e.learner, sc.competency_id;
"""


class TrackingError(Exception):
    pass


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sync_curriculum(conn: sqlite3.Connection, catalog: dict, *, now: str | None = None) -> dict:
    """Project a rendered catalog into the curriculum tables.

    Idempotent and destructive *only* to the projection: the course's own
    rows are replaced, events are never touched. Re-syncing after a
    content change is always safe.
    """
    course = catalog.get("course") or {}
    course_id = course.get("id")
    if not course_id:
        raise TrackingError(
            "catalog has no course id — sync needs a library with course.yaml"
        )
    stamp = now or _now()

    with conn:  # one transaction: a half-synced curriculum is worse than none
        # ON DELETE CASCADE clears blocks, slides, resources and credentials.
        conn.execute("DELETE FROM courses WHERE course_id = ?", (course_id,))
        conn.execute(
            "INSERT INTO courses (course_id, title, description, synced_at) VALUES (?,?,?,?)",
            (course_id, course.get("title"), course.get("description"), stamp),
        )

        for cid, label in (catalog.get("competencies") or {}).items():
            conn.execute(
                "INSERT INTO competencies (competency_id, label) VALUES (?,?) "
                "ON CONFLICT(competency_id) DO UPDATE SET label = excluded.label",
                (cid, label),
            )

        for position, block in enumerate(catalog.get("blocks") or []):
            conn.execute(
                "INSERT INTO blocks (block_id, course_id, title, duration_minutes, position) "
                "VALUES (?,?,?,?,?)",
                (
                    block["blockId"],
                    course_id,
                    block.get("title"),
                    block.get("durationMinutes"),
                    position,
                ),
            )
            for resource in block.get("resources") or []:
                conn.execute(
                    "INSERT INTO resources (block_id, path, type, title) VALUES (?,?,?,?)",
                    (block["blockId"], resource["path"], resource.get("type"),
                     resource.get("title")),
                )

        known_blocks = {b["blockId"] for b in (catalog.get("blocks") or [])}
        for position, slide in enumerate(catalog.get("slides") or []):
            block_id = slide.get("blockId")
            if block_id not in known_blocks:
                continue  # a flat library predates blocks; nothing to hang it on
            conn.execute(
                "INSERT OR REPLACE INTO slides (block_id, slide_id, title, dok, position) "
                "VALUES (?,?,?,?,?)",
                (block_id, slide["slideId"], slide.get("title"), slide.get("dok"), position),
            )
            for cid in slide.get("develops") or []:
                conn.execute(
                    "INSERT OR IGNORE INTO competencies (competency_id, label) VALUES (?,?)",
                    (cid, cid),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO slide_competencies (block_id, slide_id, competency_id) "
                    "VALUES (?,?,?)",
                    (block_id, slide["slideId"], cid),
                )

        for cred in catalog.get("credentials") or []:
            conn.execute(
                "INSERT OR REPLACE INTO credentials (credential_id, course_id, title, ects) "
                "VALUES (?,?,?,?)",
                (cred["id"], course_id, cred.get("title"), cred.get("ects")),
            )
            for req in cred.get("requires") or []:
                cid = req.get("competency") if isinstance(req, dict) else req
                min_dok = req.get("min_dok") if isinstance(req, dict) else None
                conn.execute(
                    "INSERT OR REPLACE INTO credential_requires "
                    "(credential_id, competency_id, min_dok) VALUES (?,?,?)",
                    (cred["id"], cid, min_dok),
                )

    counts = {
        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in ("blocks", "slides", "competencies", "credentials", "resources")
    }
    counts["course"] = course_id
    return counts


def record(
    conn: sqlite3.Connection,
    learner: str,
    kind: str,
    *,
    block_id: str | None = None,
    course_id: str | None = None,
    credential_id: str | None = None,
    source: str = "manual",
    detail: str | None = None,
    occurred_at: str | None = None,
) -> int:
    """Append an event. Never updates, never deletes — this is the record."""
    if kind not in ("assigned", "completed", "assessed"):
        raise TrackingError(f"unknown event kind {kind!r}")
    if block_id is not None:
        exists = conn.execute(
            "SELECT 1 FROM blocks WHERE block_id = ?", (block_id,)
        ).fetchone()
        if not exists:
            raise TrackingError(
                f"no such block {block_id!r} — sync the curriculum first"
            )
    with conn:
        cur = conn.execute(
            "INSERT INTO events (learner, kind, course_id, block_id, credential_id, "
            "occurred_at, source, detail) VALUES (?,?,?,?,?,?,?,?)",
            (learner, kind, course_id, block_id, credential_id,
             occurred_at or _now(), source, detail),
        )
    return cur.lastrowid


def credential_progress(conn: sqlite3.Connection, learner: str) -> list[dict]:
    """Per credential: which required competencies the learner has met.

    Met means evidenced at or above the required DOK, so a credential
    requiring DOK 3 is not satisfied by DOK 2 evidence.
    """
    rows = conn.execute(
        """
        SELECT c.credential_id, c.title, c.ects,
               cr.competency_id, cr.min_dok,
               lc.dok AS evidenced_dok
        FROM credentials c
        JOIN credential_requires cr ON cr.credential_id = c.credential_id
        LEFT JOIN learner_competency lc
               ON lc.competency_id = cr.competency_id AND lc.learner = ?
        ORDER BY c.credential_id, cr.competency_id
        """,
        (learner,),
    ).fetchall()

    by_credential: dict[str, dict] = {}
    for row in rows:
        entry = by_credential.setdefault(
            row["credential_id"],
            {"credential": row["credential_id"], "title": row["title"],
             "ects": row["ects"], "requirements": []},
        )
        required = row["min_dok"]
        evidenced = row["evidenced_dok"]
        entry["requirements"].append(
            {
                "competency": row["competency_id"],
                "required_dok": required,
                "evidenced_dok": evidenced,
                "met": evidenced is not None and (required is None or evidenced >= required),
            }
        )
    for entry in by_credential.values():
        entry["complete"] = all(r["met"] for r in entry["requirements"])
    return list(by_credential.values())


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="fair-track",
        description="Project a curriculum into SQLite and record completion against it",
    )
    ap.add_argument("--db", type=Path, default=Path("curriculum.db"))
    sub = ap.add_subparsers(dest="command", required=True)

    p_sync = sub.add_parser("sync", help="project a catalog.json into the curriculum tables")
    p_sync.add_argument("catalog", type=Path)

    p_done = sub.add_parser("complete", help="record that a learner completed a block")
    p_done.add_argument("--learner", required=True)
    p_done.add_argument("--block", required=True)
    p_done.add_argument("--source", default="manual")
    p_done.add_argument("--detail", default=None)

    p_report = sub.add_parser("report", help="credential progress for a learner")
    p_report.add_argument("--learner", required=True)
    p_report.add_argument("--json", action="store_true")

    args = ap.parse_args(argv)
    conn = connect(args.db)

    try:
        if args.command == "sync":
            catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
            counts = sync_curriculum(conn, catalog)
            print(
                f"synced {counts['course']}: {counts['blocks']} blocks, "
                f"{counts['slides']} slides, {counts['competencies']} competencies, "
                f"{counts['credentials']} credentials, {counts['resources']} resources"
            )
        elif args.command == "complete":
            event_id = record(
                conn, args.learner, "completed",
                block_id=args.block, source=args.source, detail=args.detail,
            )
            print(f"recorded event {event_id}: {args.learner} completed {args.block}")
        elif args.command == "report":
            progress = credential_progress(conn, args.learner)
            if args.json:
                print(json.dumps(progress, indent=2))
            else:
                if not progress:
                    print(f"no credentials for {args.learner}")
                for entry in progress:
                    state = "COMPLETE" if entry["complete"] else "in progress"
                    print(f"{entry['title'] or entry['credential']} ({state})")
                    for req in entry["requirements"]:
                        mark = "ok " if req["met"] else "   "
                        got = req["evidenced_dok"]
                        need = req["required_dok"]
                        print(
                            f"  {mark} {req['competency']:6} "
                            f"needs DOK {need if need is not None else '-'}, "
                            f"has {got if got is not None else 'none'}"
                        )
    except TrackingError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
