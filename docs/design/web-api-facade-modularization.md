# Web API Facade Modularization

## 1. Problem Statement

`apps/web/src/api.ts` has grown into the Web client's single daemon-facing facade. It is
already a thin wrapper around `LingDaemonClient`, but it now mixes several unrelated
responsibilities:

- daemon client construction and base URL export;
- domain endpoint wrappers for runs, channels, teammates, memory, runtime, providers,
  MCP, plugins, approvals, external work, automations, skills, and media;
- artifact and attachment content URL helpers;
- browser file-to-base64 upload helpers;
- Web-only form-to-daemon-payload adapters;
- run request builders for normal runs, task runs, and reruns.

The pressure point is no longer transport logic. `packages/api-client` owns the daemon
HTTP client and wire behavior. The Web problem is facade ownership: every new Web domain
adds imports, types, and adapter logic to one file, increasing merge conflicts and making
small API changes look broader than they are.

This is a behavior-preserving Web refactor. It should not redesign daemon routes, shared
contracts, or `LingDaemonClient`.

## 2. Goals And Non-Goals

### Goals

- Keep all existing public exports from `apps/web/src/api.ts` working during the first
  slice.
- Split Web facade code by domain and local responsibility.
- Keep daemon wire types in `@ling-stack/contracts` and Web form state in
  `apps/web/src/types.ts`.
- Make request builders and form payload adapters independently testable.
- Reduce future merge conflicts by moving feature-specific endpoint additions out of one
  monolithic file.
- Preserve existing runtime behavior, request bodies, content URLs, and import paths
  until call sites are migrated deliberately.

### Non-Goals

- No daemon route changes.
- No changes to `packages/api-client` unless a missing low-level client method is found.
- No OpenAPI generator.
- No new state manager or data-fetching library.
- No broad conversion of every call site in the first slice.
- No visual, copy, or e2e selector changes.

## 3. Current Shape

Current simplified shape:

```text
apps/web/src/api.ts
  -> constructs LingDaemonClient
  -> exports daemonBaseUrl
  -> exports every domain endpoint wrapper
  -> exports content URL helpers
  -> exports run request builders
  -> owns form-to-payload adapters
  -> owns file upload encoding helpers
```

That shape is workable for a small Web app, but it is now misaligned with the domain
controller split in `apps/web/src/domains/`. Domain hooks import only the functions they
need, but all those functions still live in the same source file.

The key distinction:

- `packages/api-client/src/client.ts` is the transport and daemon route client.
- `apps/web/src/api.ts` is the Web facade and compatibility surface.

The split should target the second layer only.

## 4. Target Architecture

Target shape:

```text
apps/web/src/
  api.ts                         # compatibility barrel only
  api/
    client.ts                    # daemonBaseUrl and shared daemonClient
    control-plane.ts             # health and control-plane snapshot/event APIs
    automations.ts
    skills.ts
    runs.ts
    run-request-builders.ts
    channels.ts
    channel-payloads.ts
    teammates.ts
    memory.ts
    attachments.ts
    runtime.ts
    providers.ts
    provider-payloads.ts
    mcp.ts
    mcp-payloads.ts
    plugins.ts
    approvals.ts
    approval-payloads.ts
    external-work.ts
    media.ts
    media-payloads.ts
    shared.ts                    # splitCsv, splitLines, readRecord, removeUndefined
    file-uploads.ts              # File -> base64 browser helper
```

`apps/web/src/api.ts` remains during migration:

```ts
export { daemonBaseUrl } from "./api/client.js";
export * from "./api/control-plane.js";
export * from "./api/automations.js";
export * from "./api/skills.js";
export * from "./api/runs.js";
export * from "./api/run-request-builders.js";
export * from "./api/channels.js";
export * from "./api/teammates.js";
export * from "./api/memory.js";
export * from "./api/attachments.js";
export * from "./api/runtime.js";
export * from "./api/providers.js";
export * from "./api/mcp.js";
export * from "./api/plugins.js";
export * from "./api/approvals.js";
export * from "./api/external-work.js";
export * from "./api/media.js";
```

