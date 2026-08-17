---
session: "03"
title: Incident response for cold chain breaks
version: 1.0.0
duration_minutes: 50
outcomes:
  - Respond correctly to a cold chain excursion
competencies:
  C1: Cold chain monitoring
  C3: Audit preparation
dc:
  creator: FAIR Consortium
  license: CC-BY-4.0
---

--- slide
id: s03-01
layout: Title
title: Incident response
subtitle:
  type: ul
  items:
    - "Session 03 · FAIR pilot"
---

--- slide
id: s03-02
layout: Split
title: Detecting an excursion
left:
  type: ul
  items:
    - Alarm thresholds
    - text: Logger review cadence
      items:
        - On receipt
        - Daily spot checks
right:
  type: ol
  items:
    - Confirm the reading
    - Quarantine affected stock
    - Escalate to responsible person
notes: |
  Detection reuses the monitoring competency from session 01.
develops: [C1]
dok: 3
---

--- slide
id: s03-03
layout: Full
title: The excursion report
full:
  type: ul
  items:
    - Time window and peak temperature
    - Products affected
    - Disposition decision and sign-off
develops: [C1, C3]
dok: 2
---

--- slide
id: s03-04
layout: Cards
title: Who does what in an excursion
head1: "Detect"
card1:
  type: ul
  items:
    - Logger alarm fires
    - "**Warehouse lead** confirms"
head2: "Contain"
card2:
  type: ul
  items:
    - Quarantine the stock
    - Label and segregate
head3: "Assess"
card3:
  type: ul
  items:
    - Pull the full trace
    - "*QA* rules on disposition"
head4: "Report"
card4:
  type: ul
  items:
    - File the excursion report
    - Notify the consignee
notes: |
  One card per role phase; the tabs are colour-coded by the template.
develops: [C1, C3]
dok: 2
---
