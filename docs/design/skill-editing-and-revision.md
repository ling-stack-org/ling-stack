# Skill Editing And Revision

Status: active product and domain contract
Date: 2026-07-16

## Related Docs

- [Skill Capability Model And Library Simplification](skill-capability-model-and-library-simplification.md)
- [Skill Import Productization](skill-import-productization.md)
- [Skill Library Height And AI Evolution Lifecycle](skill-library-height-and-ai-evolution-lifecycle.md)
- [Skill Library Ownership Separation](skill-library-ownership-separation.md)

## Summary

Ling supports structured editing for manually created or imported skills and for skills
published through AI evolution. Editing changes the normalized skill definition stored in
Ling. It does not reopen, overwrite, or synchronize the original local file.

Built-in, managed gstack, workspace-owned, and archived skills remain read-only. Skill
identity, ownership, source provenance, teammate bindings, candidate lineage, and review
status are server-controlled and cannot be changed by the editor.

## Editable Skills

A skill is editable when it is not archived and either:

- its source is `custom`, `skill-directory`, or `agents-md`; or
- it is AI-evolved, identified by `packId=ling-generated` or a source path beginning with
  `skill-candidates/`.

`builtin`, `gstack`, and `workspace` entries are not editable. AI-evolved skills remain in
AI evolution after every revision and never move into My skills.

## Editor Contract

New skills, AI candidate adoption, and revisions use one structured editor. The primary
fields are:

- skill name;
- skill summary;
- ordered instruction blocks.

Advanced configuration is collapsed by default and contains:

- required tools;
- required provider capabilities;
- approval mode, optional risk, tool gates, and action gates.

The editor never exposes raw JSON, candidate ids, pack ids, source paths, checksums, or
registry terminology. Skill id, role affinity, state effects, visibility, source metadata,
bindings, and candidate lineage are preserved from the current record.

## Save And Validation Contract

The primary action is **Save changes**. Users do not perform a separate check step.

On save, Ling runs a side-effect-free preview using the same server validation as final
publication. Content-only changes publish immediately when valid. Changes to required
tools, provider capabilities, or approval profile display a compact authority-change
summary and require an explicit **Confirm and save** action.

Blocking validation remains next to the affected field or in one compact error summary.
Non-blocking content warnings stay collapsed under **Things to review**. Raw warning codes
and parser messages are not default product copy.

Saving creates an immutable internal import draft and publishes it as a revision of the
existing registry entry. Revision publication updates only the target skill definition and
timestamp. It does not rewrite skill-pack metadata or create a new skill id.

## Concurrency And Recovery

Every revision request includes the skill's `updatedAt` value as `expectedUpdatedAt`.
If another change wins first, Ling returns a revision conflict and keeps the user's form
content. The user may reload the latest skill or continue reviewing the local input; Ling
must never overwrite the newer definition silently.

Closing an unchanged editor exits immediately. Closing a dirty editor shows an inline
discard state inside the same dialog with **Continue editing** and **Discard changes**.
It must not open a second modal.

## Visual Contract

- The only edit entry is a visible action in the selected skill's detail summary.
- The table action column remains reserved for archive and delete.
- The editor is a compact desktop dialog, approximately 860px wide.
- It has natural height with `max-height: min(80dvh, calc(100dvh - 120px))`.
- Header and footer remain visible; only the body scrolls when content exceeds the limit.
- Basic fields appear first. Advanced configuration is progressive disclosure, not a
  permanent diagnostics wall.
- AI skills show a quiet **AI generated** ownership marker without technical identifiers.
- Success feedback disappears after two seconds. Validation and save failures remain until
  resolved.

## Storage And Security Boundary

- Editing never writes to the browser-selected local file.
- The daemon derives `id`, `packId`, `source`, `sourcePath`, `visibility`, and review status
  from the stored skill.
- AI revisions preserve `packId=ling-generated` and
  `sourcePath=skill-candidates/<candidateId>`.
- Preview performs no durable writes.
- Publication must use a revision draft and optimistic concurrency.
- Existing bindings continue to reference the same skill id.
- Candidate status and published linkage remain unchanged after an AI skill revision.

## Non-Goals

- User-visible version history or rollback.
- Editing built-in, gstack, workspace-owned, or archived skills.
- Updating the original imported file or source directory.
- Changing skill ids, ownership, visibility, role affinity, or state effects.
- Changing skill execution, binding, approval enforcement, or candidate lifecycle semantics.

## Acceptance Criteria

- My skills and AI evolution generated skills expose the same structured editor.
- Built-in and workspace-owned entries have no edit action.
- File import remains choose-file-and-import and does not regain a content editor.
- Content changes save through automatic validation.
- Authority changes require explicit confirmation.
- AI revisions remain in AI evolution and retain candidate provenance.
- Stale revisions do not overwrite newer data.
- The dialog has one internal scroll region and no horizontal overflow at supported desktop
  viewports.