The barrel is a compatibility contract, not a permanent dumping ground. New endpoint
wrappers should be added to the domain file and re-exported from the barrel only while
legacy call sites still import from `../api.js`.

## 5. Ownership Rules

| Module | Owns | Does Not Own |
| --- | --- | --- |
| `api/client.ts` | `daemonBaseUrl`, singleton `daemonClient` | endpoint-specific wrappers |
| `api/*-payloads.ts` | Web form state to daemon request payload conversion | daemon transport, React state |
| `api/run-request-builders.ts` | `buildRunRequest`, `buildTaskRunRequest`, `buildRerunRequest` | run list/event/artifact fetching |
| `api/attachments.ts` | channel and teammate attachment upload/delete/preview helpers | generic run artifacts |
| `api/media.ts` | media job endpoints and media artifact helpers | generic artifact rows |
| `api/shared.ts` | pure parsing and record helpers | daemon calls, browser APIs |
| domain endpoint files | thin wrappers around `daemonClient` | Web component state, formatting, view models |

Rules:

- Domain endpoint files may import `daemonClient` from `api/client.ts`.
- Payload adapter files may import Web form-state types from `../types.js`.
- `api/client.ts` must not import any domain endpoint file.
- `api/shared.ts` must stay pure and browser-independent.
- Browser-only helpers, such as `FileReader`, stay isolated in `api/file-uploads.ts`.
- Domain hooks may keep importing from `../../api.js` during the compatibility phase.
- Once a domain is migrated, it may import from `../../api/providers.js` or the relevant
  domain file directly.

## 6. Migration Plan

### Slice 1: Pure Support Extraction

Extract helpers that do not call the daemon:

- `splitCsv`,
- `splitLines`,
- `splitShellishArgs`,
- `readRecord`,
- `readOptionalString`,
- `readStringArray`,
- `readToolArray`,
- `removeUndefined`,
- `fileToBase64`.

Move browser file encoding to `api/file-uploads.ts`; move pure helpers to
`api/shared.ts`.

This slice should leave `api.ts` exporting all behavior exactly as before.

### Slice 2: Request Builders And Payload Adapters

Extract Web-local adapters:

- `buildRunRequest`,
- `buildTaskRunRequest`,
- `buildRerunRequest`,
- `providerFormToPayload`,
- `mcpServerFormToPayload`,
- `channelFormToPayload`,
- `channelFormToUpdatePayload`,
- `taskEditFormToPayload`,
- `mediaJobFormToPayload`,
- approval policy payload conversion.

Add focused unit tests for these adapters before moving large endpoint groups. The risky
behavior is not the wrapper call; it is silent request-shape drift.

Recommended test file:

```text
apps/web/src/api/run-request-builders.test.ts
apps/web/src/api/form-payloads.test.ts
```

If the Web test runner is not configured for source-unit tests, add these cases to the
nearest existing Web test harness instead of introducing a new test framework just for
this split.

### Slice 3: Low-Risk Endpoint Group Extraction

Move thin wrappers with minimal local adapter logic:

- `control-plane.ts`,
- `automations.ts`,
- `skills.ts`,
- `runtime.ts`,
- `plugins.ts`,
- `external-work.ts`,
- `memory.ts`.

Each domain file should import only the types it needs. The barrel re-export keeps
existing imports stable.

### Slice 4: Adapter-Heavy Domain Extraction

Move wrappers that depend on payload adapters or browser upload helpers:

- `runs.ts`,
- `channels.ts`,
- `teammates.ts`,
- `attachments.ts`,
- `providers.ts`,
- `mcp.ts`,
- `approvals.ts`,
- `media.ts`.

This slice should be broken up if the diff becomes hard to review. For example, move
providers and MCP in separate commits because both have form-to-payload logic and secret
handling expectations.

### Slice 5: Optional Direct Import Migration

After the barrel-backed split is stable, migrate domain hooks to direct imports:

```text
domains/providers/use-providers-domain.ts -> ../../api/providers.js
domains/mcp/use-mcp-domain.ts             -> ../../api/mcp.js
domains/external-work/...                 -> ../../api/external-work.js
```

