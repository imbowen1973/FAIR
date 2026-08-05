---
session: "01"
title: Cold chain fundamentals
version: 1.0.0
duration_minutes: 45
outcomes:
  - Explain cold chain integrity requirements
  - Describe temperature monitoring approaches
dc:
  creator: FAIR Consortium
  license: CC-BY-4.0
---

--- slide
id: s01-01
layout: Title
title: Cold chain fundamentals
subtitle:
  type: ul
  items:
    - "Session 01 · FAIR pilot"
---

--- slide
id: s01-02
layout: Section
title: Why cold chains fail
---

--- slide
id: s01-03
layout: Split
title: Cold chain integrity
left:
  type: ul
  items:
    - Temperature logging
    - text: Break detection
      items:
        - Sensor thresholds
        - Manual inspection
    - Audit trail
right:
  type: ol
  items:
    - Receive shipment
    - Verify logger data
    - Sign off or quarantine
notes: |
  Walk through the three integrity pillars, then the receiving workflow.
develops: [C1, C4]
dok: 2
---

--- slide
id: s01-04
layout: Full
title: Monitoring in practice
full:
  type: image
  src: assets/logger-chart.png
develops: [C1]
dok: 1
---
