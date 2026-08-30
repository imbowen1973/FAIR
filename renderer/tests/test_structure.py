"""The running order the workbench writes, read by the renderer.

course.yaml's `structure` is the one file where a mistake is silent: a
session in the wrong module still renders perfectly, just in the wrong
place. The workbench now rearranges it, so both ends of that contract
need holding down — the workbench's own checks prove what it writes, and
these prove the renderer accepts it.

The rule worth pinning is the asymmetric one: a container whose
`children` key is *absent* is a hard error, not an empty container. It is
the shape a "new grouping" button most easily produces by accident, and
the failure lands on whoever runs the build rather than on whoever
pressed the button.
"""

from __future__ import annotations

import textwrap

import pytest
import yaml

from edufair_renderer.library import LibraryError, load_library


def _session(block_dir):
    block_dir.mkdir(parents=True, exist_ok=True)
    (block_dir / "block.yaml").write_text(
        "title: A session\nduration_minutes: 45\nresources: []\n", encoding="utf-8"
    )
    (block_dir / "slides.md").write_text(
        textwrap.dedent(
            """\
            ---
            session: '01'
            title: A session
            version: 1.0.0
            ---

            --- slide
            id: s-01
            layout: Full
            title: Opening
            ---
            """
        ),
        encoding="utf-8",
    )


def _library(root, structure):
    root.mkdir(parents=True, exist_ok=True)
    for block in ("01-intro", "02-profiles", "03-standalone", "04-exam"):
        _session(root / "blocks" / block)
    (root / "course.yaml").write_text(
        yaml.safe_dump(
            {"id": "v", "title": "V130", "structure": structure},
            sort_keys=False,
            allow_unicode=True,
        ),
        encoding="utf-8",
    )
    return root


def test_the_arrangement_the_workbench_writes_loads(tmp_path):
    # Exactly what structure-check.mjs commits after a session has been
    # moved out of one grouping and into another.
    root = _library(
        tmp_path / "lib",
        [
            {"kind": "week", "title": "Getting started", "children": [{"block": "02-profiles"}]},
            {"block": "03-standalone"},
            {
                "kind": "module",
                "title": "Assessment week",
                "children": [{"block": "04-exam"}, {"block": "01-intro"}],
            },
        ],
    )
    lib = load_library(root)
    order = [
        node["block"] if node["kind"] == "block" else f"[{node['kind']}] {node['title']}"
        for node in _flat(lib.structure)
    ]
    assert order == [
        "[week] Getting started",
        "02-profiles",
        "03-standalone",
        "[module] Assessment week",
        "04-exam",
        "01-intro",
    ]


def _flat(nodes, out=None):
    out = [] if out is None else out
    for node in nodes:
        out.append(node)
        if node.get("kind") != "block":
            _flat(node.get("children") or [], out)
    return out


def test_an_empty_grouping_is_allowed(tmp_path):
    # "+ grouping here" makes one before anything is put in it, and a
    # course left that way overnight must still build.
    root = _library(
        tmp_path / "lib",
        [
            {"kind": "module", "title": "Nothing here yet", "children": []},
            {"block": "01-intro"},
            {"block": "02-profiles"},
            {"block": "03-standalone"},
            {"block": "04-exam"},
        ],
    )
    lib = load_library(root)
    assert lib.structure[0]["title"] == "Nothing here yet"
    assert lib.structure[0]["children"] == []


def test_a_grouping_without_children_is_refused(tmp_path):
    # The asymmetry worth knowing: absent is not empty. If the workbench
    # ever writes a container without the key, this is the error the
    # author gets, and it names the grouping.
    root = _library(
        tmp_path / "lib",
        [
            {"kind": "module", "title": "Broken"},
            {"block": "01-intro"},
            {"block": "02-profiles"},
            {"block": "03-standalone"},
            {"block": "04-exam"},
        ],
    )
    with pytest.raises(LibraryError, match="Broken"):
        load_library(root)


def test_nesting_survives(tmp_path):
    root = _library(
        tmp_path / "lib",
        [
            {
                "kind": "module",
                "title": "Outer",
                "children": [
                    {"block": "01-intro"},
                    {"kind": "day", "title": "Inner", "children": [{"block": "02-profiles"}]},
                ],
            },
            {"block": "03-standalone"},
            {"block": "04-exam"},
        ],
    )
    lib = load_library(root)
    inner = lib.structure[0]["children"][1]
    assert inner["kind"] == "day"
    assert inner["children"][0]["block"] == "02-profiles"


def test_a_session_left_out_of_the_order_still_builds(tmp_path):
    # The workbench shows these under "Not in the running order yet".
    # They are a drafting state, not an error, and the renderer says so
    # by gathering them rather than refusing the library.
    root = _library(tmp_path / "lib", [{"block": "01-intro"}])
    lib = load_library(root)
    gathered = lib.structure[-1]
    assert gathered["title"] == "Unplaced blocks"
    assert sorted(n["block"] for n in gathered["children"]) == [
        "02-profiles",
        "03-standalone",
        "04-exam",
    ]


def test_a_session_that_is_not_there_is_refused(tmp_path):
    # Every move the workbench offers rearranges references it already
    # holds, so it cannot produce this — but a hand-edited course.yaml
    # can, and it must not fail silently at render time.
    root = _library(tmp_path / "lib", [{"block": "99-imaginary"}])
    with pytest.raises(LibraryError, match="99-imaginary"):
        load_library(root)
