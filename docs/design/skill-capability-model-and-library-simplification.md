# Skill Capability Model And Library Simplification

Status: active product and domain contract
Date: 2026-07-11

## Related Docs

- [Skill Library Ownership Separation](skill-library-ownership-separation.md)
- [Skill Import Productization](skill-import-productization.md)
- [AI Teammates And Skills](ai-teammates-and-skills.md)
- [GStack Skill Source Sync](gstack-skill-source-sync.md)

## Summary

Ling treats a skill as a callable capability, not as a workflow step. A skill describes
what it can do, when it is useful, which tools and model capabilities it needs, which
approval policy applies, and which teammates may use it. Planning, implementation,
testing, release, and operations are workflow concerns and must not be persisted or
displayed as intrinsic skill stages.

The Skill Library follows the same model. Its default list is a compact capability
registry. It does not ask users to classify every skill into a stage and does not reserve
permanent space for an empty detail inspector.

## Domain Contract

### Skill Definition

`SkillDefinition` contains:

- stable id, name, and summary;
- role affinity;
- prompt fragments and trigger-bearing content;
- required tools and provider capabilities;
- approval profile and explicit state effects.

`SkillDefinition` does not contain `workflowPhase`.

Examples such as image generation, document conversion, browser research, diagramming,
and PDF creation are complete skills without a workflow stage. Ling must not replace the
removed stage with labels such as `General capability`.

### Workflow Phase

Workflow steps may still use:

```ts
type WorkflowPhase =
  | "discover"
  | "plan"
  | "design"
  | "implement"
  | "review"
  | "test"
  | "secure"
  | "ship"
  | "document"
  | "operate";
```

`SkillWorkflowPhase` remains temporarily as a deprecated alias for source compatibility,
but new code must use `WorkflowPhase` and only on real workflow objects.

## Compatibility Contract

- Legacy skill JSON may contain `workflowPhase` during the transition.
- Daemon request parsers accept extra legacy fields and ignore them.
- Registry, import, source-sync, and candidate responses omit the field.
- SQLite startup migration removes the field from skill definition, import draft, and
  candidate JSON. The migration is idempotent.
- Workflow templates, workflow steps, tasks, runs, and automations keep their genuine
  phase fields.

Compatibility must not silently convert a missing or unknown phase to `operate`. That
behavior created false product meaning and is removed.

## Recommendation And Health Contract

Skill recommendation uses capability evidence:

- id, name, and summary;
- prompt fragments and trigger text;
- role affinity;
- required tools and provider capabilities.

Recommendation reasons must not mention a stage. Duplicate similarity and conflict
analysis must not score or compare a skill phase. Source sync infers role affinity directly
from the skill id and summary; it does not infer a workflow phase. State effects are kept
only when explicitly defined by a trusted built-in or import payload, otherwise they use
the conservative empty value.

## Skill Library Contract

### My Skills

- Shows all non-built-in, non-archived entries in one list.
- Published entries are the normal state and show no status chip.
- Draft, disabled, blocked, or otherwise abnormal entries show a compact status chip.
- Toolbar contains search and sort only; there is no Current / Published / Draft summary
  or status segmented control.
- Search placeholder is `Search skills or tools`.
- Columns are `Skill / Description / Bound teammates / Updated / Actions`.
- The skill name has a compact stable width. Description uses `SkillDefinition.summary`,
  stays on one line, and exposes its full value on hover.
- Skill name is the first column. Clicking the row opens details.
- Source is audit information shown in details, not a default table column.
- Archive is a direct action. It remains recoverable and continues to use the existing
  archive route.
- Delete is a direct, confirmed, irreversible action only for manually imported
  `custom`, `skill-directory`, and `agents-md` skills. It is blocked when a skill is
  still bound to a teammate or referenced by active work.

### Built-in Skills

- Remains read-only.
- Retains All / Bound / Unbound filtering.
- Uses `Skill / Description / Bound teammates / Updated` and on-demand details.
- Never shows edit, archive, disable, copy, or source mutation actions.

### Detail Drawer

- No empty inspector is rendered by default; the list uses the full content width.
- Selecting a row opens the shared `RightDrawer` pattern.
- The drawer has a close action and closes on Escape.
- Source, requirements, approval policy, prompt fragments, bindings, optimization preview,
  and technical details remain available in the drawer.
- The drawer does not reintroduce a Stage field.

## Storage And Security Boundary

This change does not modify:

- skill execution or effective resolution;
- teammate bindings;
- approval enforcement or tool permissions;
- source snapshot content or publication semantics;
- task, run, workflow, or automation phase semantics.

Hard delete does not rewrite teammate bindings, task records, run history, or automation
definitions. It is rejected while a live binding or active reference remains. Completed
task and run records retain their selected skill id as historical audit data.

The migration may remove only the legacy skill field from the three documented JSON
locations. Any need to rewrite workflow-step JSON is a hard stop.

## Acceptance Criteria

- Newly created, imported, built-in, synced, and candidate-published skills contain no
  `workflowPhase`.
- Existing skill JSON is cleaned without changing workflow-step phases.
- Recommendation and duplicate analysis do not use phase.
- My Skills has no status summary or status filter and defaults to updated-descending.
- The default table has a compact name column, summary column, and direct actions; it
  has no Stage or Source column and no More menu.
- Only manual-import sources can be permanently deleted. Built-in, gstack, and workspace
  skills remain non-deletable.
- Details open on demand in the shared right drawer and close with Escape.
- Long lists scroll inside the list surface; the Settings page does not grow with skill
  count.

## Non-Goals

- New skill lifecycle states or enable/disable management.
- Changes to binding, execution, approvals, permissions, or source ownership.
- Full Skill Library architecture rewrite beyond the existing panel/component boundary.
- Workflow model redesign.
