# Provider Generation Runtime Resolver

## Summary

Ling separates provider presets from generation runtime readiness.

- A provider preset describes a vendor route: kind, provider id, protocol, model, Base URL,
  secret reference, declared capabilities, and compatibility metadata.
- The generation runtime resolver decides whether that preset can run a generation
  operation right now.
- Image generation, image editing, and video generation must use the same resolver.

The resolver is not a provider and does not replace vendor adapters. It is the shared
gate used by Model Workbench, provider Check, media job creation/running, Web filters,
and e2e mocks.

The resolver is also not an approval engine. Standalone Media Job runs do not create
`media_cost` approvals. Media Production owns its separate user-intent boundary:
scene runs, ordered project runs, and workflow tests create a media-owned approval
before they dispatch the same generation runtime.

## Goals

- Use one decision path for `image_generate`, `image_edit`, and `video_generate`.
- Keep provider routing/vendor identity separate from runtime capability decisions.
- Make old presets such as `gpt-image-2` with `compat: {}` work without a database
  migration when the model family has a connected live adapter.
- Prevent unknown image-looking or video-looking models from pretending to be runnable.
- Keep Check cheap: it may validate static readiness for providers whose live check
  would create paid media output.

## Non-goals

- No new HTTP APIs.
- No provider preset schema migration.
- No automatic adapter for every known image or video model family.
- No automatic merging of multiple relays that expose the same model id.
- No mobile-specific acceptance scope.

## Decision Ladder

Generation capability resolution must happen in this order:

1. Trust explicit upstream capability metadata when model discovery returns reliable
   fields such as `api`, `capabilities`, `input`, or known modality keys.
2. Use Ling's model-family catalog to fill gaps for deterministic public families such
   as OpenAI Images, Seedream, Seedance, Flux, Qwen Image, Ideogram, and Stability.
3. Treat unknown models conservatively. A model is not runnable for generation just
   because it supports vision or appears on a chat endpoint.

Runtime readiness then applies stricter gates:

1. Preset must use `api: "media-job"`.
2. Preset must declare the requested generation capability.
3. Preset must be enabled.
4. Preset must have a valid live media transport after normalization.
5. Preset must have Base URL and configured secret when live transport is required.
6. Ling must have a connected adapter for that vendor/model-family/operation.

## Module Boundaries

- `packages/core/src/provider-generation-models.ts`
  owns model-family inference and conservative capability fallback.
- `packages/core/src/provider-media-normalization.ts`
  owns runtime normalization and generation readiness decisions.
- `packages/providers`
  owns vendor adapter implementations and live transport execution.
- `packages/daemon`
  calls the core resolver for provider list, create/update/import, Check, and media jobs.
- `apps/web`
  calls the core resolver for display state and filtering only; it must not reimplement
  runtime readiness.
- `apps/web/e2e/support/mock-daemon.ts`
  uses the same core resolver so tests match daemon behavior.

## Runtime State

The resolver returns a pure state object:

- normalized compat for runtime use;
- inferred generation family;
- supported generation operations;
- whether the requested operation is supported;
- whether live transport is enabled;
- whether a real adapter is connected for the operation;
- final `canRun` boolean;
- a stable reason and UI copy key when unavailable.

`compat.mediaVendorTransport.mode` is only a runtime transport switch. It does not mean
the model is intrinsically a generator.

## Connected Adapter Policy

Known generation families may be detected before Ling can execute them.

- OpenAI Images: connected for `image_generate` through OpenAI-compatible Images.
- Seedream: connected for `image_generate` and URL/data-URL based `image_edit`.
- Seedance: connected for `video_generate`; success requires final task polling and a
  downloaded video artifact, not only a task id.
- Jimeng, Flux, Qwen Image, Stability, Ideogram, Google image families, and xAI Grok
  Imagine may be recognized as generation models but are not runnable until a matching
  live adapter is connected.

Check must not create paid output for OpenAI Images or Seedance. Those providers can
return static readiness when all runtime gates are satisfied. Seedream may keep the
existing lightweight image probe because that behavior already exists.

## Video Input Modes

`video_generate` remains one operation. Runtime readiness additionally returns verified
input modes for the exact model version:

```ts
type VideoGenerationInputMode = "text" | "first_frame" | "reference_image";
```

- Seedance 1.0 Pro, 1.0 Pro Fast, and 1.5 Pro expose `text` and `first_frame`.
- Seedance 2.0 exposes those modes plus up to 9 `reference_image` inputs.
- Seedance 2.5 exposes those modes plus up to 30 `reference_image` inputs.
- Unrecognized Seedance versions remain text-only until a verified mapping is added.

First-frame and reference-image inputs are mutually exclusive in one request. Capability
metadata controls Web visibility and daemon validation; Provider Preset `compat` data
cannot grant a mode that the connected adapter does not verify.

Local image content is materialized by daemon immediately before adapter submission.
Resolver state, preset records, Media Job input, snapshots, logs, and recovery handles
contain only stable local references and safe metadata, never Base64 image bytes.

## Hard Stops

- Do not show generation models in conversation/chat provider selectors.
- Do not treat Check success as the source of truth for media page availability.
- Do not bypass the resolver in Web, daemon, or mock-daemon paths.
- Do not silently migrate or delete existing provider records.
- Do not add a new provider kind solely to classify a model as generated media.
