---
session: "gallery"
title: Layout gallery — every layout in the profile
version: 1.0.0
duration_minutes: 0
outcomes:
  - See what each layout offers before authoring against it
dc:
  creator: FAIR Consortium
  license: CC-BY-4.0
---

--- slide
id: g-01
layout: Title
title: Layout gallery
subtitle: One slide per layout, with every region filled
notes: |
  Render this against any template to see how that template treats each
  layout. Nothing here is styled by the renderer: every colour, font,
  shape and position comes from the template's own masters and layouts.

    edufair-render examples/layout-gallery/gallery.md \
      --template <your-template.pptx> \
      --layout-map <your-layout-map.yaml> \
      --out-dir out/gallery

  Generate the layout map first with `edufair-template <your-template.pptx>`.
---

--- slide
id: g-02
layout: Section
title: Core profile
subtitle: The nine layouts any stock PowerPoint template already provides
notes: |
  Section is a divider. Stock name: "Section Header". Regions: title,
  subtitle.
---

--- slide
id: g-03
layout: Full
title: Full — one content well
full:
  type: ul
  items:
    - "**Stock name:** Title and Content"
    - "**Regions:** title, full"
    - text: "Takes any text content type"
      items:
        - "`ul` — bulleted, like this one"
        - "`ol` — numbered"
        - "`p` — plain paragraphs, no bullets"
        - "`image`, `mermaid`, `video`"
notes: |
  The workhorse. Sub-list bullet glyphs are colour-coded per level by the
  master, so authors get coloured hierarchy without writing any colour.
---

--- slide
id: g-04
layout: Split
title: Split — two equal columns
left:
  type: ul
  color: accent1
  items:
    - "**Left region**"
    - Coloured with accent1
    - text: Nesting works here too
      items:
        - Up to five levels
right:
  type: ul
  color: accent2
  items:
    - "**Right region**"
    - Coloured with accent2
    - Bound by geometry, not index
notes: |
  Stock name: "Two Content". Regions: title, left, right.

  left and right are bound by the placeholders' x coordinates, never by
  index order — a designer may ship the right-hand pane at idx 1.
---

--- slide
id: g-05
layout: Comparison
title: Comparison — two headed columns
left_head: "Pedagogy"
left:
  type: ul
  items:
    - Teacher holds the knowledge
    - Motivation is extrinsic
    - Subject-centred
right_head: "Andragogy"
right:
  type: ul
  items:
    - Learner is self-directing
    - Motivation is intrinsic
    - Problem-centred
notes: |
  Regions: title, left_head, left, right_head, right. The heads are
  plain strings — the layout styles them.
---

--- slide
id: g-06
layout: Caption
title: Caption — content with a note beneath
content:
  type: ol
  color: accent1
  items:
    - Content well takes the substance
    - Numbered here, but any type works
    - The caption below carries the aside
caption: "**Stock name:** Content with Caption · regions: title, content, caption"
notes: |
  content and caption are told apart by area: the larger placeholder is
  the content well.
---

--- slide
id: g-07
layout: Picture
title: Picture — the one bound image region
picture:
  type: image
  src: ../sessions/assets/logger-chart.png
caption: "The only stock layout with a real PICTURE placeholder, so the image keeps its binding"
notes: |
  Images placed in any other layout are positioned at the target
  placeholder's geometry and the placeholder removed, so they carry no
  <p:ph> binding. That is the documented price of working with stock
  templates — see docs/template-profile.md.
---

--- slide
id: g-08
layout: Cards
title: Cards — four tabbed panels
head1: "Plan"
card1:
  type: ul
  items:
    - Tab is head1
    - Panel is card1
head2: "Brief"
card2:
  type: ul
  items:
    - Tabs fill accent1–4
    - In order, left to right
head3: "Teach"
card3:
  type: ul
  items:
    - Panels fill bg2
    - Styled by the layout
head4: "Debrief"
card4:
  type: ul
  items:
    - Author writes text only
    - No colour, no geometry
notes: |
  EXTENDED profile: not in stock PowerPoint templates. A template must
  define nine placeholders — title 0, tabs 1–4, panels 5–8 — and carry
  all the styling itself.

  This is the point of the contract: the rendered slide holds no fill,
  no shape and no position. Re-theme the template and every card slide
  in every deck follows, with no session edited.
---

--- slide
id: g-09
layout: TitleOnly
title: TitleOnly — a title over open space
notes: |
  Regions: title. For a slide whose body is drawn live, or a deliberate
  pause in a deck.
---

--- slide
id: g-10
layout: Blank
notes: |
  Blank declares no regions at all. Chrome — date, footer, slide number
  — still comes from the layout, at idx 10, 11 and 12, which the layout
  map never touches.
---
