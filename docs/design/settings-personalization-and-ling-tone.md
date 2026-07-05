# Settings Personalization And Ling Conversation Tone

## Status

Design follow-up.

This document defines the Settings IA change that moves `Skill policy` under a new
`Personalization` section while keeping `Skill library` as its own Settings item. It
also defines the detailed design for `Ling conversation tone`, a Codex-style default
tone selector for Ling Agent conversations.

## Related Docs

- [Settings Semantic Convergence P3](settings-semantic-convergence-p3.md)
- [Settings Semantic Convergence P3 Implementation Plan](settings-semantic-convergence-p3-implementation-plan.md)
- [AI Teammates And Skills](ai-teammates-and-skills.md)
- [Ling Agent Session](ling-agent-session.md)
- [Two Layer Configuration](two-layer-configuration.md)
- [Codex-Inspired Settings And Permission Presets](codex-inspired-settings-permission-presets.md)

## Problem

Settings currently treats `Skill policy` and `Skill library` as two tabs under one
`Skills` surface. That groups two different jobs:

- `Skill policy`: how Ling behaves when recording repeatable work and creating reviewable
  candidates.
- `Skill library`: the user's reusable skill asset inventory.

`Skill policy` is behavioral preference. It belongs near personalization settings. The
library is asset management and should remain a standalone top-level Settings item.

Ling also needs a Codex-style default conversation tone. The UI should let the user choose
whether Ling replies in a friendly or pragmatic tone without editing raw system prompts,
teammate persona text, or brittle custom instructions.

## Goals

- Add a top-level Settings item named `Personalization`.
- Move `Skill policy` into `Personalization`.
- Keep `Skill library` as its own top-level Settings item.
- Add `Ling conversation tone` as a structured workspace preference.
- Make tone resolution auditable through effective config and run request snapshots.
- Apply tone as a default presentation instruction, not as user prompt text.
- Keep Ling Agent tone separate from response language, teammate persona, permissions,
  tools, skills, and model provider settings.

## Non-goals

- No freeform "tone prompt" textbox in this slice.
- No change to `SkillGovernancePolicy` behavior.
- No migration of skill definitions, source snapshots, or candidate review records.
- No override of custom AI teammate personas.
- No new permission, model, runner, or tool authority.
- No Codex app-server protocol migration.
- No prompt-template registry for all possible personalities.

## Target Settings IA

```text
Settings
  Workspace tools
    Model Workbench
    Teammate Management
    Council Workspace
    Work Board
    Default authorization

  Workspace
    Personalization
      Ling conversation tone
      Skill policy
    Interface preferences
    External work
    MCP tool servers
    Plugin Manager
    Skill library

  Maintenance
    Archived items
    Startup and diagnostics
```

This supersedes the P3 `Skills -> Skill policy / Skill library` grouping for future
implementation work. P3 remains the historical Settings semantics pass; this document is
the follow-up for behavior-bearing personalization settings.

## Product Semantics

| Surface | User job | Implementation boundary |
| --- | --- | --- |
| `Personalization` | Decide how Ling behaves by default for this workspace. | Workspace settings and effective config. |
| `Ling conversation tone` | Choose the default feel of Ling Agent replies. | Structured enum resolved into append-system instructions. |
| `Skill policy` | Control skill recording, candidate generation, and review gates. | Existing `SkillGovernanceSettingsSection`. |
| `Skill library` | Inspect and manage reusable skill definitions. | Existing `SkillLibrarySettingsPanel`, top-level only. |

## Existing Code To Reuse

- `apps/web/src/features/settings/SettingsPage.tsx` owns top-level Settings sections and
  panel routing.
- `apps/web/src/features/settings/SkillGovernanceSettingsSection.tsx` already owns
  loading, saving, and effective-config display for `SkillGovernancePolicy`.
- `apps/web/src/features/settings/SkillLibrarySettingsPanel.tsx` already owns skill
  library management.
- `packages/contracts/src/settings.ts`, `packages/core/src/workspace-types.ts`, and
  `packages/core/src/storage/sqlite/workspace-settings-store.ts` already provide the
  workspace settings pattern used by `responseLanguage`.
- `packages/daemon/src/features/settings/effective-config.ts` already resolves
  workspace/user/built-in settings sources.
- `packages/runner-pi/src/resource-loader.ts` and `packages/runner-pi/src/utils.ts`
  already support `appendSystemPrompt` and base Ling system prompts.
- `packages/daemon/src/features/conversations/routes.ts` already appends
  response-language instructions to conversation run prompts. Tone should move through a
  system-instruction path, not into the user prompt body.

## Core Decision

`Ling conversation tone` is a structured enum:

```ts
export type LingConversationTone = "friendly" | "pragmatic" | "none";
```

The default is `pragmatic`.

This mirrors the useful Codex pattern:

```text
client chooses structured personality value
-> server validates enum
-> runtime resolves instructions from the value
-> run snapshot records the effective value
```

Do not implement this as freeform prompt text. Freeform text makes precedence unclear,
creates injection risk, and overlaps with existing teammate/profile custom instructions.

