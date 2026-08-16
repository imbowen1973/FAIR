"""Load layout-map.yaml and validate it against the actual template.

The layout map is the explicit binding contract (spec A.2). Validation is
mandatory: if the template is re-edited in PowerPoint and placeholder
indices shift, the build must fail loudly rather than write content into
the wrong placeholder.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml
from pptx.presentation import Presentation


class LayoutMapError(Exception):
    """Raised when layout-map.yaml is malformed or disagrees with the template."""


@dataclass
class LayoutBinding:
    key: str  # key used in session.md, e.g. "Split"
    layout_name: str  # layout name inside template.pptx
    regions: dict[str, int]  # region name -> placeholder idx


def load_layout_map(path: Path) -> dict[str, LayoutBinding]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise LayoutMapError(f"{path}: invalid YAML: {e}") from e
    if not isinstance(data, dict) or not data:
        raise LayoutMapError(f"{path}: layout map must be a non-empty mapping")

    bindings: dict[str, LayoutBinding] = {}
    for key, entry in data.items():
        if not isinstance(entry, dict):
            raise LayoutMapError(f"{path}: entry {key!r} must be a mapping")
        layout_name = entry.get("layout_name")
        regions = entry.get("regions")
        if not isinstance(layout_name, str) or not layout_name:
            raise LayoutMapError(f"{path}: entry {key!r} missing 'layout_name'")
        if not isinstance(regions, dict):
            raise LayoutMapError(
                f"{path}: entry {key!r} missing 'regions' (use {{}} for chrome-only layouts)"
            )
        for rname, idx in regions.items():
            if not isinstance(idx, int) or idx < 0:
                raise LayoutMapError(
                    f"{path}: {key}.regions.{rname} must be a non-negative integer, got {idx!r}"
                )
        indices = list(regions.values())
        if len(indices) != len(set(indices)):
            raise LayoutMapError(f"{path}: entry {key!r} maps two regions to the same index")
        bindings[key] = LayoutBinding(key=key, layout_name=layout_name, regions=dict(regions))
    return bindings


def validate_against_template(
    bindings: dict[str, LayoutBinding], prs: Presentation, template_path: Path
) -> None:
    """Fail fast if any mapped layout or placeholder index is absent."""
    layouts_by_name = {
        layout.name: layout for master in prs.slide_masters for layout in master.slide_layouts
    }
    errors: list[str] = []
    for binding in bindings.values():
        layout = layouts_by_name.get(binding.layout_name)
        if layout is None:
            errors.append(
                f"layout {binding.layout_name!r} (key {binding.key!r}) not found in template; "
                f"template has: {sorted(layouts_by_name)}"
            )
            continue
        available = {ph.placeholder_format.idx for ph in layout.placeholders}
        for rname, idx in binding.regions.items():
            if idx not in available:
                errors.append(
                    f"{binding.key}.{rname} -> idx {idx}, but layout "
                    f"{binding.layout_name!r} only has placeholder indices {sorted(available)}"
                )
    if errors:
        raise LayoutMapError(
            f"layout map does not match template {template_path}:\n  " + "\n  ".join(errors)
        )