This is optional. The real maintainability win comes from source ownership. Direct
imports are useful only if they improve dependency clarity or make lint guards possible.

## 7. API Surface Compatibility

The first implementation must preserve these exports from `apps/web/src/api.ts`:

- `daemonBaseUrl`;
- all existing endpoint functions;
- `artifactContentUrl`;
- `attachmentContentUrl`;
- `attachmentContentUrlById`;
- `channelAttachmentContentUrl`;
- `previewArtifactContent`;
- `previewAttachmentContent`;
- `buildRunRequest`;
- `buildTaskRunRequest`;
- `buildRerunRequest`.

No caller should need to change in Slice 1 through Slice 4. If TypeScript requires call
site changes, that is a signal the split has changed an API and should be narrowed.

## 8. Test Plan

Run after each extraction slice:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
git diff --check
```

Run targeted e2e when these surfaces move:

```bash
corepack pnpm --filter @ling-stack/web exec playwright test
```

Targeted regression coverage should include:

- run request creation with provider preset and legacy inline provider;
- task run request fallback tools and channel-bound cwd;
- rerun request reconstruction from `requestSnapshot` and `taskSnapshot`;
- provider payload trimming, secret clear behavior, numeric fields, and media-job compat;
- MCP stdio and streamable-http payload conversion;
- channel create versus update null/undefined behavior;
- approval policy allowed-write-path newline parsing;
- media job JSON object parsing and invalid-array rejection;
- attachment upload base64 conversion and content URL preservation;
- artifact preview and content URL preservation.

## 9. Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Barrel re-export accidentally drops an export | Add typecheck plus a temporary export list comparison before and after the split. |
| Request body drift in payload adapters | Extract and test adapters before moving endpoint groups. |
| Circular imports between `api/client.ts` and domain modules | Enforce one-way imports: domain files import client, client imports nothing from domains. |
| Browser-only `FileReader` leaks into test/runtime contexts | Keep upload encoding in `file-uploads.ts` and import it only from attachment/teammate modules. |
| Review diff becomes too large | Ship support extraction, request builders, low-risk endpoints, and adapter-heavy domains as separate commits or PRs. |
| Direct import migration creates churn | Keep direct import migration optional; barrel compatibility is enough for the first refactor. |

## 10. Exit Criteria

The split is complete when:

- `apps/web/src/api.ts` is only a re-export barrel;
- each endpoint wrapper lives in a domain-specific `apps/web/src/api/*.ts` file;
- request builders and payload adapters have targeted regression coverage;
- no Web domain hook imports adapter-heavy helpers from unrelated API modules;
- `corepack pnpm --filter @ling-stack/web typecheck` passes;
- `corepack pnpm --filter @ling-stack/web build` passes;
- `git diff --check` passes.

## 11. Implementation Status

Implemented in the Web API facade split:

- `apps/web/src/api.ts` is now a compatibility barrel.
- `apps/web/src/api/client.ts` owns `daemonBaseUrl` and the shared `daemonClient`.
- endpoint wrappers are split into domain files for control-plane, automations, skills,
  runs, channels, teammates, memory, attachments, runtime, secrets, MCP, plugins,
  approvals, external work, and media.
- request builders live in `api/run-request-builders.ts`.
- Web form payload adapters live in focused `*-payloads.ts` files.
- browser file encoding lives in `api/file-uploads.ts`; pure parsing helpers live in
  `api/shared.ts`.
- `AppShell` imports `getControlPlaneSnapshot` from the narrower
  `api/control-plane.js` module instead of the compatibility barrel.
- `apps/web/e2e/api-adapters.spec.ts` covers request builder and payload adapter
  regression cases.

## 12. Relationship To Existing Design Docs

- [Contracts and API Client](contracts-api-client.md) owns the shared contracts and
  daemon HTTP client extraction. This plan does not reopen that layer.
- [Web Modularization](web-modularization.md) owns feature presentation and CSS
  extraction. This plan is the API-facade follow-up.
- [Web AppShell Domain Modularization](web-appshell-domain-modularization.md) owns domain
  state controllers and AppShell coordination. This plan makes the API import layer match
  that domain shape.
