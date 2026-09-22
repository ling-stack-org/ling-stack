# P15 Provider Model Catalog And Discovery Implementation Plan

Status: Complete
Owner: Provider platform
Depends on: [P15 Design](provider-model-catalog-and-discovery-p15.md)

## Delivery Slices

### P15-A Versioned catalog

- Add a deterministic `scripts/sync-provider-model-catalog.mjs` generator.
- Read only reviewed primary provider ids from `https://models.dev/api.json`.
- Keep the generated file focused on names, modalities, safe chat capabilities, thinking
  modes and token limits.
- Add a daily GitHub workflow that validates and opens/updates a PR without auto-merge.
- Export catalog manifest/status and exact lookup from `@ling-stack/core`.
- Keep reviewed family rules as the fallback for relays and unknown ids.

### P15-B Discovery adapters

- Extract request URL, auth and response collection rules from `models.ts`.
- Add native `google-generative-ai` and `mistral-conversations` discovery.
- Preserve OpenAI, Anthropic and media behavior.
- Keep a 10 second provider request timeout and 200-model response ceiling.
- Normalize Gemini names, display names, token limits and supported generation methods.
- Return `fetchedAt` and catalog provenance.

### P15-C Workbench provenance

- Extend shared contracts and API client response types.
- Show provider source, fetch time, catalog version/date and stale state inside the current
  source inspector.
- Keep the default model row density unchanged.
- Add localized compact stale copy and screen-reader labels.

### P15-D Verification

- Core tests: exact catalog match, provider precedence, unique relay lookup, conservative
  fallback and manifest freshness calculation.
- Daemon tests: OpenAI-compatible regression, Gemini auth/normalization, Mistral auth and
  secret redaction.
- Web tests: provenance details, stale warning, no default-layer clutter and dark mode.
- Run with the user's existing local Ling provider presets on an isolated daemon port.
  Record only provider id/model, result counts and capability provenance; never print keys.

## File Ownership

| Area | Files |
| --- | --- |
| Generated data | `packages/core/src/provider-model-catalog.generated.ts` |
| Catalog resolver | `packages/core/src/provider-model-catalog.ts` |
| Discovery adapters | `packages/daemon/src/features/providers/model-discovery-adapters.ts` |
| Discovery orchestration | `packages/daemon/src/features/providers/models.ts` |
| Public contract | `packages/contracts/src/providers.ts`, `packages/core/src/provider-types.ts` |
| Web presentation | `ProviderModelImportPanel.tsx`, provider discovery view-models |
| Automation | `scripts/sync-provider-model-catalog.mjs`, `.github/workflows/sync-provider-model-catalog.yml` |

## Migration And Compatibility

- No database migration is required.
- Saved provider presets are unchanged.
- New response fields are additive.
- `ProviderModelListRequest.providerPresetId` is additive and exists only to bind saved
  local-secret discovery to an unchanged persisted connection.
- Existing clients can ignore provenance fields.
- Existing family rules remain until the generated catalog has equivalent regression
  coverage; P15 does not delete them wholesale.
- The generated snapshot is bundled, so offline startup and model setup continue to work.

## Commands

```bash
node scripts/sync-provider-model-catalog.mjs --check
git diff --check
corepack pnpm --filter @ling-stack/contracts typecheck
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web typecheck
cd apps/web
corepack pnpm exec playwright test e2e/model-workbench.spec.ts e2e/ui2-model-workbench.spec.ts
```

## Completion Gate

- The generator is deterministic and a second run produces no diff.
- Scheduled synchronization cannot directly merge catalog changes.
- Native Gemini and Mistral discovery pass real response-shape fixtures.
- Catalog metadata never enables a generation adapter.
- Existing local provider presets can fetch models through the new daemon build.
- No API key, secret header or key fingerprint appears in logs, response bodies or test
  evidence.
- Documentation, contracts, implementation and browser behavior agree.

## Completion Evidence

- Deterministic catalog check: current, 335 records across 14 trusted providers.
- Core full suite: passed before final provider-boundary slice; the final slice does not
  change Core behavior.
- Daemon full suite: passed; focused provider API suite passed 9/9 after the final
  saved-local-secret boundary change.
- Contracts, Core, daemon, API Client and Web typechecks: passed.
- Web i18n check and runtime catalog compilation: passed.
- The full localization catalog audit remains open: 53 non-English/Chinese catalogs
  still need the shared Profile/UI backlog and the new P15 strings translated. P15 keeps
  the English and Chinese runtime catalogs current and does not bulk-generate unrelated
  locale translations.
- Web focused model-workbench and dark-mode coverage: passed; real browser verification
  also covered existing local configuration, source provenance, dark mode and console.
