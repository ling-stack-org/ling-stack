# Provider and Runner Internal Modularization

## Purpose

This document defines a behavior-preserving internal split for:

- `packages/providers/src/index.ts`
- `packages/runner-pi/src/index.ts`

Both files have grown into package-wide implementation sinks. The goal is to make
provider/media and Pi runner changes easier to review without changing package names,
daemon imports, runtime behavior, or public API shape.

## Current Baseline

Implemented today:

- `@ling-stack/providers` exports provider and media adapter contracts, media registry
  helpers, built-in media provider extension metadata, static media adapters, live
  vendor transport helpers, request-plan rendering, error normalization, and redaction
  behavior from one `src/index.ts`.
- `@ling-stack/runner-pi` exports Pi runner types, extension metadata, `PiRunnerAdapter`,
  `createPiRunner()`, resource loader wiring, approval interception, runtime permission
  request tooling, file mutation overrides, MCP proxy tools, and Pi event translation
  from one `src/index.ts`.
- Daemon imports both packages through their package root. There are no supported deep
  imports from app or daemon code.
- Pi remains the default embedded `@earendil-works/pi-coding-agent` library backend.
  This split does not move Ling Stack to the Pi CLI.
- The internal extension registry consumes metadata from both packages, but execution
  authority still remains in daemon runtime, approval policy, leases, and state
  machines.

## Goals

- Keep `@ling-stack/providers` and `@ling-stack/runner-pi` as the stable package
  boundaries.
- Keep `src/index.ts` in each package as a public barrel that re-exports the same
  public symbols.
- Split implementation by domain responsibility, not by generic utility buckets first.
- Preserve all request/response shapes, artifact content, event names, extension ids,
  default tools, provider capabilities, and error codes.
- Make future media vendor additions and runner tool changes narrow file edits.
- Keep tests focused on existing public root imports so accidental API drift is caught.

## Non-Goals

- No new workspace packages.
- No daemon route or store rewrite.
- No provider preset schema change.
- No media job behavior change.
- No runner backend switch from embedded Pi library mode to Pi CLI.
- No dynamic plugin loading.
- No public deep import contract for internal modules.
- No broad cleanup of local logs, generated artifacts, or unrelated workspace state.

## Provider Target Structure

```text
packages/providers/src/
  index.ts
  types.ts
  errors.ts
  media-registry.ts
  media-executor.ts
  media-static.ts
  media-vendor-definitions.ts
  media-vendor-http.ts
  media-vendor-metadata.ts
  media-vendor-plan.ts
  media-vendor-transport.ts
  redaction.ts
  utils.ts
  vendors/
    seedance.ts
    seedream.ts
```

Responsibilities:

- `types.ts` owns public provider, media, request, response, transport, and adapter
  contract types.
- `errors.ts` owns `MediaAdapterExecutionError` and normalized media error mapping.
- `media-registry.ts` owns `MediaAdapterRegistry`, default registry construction, and
  registry resolution.
- `media-executor.ts` owns `executeMediaJob()`.
- `media-static.ts` owns local static media adapters and static vendor adapter behavior.
- `media-vendor-definitions.ts` owns built-in vendor definitions and lookup.
- `media-vendor-http.ts` owns shared media-vendor HTTP response helpers.
- `media-vendor-metadata.ts` owns `ProviderExtensionMetadata` projection for built-in
  media providers.
- `media-vendor-plan.ts` owns redacted vendor request-plan construction.
- `media-vendor-transport.ts` owns disabled/live transport selection and preset compat
  gate parsing.
- `vendors/seedream.ts` and `vendors/seedance.ts` own vendor-specific payloads, response
  parsing, HTTP failure normalization, and live-call artifacts.
- `redaction.ts` owns recursive secret redaction.
- `utils.ts` owns tiny shared structural helpers only.

## Runner-Pi Target Structure

```text
packages/runner-pi/src/
  index.ts
  adapter.ts
  constants.ts
  content.ts
  events.ts
  metadata.ts
  resource-loader.ts
  types.ts
  utils.ts
  extensions/
    approval.ts
    file-mutation.ts
    mcp-proxy.ts
    permissions.ts
```

Responsibilities:

- `types.ts` owns the public Pi runner request, result, event, approval, permission,
  provider, MCP, and model types.
- `constants.ts` owns default tools, supported provider APIs, and approval/tool sets.
- `metadata.ts` owns `PI_RUNNER_EXTENSION_ID` and `getPiRunnerExtension()`.
- `adapter.ts` owns `PiRunnerAdapter`, custom provider registration, run lifecycle, and
  `createPiRunner()`.
- `resource-loader.ts` owns `DefaultResourceLoader` construction and extension factory
  composition.
- `extensions/approval.ts` owns side-effect approval interception for built-in Pi tools.
- `extensions/permissions.ts` owns the `request_permission` tool and scope parsing.
- `extensions/file-mutation.ts` owns `edit`/`write` overrides and daemon-handled patch
  result normalization.
- `extensions/mcp-proxy.ts` owns MCP tool registration and approval routing.
- `content.ts` owns shared runner tool result content normalization.
- `events.ts` owns Pi-to-Ling event translation.
- `utils.ts` owns small shared helpers such as record checks, abort handling, prompt
  formatting, and default Ling runner system prompt.

## Public API Compatibility

The root exports must continue to support existing imports:

```ts
import { createPiRunner, getPiRunnerExtension } from "@ling-stack/runner-pi";
import type { PiRunnerProviderConfig, PiRunnerRunOptions } from "@ling-stack/runner-pi";

import {
  createDefaultMediaAdapterRegistry,
  executeMediaJob,
  listBuiltinProviderExtensions,
} from "@ling-stack/providers";
```

Tests should continue importing from `../dist/index.js` or the package root. Internal
module paths are not stable product contracts.

## Migration Plan

1. Add this design document before code changes.
2. Split `packages/providers/src/index.ts` into the target files while leaving root
   exports unchanged.
3. Run `corepack pnpm --filter @ling-stack/providers test`.
4. Split `packages/runner-pi/src/index.ts` into the target files while leaving root
   exports unchanged.
5. Run `corepack pnpm --filter @ling-stack/runner-pi build`.
6. Run `corepack pnpm --filter @ling-stack/daemon typecheck` to prove daemon imports and
   cross-package declarations still compile.
7. Run `git diff --check`.

## Verification Requirements

Provider verification:

- Built-in media provider extension ids remain
  `provider:media:jimeng`, `provider:media:seedream`, and `provider:media:seedance`.
- Media adapter registry still maps built-in media vendors to static adapters.
- Static media artifacts remain redacted.
- Live transport gate still rejects preset-configured `fake` mode.
- Seedream and Seedance live helper behavior remains covered by existing provider tests.

Runner verification:

- `runner:pi` metadata id and supported tools remain unchanged.
- `edit` and `write` remain interceptable before mutation.
- MCP tool proxy approval still fails closed when approval is required but no handler is
  configured.
- Abort and run lifecycle semantics remain unchanged.
- Daemon typecheck still accepts root package imports.

## Risks and Guardrails

- Risk: accidental public API drift from missing re-exports.
  Guardrail: keep tests importing from package root and run daemon typecheck.
- Risk: circular imports between runner extensions.
  Guardrail: put shared content and utility helpers in `content.ts` and `utils.ts`
  instead of importing one extension from another.
- Risk: media vendor code leaking redaction helpers into public API.
  Guardrail: export redaction helpers only internally, not from root `index.ts`.
- Risk: mistaking modularization for a package boundary redesign.
  Guardrail: do not add workspace packages or deep import docs in this slice.