## Tone Values

| Value | UI label | UI description | Runtime instruction intent |
| --- | --- | --- | --- |
| `friendly` | `Friendly` / `亲和` | Warm, collaborative, considerate. | Keep replies warm and collaborative while staying concise. |
| `pragmatic` | `Pragmatic` / `务实` | Concise, focused, direct. | Keep replies concise, direct, and action-oriented. |
| `none` | `No extra tone` / `无额外语气` | Advanced compatibility mode. | Emit no extra tone instruction. |

Recommended first UI:

- show `Friendly` and `Pragmatic` in the normal selector;
- support `none` in the API and parser;
- optionally expose `none` in an advanced dropdown later.

Reason: most users need a product choice, not an implementation escape hatch. Codex has a
`none` value because the server needs a null-personality mode; Ling can support that
without making it the primary product choice.

## Configuration Model

Add the optional field to the shared settings contracts:

```ts
export interface WorkspaceSettings {
  readonly lingConversationTone?: LingConversationTone;
}

export interface UpdateWorkspaceSettingsRequest {
  readonly lingConversationTone?: LingConversationTone | null;
}

export interface EffectiveConfigResponse {
  readonly values: {
    readonly lingConversationTone: EffectiveConfigValue<LingConversationTone>;
  };
}
```

Resolution order:

```text
workspace `.ling-stack` workspace settings
  -> user `~/.ling-stack/settings.json`
  -> built-in default `pragmatic`
```

Reset semantics:

- `PATCH /workspace-settings { "lingConversationTone": "friendly" }` stores a workspace
  override.
- `PATCH /workspace-settings { "lingConversationTone": null }` clears the workspace
  override.
- if no workspace or user value exists, `GET /effective-config` returns
  `{ value: "pragmatic", source: "built_in" }`.

Validation:

- accept only `friendly`, `pragmatic`, or `none`;
- reject empty string, arbitrary labels, and prompt text;
- parse invalid persisted values as absent and fall back through effective config;
- emit a diagnostic for invalid user-level settings.

## Runtime Scope

The first implementation should apply `Ling conversation tone` to Ling Agent surfaces:

- normal Ling Agent conversations backed by `packages/daemon/src/features/conversations`;
- channel replies where the responding teammate is the protected Ling Agent system
  teammate;
- future Ling Agent private chat surfaces that use the same run request path.

It should not apply to:

- user-created AI teammates with explicit personas;
- council member personas;
- imported skill text;
- project instructions;
- approval, permission, provider, or runner decisions.

If a later product decision wants workspace tone to affect all teammates, that should be a
separate setting, for example `teammateToneInheritance`, because it changes persona
ownership.

## Instruction Rendering

Add a small renderer, ideally near the existing response-language instruction helpers:

```ts
export function lingConversationToneInstruction(tone: LingConversationTone): string {
  if (tone === "friendly") {
    return [
      "Default conversation tone: friendly.",
      "Be warm, collaborative, and considerate while staying concise and useful.",
    ].join(" ");
  }
  if (tone === "pragmatic") {
    return [
      "Default conversation tone: pragmatic.",
      "Be concise, direct, and action-oriented. Avoid unnecessary pleasantries and over-explanation.",
    ].join(" ");
  }
  return "";
}
```

Instruction placement:

```text
base Ling system prompt
  -> Ling conversation tone instruction
  -> response-language instruction
  -> profile/project/custom append instructions
  -> user task prompt
```

The exact array ordering should preserve this precedence:

1. safety, permissions, and task boundaries win over tone;
2. explicit current-turn user style requests can override the default tone;
3. user/profile custom instructions can override the default tone;
4. response language is independent from tone;
5. `none` emits no tone instruction.

Implementation detail: when assembling `appendSystemPrompt`, put the tone instruction
before narrower user/profile append instructions so later custom instructions can refine
it.

## Conversation Run Flow

```text
User sends message
  -> daemon reads effective config
  -> resolves `lingConversationTone`
  -> renders tone instruction
  -> appends instruction to run request
  -> run snapshot records effective tone and appendSystemPrompt
  -> runner loads base system prompt plus appendSystemPrompt
  -> assistant reply follows the default tone unless narrower instructions override it
```

The user task prompt should remain the user's words plus materialized attachment context.
Do not append tone to the task prompt. Tone is a behavior default, not user content.

## Snapshot And Rerun Semantics

Run snapshots must record the effective tone used at start time:

```json
{
  "lingConversationTone": "pragmatic",
  "appendSystemPrompt": [
    "Default conversation tone: pragmatic. Be concise, direct, and action-oriented..."
  ]
}
```

Rerun behavior:

- rerun should preserve the old run's `lingConversationTone` and `appendSystemPrompt`;
- changing Settings after a run starts must not mutate in-flight behavior;
- a new conversation turn should use the latest effective config unless the client sends
  an explicit run snapshot override in the future.

This matches Ling's existing snapshot pattern and avoids confusing drift where a rerun
changes style just because Settings changed later.

## UI Design

Add `PersonalizationSettingsPanel`.

