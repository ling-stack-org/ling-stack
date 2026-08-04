# Codex-Inspired Settings And Permission Presets

## Status

Design plan.

This document defines the narrow product slice for borrowing Codex-style general
settings, work-mode presentation, and permission presets without copying Codex's full
configuration language or app-server runtime.

Related docs:

- [Codex-Inspired Settings And Permission Presets Implementation Plan](codex-inspired-settings-permission-presets-implementation-plan.md)
- [Approval Policy](approval-policy.md)
- [Codex-Like Execution Experience](codex-like-execution.md)
- [Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md)
- [Runtime Control Plane Long-Term Implementation Plan](./runtime-control-plane-roadmap.md)
- [AI Teammates And Skills](ai-teammates-and-skills.md)

## Problem

Ling already has the enforcement pieces needed for safer runs:

- workspace `ApprovalPolicy` with `allow`, `ask`, and `deny` tool decisions;
- `SessionPermissionMode` values such as `ask_everything`, `balanced`,
  `workspace_write`, `full_access`, and `custom`;
- `SkillApprovalProfile` and teammate approval profiles;
- channel bound paths;
- full-access confirmation evidence;
- run request snapshots and effective policy snapshots.

The product surface is still too low-level. Settings expose tool rows such as `read`,
`grep`, `find`, `ls`, `bash`, `edit`, and `write`. Task detail exposes a raw
permission-mode select. That is accurate, but it asks users to reason like runtime
engineers before every run.

Codex's useful product lesson is different: collapse common authority choices into a few
understandable presets, then show what those presets mean before execution.

## Goals

- Add Codex-style settings cards for common permission choices.
- Keep Ling's existing `ApprovalPolicy` and `SessionPermissionMode` as the source of
  enforcement.
- Make the effective policy visible before a run starts.
- Keep work mode separate from permission mode.
- Keep full access explicitly confirmed and auditable.
- Preserve advanced policy editing for power users.

## Non-Goals

- No full Codex-style profile DSL in this slice.
- No network sandbox DSL, filesystem sandbox DSL, or claims the current runner cannot
  enforce.
- No migration to Codex app-server JSON-RPC.
- No switch from embedded `@earendil-works/pi-coding-agent` to Pi CLI as the default
  runner.
- No permission grants from skill text, teammate persona text, imported markdown, or
  workflow instructions.
- No hidden auto-approval of side effects.

## Core Decision

Borrow Codex-style permissions as product presets and previews, not as a full
configuration language.

```text
user chooses a preset
-> Ling resolves preset to existing permission mode and workspace policy
-> UI previews the effective policy
-> run request records permission mode, confirmation evidence, and snapshot
-> daemon enforces through existing approval policy and runner gates
```

The future profile DSL should wait until Ling can enforce every exposed dimension and has
tested precedence rules across all existing authority layers.

## Concepts

### Work Mode

Work mode controls how much operational detail the UI shows. It must not grant or remove
authority.

```ts
type WorkMode = "coding" | "daily";
```

| Work mode | Meaning | UI effect |
| --- | --- | --- |
| `coding` | The user wants maximum run detail. | Show dense run timelines, approval details, tool counts, policy snapshot, artifacts, and diagnostics by default. |
| `daily` | The user wants the task outcome first. | Keep summaries prominent, collapse verbose timelines, and surface approvals only when action is required. |

Work mode can be global user preference and per-thread override. It should not affect
`ApprovalPolicy`, `SessionPermissionMode`, allowed tools, runner selection, or skill
approval profiles.

### Permission Preset

Permission presets are product labels that compile to current Ling policy inputs.

```ts
type PermissionPreset =
  | "read_only"
  | "workspace_collaboration"
  | "full_access"
  | "custom";
```

| Preset | Session mode | Write scope | Risky tools | Product copy |
| --- | --- | --- | --- | --- |
| `read_only` | `ask_everything` or future read-only alias | Workspace policy paths | `bash`, `edit`, `write` ask or deny | Plan, review, and inspect without automatic workspace mutation. |
| `workspace_collaboration` | `workspace_write` | Channel bound path or workspace path | `edit` and `write` allow in scope; `bash` asks | Let Ling modify files inside this workspace while keeping commands and external actions gated. |
| `full_access` | `full_access` | `/` in the effective snapshot | Risky tools allow unless workspace policy denies | Let Ling use broad local access for this run after explicit confirmation. |
| `custom` | `custom` | Workspace `ApprovalPolicy` | Workspace `ApprovalPolicy` | Use the manually configured workspace policy. |

