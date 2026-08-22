"""Flow a library repo into the assembler's data directory.

git -> render -> ppt, nothing retained: the repo's tip is shallow-cloned
(no history) into a temporary directory, rendered at point of use, and
the source is deleted the moment the render completes. Only the render
survives — long enough for the pane to fetch decks from it — and the
server sweeps that too (FAIR_RENDER_TTL).

    python scripts/pull_library.py https://github.com/Org/Some-Library

The markdown in git remains the only stored artifact anywhere.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "renderer" / "src"))

from edufair_renderer.corpus import build_corpus, CorpusError  # noqa: E402

# Library layout, per the authoring convention in docs/platform-architecture.md.
# Only sessions/ and a template are required; the rest sharpen the catalog.
LAYOUT = {
    "sessions": ("sessions", True),
    "template": ("template.pptx", True),
    "layout_map": ("layout-map.yaml", True),
    "framework": ("competencies/framework.yaml", False),
    "credentials": ("credentials", False),
}


def git(*args: str, cwd: Path | None = None) -> str:
    """Run git, returning stdout. Never prompts: a private repo fails fast."""
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if result.returncode != 0:
        raise SystemExit(f"error: git {' '.join(args)}\n{result.stderr.strip()}")
    return result.stdout.strip()


def fetch_tip(url: str, ref: str | None, dest: Path) -> str:
    """Shallow-clone the tip only — content, no history — into dest."""
    args = ["clone", "--quiet", "--depth", "1", "--single-branch"]
    if ref:
        args += ["--branch", ref]
    git(*args, url, str(dest))
    return git("rev-parse", "--short", "HEAD", cwd=dest)


def resolve(root: Path) -> dict[str, Path]:
    found, missing = {}, []
    for key, (rel, required) in LAYOUT.items():
        path = root / rel
        if path.exists():
            found[key] = path
        elif required:
            missing.append(rel)
    if missing:
        raise SystemExit(
            f"error: {root} is not a library — missing {', '.join(missing)}"
        )
    return found


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="pull_library.py",
        description="Flow a library repo through the renderer for the pane",
    )
    ap.add_argument("url", help="git URL of the library repo (or a local path)")
    ap.add_argument("--ref", default=None, help="branch to render (default: remote HEAD)")
    ap.add_argument("--out", type=Path, default=REPO / "assembler" / "web" / "data")
    args = ap.parse_args()

    name = args.url.rstrip("/").split("/")[-1].removesuffix(".git")

    # The source exists only inside this block; it is gone before we exit.
    with tempfile.TemporaryDirectory(prefix="fair-pull-") as tmp:
        src = Path(tmp) / "src"
        sha = fetch_tip(args.url, args.ref, src)
        print(f"{name} @ {sha}")

        paths = resolve(src)
        try:
            summary = build_corpus(
                sessions_dir=paths["sessions"],
                template=paths["template"],
                layout_map=paths["layout_map"],
                out_dir=args.out,
                framework=paths.get("framework"),
                credentials_dir=paths.get("credentials"),
            )
        except CorpusError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1

    print(
        f"wrote {summary['catalog']}: {summary['sessions']} sessions, "
        f"{summary['slides']} slides, {summary['competencies']} competencies, "
        f"{summary['credentials']} credentials"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
