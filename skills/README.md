# FAIR-Ed skills

Claude skills that author FAIR-Ed content with an educator — asking
first, agreeing the outcomes, then writing in the exact formats the
workbench imports.

| Skill | Produces | Paste into |
|---|---|---|
| `fair-ed-module/` | the whole module — level, programme, competencies, groupings, sessions, outcomes, funding — as one block of Markdown (`docs/module-md-format.md`) | workbench → **Module → Import** |
| `fair-ed-session/` | one session's deck, lesson plan and questions (`docs/session-md-format.md`, `docs/questions-format.md`) | the session's **Import**, **Lesson plan** and 🔒 **Questions** tabs |

They chain: the module skill hands each session's `--- session` block on
to the session skill, which keeps its outcome ids.

## Installing in Claude

Zip each skill's folder (the folder itself, with `SKILL.md` inside) and
upload it in Claude under **Settings → Capabilities → Skills**. Claude
then uses it whenever a conversation is about designing a module or
writing a session.

```bash
cd skills && for s in fair-ed-module fair-ed-session; do zip -r "$s.zip" "$s"; done
```

## Keeping them true

The formats are defined by the importers, not by these files. When a
format changes, change its doc and its skill together; the workbench's
tests hold the module format's documented example
(`workbench/tests/fixtures/module-example.md`) to the importer.
