# Conversation Model Binding And Creation Validation Implementation Plan

Status: implementation source of truth
Date: 2026-07-30
Design contract: [Conversation Model Binding And Creation Validation](conversation-model-binding-and-creation-validation.md)

## Module Boundaries

- Contracts: teammate binding mode and required public create fields.
- Core domain: pure built-in detection and effective provider resolver.
- Core storage: SQLite column, migration, mapping and update invariants.
- Daemon: focused conversation-provider validator and route wiring.
- Web state: provider-save callback, teammate model controller and channel create validation.
- Web view: model-source copy and required model controls.
- Tests: pure resolver/migration, daemon routes and focused Playwright.

Large owners remain composition-only. Do not append domain logic to
`use-channel-actions-controller.ts`, `channels/routes.ts`, `teammates/routes.ts` or
`TeammateWorkspace.tsx`; add focused helpers and pass derived inputs through those owners.

## Slice 1: Contracts And Storage

1. Add `AiTeammateModelBindingMode = "workspace_default" | "fixed"` to contracts and
   core workspace types.
2. Add `modelBindingMode` to `AiTeammate`, internal create/update input and public update.
3. Make public teammate and channel create provider ids required.
4. Add `model_binding_mode TEXT NOT NULL DEFAULT 'fixed'` to `ai_teammates`.
5. Migrate Ling Agent and provider-less built-in ids to `workspace_default`; preserve
   provider-bound built-ins as `fixed`.
6. Map, insert and update the field. Ling Agent protection always restores
   `workspace_default` plus a null provider.

## Slice 2: Effective Model Resolver

Add a pure core module that:

- identifies `ling_agent` and `teammate_builtin_*` as default-capable;
- rejects `workspace_default` for user-created teammates;
- resolves ordinary built-ins from the workspace default on both surfaces, while the
  protected Ling Agent resolves from the channel Ling Agent model inside a channel;
- never scans provider inventory for an arbitrary fallback.

Use the resolver in private reply creation, direct context/projection routes, channel reply
routing and channel auto-start checks. Runtime errors must distinguish missing workspace
default, missing channel default and invalid fixed bindings.

The Web channel composer does not derive or submit a provider id. Daemon channel routing
ignores request-level provider overrides for resolved teammates so API callers cannot turn
the message request into an undocumented per-channel teammate model override.

## Slice 3: Authoritative Create Validation

Add a small daemon helper around existing provider-run preflight. It receives store, cwd,
provider id and secret resolver, and verifies the provider can run conversation work.

- Channel POST requires and validates `defaultProviderPresetId` before workspace creation.
- Channel PATCH validates model changes and transitions back to `active`, while unrelated
  metadata updates remain available for channels whose existing model needs repair.
- Teammate POST requires and validates `providerPresetId`, then creates `fixed`.
- Built-in bootstrap does not call the public POST path.
- Built-in model updates may select `workspace_default`; user teammates may not.
- Fixed updates require and validate a provider id before persistence.

Route errors use stable codes such as `conversation_model_required`,
`conversation_model_not_ready` and `teammate_model_binding_invalid` while preserving the
underlying provider code in technical details/logs.

## Slice 4: First Model And Provider Lifecycle

- Extend the Web provider domain with an owner callback fired only after a non-media chat
  provider is saved and its persisted check succeeds.
- AppShell sets that provider as workspace default only when no default exists.
- Existing explicit `Use as default` behavior remains authoritative for later changes.
- Deletion keeps the current server reference inspection. Add equivalent guard behavior to
  disable/capability-loss paths if current code permits them without inspection.
- Archived channels remain non-blocking; restoration validates or repairs the provider.

## Slice 5: Web Product Surfaces

### Channel Create

- Move `Ling Agent model` into Basic information.
- Recompose Advanced settings after that move: put response language and write lock in one
  aligned editable-controls row, then render the smart-scheduling summary at full width.
  At the narrow breakpoint the controls stack to one column; no grid track may remain for
  the removed model field.
