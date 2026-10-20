# P15 Provider Model Catalog And Discovery

Status: Implemented and verified
Owner: Provider platform
Last verified: 2026-09-22

Related documents:

- [Provider Presets](provider-presets.md)
- [Provider Generation Runtime](provider-generation-runtime.md)
- [Provider Hardening And Media Adapters](provider-hardening-and-media-adapter-completion.md)
- [UI 2.0 Model Workbench](ui2.0升级/modules/09-Model-Workbench.md)
- [P15 Implementation Plan](provider-model-catalog-and-discovery-p15-implementation-plan.md)

## Problem

Provider connectors, default setup suggestions and model metadata currently change at
different speeds, but the implementation treats too much of them as one bundled list.
The result is predictable drift:

- a provider can publish a new model before Ling ships another release;
- `/models` can return the new id, while Ling still has no exact context, reasoning or
  modality metadata for it;
- model-family regular expressions can classify a new id too broadly;
- native Gemini and Mistral protocols cannot currently use the same discovery flow as
  OpenAI-compatible and Anthropic routes;
- users cannot tell whether a capability came from the provider, the Ling catalog or a
  conservative fallback.

P15 separates connection code from model data. It does not turn remote model metadata
into executable code and does not allow a catalog entry to bypass runtime adapters.

## Product Outcome

The model workbench should behave as follows:

```text
choose or configure a provider
  -> fetch the provider's current model ids
  -> normalize the provider-specific response
  -> prefer explicit provider metadata
  -> fill missing metadata from Ling's versioned catalog
  -> fall back conservatively when the model is unknown
  -> let the user review and import the result
```

New model ids can appear without adding another template. Exact capability metadata can
be refreshed through a reviewed catalog update. Authentication and protocol changes
still require a Ling release.

## Three Update Clocks

### Runtime discovery

Runtime discovery reads model ids from the configured provider. It is user-triggered,
uses the user's existing provider route and credentials, and never sends those
credentials to the catalog source.

Supported discovery adapters:

| API | Request | Authentication | Response collection |
| --- | --- | --- | --- |
| OpenAI Completions | `<base>/models` | Bearer | `data[]` |
| OpenAI Responses | `<base>/models` | Bearer | `data[]` |
| Anthropic Messages | `<base>/models` | `x-api-key` + `anthropic-version` | `data[]` |
| Google Generative AI | `<base>/models` | `x-goog-api-key` | `models[]` |
| Mistral Conversations | `<base>/models` | Bearer | `data[]` |
| Media job routes | `<base>/models`, then safe built-in fallback | route-specific | `data[]` or array |

`openai-codex-responses` is excluded from discovery. It is a session transport, not a
normal provider catalog API.

### Catalog synchronization

The Ling catalog is data, not connector code. A generated, reviewable snapshot contains
only fields used by Ling:

- provider id and model id;
- display name;
- input modality;
- chat, tool, reasoning and vision capability declarations;
- supported thinking levels when the source publishes them;
- context and output-token limits;
- upstream last-updated date.

The initial source is the MIT-licensed `models.dev` catalog. A repository workflow runs
the generator on a schedule and opens or updates a pull request. It never commits to
`main` directly and never auto-enables runtime adapters.

The daily workflow runs at 10:23 Asia/Shanghai (`23 2 * * *` UTC), only from `main`.
It uses a dedicated GitHub App installation token for both the catalog branch push
and PR creation so PR events start CI automatically. The built-in `GITHUB_TOKEN`
has read-only contents access. An organization owner or App manager must complete
this one-time setup; repository admin access alone is insufficient:

1. Create an organization-owned private GitHub App with only Contents and Pull requests
   read/write repository permissions. No webhook, organization permission, Actions
   write permission or branch-protection bypass is needed.
2. Install it for the selected `ling-stack` repository only and generate its PEM RSA
   private key. Keep the key out of source control and workflow logs.
3. Set repository variable `MODEL_CATALOG_APP_CLIENT_ID` to the App's Client ID and
   repository secret `MODEL_CATALOG_APP_PRIVATE_KEY` to the private key. Merge the
   workflow change through normal review, then dispatch it from `main` and verify
   that its generated PR starts CI without a manual workflow approval.

Missing or invalid configuration fails before token creation or any branch write;
there is no built-in-token or personal-token fallback. Tokens are restricted to the
current repository and revoked after the job. Normal CI and main branch protection
still apply; this workflow never merges the PR.

### Connector releases

The following remain normal reviewed code changes:

- authentication and custom headers;
- request and response payload shape;
- streaming and retry behavior;
- hosted search/tool protocol behavior;
- image, video, audio and file execution adapters;
- provider-specific safety and billing behavior.

## Authority And Precedence

Metadata precedence for a discovered model is:

1. explicit user/admin advanced override on the saved preset;
2. explicit metadata returned by the configured provider;
3. exact model match in the versioned Ling catalog;
4. bundled provider template or reviewed family rule;
5. conservative fallback.

An upstream declaration is authoritative for the fields it actually returns. Ling must
not union catalog capabilities into an explicit smaller upstream capability set. Missing
fields may still be filled from the next layer.

Capability metadata is descriptive. Runtime authority is separate:

- `tool_call` does not grant workspace permissions;
- `web_search` requires a supported search protocol;
- `image_generate`, `image_edit` and `video_generate` require a connected generation
  adapter and generation runtime readiness;
- unknown models default to chat-only for chat protocols and no generation capability.

## Catalog Contract

