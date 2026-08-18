"""Pull a library repo and render it into the assembler's data directory.

A library is a plain git repo of markdown — no Pages, no published
decks. This clones or updates it under .libraries/ and renders it at
point of use, which is the invariant: the pptx is never stored or
published, it is regenerated from the markdown whenever needed.

    python scripts/pull_library.py https://github.com/Org/Some-Library

Re-run to refresh; it fast-forwards to the remote's current tip. The
default branch is read from the remote rather than assumed to be main.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "renderer" / "src"))

from fair_renderer.corpus import build_corpus, CorpusError  # noqa: E402

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


def default_branch(url: str) -> str:
    """The remote's own HEAD, so we do not assume 'main'."""
    for line in git("ls-remote", "--symref", url, "HEAD").splitlines():
        if line.startswith("ref:"):
            return line.split()[1].removeprefix("refs/heads/")
    return "HEAD"


def sync(url: str, ref: str | None, cache: Path) -> tuple[Path, str]:
    ref = ref or default_branch(url)
    if (cache / ".git").is_dir():
        git("fetch", "--prune", "origin", cwd=cache)
    else:
        cache.parent.mkdir(parents=True, exist_ok=True)
        git("clone", "--quiet", url, str(cache))
        git("fetch", "--prune", "origin", cwd=cache)
    # Hard reset, not merge: the cache is a render input, not a workspace.
    git("checkout", "--quiet", "--detach", f"origin/{ref}", cwd=cache)
    return cache, git("rev-parse", "--short", "HEAD", cwd=cache)


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
        description="Clone/update a library repo and render it for the pane",
    )
    ap.add_argument("url", help="git URL of the library repo (or a local path)")
    ap.add_argument("--ref", default=None, help="branch to render (default: remote HEAD)")
    ap.add_argument("--out", type=Path, default=REPO / "assembler" / "web" / "data")
    ap.add_argument("--cache", type=Path, default=None,
                    help="where the clone lives (default: .libraries/<name>)")
    args = ap.parse_args()

    name = args.url.rstrip("/").split("/")[-1].removesuffix(".git")
    cache = args.cache or REPO / ".libraries" / name

    root, sha = sync(args.url, args.ref, cache)
    print(f"{name} @ {sha}")

    paths = resolve(root)
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
