# Codex-Inspired Settings And Permission Presets Implementation Plan

## Status

Design plan.

This implementation plan breaks down
[Codex-Inspired Settings And Permission Presets](codex-inspired-settings-permission-presets.md)
into shippable slices. It should not expand into a general permission rewrite.

## Current Baseline

Code already has the core enforcement model:

- `SessionPermissionMode` supports `ask_everything`, `balanced`, `workspace_write`,
  `full_access`, and `custom`.
- `resolveSessionRunPolicy` merges workspace `ApprovalPolicy`, session permission mode,
  channel bound path, and approval profile into an `EffectiveRunPolicySnapshot`.
- Workspace approval policy persists tool decisions and allowed write paths.
- Task runs already submit `permissionMode`.
- Full access already requires confirmation before a task run starts.
- Run history can display permission mode and effective policy snapshots.
- Settings exposes the raw approval policy table.

The missing product layer is preset selection and effective-policy preview.

## Implementation Principles

- Keep `ApprovalPolicy` and `SessionPermissionMode` as the enforcement source.
- Treat `PermissionPreset` as UI/request metadata that compiles into existing policy
  inputs.
- Use one resolver for previews and actual run execution.
- Preserve workspace `deny` as the highest-priority decision.
- Keep work mode separate from permission mode.
- Keep `custom` as the escape hatch for advanced users.
- Do not add a profile DSL in this plan.

## Target Types

Add shared product-facing types in the contracts layer.

```ts
type WorkMode = "coding" | "daily";

type PermissionPreset =
  | "read_only"
  | "workspace_collaboration"
  | "full_access"
  | "custom";

interface PermissionPresetDefinition {
  readonly preset: PermissionPreset;
  readonly label: string;
  readonly description: string;
  readonly permissionMode: SessionPermissionMode;
  readonly requiresConfirmation: boolean;
}
```

Initial mapping:

| Preset | `permissionMode` | Requires confirmation | Notes |
| --- | --- | --- | --- |
| `read_only` | `ask_everything` | no | This is a product label first. It can become a distinct session mode later if audit clarity requires it. |
| `workspace_collaboration` | `workspace_write` | no | Uses channel bound path when available. |
| `full_access` | `full_access` | yes | Keeps current confirmation flow. |
| `custom` | `custom` | no | Delegates to saved workspace policy. |

Do not add a new `read_only` `SessionPermissionMode` in the first slice. The existing
`ask_everything` mode already prevents automatic risky side effects. If the UI copy or
audit trail becomes confusing, add `read_only` later as a small resolver extension.

## Slice 0: Documentation Wiring

Status: in progress.

Changes:

- Add the parent design.
- Add this implementation plan.
- Link both from `README.md`.
- Link implementation plan from the parent design.

Verification:

- Markdown files have no trailing whitespace.
- Linked docs exist.

## Slice 1: Shared Preset Mapping

Goal: create one shared mapping so Web, API client, and tests do not duplicate labels or
mode conversion.

Files:

- `packages/contracts/src/index.ts`
- `apps/web/src/lib/session-permissions.ts`
- `packages/core/src/session-permissions.ts`

Work:

- Export `PermissionPreset` and `WorkMode` from contracts.
- Add a pure helper:

  ```ts
  function permissionModeForPreset(preset: PermissionPreset): SessionPermissionMode;
  ```

- Add a pure reverse helper for old snapshots:

  ```ts
  function inferPermissionPreset(mode: SessionPermissionMode): PermissionPreset;
  ```

- Keep labels in Web/i18n, not core.

Tests:

- Preset-to-mode mapping is stable.
- Reverse helper maps old snapshots as expected.
- `full_access` maps to confirmation-required UI state.

## Slice 2: Settings Permission Cards

Goal: make Settings understandable without removing advanced policy controls.

Files:

- `apps/web/src/features/settings/SettingsPage.tsx`
- `apps/web/src/styles/settings.css`
- `apps/web/src/lib/session-permissions.ts`
- `apps/web/e2e/settings.spec.ts`

Work:

- Add a "Permissions" preset card group above the existing tool-decision grid.
- Show four cards: Read-only / planning, Workspace collaboration, Full access, Custom.
- Move the tool-decision grid and allowed write paths into an advanced section.
- Selecting `custom` shows the advanced policy controls as the primary editing path.
- Editing any advanced policy field switches the displayed preset to `custom`, or shows
  a clear "custom policy" state.
- Do not persist a workspace default preset yet unless the implementation also adds a
  settings storage field. The first slice can treat the selection as preview/UI state.

Verification:

- Settings still loads existing approval policy.
- Saving custom policy still sends the same `PATCH /approval-policy` payload.
- Existing approval policy e2e coverage still passes.
- New e2e coverage checks that card selection updates the visible preview.

## Slice 3: Task Detail Preset Control

Goal: replace the raw permission-mode selector with preset-oriented task controls while
keeping the existing run payload.

Files:

- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/src/lib/session-permissions.ts`
- `apps/web/src/styles/workspace.css`
- `apps/web/e2e/workspace.spec.ts`

Work:

- Replace or wrap the `Permission mode` select with a compact preset segmented control.
- Preserve the existing `onPermissionModeChange` callback in the first implementation.
- Convert selected preset to `permissionMode` before run submission.
- Keep the full-access confirmation dialog unchanged.
- Add a "Preview permissions" disclosure under the control.
- For older code paths that still pass `permissionMode`, infer the selected preset.

Verification:

- Existing test "workspace task run sends the selected session permission mode" still
  passes or is updated to select the new preset UI.
- Existing full-access confirmation test still passes.
- Selecting Workspace collaboration sends `permissionMode = "workspace_write"`.
- Selecting Full access opens confirmation before run creation.

## Slice 4: Local Effective Preview

Goal: show policy preview before adding a daemon endpoint.

Files:

- `apps/web/src/lib/session-permissions.ts`
- `apps/web/src/features/settings/SettingsPage.tsx`
- `apps/web/src/features/workspace/WorkspaceClientView.tsx`
- `apps/web/e2e/settings.spec.ts`
- `apps/web/e2e/workspace.spec.ts`

Work:

- Add a Web formatter for `EffectiveRunPolicySnapshot`.
- Reuse existing run snapshots when available.
- For pre-run UI, compute a local preview only from known frontend state:
  - workspace approval policy;
  - selected preset / permission mode;
  - selected channel bound path.
- Label it as preview if it is locally computed.
- Do not use local preview as authority. Actual run execution remains daemon-owned.

Verification:

- Preview lists allowed write paths.
- Preview lists allow/ask/deny tool groups.
- Workspace `deny` is shown as a downgrade note when the selected preset asks for more.
- No run, approval, artifact, or state transition is created by preview interactions.

## Slice 5: Daemon Policy Preview Endpoint

Goal: make preview authoritative by using the same resolver as run execution.

Route:

```http
POST /runs/policy-preview?cwd=/path/to/workspace
```

Request:

```ts
interface RunPolicyPreviewRequest {
  readonly channelId?: string;
  readonly taskId?: string;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly approvalProfile?: SkillApprovalProfile;
}
```

Response:

```ts
interface RunPolicyPreviewResponse {
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode: SessionPermissionMode;
  readonly effectivePolicySnapshot: EffectiveRunPolicySnapshot;
  readonly requiresConfirmation: boolean;
}
```

Files:

- `packages/contracts/src/index.ts`
- `packages/api-client/src/client.ts`
- `packages/daemon/src/features/runs/routes.ts`
- `packages/daemon/src/server/router.ts`
- `apps/web/src/api/runs.ts`
- `apps/web/src/api.ts`
- `apps/web/e2e/api-adapters.spec.ts`
- `packages/daemon/test/approval-policy-run.test.mjs`

Work:

- Add request/response contracts.
- Route request to the workspace store and channel/task lookup.
- Resolve `permissionPreset` to `permissionMode` if provided.
- Use `resolveSessionRunPolicy` for the returned snapshot.
- Return `requiresConfirmation = true` for `full_access`.
- Do not create or mutate any run-related records.

Verification:

- Endpoint returns the same effective snapshot that a later run request stores.
- Endpoint returns 400 for unsupported modes or malformed approval profiles.
- Endpoint has no side effects in store counts.
- Full access preview marks confirmation required.

## Slice 6: Run Snapshot And Audit Polish

Goal: make run history explain the user's original choice, not only the resolved mode.

Files:

- `packages/contracts/src/index.ts`
- `packages/daemon/src/features/runs/schemas.ts`
- `packages/daemon/src/features/tasks/schemas.ts`
- `packages/core/src/storage/sqlite-run-store.ts`
- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/features/runs/ThreadPage.tsx`
- `apps/web/e2e/runtime.spec.ts`

Work:

- Add optional `permissionPreset` to run request snapshots.
- Preserve `permissionMode` as required for enforcement and old clients.
- Render preset label when present.
- Fall back to `permissionMode` for older runs.
- Show full-access confirmation evidence when present.
- Keep effective policy snapshot visible in detail panels.

Verification:

- Old run snapshots without `permissionPreset` still render.
- New task runs store both preset and mode when preset is supplied.
- Run history shows preset, mode, write scope, ask count, deny count, and risk notes.

## Slice 7: General Work Mode

Goal: borrow Codex-style detail level without mixing it with permissions.

Files:

- `apps/web/src/features/settings/SettingsPage.tsx`
- `apps/web/src/features/runs/RunTimeline.tsx`
- `apps/web/src/features/runs/RunHistory.tsx`
- `apps/web/src/shared/conversation/*`
- local-storage/settings domain files as needed.

Work:

- Add `WorkMode` control in Settings General.
- Default to `coding` for now.
- In `daily`, collapse dense run timeline details by default but keep approval prompts
  fully visible.
- Do not change run requests, permission modes, approval profiles, or policy resolution.

Verification:

- Switching work mode changes presentation density only.
- Approval prompts remain visible in both modes.
- No run request payload changes when work mode changes.

## Deferral: Full Profile DSL

Do not begin DSL work in these slices.

Revisit only after:

- daemon/runner can enforce filesystem and network dimensions directly;
- preview and execution share one resolver;
- conflict precedence has tests across workspace policy, session mode, teammate profile,
  skill profile, workflow gates, channel path, and run override;
- import/export/migration/audit requirements are written;
- users need reusable policy templates that presets cannot express.

## Rollout Order

Recommended order:

1. Slice 1: shared preset mapping.
2. Slice 3: task detail preset control.
3. Slice 4: local effective preview.
4. Slice 2: Settings permission cards.
5. Slice 5: daemon policy preview endpoint.
6. Slice 6: run snapshot and audit polish.
7. Slice 7: general work mode.

This order improves the main run-start path before reshaping the settings page. It also
avoids blocking the first UI improvement on a new daemon endpoint.

## Acceptance Criteria

The feature is complete when:

- users can pick a permission preset before a task run;
- the run still enforces current Ling approval policy;
- full access still requires confirmation;
- users can preview effective tool decisions and write scope before running;
- settings expose presets first and advanced tool decisions second;
- run history records or infers the preset and shows the effective policy snapshot;
- no skill, teammate, workflow, or imported text can grant authority by itself;
- no profile DSL exists in this feature.
