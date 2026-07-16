# Skill Editing And Revision Implementation Plan

Status: active implementation plan
Date: 2026-07-16

Related contract: [Skill Editing And Revision](skill-editing-and-revision.md)

## Goal

Add one structured editor for new skills, AI candidate adoption, and revisions while
keeping file import simple and preserving skill ownership, bindings, and AI lineage.

## Slice 1: Contracts And Revision Domain

- Add `SkillEditableDefinition`, revision request/preview/publish contracts, and authority
  diff types.
- Add `POST /skills/:skillId/revision-preview` and
  `POST /skills/:skillId/revisions` to the API client and daemon route parser.
- Extract revision parsing, eligibility, normalization, warning generation, and authority
  comparison into a focused daemon module.
- Add `publishSkillRevisionDraft()` to the SQLite skill registry store. It must update only
  the target row in `skill_definitions`, preserve server-owned metadata, and enforce
  `expectedUpdatedAt` inside the transaction.
- Keep `skill_import_drafts` as the immutable revision input record. Do not add a table or
  migration.
- Dispatch from the existing large skills route without adding the implementation body to
  that file.

## Slice 2: Structured Editor

- Keep `SkillImportDialog` and `useSkillImportController` file-import only.
- Add `SkillEditorDialog`, `useSkillEditorController`, and pure editor form helpers.
- Support editor modes `create`, `candidate`, and `revision`.
- Serialize create and candidate forms through the existing import-draft publication path.
- Use the revision endpoints only for existing skills.
- Preserve hidden `roleAffinity` and `stateEffects`; do not expose them as editable fields.
- Model instruction content as an ordered list with add, remove, and reorder controls.
- Put tools, provider capabilities, and the complete approval profile under a collapsed
  advanced section.
- Add inline dirty-close confirmation, authority-change confirmation, validation errors,
  conflict recovery, and two-second success feedback.

## Slice 3: Skill Library Integration

- Add one visible Edit action to the selected editable skill's summary in the detail drawer.
- Do not add an edit icon to the table action column or top toolbar.
- Derive edit eligibility in a pure view-model helper and pass `editable/onEdit` into the
  inspector.
- Keep archive/delete behavior and AI evolution ownership unchanged.
- After save, reload the registry, keep the same skill selected, and show the updated detail.
- Add editor styles in a dedicated Settings stylesheet with a natural-height, max-80dvh
  body-scroll layout.

## Interfaces

```ts
interface SkillEditableDefinition {
  readonly name: string;
  readonly summary: string;
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly ToolName[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
  readonly approvalProfile: SkillApprovalProfile;
}

interface SkillRevisionPreviewRequest {
  readonly expectedUpdatedAt: string;
  readonly definition: SkillEditableDefinition;
}

interface SkillRevisionPublishRequest extends SkillRevisionPreviewRequest {
  readonly confirmAuthorityChanges?: boolean;
}
```

The preview response contains the merged normalized definition, product-safe warnings,
an authority diff, `requiresConfirmation`, and `canPublish`. The publish response returns
the updated `SkillRegistryEntry`.

## Error Contract

- `skill_not_editable`: source or status is read-only.
- `skill_revision_conflict`: `expectedUpdatedAt` no longer matches.
- `skill_revision_invalid`: required fields or enum values are invalid.
- `skill_revision_confirmation_required`: authority-changing content needs confirmation.

The Web client maps these codes to Chinese product copy and does not expose daemon error
sentences by default.

## Test Plan

- Core store tests cover immutable metadata, pack isolation, optimistic concurrency, and
  review-status preservation.
- Daemon tests cover eligible sources, read-only sources, preview side effects, authority
  confirmation, AI provenance, and route responses.
- API-client tests cover the two new endpoints.
- Web E2E covers create, candidate adoption, imported-skill revision, AI-skill revision,
  built-in/workspace read-only states, dirty close, validation, authority confirmation,
  conflict recovery, and file-import separation.
- Run core, daemon, API-client, Web typecheck, i18n, focused Playwright, and
  `git diff --check`.
- Verify 1440x960 and 1280x800 light mode plus 1440x960 dark mode in a real browser,
  including long instructions, expanded advanced controls, loading, failure, confirmation,
  and conflict states.

## Hard Stops

- Stop if the implementation needs to write to the original local skill file.
- Stop if AI provenance cannot be preserved exactly.
- Stop if revision publication would update skill-pack metadata or sibling definitions.
- Stop if built-in, gstack, workspace, or archived entries become editable.
- Stop if the implementation changes bindings, runtime selection, approval enforcement,
  or candidate lifecycle semantics.