The generated snapshot has a stable manifest and normalized records:

```ts
interface ProviderModelCatalogManifest {
  schemaVersion: 1;
  version: string;
  source: "models.dev";
  sourceUrl: string;
  license: "MIT";
  generatedAt: string;
  updatedAt: string;
}

interface ProviderModelCatalogRecord {
  providerId: string;
  id: string;
  displayName?: string;
  input?: readonly ("text" | "image")[];
  capabilities: readonly ProviderCapability[];
  thinkingModes?: readonly ProviderThinkingMode[];
  contextWindow?: number;
  maxTokens?: number;
  updatedAt?: string;
}
```

The runtime exposes catalog provenance with every discovery response:

```ts
interface ProviderModelCatalogInfo {
  source: "models.dev" | "ling-builtin";
  version: string;
  updatedAt: string;
  stale: boolean;
}

interface ProviderModelListResponse {
  source: string;
  fetchedAt: string;
  catalog: ProviderModelCatalogInfo;
  models: readonly ProviderModelOption[];
}
```

`stale` means the catalog snapshot is older than 45 days. Stale metadata remains usable
as a fallback, but the UI names it as stale and unknown models remain conservative.

## Provider Identity Mapping

Catalog provider ids and Ling route ids are intentionally separate. The reviewed alias
map includes, at minimum:

| Ling provider id | Catalog provider id |
| --- | --- |
| `openai`, `openai-codex` | `openai` |
| `anthropic` | `anthropic` |
| `google`, `google-gemini`, `gemini` | `google` |
| `xai` | `xai` |
| `deepseek` | `deepseek` |
| `minimax` | `minimax` |
| `alibaba-bailian` | `alibaba` |
| `moonshot` | `moonshotai` |
| `glm` | `zhipuai`, then `zai` |
| `siliconflow` | `siliconflow` |
| `stepfun` | `stepfun` |
| `doubao` | `volcengine` |

An unknown OpenAI-compatible relay may use an exact model-id match only when the id is
unique in the trusted snapshot. Ambiguous ids remain on family or conservative rules.

## Model Workbench Presentation

The default editor keeps its current compact model list. Catalog details stay in the
existing source inspector instead of adding another status card.

- source inspector shows provider endpoint, fetch time, catalog version and catalog date;
- a stale catalog uses one compact warning line;
- every model retains one capability-source label: provider, Ling catalog, template,
  custom or conservative;
- no price, raw metadata, catalog JSON or checksum appears in the default list;
- refreshing models replaces the current discovery result without changing saved models;
- importing a model keeps the current confirmation and preflight behavior.

## Failure Behavior

- Provider auth/network failure: keep the current productized error and do not replace it
  with a catalog-only model list.
- Empty provider result: show the existing empty result state; media routes may use their
  reviewed built-in candidates.
- Catalog generation failure: fail CI and leave the previous snapshot unchanged.
- Catalog snapshot missing or invalid: build/test fails; runtime does not silently fetch
  executable code or accept malformed fields.
- Catalog stale: continue with provenance and conservative unknown-model handling.
- Duplicate provider/model records: generator fails unless aliases resolve them explicitly.

## Security And Privacy

- API keys and secret headers are used only for the configured provider request.
- A saved local API key may be reused for discovery only when the request names its
  provider preset and the provider kind, provider id, API protocol, Base URL and auth
  mode still match the saved connection. Changed connection details require saving or
  entering the key again before discovery.
- Catalog synchronization runs in CI and does not receive user credentials.
- The generated file contains data only and is committed for review.
- Generated media capabilities are ignored. Generation authority remains in the local
  adapter allowlist.
- Remote records cannot change Base URL, headers, transport, permissions or enabled state.
- The workflow opens a PR and never pushes catalog changes directly to `main`.

## Acceptance

- OpenAI-compatible, Anthropic, native Gemini and Mistral routes can discover models.
- Gemini ids are normalized from `models/<id>` and non-generation methods are excluded.
- Explicit provider capability metadata wins over catalog metadata.
- An exact catalog match fills missing context, output, reasoning and modality metadata.
- An unknown model remains conservative and can still be manually imported.
- Discovery responses expose fetch time and catalog provenance without secrets.
- The model editor shows catalog freshness inside details and does not add a new card.
- Catalog generation is deterministic, schema checked and PR based.
- Existing provider presets, checks, imports, defaults and generation adapters do not regress.

## Verification Record

Verified on 2026-09-22 against the isolated P15 worktree and a consistency backup of
the user's local Ling workspace data:

- the configured `custom-openai-compatible` / `openai-completions` route discovered 34
  models without re-entering or exposing its saved local API key;
- configured model `gpt-5.4-mini` resolved to `model_catalog` with `known` confidence;
- catalog `models.dev:30010ab6f9b9`, updated 2026-09-21, reported `stale=false`;
- a focused daemon test proves changed Base URLs are rejected before any provider
  request can reuse the saved local secret;
- the real browser workbench showed localized fetch/catalog provenance in the existing
  Source inspector, passed dark-mode inspection at 1280x720 and 1440x960, had no
  horizontal body overflow and reported no console errors.

No API key, secret header, secret reference value or reversible fingerprint is part of
this evidence.

## Non-Goals

- Loading arbitrary provider plugins from the network.
- Executing remote catalog code.
- Billing aggregation or price calculation.
- Automatically replacing saved user model selections.
- Automatically enabling generation or workspace-changing tools from catalog metadata.
- Making Ling startup depend on `models.dev` availability.
