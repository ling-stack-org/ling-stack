# Provider Hardening And Media Adapter Completion Implementation Plan

## Summary

Implement the remaining provider hardening work in small PRs:

1. keep documentation honest;
2. block unsafe provider deletion;
3. add provider secret header refs;
4. wire generic provider Keychain setup;
5. complete live media adapters for Jimeng, Seedream edit, and Seedance final video;
6. polish Web surfaces after backend behavior is real.

Source of truth:

- [Provider Hardening And Media Adapter Completion](provider-hardening-and-media-adapter-completion.md)
- [Daemon API](../daemon-api.md)
- [Secrets and Keychain](secrets-keychain.md)
- [Provider Generation Runtime Resolver](provider-generation-runtime.md)

## Module Boundaries Before Coding

- UI: Model Workbench provider setup, delete-blocked copy, secret header inputs, and
  media provider status display live under `apps/web/src/features/providers` and existing
  media pages.
- State: Web provider form state should carry only refs/status, never secret values after
  save.
- Domain logic: provider reference inspection, provider secret materialization, and media
  runtime readiness stay outside React.
- HTTP/client: contracts live in `packages/contracts`; API client mirrors daemon routes
  in `packages/api-client`.
- Daemon: route handlers orchestrate modules but do not own blocker inspection,
  keychain write logic, or vendor payload logic inline.
- Providers: vendor-specific media payloads, polling, and artifact extraction stay under
  `packages/providers/src/vendors`.
- Tests: core/daemon/provider tests exercise modules through their interfaces; Web e2e
  verifies user-visible behavior only.

Production files over 1200 lines should not receive major new behavior unless the change
is a narrow hotfix. Extract focused helpers first.

## PR 0: Documentation And API Description

Status: done by this doc slice.

Changes:

- Add full daemon API docs for `POST /provider-models`.
- Add full daemon API docs for `POST /providers/import-models`.
- Add design contract for delete protection, provider Keychain, secret headers, and media
  adapter completion.
- Clarify that Seedance task-only success was the historical gap; the later PR 6 slice
  now polls until a final video is downloadable before success.

Validation:

```bash
git diff --check
```

No production code changes.

## PR 1: Provider Delete Protection

Status: implemented in this branch.

Goal: make `DELETE /providers/:id` safe.

Code targets:

- `packages/daemon/src/features/providers/reference-inspector.ts` new module.
- `packages/daemon/src/features/providers/routes.ts` delete branch calls the inspector.
- `packages/core/src/storage/sqlite/*` read facets only if existing store methods are not
  enough.
- `packages/contracts/src/providers.ts` add blocked-delete response shape if the Web needs
  typed handling.
- `apps/web/src/features/providers/ProviderSettings.tsx` show blockers in the delete
  confirmation/error state.

Implementation:

1. Add `ProviderReferenceInspector` with a small interface returning blocker records.
2. Include blockers for workspace default, channel defaults, AI teammates, automations,
   conversation thread defaults, active runs, active work units, and active media jobs.
3. Treat terminal historical runs/jobs as nonblocking references.
4. If blockers exist, return HTTP 409:

   ```json
   {
     "error": "provider_delete_blocked",
     "message": "Provider is still referenced.",
     "blockers": [
       { "kind": "channel_default_provider", "id": "channel_...", "label": "Engineering", "active": true }
     ]
   }
   ```

5. If no blockers exist, delete the provider preset and its owned local provider secret.
6. Keep provider disable behavior unchanged.

Tests:

```bash
corepack pnpm --filter @ling-stack/daemon test -- providers
corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts
corepack pnpm --filter @ling-stack/web typecheck
```

Required assertions:

- channel default blocks delete;
- AI teammate provider blocks delete;
- active media job blocks delete;
- completed run/job does not block delete;
- blocked delete leaves provider and local secret intact;
- Web shows a product-readable blocked message.

Rollback:

- The module is additive. Revert route wiring and keep the inspector file unused if a
  blocker query is wrong.

## PR 2: Provider Secret Header Refs

Status: implemented in this branch.

Goal: support secret provider headers without storing values in static provider config.

Code targets:

- `packages/contracts/src/providers.ts`
- provider schema parsers in `packages/daemon/src/features/providers/schemas.ts`
- provider storage mappers/select SQL in `packages/core/src/storage/sqlite`
- provider runtime materialization under `packages/daemon/src/features/providers`
- provider check, model discovery, imported-provider check, run startup, image vision,
  and media adapter call sites
