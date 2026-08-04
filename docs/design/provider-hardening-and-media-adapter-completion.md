# Provider Hardening And Media Adapter Completion

## Status

Design contract. Created 2026-06-30.

This document records the remaining provider hardening and generation adapter work
after the provider workbench and generation runtime resolver landed.

Related docs:

- [Provider Presets Design](provider-presets.md)
- [Provider Generation Runtime Resolver](provider-generation-runtime.md)
- [Secrets and Keychain](secrets-keychain.md)
- [Runtime, Provider, and Secrets Inheritance](runtime-provider-secrets-inheritance.md)
- [Daemon API](../daemon-api.md)

## Purpose

Provider presets are now the shared route records for chat, reasoning, image generation,
image editing, video generation, channel execution, teammate execution, automation, and
conversation execution. That makes provider deletion, secret storage, secret headers,
and vendor adapter completion part of the same data-consistency surface.

The goal is to close those gaps without weakening the existing generation resolver:

- deleting a provider must not silently break channels, teammates, active work, or media
  jobs;
- provider secrets should move toward OS Keychain storage for desktop production;
- custom provider headers need a secret-ref path equivalent to MCP `secretHeaderRefs`;
- connected media adapters must produce real final artifacts, not task ids or static
  placeholders;
- documentation must describe implemented interfaces separately from planned seams.

## Current State

Implemented:

- Provider presets store non-secret provider route data.
- `apiKeyRef` supports `env:` and `keychain:` refs at the contract level.
- A workspace-local provider secret compatibility path exists for setup flows that
  submit a raw `apiKey`.
- The daemon has a `SecretResolver` seam and a macOS Keychain adapter used by the
  external-work token setup flow.
- MCP server transport config supports `secretHeaderRefs`.
- `/provider-models` and `/providers/import-models` are implemented and now documented
  in `docs/daemon-api.md`.
- The generation runtime resolver gates media runtime readiness.
- OpenAI Images can return final image artifacts for `image_generate`.
- Seedream can return final image artifacts for `image_generate`.
- Seedream can return final image artifacts for URL-based `image_edit`.
- Seedance `video_generate` now polls task status and downloads the final video artifact
  before marking a media job as succeeded.
- Jimeng is recognized by templates/model-family rules but remains fail-closed because
  the current provider secret/auth contract does not yet model its Visual API signing
  requirements.
- `DELETE /providers/:id` returns `provider_delete_blocked` before deleting local
  provider secrets when the provider is still referenced by current config or
  active work.
- Provider presets now persist `secretHeaderRefs`; runtime calls resolve them through
  the secret materializer and redact resolved values.
- Generic provider Keychain setup/delete endpoints exist for provider API keys.

Still missing:

- Jimeng has no live `image_generate` adapter.
- Local-file or stored-artifact materialization for image editing is not implemented;
  Seedream edit currently accepts URL/data-URL image inputs only.
- Web can display provider Keychain and secret-header status, but broader desktop
  packaging polish remains outside this slice.

## Product Decisions

1. Provider delete defaults to safe blocking.
   If a provider is referenced by current configuration or active work, deletion returns
   `provider_delete_blocked`. Disabling the provider remains allowed.

2. Delete protection is not a permission system.
   It is a data-integrity guard. Authorization and destructive-action confirmation stay
   outside this module.

3. Generic provider Keychain setup must be explicit.
   Existing SQLite local provider secrets are not silently migrated. A user or setup flow
   must save a provider secret to a `keychain:` ref.

4. Provider secret headers mirror MCP semantics.
   Static `headers` stay for non-secret values. New `secretHeaderRefs` hold secret refs.
   The same header name cannot appear in both maps.

5. Media adapter truthfulness wins over broad capability labels.
   A provider may be recognized as a generation model but still be unavailable until a
   connected adapter can execute the exact operation and produce the expected artifact.

6. Seedance task id is not a final video artifact.
   The implementation polls task status and downloads the resulting video before marking
   the media job as succeeded with a video artifact.

7. Desktop Web remains the acceptance scope.
   No mobile-specific acceptance target is introduced here.

## Module Boundaries

### ProviderReferenceInspector

Module purpose: decide whether a provider preset can be deleted.

Seam: daemon provider feature, behind a pure interface that accepts store read facets and
a provider preset id.

Suggested interface:

```ts
export type ProviderReferenceBlockerKind =
  | "workspace_default_provider"
  | "channel_default_provider"
  | "ai_teammate_provider"
  | "automation_execution_policy"
  | "conversation_thread_default"
  | "active_run"
  | "active_work_unit"
  | "active_media_job";

export interface ProviderReferenceBlocker {
  readonly kind: ProviderReferenceBlockerKind;
  readonly id: string;
  readonly label?: string;
  readonly status?: string;
  readonly active: boolean;
}

export interface ProviderReferenceInspection {
  readonly providerPresetId: string;
  readonly canDelete: boolean;
  readonly blockers: readonly ProviderReferenceBlocker[];
}
```

Implementation reads:

- workspace settings `defaultProviderPresetId`;
- channel `defaultProviderPresetId`;
- AI teammate `providerPresetId`;
- automation execution policies that hold `providerPresetId`;
- conversation thread defaults when the conversation thread model is active;
- nonterminal runs whose `providerPresetId` matches;
- nonterminal runtime work units whose `providerPresetId` matches;
- nonterminal media jobs whose `providerPresetId` matches.

The delete route calls this module before touching provider rows or local secrets.

### ProviderSecretMaterializer

