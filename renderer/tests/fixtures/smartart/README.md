# SmartArt fixtures

Each layout has two files, gzipped:

- `<layout>.definition.xml.gz` — the definition bundle import writes to a
  block's `media/` (layout, quick style and colours, in `<fair:smartart>`)
- `<layout>.data.xml.gz` — the data model **PowerPoint itself wrote** for
  that diagram, presentation points included

The data models are the oracle for `test_smartart.py`: the generator must
rebuild PowerPoint's presentation tree from the content alone.

Source: LibreOffice core's PowerPoint test documents
(`sd/qa/unit/data/pptx/smartart-*.pptx`, `tdf145528_SmartArt_Matrix.pptx`),
Mozilla Public License 2.0. The layout definitions inside are PowerPoint's
built-in SmartArt layouts, as embedded in every deck that uses them.