Recommended structure:

```text
Personalization

Ling conversation tone
  Select how Ling replies by default in this workspace.

  [Friendly]   Warm, collaborative, considerate.
  [Pragmatic]  Concise, focused, direct.       selected

Skill policy
  Existing SkillGovernanceSettingsSection
```

Control choices:

- use a compact segmented control or select-like row consistent with existing Settings
  rows;
- avoid a large marketing-style card layout;
- keep `Skill policy` below tone because tone is the everyday preference and policy is
  heavier governance;
- show source labels using the same language as `responseLanguage`:
  `Workspace`, `User default`, `Built-in`;
- keep the save action local to each panel or use one shared save row only if both fields
  are managed by the same controller.

`Skill library` becomes a standalone Settings section:

```text
Skill library
  Existing SkillLibrarySettingsPanel
```

The old `SkillsSettingsPanel` tab wrapper should be removed or reduced to a thin library
wrapper. It should not keep a hidden `Skill policy` tab.

## API And Storage Changes

Implementation touches:

- `packages/contracts/src/settings.ts`
- `packages/core/src/workspace-types.ts`
- `packages/core/src/storage/sqlite/workspace-settings-store.ts`
- `packages/daemon/src/features/settings/effective-config.ts`
- `packages/daemon/src/features/settings/routes.ts` only if route response docs or helper
  imports change
- `packages/api-client/src/endpoints/system.ts` only if generated/typed exports require
  updates
- `apps/web/src/types.ts` through generated or re-exported contracts
- `apps/web/src/features/settings/SettingsPage.tsx`
- new `apps/web/src/features/settings/PersonalizationSettingsPanel.tsx`
- existing `apps/web/src/features/settings/SkillGovernanceSettingsSection.tsx`
- `packages/daemon/src/features/conversations/routes.ts`
- channel Ling Agent reply path if system Ling Agent channel replies are in first scope
- `packages/runner-pi/src/types.ts` only if `lingConversationTone` is added to runner
  options rather than kept in request snapshots

No SQLite migration is required if the field is stored inside `workspace_settings.settings_json`.
The parser must tolerate older rows that do not contain the field.

## Tests

Core/storage:

- default workspace settings parse without `lingConversationTone`;
- update stores `friendly`, `pragmatic`, and `none`;
- `null` clears the workspace override;
- invalid persisted values fall back rather than crashing.

Daemon:

- `PATCH /workspace-settings` rejects invalid tone values;
- `GET /effective-config` resolves workspace > user > built-in;
- invalid user `settings.json` tone produces a diagnostic and falls back;
- conversation run request includes the effective tone instruction;
- rerun preserves the snapshot tone and append instructions.

Web:

- Settings sidebar shows `Personalization` and standalone `Skill library`;
- `Personalization` shows `Ling conversation tone` before `Skill policy`;
- changing tone saves through workspace settings and refreshes the source label;
- `Skill library` opens the existing library surface without a policy tab.

Suggested commands:

```bash
corepack pnpm --filter @ling-stack/core test -- channel-runtime-store
corepack pnpm --filter @ling-stack/daemon test -- channel-workspace
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts
```

Use narrower test-name filters during implementation if the full daemon test file is too
slow.

## Risks

- **Prompt drift:** if tone is only rendered into UI state, it will not affect actual
  replies. It must be resolved server-side and recorded in the run snapshot.
- **Persona overwrite:** applying workspace tone to every teammate would flatten custom
  teammate identities. Limit first scope to Ling Agent.
- **Precedence confusion:** tone must not override safety, project instructions, explicit
  user style requests, or profile custom instructions.
- **Duplicate language control:** tone is not response language. Keep labels and docs
  separate.
- **Settings bloat:** `SettingsPage.tsx`, `settings.css`, and `i18n.tsx` are already
  large. Add a focused panel and minimal copy keys instead of expanding the page inline.
- **False Codex equivalence:** Ling should borrow Codex's structured personality pattern,
  not Codex's full app-server config model.

## Implementation Tasks

- [x] Add `LingConversationTone` types and workspace/effective-config parsing.
- [x] Add `lingConversationToneInstruction` and server-side run request wiring for Ling
  Agent conversations.
- [x] Record effective tone in run request snapshots and preserve it during rerun.
- [x] Add `PersonalizationSettingsPanel` with tone selector and existing skill policy
  section.
- [x] Promote `Skill library` to a standalone Settings item.
- [x] Update Settings i18n labels and focused Settings tests.
- [x] Update daemon API docs after implementation lands.

## Open Questions

1. Should `none` be visible in the first UI?

   Recommendation: support it in API/storage now, but hide it from the primary UI unless
   an advanced control is already present.

2. Should workspace tone apply to non-Ling custom teammates?

   Recommendation: no for this slice. Custom teammate personas are explicit identity
   settings and should not be silently rewritten by a workspace default.

3. Should a per-thread tone override exist?

   Recommendation: defer. Start with workspace default plus current-turn explicit user
   style requests. Add per-thread override only if users need different ongoing tones in
   different work contexts.