The preset is a UI-level and request-level convenience. The daemon still resolves and
enforces the final `EffectiveRunPolicySnapshot`.

### Effective Policy Preview

The effective policy preview is the main safety affordance. It explains what the next run
will actually be allowed to do after all layers are merged.

It should include:

- selected preset and resolved `SessionPermissionMode`;
- effective tool decisions for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`;
- allowed write paths after channel-bound-path resolution;
- operations that will ask for approval;
- operations denied by workspace policy;
- risk notes from policy downgrade or approval-profile requirements;
- whether full-access confirmation is required;
- timestamp and source of the workspace policy used for resolution.

The preview should use the same shape as `EffectiveRunPolicySnapshot` where possible.
Do not invent a separate user-facing permission model that can drift from enforcement.

## Authority Resolution

Ling should keep one precedence rule:

```text
workspace ApprovalPolicy deny
  > strict skill/workflow/teammate approval requirements
  > session PermissionPreset / SessionPermissionMode
  > workspace default ask/allow choices
```

Rules:

- A workspace `deny` must never be relaxed by a preset.
- A strict skill, workflow gate, or teammate profile can upgrade a risky tool from
  `allow` to `ask`, but it cannot override workspace `deny`.
- `workspace_collaboration` narrows writes to the channel bound path when available.
- `full_access` may widen allowed write paths to `/`, but workspace `deny` decisions still
  apply.
- `custom` delegates to the saved workspace `ApprovalPolicy`.
- External actions, deploys, credential changes, paid media calls, and GitHub mutations
  continue to use their explicit approval records and stricter action gates.

## UI Design

### Settings: General

Add a General settings group that keeps lightweight preferences separate from authority:

- default work mode: `coding` or `daily`;
- default task permission preset;
- notification preferences for run completion, failed runs, and pending approvals;
- desktop-only keep-awake setting when the desktop shell supports it.

These preferences should be user/workspace settings. They should not mutate approval
policy directly unless the user changes the default permission preset.

### Settings: Permissions

Replace the first impression of the current approval-policy page with preset cards:

```text
Permissions

[Read-only / planning]      Plan and inspect. Risky actions ask or are blocked.
[Workspace collaboration]   Edit files in the bound workspace. Commands still ask.
[Full access]               Broad local access for a confirmed run.
[Custom]                    Use the advanced workspace policy below.

Effective preview
  Write scope: /path/to/channel
  Allows: read, grep, find, ls, edit, write
  Asks: bash, external send, deploy
  Denies: none
  Notes: workspace policy denied write? ...

Advanced
  Tool decisions table
  Allowed write paths