- Web Model Workbench provider form

Implementation:

1. Add `secretHeaderRefs?: Record<string, string>` to provider preset, template, create,
   update, model list, and import payload types.
2. Persist the map in provider preset storage, defaulting old rows to `{}`.
3. Add validation:
   - header names cannot duplicate across `headers` and `secretHeaderRefs`;
   - refs must parse as supported secret refs;
   - reject ambiguous `authorization` secret header when `authHeader !== false` and
     `apiKeyRef` is configured.
4. Add `ProviderSecretMaterializer` that resolves API key plus secret headers once per
   runtime call and returns redaction values.
5. Replace direct `provider.headers` spread at runtime call sites with materialized
   headers.
6. Web exposes a compact "secret headers" section with header name + secret ref, not a
   raw value field.

Tests:

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test -- provider
corepack pnpm --filter @ling-stack/daemon test -- providers
corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts
```

Required assertions:

- static/secret duplicate header is rejected;
- missing secret header fails preflight with a stable code;
- resolved secret header reaches mocked provider HTTP calls;
- provider snapshots and media artifacts redact the header value;
- old providers without `secretHeaderRefs` still load.

Rollback:

- Keep schema fields optional. If runtime wiring regresses, revert materializer call-site
  usage while preserving storage compatibility.

## PR 3: Generic Provider Keychain Setup

Status: implemented in this branch.

Goal: allow provider API keys to be saved/deleted through OS Keychain for desktop
production, without silently migrating local SQLite secrets.

Code targets:

- `packages/daemon/src/features/providers/secrets.ts`
- new provider secret setup route under provider feature
- `packages/core/src/secrets.ts` only if the existing interface needs a small status
  extension
- `packages/api-client/src/endpoints/admin.ts`
- `packages/contracts/src/providers.ts`
- `apps/web/src/features/providers`
- `docs/daemon-api.md` after implementation lands

Implementation:

1. Add narrow provider secret setup/delete endpoints:

   ```http
   POST /providers/:id/secrets/configure?cwd=...
   DELETE /providers/:id/secrets/keychain?cwd=...
   ```

2. Accept only `keychain:` refs for the Keychain endpoint.
3. Use the existing daemon Keychain adapter or return
   `provider_secret_store_unavailable`.
4. On successful save, patch the provider `apiKeyRef` to the keychain ref and clear owned
   local provider secret if the user explicitly requested replacement.
5. On delete, remove the keychain item and clear provider `apiKeyRef` only when it points
   to that exact ref.
6. Do not migrate existing `local:<providerId>` secrets automatically.
7. Web shows Keychain status and keeps raw key only in the transient form before save.

Tests:

```bash
corepack pnpm --filter @ling-stack/daemon test -- providers
corepack pnpm --filter @ling-stack/core test -- secrets
corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts
```

Required assertions:

- unsupported keychain store returns stable unavailable error;
- successful fake Keychain adapter persists only the ref;
- deleting a Keychain secret does not delete the provider preset;
- raw values never appear in provider list, run snapshots, or logs.

Rollback:

- Endpoint is additive. Web can hide the Keychain setup affordance while env/local
  compatibility paths continue to work.

## PR 4: Jimeng `image_generate` Live Adapter

Status: intentionally deferred/fail-closed.

Goal: make Jimeng image generation produce final image artifacts when configured.

Code targets:

- `packages/providers/src/vendors/jimeng.ts` new adapter.
- `packages/providers/src/media-vendor-transport.ts` route Jimeng image generation.
- `packages/core/src/provider-media-normalization.ts` connected-adapter gate.
- daemon media tests and Web media e2e fixtures.

Implementation:

1. Implement Jimeng request payload mapping for `image_generate`.
2. Support the vendor response shape for sync or async output, depending on the documented
   endpoint used by the template.
3. Download final image URLs or decode final base64 assets.
4. Return image artifacts plus compact JSON metadata.
5. Keep unsupported Jimeng `image_edit` blocked until PR 5 or a separate adapter lands.

Tests:

```bash
corepack pnpm --filter @ling-stack/providers test -- jimeng
corepack pnpm --filter @ling-stack/core test -- provider-media
corepack pnpm --filter @ling-stack/daemon test -- media
corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts
```

Hard stop:

- Do not mark Jimeng runnable if the adapter only returns a task id or placeholder JSON.

Current branch decision: keep Jimeng unavailable until its live Visual API auth/signing
contract is explicitly modeled. The resolver continues to recognize Jimeng as a
generation family, but it does not mark Jimeng runnable.

## PR 5: Seedream `image_edit` Live Adapter

Status: implemented for URL/data-URL image inputs in this branch.

Goal: connect Seedream image editing through the same generation runtime resolver.

Code targets:

- `packages/providers/src/vendors/seedream.ts`
- `packages/providers/src/media-vendor-transport.ts`
- `packages/daemon/src/features/media`
- Web media job form if current edit inputs need stricter validation/copy.

Implementation:

1. Define supported edit input shape for first version: prompt plus image URL(s) or stored
   artifact references that daemon can materialize into accepted vendor input.
2. Build Seedream edit payload separately from image generation payload.
3. Return final edited image artifacts.
4. Normalize unsupported local-file cases with a clear error instead of sending invalid
   payloads.

Tests:

```bash
corepack pnpm --filter @ling-stack/providers test -- seedream
corepack pnpm --filter @ling-stack/daemon test -- media
corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts
```

Hard stop:

- Do not expose `image_edit` as runnable unless the daemon can provide the image input
  form the adapter expects.

## PR 6: Seedance Final Polling And Video Download

Status: implemented in this branch.

Goal: Seedance `video_generate` succeeds only after a final video artifact is available.

Code targets:

- `packages/providers/src/vendors/seedance.ts`
- provider transport options for polling timeout/interval if needed
- daemon media executor cancellation and timeout paths
- artifact persistence for downloaded video

Implementation:

1. Keep task creation as the first step.
2. Poll the vendor task-status endpoint until terminal state.
3. Handle success, failure, cancellation, timeout, and malformed status bodies.
4. Download the final video URL to a video artifact.
5. Store compact task metadata JSON alongside the video artifact.
6. Redact secrets from status and download failure messages.

Tests:

```bash
corepack pnpm --filter @ling-stack/providers test -- seedance
corepack pnpm --filter @ling-stack/daemon test -- media
corepack pnpm --filter @ling-stack/web test:e2e -- media-jobs.spec.ts
```

Required assertions:

- pending statuses continue polling;
- failed terminal status fails the media job;
- success without downloadable video is an invalid provider response;
- final success includes a video artifact, not only JSON.

Rollback:

- Feature can fall back to "unavailable" in resolver rather than task-only success.

## PR 7: Web Model Workbench And Media Status Polish

Status: implemented in this branch.

Goal: make the new backend behavior understandable without adding fake capabilities.

Code targets:

- `apps/web/src/features/providers/ProviderSettings.tsx`
- provider styles
- media job creation/runtime status UI
- i18n strings

Implementation:

1. Show blocked-delete blockers in concise Chinese copy.
2. Show Keychain unavailable/configured/missing status without exposing values.
3. Show secret header refs as configured/missing rows.
4. Show Jimeng/Seedream edit/Seedance final-video availability based on resolver state.
5. Keep desktop-only layout validation.

Tests:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts media-jobs.spec.ts
```