- Show only runnable chat providers as selectable targets; retain disabled historical value
  only in edit/repair surfaces, not create.
- Preselect workspace default after async provider/settings loading, then the first runnable
  chat provider only when the workspace has no default yet.
- Disable Create while model inventory loads or no valid model is selected.
- Keep advanced settings for language and runtime policy.

### Teammate Create And Settings

- Keep the existing runnable-model create gate and make the payload non-optional.
- Pass workspace default id into teammate workspace/model controller.
- Add a persistent More menu beside the private-chat title. Its Settings action opens
  Profile; the conditional model warning continues to deep-link to Model.
- Built-in model settings add `Use workspace default (current: ...)`; selecting it persists
  `workspace_default`, while selecting any concrete provider persists `fixed`.
- User-created teammates show only concrete providers and cannot save an empty selection.
- Ling Agent shows read-only effective default state.
- Private composer readiness uses the effective provider, not raw
  `teammate.providerPresetId`.

### Channel Settings

- Rename the editable provider field to `Ling Agent model` and keep its existing
  autosave and daemon validation path.
- Do not add a model Select to each member row. Derive a read-only ownership label from the
  Ling Agent identity, workspace default and each teammate's binding mode.
- Ling Agent displays the channel Ling Agent model. Following-default specialists display
  the workspace model. Fixed members display their own model and continue to be edited only
  from teammate settings.

## Data Repair

- Migration is idempotent and never overwrites a non-null built-in provider.
- Current provider-less built-ins become inherited immediately.
- Existing user-owned null/stale records remain visible as repair-required.
- Active provider-less channels may receive the runnable workspace default through a
  bounded repair step; never replace a stale non-null provider silently.
- Archived stale channels require repair when restored.

## Tests

### Core

- Migration assigns binding modes correctly and is idempotent.
- Built-in specialists use the workspace default in private chat and channels; Ling Agent
  alone uses the channel Ling Agent model in a channel.
- Fixed teammates ignore later workspace-default changes.
- User-created `workspace_default` is rejected.
- Ling Agent remains protected and inherited.

### Daemon

- Create channel/teammate without model fails before persistence.
- Missing, disabled, media-only, secret-missing, unchecked and failed-check providers fail.
- Runnable chat provider succeeds.
- Built-in private reply uses workspace default; fixed private reply does not fallback.
- Channel Ling Agent uses the channel-owned model; a following-default specialist uses the
  workspace default; a fixed teammate uses its own provider.
- A request-level provider id cannot override any of those three channel ownership rules.
- Deleting an in-use provider remains blocked; archived-channel restore requires repair.

### Web

- First successful chat-provider save assigns default once; later saves do not replace it.
- Channel create shows `Ling Agent model` in the basic section and cannot submit without it.
- Teammate create always sends a provider id.
- Built-in setting distinguishes following default from fixed selection.
- Healthy private chat still exposes the title More menu and can enter Profile and Model.
- Changing the Ling Agent model updates only Ling Agent and channel-owned routing. Changing
  the workspace default updates following-default specialists; changing a fixed teammate
  updates its label in every channel.
- Changing workspace default updates inherited copy/effective readiness but not fixed
  teammate or existing channel payloads.
- No-model new-user state has one actionable message and no horizontal/vertical overflow.

## Verification

- Contracts, core, daemon and API client typecheck/tests.
- Web lint, typecheck, unit tests, i18n and production build.
- Focused channel/model-workbench/teammate Playwright before broader conversation tests.
- Browser acceptance at 1440x960 Light and 1280x800 Dark, including no-model, inherited,
  fixed, missing and create-blocked states; inspect console and page errors.
- `git diff --check`.

## Hard Stops

- Stop if the implementation requires changing provider credentials or executing a paid
  model request beyond the existing provider check.
- Stop if fixed teammate behavior can be overwritten by workspace-default changes.
- Stop if passing tests requires restoring arbitrary runtime provider fallback.
- Do not delete or rewrite unrelated private-chat Tasks/Activity work already present in
  the dirty worktree.
