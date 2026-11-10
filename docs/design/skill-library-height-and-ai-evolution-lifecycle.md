# Skill Library Height And AI Evolution Lifecycle

Status: approved and implemented from the 2026-07-15 product plan.

Related follow-up: [Skill Editing And Revision](skill-editing-and-revision.md)
Related surface: [External Agent Skill Discovery And Adoption](external-agent-skill-discovery.md)

## Purpose

Keep My skills, Local skill folders, AI evolution, and Built-in skills visually consistent
while making AI-created skills a complete governed lifecycle instead of a candidate queue
that leaks published records into My skills.

## Height Contract

All four Skill Library sections use natural content height. Their list or drawer content
may grow up to:

```css
min(80dvh, calc(100dvh - 140px))
```

The `vh` equivalent is the fallback. No section receives a visual fixed height or minimum
height. Search, section navigation, filters, and summaries remain outside the list scroll
area. Empty states stay compact. The list and its detail drawer share the same maximum.

## Ownership Contract

- My skills contains user-managed skills that are not built in and not AI-evolved. Local
  skill folders is a review surface, not an ownership list: publishing an external record
  creates a user-owned `skill-directory` entry that appears in My skills.
- Local skill folders shows shared `.agents/skills` candidates and client-side ignored
  state; it never lists built-in, AI-evolved, or already adopted entries as its own.
- AI evolution owns skills whose `packId` is `ling-generated` or whose source path starts
  with `skill-candidates/`.
- Built-in skills contains built-in and managed gstack skills and remains read-only.
- AI-evolved skills continue to use the standard skill runtime, teammate bindings,
  permissions, approval checks, archive behavior, and guarded hard delete behavior.

## AI Evolution Views

- Needs review contains actionable skill candidates, reviewable repeated approaches, and
  draft channel flows.
- Generated contains published AI skills and enabled channel flows.
- Ignored contains rejected, cancelled, expired, superseded, quarantined, blocked, or
  routed-away records. It is read-only in v1.
- Repeated approaches that are still collecting examples do not appear in Needs review.

## Adoption And Publication

`Adopt and edit` performs candidate approval when required, creates a candidate-owned
import draft, and opens the existing skill editor. It never publishes immediately.

Candidate drafts and edited content must preserve:

- `packId=ling-generated`
- `source=custom`
- `sourcePath=skill-candidates/<candidateId>`

Publishing creates normal registry skills, records the candidate-to-skill published event,
and moves the candidate from `approved_for_draft` to `published`. Repeated publication is
idempotent. Legacy published skills with broken ownership are repaired by migration.

Published AI skills may be revised through the shared structured skill editor. Revisions
must preserve `packId=ling-generated`, the candidate source path, candidate published
status, and the AI evolution management location.

## Product Language

The default interface uses Needs review, Generated, Ignored, Repeated approaches, Channel
flows, Adopt and edit, Ignore, View basis, and Reference records. Raw IDs, route blockers,
and internal state remain inside collapsed technical details.

## Non-Goals

- No separate AI skill runtime or new business table.
- No change to binding, execution selection, approval, permission, or source-sync semantics.
- No restore action for Ignored in v1.
- No direct one-click publication without the editor confirmation step.
