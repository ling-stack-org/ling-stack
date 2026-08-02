# Conversation Model Binding And Creation Validation

Status: active design contract
Date: 2026-07-30
Scope: workspace default chat model, built-in teammates, user-created teammates,
channel creation, private chat, provider lifecycle

## Summary

Ling must distinguish an explicit default-model binding from a fixed model binding.
An empty provider id is not a product state and runtime code must not silently choose the
first enabled provider.

The product has two durable teammate binding modes:

- `workspace_default`: a built-in specialist follows the workspace default model in both
  private chat and channels. Ling Agent is the protected exception: it follows the
  workspace default in private chat and the channel's `Ling Agent model` in a channel.
- `fixed`: the teammate owns a concrete provider preset id until the user changes it.

Ling Agent always uses `workspace_default`. Other built-in teammates start in
`workspace_default` and may be changed to `fixed`. User-created teammates are always
created as `fixed` and require a runnable chat model.

## Product Rules

### First Chat Model

- A new workspace may have no chat provider and still show the built-in teammate roster.
- Built-in teammates remain visible but cannot send until an effective default exists.
- When the first chat provider is saved and its real provider check succeeds, Ling sets it
  as the workspace default only when no workspace default already exists.
- Saving later providers never changes the workspace default automatically.
- Changing the workspace default updates only teammates in `workspace_default` mode.
  It never rewrites fixed teammates or existing channel model ids.

### Teammate Ownership

| Teammate | Initial binding | Private chat | Channel |
|---|---|---|---|
| Ling Agent | `workspace_default` | workspace default | channel Ling Agent model |
| Built-in specialist | `workspace_default` | workspace default | workspace default |
| Built-in specialist with user override | `fixed` | fixed provider | fixed provider |
| User-created teammate | `fixed` | fixed provider | fixed provider |

The model settings control must expose the mode explicitly. The first option is
`Use workspace default (current: <model>)`; concrete provider options below it always mean
`fixed`, even when the selected id currently equals the workspace default id.

Ling Agent remains protected and read-only in teammate settings. Its effective provider is
shown as `Workspace default` in private chat or `Ling Agent model` in a channel, not as
`Automatic` or an empty model.

### Channel Ownership

- A newly created channel requires a concrete runnable `Ling Agent model` because Ling
  Agent and channel-owned routing must remain runnable even before another teammate acts.
- The workspace default is preselected, but creation stores a channel-specific Ling Agent
  provider id. Existing channels are not rewritten when the workspace default changes.
- Channel Settings may change the Ling Agent model directly.
- The historical API/storage field remains `defaultProviderPresetId` for compatibility;
  user-facing surfaces must not call it a channel default or coordination model.
- Channel member rows show `Ling Agent model`, `Workspace default`, or `Fixed model`.
- Channel Settings must not mutate an individual teammate model. Fixed teammate models are
  changed only in that teammate's settings and then take effect in private chat and every
  channel where the teammate participates.
- Model selection belongs in the basic create flow, not in a collapsed advanced section.
- Channel Create advanced settings use a deliberate two-level layout after the model moves
  to Basic information: response language and write lock align as the two editable fields
  in the first desktop row, while the read-only smart-scheduling explanation spans the row
  below. Narrow layouts stack these items without preserving an empty model column.
- With no runnable model, channel creation is blocked and the only recovery action opens
  Model Workbench.

### Effective Resolution

Resolution is deterministic:

```text
private user teammate    -> fixed teammate provider
private built-in         -> fixed override OR workspace default
channel user teammate    -> fixed teammate provider
channel built-in         -> fixed override OR workspace default
channel Ling Agent       -> channel Ling Agent model
```

An explicit request provider may be used only by an existing private-chat product flow
that already owns such an override. Channel messages never use a request model as a
per-message teammate override: daemon resolution remains authoritative for Ling Agent,
workspace-default and fixed bindings. Missing configuration never falls through to an
arbitrary enabled provider.

## Validation Contract

Public create requests must pass daemon validation at submit time. A valid conversation
provider:

- exists;
- is enabled;
- is not a generation-only `media-job` provider;
- declares `chat` capability;
- has all required secrets available;
- has a successful stored provider check.

Web validation is usability feedback only. Daemon validation is authoritative and must
catch deletion, disablement or capability changes that happen after the dialog opened.

Channel updates revalidate the provider when the selected model changes or a paused or
archived channel becomes active. A stale or temporarily unavailable model does not block
unrelated maintenance such as renaming, pausing or archiving the channel.

Public contracts require:

- `CreateAiTeammateRequest.providerPresetId: string`;
- `CreateChannelRequest.defaultProviderPresetId: string`.

Internal bootstrap input remains separate so protected and built-in teammates can be
created in `workspace_default` mode without pretending that they own a provider id.

## Provider Lifecycle

- Provider deletion and disablement inspect workspace default, active channel, fixed
  teammate, automation and active execution references.
- A referenced provider cannot be deleted or disabled until the user selects a replacement
  or clears the owning product state through its supported flow.
- Archived channels do not block provider deletion. Restoring an archived channel with a
  missing provider requires choosing a new runnable model before activation.
- Provider history and run snapshots remain readable after a provider is deleted.

## Persistence And Migration

`ai_teammates` stores `model_binding_mode` independently from `provider_preset_id`.

- `workspace_default` requires a null provider id.
- `fixed` requires a provider id for all public/user writes.
- Existing Ling Agent records migrate to `workspace_default`.
- Existing `teammate_builtin_*` records with no provider migrate to
  `workspace_default`; built-ins with a previously selected provider remain `fixed`.
- Existing user-created teammates remain `fixed`. Missing or stale user-owned bindings are
  surfaced for repair; they are not silently switched during normal runtime.

Active legacy channels with no provider may be backfilled only from an already runnable
workspace default during migration/startup repair. Stale archived channels wait for the
restore flow.

## UI States

- Channel and private-chat headers expose a persistent title-adjacent More menu with a
  Settings action; the entry remains available in healthy, warning and loading states.
- Private Settings opens on Profile by default and keeps Model as an explicit section.
  A model warning opens Model directly without replacing the persistent Settings entry.
- Private-chat model failures do not occupy the header. They use the same composer-adjacent
  `ConversationStatusStrip` grammar as channels and appear immediately above the composer:
  concise title, concrete blocker, current model summary and one `Configure model` action.
  The notice disappears only when the teammate's authoritative effective model is runnable.
- Channel create and General label the channel-owned selector as `Ling Agent model`. The
  Members section displays `Ling Agent model - <model>`, `Workspace default - <model>`, or
  `Fixed model - <model>` as read-only ownership.
- No configured model: one actionable composer notice, disabled send/create, no header badge
  and no repeated warning badge on every built-in teammate.
- Following default: `Workspace default - <model>` in private settings and effective model
  surfaces.
- Fixed: `Fixed model - <model>`.
- Missing/disabled/check failed: persistent repair feedback with an action to Model
  Workbench.
- Provider save success remains brief; model configuration failures remain until repaired.

## Non-Goals And Hard Stops

- Do not add a model picker to the private-chat composer.
- Do not add a per-channel teammate-model override or silently edit teammate bindings from
  Channel Settings.
- Do not send a derived provider id with ordinary channel messages or accept it as a
  per-message override of channel teammate ownership.
- Do not let user-created teammates silently use workspace or channel fallback.
- Do not bulk rewrite fixed teammate or channel ids when the workspace default changes.
- Do not select the first enabled provider at runtime as an error recovery mechanism.
- Do not make media-generation providers eligible conversation defaults.
- Do not change chat permissions, approvals, teammate skills, channel membership or run
  history semantics.
