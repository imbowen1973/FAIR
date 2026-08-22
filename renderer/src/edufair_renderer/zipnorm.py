"""Normalize a .pptx (ZIP) for byte-stable output.

python-pptx saves through the standard zipfile module, which stamps every
entry with the current system time — so two otherwise identical builds
differ. Rewriting each entry with a fixed timestamp and fixed compression
settings, preserving entry order, makes the file byte-stable (spec A.6.5).
"""

from __future__ import annotations

import zipfile
from pathlib import Path

FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)


def normalize_zip(path: Path) -> None:
    tmp = path.with_suffix(path.suffix + ".norm")
    with zipfile.ZipFile(path, "r") as src, zipfile.ZipFile(
        tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
    ) as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            norm = zipfile.ZipInfo(filename=info.filename, date_time=FIXED_DATE_TIME)
            norm.compress_type = zipfile.ZIP_DEFLATED
            norm.external_attr = info.external_attr
            dst.writestr(norm, data)
    tmp.replace(path)