Module purpose: resolve provider secret material for outbound HTTP calls without leaking
values to clients, logs, snapshots, or artifacts.

Seam: daemon/provider runtime code, backed by the existing `SecretResolver`.

Interface shape:

```ts
export interface ProviderSecretMaterial {
  readonly apiKey?: string;
  readonly staticHeaders: Record<string, string>;
  readonly secretHeaders: Record<string, string>;
  readonly redactionValues: readonly string[];
}
```

Implementation rules:

- resolve `apiKeyRef` with purpose `provider_api_key`;
- resolve `secretHeaderRefs` with purpose `custom_header`;
- fail closed when a required secret is missing, inaccessible, or the keychain store is
  unavailable;
- add every resolved value to redaction before writing logs, run snapshots, media
  artifacts, or provider check output;
- never return resolved values through daemon HTTP responses.

### ProviderKeychainSetup

Module purpose: write/delete provider API keys through the trusted daemon/desktop secret
store and persist only `apiKeyRef`.

Seam: daemon provider setup endpoint plus Web Model Workbench setup UI.

Design constraints:

- accepts only `keychain:` refs for provider Keychain setup;
- uses the same `ExternalSecretStore` style as external-work setup where possible;
- reports `provider_secret_store_unavailable` when OS Keychain storage is unavailable;
- deleting a provider Keychain secret does not delete the provider preset;
- deleting a provider preset may delete its owned local SQLite secret only after delete
  protection passes;
- no generic arbitrary-secret endpoint is exposed to plugins or untrusted renderer code.

### ProviderSecretHeaderRefs

Module purpose: let provider presets carry secret HTTP headers without storing header
values in static provider config.

Interface addition:

```ts
export interface ProviderPreset {
  readonly headers: Record<string, string>;
  readonly secretHeaderRefs?: Record<string, string>;
}
```

Validation rules:

- header names are normalized for duplicate detection but persisted with caller casing;
- a header name cannot exist in both `headers` and `secretHeaderRefs`;
- `authorization` should be rejected in `secretHeaderRefs` when `authHeader !== false`
  and `apiKeyRef` is configured, because that would create ambiguous auth;
- refs must parse as supported secret refs;
- status responses may report configured/missing by header name, never by value.

Call sites:

- provider check;
- `/provider-models`;
- `/providers/import-models` follow-up checks;
- run startup and provider-backed channel/teammate/conversation execution;
- image vision materialization;
- media vendor transport.

### MediaVendorOperationAdapter

Module purpose: execute one vendor operation and return normalized final artifacts or a
normalized failure.

Existing seam: `packages/providers` media adapter execution.

Adapter completion targets:

- Jimeng `image_generate`: still pending until the auth/signing contract is explicitly
  modeled. It must remain unavailable rather than returning a task id or placeholder.
- Seedream `image_edit`: accepts URL/data-URL source images, submits the edit request,
  downloads final image assets, and returns image artifacts.
- Seedance `video_generate`: submits the task, polls task status until terminal state,
  downloads the final video asset, and returns a video artifact plus compact JSON
  metadata.

Adapter rules:

- never mark a job succeeded with only a task id when the product requested final media;
- normalize vendor HTTP, auth, quota, timeout, and invalid-response failures;
- redact API keys and secret headers in request/response artifacts;
- use bounded polling with timeout and cancellation-friendly checks;
- keep vendor-specific payload mapping inside the vendor adapter.

## HTTP Interface Notes

Implemented and documented now:

- `POST /provider-models?cwd=...`
- `POST /providers/import-models?cwd=...`
- `POST /providers/:id/secrets/configure?cwd=...`
- `DELETE /providers/:id/secrets/keychain?cwd=...`

Implemented in code and documented in `docs/daemon-api.md`:

- provider delete blocked response body for `DELETE /providers/:id`;
- provider `secretHeaderRefs` fields in provider create/update/import/model discovery
  request payloads.

Do not document future provider secret endpoints in `docs/daemon-api.md` until the
implementation lands.

## Error Codes

Provider hardening should use stable, product-readable error codes:

- `provider_delete_blocked`
- `provider_secret_store_unavailable`
- `provider_secret_header_conflict`
- `provider_secret_missing`
- `provider_secret_access_denied`
- `provider_secret_ref_invalid`

Media adapters should continue using normalized media/provider failures where possible:

- `auth_failed`
- `rate_limited`
- `network_error`
- `timeout`
- `provider_error`
- `invalid_request`
- `unsupported_capability`

## Non-goals

- No automatic migration from local SQLite provider secrets to OS Keychain.
- No cloud secret sync.
- No mobile-specific acceptance scope.
- No fake media output to make unsupported vendors appear connected.
- No bypass around the generation runtime resolver.
- No broad rewrite of provider storage.
- No direct plugin or renderer access to raw secret values.

## Acceptance Criteria

- Deleting a referenced provider returns `provider_delete_blocked` with useful blockers
  and leaves the provider plus secrets untouched.
- Disabling a referenced provider remains possible and existing preflight surfaces report
  the disabled state.
- Provider Keychain setup saves only `apiKeyRef` in provider config and keeps the raw
  value inside the trusted Keychain adapter.
- Provider secret headers are resolved for runtime calls and redacted everywhere.
- Static headers and secret headers cannot conflict.
- Jimeng image generation stays unavailable until a signed live adapter can return final
  image artifacts or a normalized failure.
- Seedream image editing returns final image artifacts or a normalized failure.
- Seedance video generation returns a final video artifact before success.
- `/provider-models` and `/providers/import-models` documentation matches contracts and
  does not claim planned secret-header support as implemented.
