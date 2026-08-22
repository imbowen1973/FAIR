"""Word rendering: markdown documents into a branded .docx.

The same separation the deck renderer works to, applied to the documents
a session already has — its lesson plan, its workbook, its teacher
resources:

    FAIR defines meaning. The template defines appearance.

A markdown document says what it *is* — a heading, a list, a figure, a
callout — and the Word template says what those look like. Nothing in
the markdown may name a font, a colour, a margin or a size, and the
block model has nowhere to put such a thing, which is the enforcement.
"""
