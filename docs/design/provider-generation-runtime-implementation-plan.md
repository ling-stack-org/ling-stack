# Provider Generation Runtime Resolver Implementation Plan

## Summary

Implement one shared Generation Runtime Resolver for image generation, image editing,
and video generation. Provider presets remain vendor route records; resolver state
decides runtime readiness.

## Key Changes

- Document and export the resolver contract from core.
- Keep compatibility aliases for existing `MediaProviderRuntime*` names while adding
  `GenerationProviderRuntime*` names.
- Normalize live transport for connected adapter families without mutating persisted
  provider rows.
- Replace scattered Web, daemon, and mock-daemon runtime checks with the core resolver.
- Fix Seedream e2e fixtures to include the Base URL required by live generation.

## Module Work

- Core:
  - Extend `provider-media-normalization.ts` with operation-aware state, supported
    operations, adapter support, and UI copy keys.
  - Keep `resolveMediaProviderRuntimeState` as a wrapper around
    `resolveGenerationProviderRuntimeState`.
  - Include Seedance video as a connected adapter when operation is `video_generate`.
- Daemon:
  - Use normalized presets in provider list, create/update/import, Check, media job
    creation, and media job execution.
  - For Check, use static ready for OpenAI Images and Seedance; keep Seedream probe.
- Web:
  - Use resolver state for generation model lists, Model Workbench status, conversation
    model filtering, and media create availability.
  - Do not directly inspect `compat.mediaVendorTransport` for product readiness.
- E2E mock:
  - Normalize providers before returning `/providers`.
  - Normalize create/update/import payloads.
  - Use resolver state in media job run gates.

## Tests

- Core:
  - OpenAI Images old `compat: {}` normalizes to live and can run `image_generate`.
  - Seedream normalizes to live for `image_generate`.
  - Seedance can run `video_generate` when configured.
  - Flux/Qwen Image/Ideogram are recognized but not runnable without connected adapter.
  - Ordinary chat/vision models are not generation runtime providers.
- Daemon:
  - Provider list returns normalized compat for old OpenAI Images presets.
  - Create/update/import all use the resolver normalization.
  - Check returns static ready for OpenAI Images and Seedance, live probe for Seedream,
    and unsupported for recognized but unconnected families.
  - Media job run accepts only resolver-runnable providers.
- Web e2e:
  - `gpt-image-2` does not appear in conversation model menus.
  - Image Generation shows create action for runnable providers.
  - Recognized-but-unconnected generation providers do not appear as runnable.
  - Model discovery search, select all, clear, and multi-import still work.

## Verification Checklist

- [x] Documentation landed in `docs/design`.
- [x] Core helper is the single runtime readiness source.
- [x] Web no longer has direct live media transport readiness logic.
- [x] Daemon provider list, Check, and media job paths call the resolver.
- [x] Mock daemon follows the same resolver for e2e.
- [x] `gpt-image-2 compat:{}` is runnable when Base URL and secret are configured.
- [x] Seedream fixture includes Base URL.
- [x] Targeted core, daemon, and web e2e tests pass.

## Assumptions

- No database migration in this slice.
- No new HTTP endpoints in this slice.
- The resolver may recognize more model families than Ling can execute.
- Unknown models remain conservative.
- Desktop Web is the acceptance target.