## PR 8: Docs And Regression Sweep

Status: in progress in this branch.

Goal: update docs after implementation and run the final regression batch.

Docs:

- `docs/daemon-api.md`
- `docs/design/provider-hardening-and-media-adapter-completion.md`
- `docs/design/secrets-keychain.md`
- `docs/design/provider-generation-runtime.md`

Validation:

```bash
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/providers test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts media-jobs.spec.ts settings.spec.ts channel.spec.ts teammates.spec.ts automations.spec.ts
git diff --check
```

## Hard Stops

- Do not delete provider presets while references or active work still exist.
- Do not automatically migrate local SQLite provider secrets to Keychain.
- Do not return raw secret values through daemon HTTP responses, Web state, logs,
  artifacts, or snapshots.
- Do not put secret values in provider `headers`.
- Do not bypass the generation runtime resolver.
- Do not report Seedance success without a final video artifact.
- Do not introduce mobile-specific acceptance work in this scope.

## Implementation Order Rationale

Delete protection comes first because it prevents data loss before deeper secret/media
changes. Secret headers come before Keychain polish because they touch the runtime
materialization seam used by checks, model discovery, run startup, vision, and media
adapters. Media adapters are separate PRs because each vendor has different payload,
polling, and artifact rules. Web polish comes after backend truth is available, so the UI
does not present controls that are not real yet.
