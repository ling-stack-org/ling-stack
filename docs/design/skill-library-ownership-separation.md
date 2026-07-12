# Skill Library Ownership Separation

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

The product surface is separated into two ownership views:

- **My skills** is the default view and contains every non-built-in registry entry.
- **Built-in skills** is a separate read-only view for Ling-provided definitions.

Review and source-sync workflows remain independent because they represent lifecycle
work, not ownership.

## Ownership Contract

Ownership is derived from the existing registry entry and is not persisted separately.

```ts
type SkillOwnership = "user" | "builtin";

function skillOwnership(entry: SkillRegistryEntry): SkillOwnership {
  return entry.source === "builtin" || entry.reviewStatus === "builtin"
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
- `gstack`

Source sync may attach or update source snapshots, but it never changes ownership.

## Information Architecture

The Skill Library sub-navigation is:

1. **My skills**
2. **Built-in skills**
3. **Review queue**
4. **Source sync**

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

Built-in source mutations remain reachable only through **Source sync**, which preserves
the existing reviewed publish workflow.

## Interaction Rules

- Search is scoped to the active ownership view.
- Switching ownership views clears a selection that is not present in the target view.
- The inspector must never continue showing a skill from the previous ownership view.
- Import and new-draft actions appear only in My skills.
- Refresh remains available in every subsection.
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
- Every non-built-in source appears in My skills.
- Archived and disabled user skills are not presented as dead filters because the current
  registry endpoint does not return them.
- Built-in skills has no archive, disable, edit, copy, source archive, or rollback action.
- Review queue and Source sync remain reachable and behaviorally unchanged.
- Registry list and inspector stay within the existing fixed-height internal scroll area.
- Desktop layouts at 1440x960 and 1280x800 have no horizontal page overflow.

## Non-Goals

- Per-workspace enable/disable overrides for built-in skills.
- Cloning built-in skills into user-owned skills.
- New marketplace, package manager, or remote discovery behavior.
- API, contract, schema, or runtime changes.
- Settings navigation changes outside the Skill Library page.

## Assumptions

- All non-built-in sources are user-owned for product presentation, including gstack
  source-sync imports.
- Built-in management is intentionally read-only.
- Desktop Web is the acceptance target for this pass.
