# Skill Library Height And AI Evolution Lifecycle Implementation Plan

## Frontend

- Add `SkillEvolutionViewId` and the `evolved` ownership partition.
- Keep `SkillLibrarySettingsPanel` responsible for loading and side effects only.
- Use `SkillEvolutionSection` for the Needs review, Generated, and Ignored assembly.
- Reuse `SkillLibraryRegistrySection` and `SkillLibraryTable` with an evolved mode.
- Preserve candidate identity in `useSkillImportController` after content edits.
- On candidate publish, refresh the registry, open AI evolution Generated, and select the
  newly published skill. Manual imports continue to return to My skills.
- Use one shared CSS max-height variable with `vh` and `dvh` variants. Remove fixed and
  visual minimum heights from Skill Library lists, empty states, and drawers.

## Contracts And Daemon

- Extend candidate draft creation with optional edited `content`.
- Reparse edited content while forcing AI ownership metadata.
- Mark approved candidates published after a successful draft publication.
- Record published usage links idempotently and emit the existing candidate-change event.

## Migration

- Normalize legacy candidate-linked skills to `pack_id=ling-generated`.
- Normalize source paths to `skill-candidates/<candidateId>`.
- Mark candidates as published when a linked published skill already exists.
- Backfill missing published usage events without creating duplicates.
- Do not modify teammate bindings, runtime history, source snapshots, or approvals.

## Verification

- Core store tests cover publish transition guards and idempotency.
- Migration tests cover legacy ownership repair and repeated reopen.
- Daemon API tests cover edited candidate content, preserved provenance, candidate status,
  and idempotent publication events.
- Web tests cover ownership separation, ignored history, adoption and publication, natural
  small-list height, large-list internal scrolling, and no horizontal overflow.
- Run Web typecheck, i18n audit, focused Playwright, package tests, and `git diff --check`.
