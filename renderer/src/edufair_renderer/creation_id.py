"""Deterministic p14:creationId injection.

python-pptx never writes p14:creationId; PowerPoint only writes it for
slides created interactively. The Office.js assembler's
insertSlidesFromBase64 addresses source slides as "slideId#creationId",
so the renderer must inject a creationId into every slide it creates.

The id is derived from sha256(session_id:slide_id), not random, so the
same input always yields the same bytes (spec A.6.5) and the id is stable
across rebuilds — a re-rendered session can still be addressed by the
same sourceRef.
"""

from __future__ import annotations

import hashlib

from lxml import etree
from pptx.slide import Slide as PptxSlide

P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
P14_NS = "http://schemas.microsoft.com/office/powerpoint/2010/main"
# The registered extension URI PowerPoint uses for p14:creationId.
CREATION_ID_EXT_URI = "{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"


def derive_creation_id(session_id: str, slide_id: str) -> int:
    """Stable uint32 (1 .. 2**31-1) from the authored identifiers.

    PowerPoint's own creationIds are 32-bit values; we stay in the positive
    signed range and avoid 0, which reads as "absent".
    """
    digest = hashlib.sha256(f"{session_id}:{slide_id}".encode("utf-8")).digest()
    value = int.from_bytes(digest[:4], "big") & 0x7FFFFFFF
    return value or 1


def inject_creation_id(slide: PptxSlide, value: int) -> None:
    """Add <p:extLst><p:ext uri=...><p14:creationId val=.../> to the slide root."""
    sld = slide._element  # <p:sld>
    ext_lst = sld.find(f"{{{P_NS}}}extLst")
    if ext_lst is None:
        ext_lst = etree.SubElement(sld, f"{{{P_NS}}}extLst")
    ext = etree.SubElement(ext_lst, f"{{{P_NS}}}ext")
    ext.set("uri", CREATION_ID_EXT_URI)
    creation = etree.SubElement(ext, f"{{{P14_NS}}}creationId", nsmap={"p14": P14_NS})
    creation.set("val", str(value))
