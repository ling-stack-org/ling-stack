# Skill Library Ownership Separation

> Superseded in part by [Skill Capability Model And Library Simplification](skill-capability-model-and-library-simplification.md). The ownership split remains active; the old stage columns, user status summary/filters, permanent inspector, and table column contract are replaced.

## Related Docs

- [Ling Skill Import V1](ling-skill-import-v1.md)
- [GStack Skill Source Sync](gstack-skill-source-sync.md)
- [Settings Diagnostic Density P8](settings-diagnostic-density-p8.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)

## Summary

The Skill Library currently mixes Ling-bundled definitions, user-created drafts,
imported directories, workspace skills, and synced gstack skills in one registry list.
The existing `Built-in / Custom` filter exposes implementation provenance, but it does
not answer the user's primary question: which skills are mine to manage, and which are
provided by Ling?

The product surface is separated into two ownership views plus one governed evolution
view:

- **My skills** is the default view and contains user-managed registry entries.
- **AI evolution** contains reusable skills and patterns discovered by Ling that still
  require explicit user review before they can affect the registry.
- **Built-in skills** is a separate read-only view for Ling-provided definitions.

Official source updates and health-diagnostic workflows are not part of the Skill Library
navigation. AI evolution remains visible because it is the user approval boundary for
generated skill candidates, observed reusable procedures, and playbook proposals.

## Ownership Contract

Ownership is derived from the existing registry entry and is not persisted separately.

```ts
type SkillOwnership = "user" | "builtin";

function skillOwnership(entry: SkillRegistryEntry): SkillOwnership {
  return entry.source === "builtin" || entry.source === "gstack" || entry.reviewStatus === "builtin"
    ? "builtin"
    : "user";
}
```

The defensive `reviewStatus === "builtin"` check prevents a malformed or legacy entry
from appearing as user-managed when its lifecycle is still built-in.

User-owned sources include:

- `custom`
- `workspace`
- `skill-directory`
- `agents-md`

`gstack` is a Ling-managed built-in source. Source sync may attach or update source
snapshots, but it never makes a gstack skill user-owned.

Legacy workspaces may contain a published `gstack` registry entry from the old source
sync prototype (`id=gstack`, `packId=gstack-source-sync`). That entry represented the
source umbrella, not a distinct end-user skill. It must not appear in either ownership
list. The actual gstack capabilities remain the individual built-in skills.

## Information Architecture

The Skill Library sub-navigation is:

1. **My skills**
2. **AI evolution**
3. **Built-in skills**

Entering or reloading the Skill Library always opens **My skills**. The selected
subsection is not stored in localStorage.

### My Skills

My skills is the management surface for all non-built-in entries.

- Default filter: `Current`.
- Current includes the published and draft entries returned by the existing `/skills`
  endpoint.
- Status filters: `Current / Published / Draft`.
- Default sort: updated descending, with name as the stable tie-breaker.
- Available actions: import, create draft, inspect, preview optimization, archive eligible
  entries, and manage source snapshots where already supported.
- Table columns: status, skill, source, stage, bound teammates, actions.

### Built-in Skills

Built-in skills is a read-only management surface.

- Filters: `All / Bound / Unbound`.
- Default sort: name ascending.
- Available actions: search, inspect, preview optimization, and view binding/source facts.
- Forbidden actions: edit, archive, disable, copy, archive source snapshots, or roll back
  source snapshots.
- Table columns: skill, stage, bound teammates, source status, details.

Built-in source mutations are not exposed from the Skill Library.

The current Ling built-in skills come from `gstack-default`, but the default list does
not add a separate pack banner above the registry. Pack and source identity remain
available in skill details for audit. The archived legacy `gstack-source-sync` umbrella
record is not an end-user skill and stays hidden.

### AI Evolution

AI evolution is a governed review surface, not an automatically active skill list.

- It displays open skill candidates, reusable procedure clusters, and playbook proposals
  produced by the existing observation pipeline.
- Creating a draft, approving, rejecting, or routing an item continues to use the existing
  review APIs and safety gates.
- An item appears in My skills only after the existing review and publish flow creates a
  registry entry.
- Skill health diagnostics and official source-update controls are not rendered in this
  view.

## Interaction Rules

- Search is scoped to the active ownership view.
- Default search covers skill name, description, required tools, and provider
  capabilities. Hidden provenance such as pack id, source paths, upstream paths, and
  checksums must not make every skill match a source name such as `gstack`.
- Switching ownership views clears a selection that is not present in the target view.
- The inspector must never continue showing a skill from the previous ownership view.
- Import and new-draft actions appear only in My skills.
- Archiving a user skill removes it from the current registry list; archived and disabled
  records are not returned by the existing `/skills` endpoint.
- Empty My skills offers Import skill and New draft actions.
- Empty Built-in skills offers only Refresh.
- Long lists scroll inside the registry body; the Settings page must not grow with the
  number of skills.

## Runtime And Security Boundary

This change reorganizes presentation only. It must not change:

- effective skill resolution;
- teammate skill bindings;
- task or run skill selection;
- approval profiles or tool permissions;
- source-sync publish semantics;
- registry storage or daemon routes.

Imported or synced skill content still cannot grant tools, credentials, provider access,
approval bypasses, or external-send authority.

## Acceptance Criteria

- Skill Library opens on My skills.
- No built-in entry appears in My skills.
- Every user-managed non-built-in source appears in My skills.
- Archived and disabled user skills are not presented as dead filters because the current
  registry endpoint does not return them.
- Built-in skills has no archive, disable, edit, copy, source archive, or rollback action.
- Skill Library exposes My skills, AI evolution, and Built-in skills.
- AI evolution restores the governed candidate-review flow without restoring official
  skill updates or skill health diagnostics.
- Built-in skills contains the 55 bundled `gstack-default` entries without a redundant
  pack banner; source identity remains in details.
- `source=gstack` entries never appear in My skills.
- The legacy single `gstack` source umbrella does not appear in either list.
- Registry list and inspector follow the natural-height and viewport maximum defined by
  `skill-library-height-and-ai-evolution-lifecycle.md`.
- Desktop layouts at 1440x960 and 1280x800 have no horizontal page overflow.

## Non-Goals

- Per-workspace enable/disable overrides for built-in skills.
- Cloning built-in skills into user-owned skills.
- New marketplace, package manager, or remote discovery behavior.
- Runtime semantics outside the candidate publication lifecycle.
- Settings navigation changes outside the Skill Library page.

## Assumptions

- gstack is a Ling-managed built-in source, not a user-owned import source.
- Built-in management is intentionally read-only.
- Desktop Web is the acceptance target for this pass.

## Follow-Up Contract

The AI evolution ownership, publication lifecycle, migration, and shared height behavior
are superseded by `skill-library-height-and-ai-evolution-lifecycle.md`. This document
continues to own the My skills and Built-in skills separation rules.