```

The existing tool-decision table remains, but moves behind an advanced disclosure when a
preset other than `custom` is selected. If the user edits the table, the UI should switch
to `custom` or clearly say that the edit updates the workspace custom policy.

### Task Detail

Replace the raw permission-mode select with a compact preset control:

- icon and label for the preset;
- short one-line description;
- "Preview permissions" disclosure;
- full-access confirmation dialog before starting the run.

The current select can remain as an advanced fallback during the first implementation
slice, but the user-facing label should be preset-oriented.

### Run History And Thread Detail

Run details should show:

- selected preset when known;
- resolved permission mode;
- effective policy snapshot;
- full-access confirmation evidence when present;
- approval/risk notes that affected the run.

This keeps later audit independent from current settings.

## API And Data Model

### Minimal P0

P0 can avoid new daemon API by resolving policy client-side from existing inputs only for
display, while the run still resolves policy server-side. This is acceptable only if the
preview is labelled as local preview and tests prove it matches `resolveSessionRunPolicy`.

### Preferred P1

Add a daemon preview endpoint:

```http
POST /runs/policy-preview?cwd=/path/to/workspace
```

Request:

```json
{
  "channelId": "channel_...",
  "taskId": "task_...",
  "permissionMode": "workspace_write",
  "approvalProfile": { "mode": "standard", "requiredForTools": ["bash"] }
}
```

Response:

```json
{
  "preset": "workspace_collaboration",
  "mode": "workspace_write",
  "effectivePolicySnapshot": {
    "mode": "workspace_write",
    "toolDecisions": {
      "read": "allow",
      "grep": "allow",
      "find": "allow",
      "ls": "allow",
      "bash": "ask",
      "edit": "allow",
      "write": "allow"
    },
    "allowedWritePaths": ["/path/to/channel"],
    "workspacePolicyUpdatedAt": "2026-06-07T00:00:00.000Z",
    "riskNotes": []
  },
  "requiresConfirmation": false
}
```

The endpoint should call the same resolver used during run execution. It must not create a
run, approval, artifact, or state transition.

### Run Request Snapshot

Run request snapshots should eventually record both:

```ts
interface RunPermissionRequestSnapshot {
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode: SessionPermissionMode;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly effectivePolicySnapshot: EffectiveRunPolicySnapshot;
}
```

If `permissionPreset` is missing for older runs, the UI should fall back to
`permissionMode`.

## Full Access Confirmation

Full access must remain a per-run or per-session action, not a silent workspace default.

Confirmation payload:

```ts
interface PermissionConfirmation {
  readonly mode: "full_access";
  readonly confirmed: true;
  readonly confirmedAt: string;
  readonly reason: "user_confirmed_full_access";
}
```

Rules:

- The run cannot start in `full_access` without confirmation.
- The confirmation timestamp is stored in the request snapshot.
- The confirmation does not edit workspace `ApprovalPolicy`.
- Workspace `deny` decisions still win after confirmation.
- The UI must show that `full_access` may allow broad file and command access.

## Why Not Profile DSL Yet

The full DSL is deferred because its hard part is not parsing. Its hard part is
enforcement and trust.

A DSL is allowed only after:

- filesystem and network dimensions map to real runner/daemon enforcement;
- conflict resolution is tested across workspace policy, session mode, teammate profile,
  skill profile, workflow gates, channel paths, and run overrides;
- dry-run preview uses the same resolver as execution;
- migrations and audit logs exist;
- teams actually need reusable policy templates that presets cannot express.

Until then, a DSL would add complexity without improving safety.

## Implementation Slices

### Slice 1: Documentation And Product Copy

- Add this design.
- Link it from README and approval policy.
- Normalize product labels for presets and work modes.

### Slice 2: Web Preset Control

- Add permission preset cards in Settings.
- Keep advanced tool decisions behind disclosure.
- Replace or wrap the task detail permission select with preset labels.
- Keep current `SessionPermissionMode` payloads.

### Slice 3: Effective Preview

- Add a shared Web helper that formats `EffectiveRunPolicySnapshot`.
- Show preview in Settings and task detail.
- Show downgrade notes from workspace `deny` and approval-profile upgrades.

### Slice 4: Daemon Preview Endpoint

- Add `POST /runs/policy-preview`.
- Reuse `resolveSessionRunPolicy`.
- Add contract/API client bindings.
- Add e2e coverage that the preview matches the actual run snapshot.

### Slice 5: Run Snapshot And Audit Polish

- Add optional `permissionPreset` to run request snapshots.
- Show preset and confirmation evidence in Run History and Thread detail.
- Keep old runs readable by falling back to `permissionMode`.

## Test Plan

- Core resolver tests:
  - workspace `deny` survives `full_access`;
  - `workspace_write` resolves allowed write paths to channel bound path;
  - strict approval profiles upgrade risky tools to `ask`;
  - `custom` uses saved workspace policy.
- Daemon API tests:
  - policy preview returns the same snapshot that a run would store;
  - preview has no side effects;
  - full access preview marks confirmation required.
- Web tests:
  - Settings preset cards update the visible preview;
  - task run sends the selected permission mode/preset;
  - full access requires confirmation;
  - advanced custom policy remains editable;
  - run history displays the stored effective policy snapshot.
- Regression tests:
  - imported skills/personas cannot grant permissions;
  - external-work approvals remain strict action approvals;
  - older run snapshots without `permissionPreset` still render.

## Open Questions

- Should `read_only` map to existing `ask_everything`, or should Ling add a distinct
  `read_only` `SessionPermissionMode` for clearer audit?
- Should default permission preset be workspace-scoped, user-scoped, or channel-scoped?
- Should `daily` work mode be global only, or should each thread remember its last display
  mode?
- Should policy preview include future external action classes even before those actions
  are runnable in a given context?
