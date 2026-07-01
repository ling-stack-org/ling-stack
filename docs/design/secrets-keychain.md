# Secrets and Keychain

## Purpose

This document records the secret reference and future keychain design.

Ling Stack supports `env:NAME` secret refs for local development and accepts stable
`keychain:NAME` refs as a fail-closed contract. Desktop packaging, GitHub automation,
provider API keys, MCP transport secrets, webhook secrets, and future automation tokens
all use this same boundary.

The target goal is to keep a shared SecretResolver abstraction without storing raw
secrets in JSON config, logs, artifacts, Web state, renderer IPC responses, or plugin
manifests. Current provider setup also has a workspace-local `local:<providerId>`
compatibility path backed by SQLite; treat that as local-only compatibility, not the
target architecture for general secrets.

Related docs:

- [Two-Layer Configuration](two-layer-configuration.md)
- [Runtime, Provider, and Secrets Inheritance](runtime-provider-secrets-inheritance.md)
- [Startup Readiness Chain](startup-readiness-chain.md)
- [Provider Presets Design](provider-presets.md)

## Implementation Status

Implemented in v0.1:

- core exports `SecretResolver`, `parseSecretRef()`, `createEnvSecretResolver()`, and `createCompositeSecretResolver()`,
- `env:` and `keychain:` refs are valid; raw keys, empty names, and unknown schemes are rejected,
- daemon provider check, run startup, live media transport, MCP check/sync/tool calls,
  and public provider/MCP mapping resolve through the injected resolver,
- daemon exposes read-only `GET /secrets/status`,
- daemon exposes external-work-specific workflow bootstrap plus Keychain setup/delete
  endpoints for channel-bound `WORKFLOW.md` files,
- contracts and API client expose secret status DTOs and `getSecretStatus()`,
- Web and CLI accept/display `keychain:` refs without exposing values,
- MCP server config stores `secretEnvRefs`, `secretHeaderRefs`, and `bearerTokenRef`
  only; raw MCP secret reads are disabled and legacy raw SQLite rows are reported as
  migration-required evidence,
- Web Settings can save/remove GitHub and Linear external-work tokens through the daemon
  without storing token values in browser storage,
- run events, run snapshots, provider snapshots, and generated artifacts redact resolved secret values.
- provider API keys can currently use `local:<providerId>` for workspace-local
  compatibility; this must not be expanded beyond provider setup.
- provider API keys can be saved/deleted through
  `POST /providers/:id/secrets/configure` and
  `DELETE /providers/:id/secrets/keychain`, which accept only `keychain:` refs and never
  return raw values.
- provider presets store `secretHeaderRefs`; provider check, model discovery, import,
  run startup, image vision, web search, and media transport resolve those refs only
  inside trusted daemon runtime calls.

Not implemented in v0.1:

- generic renderer APIs that set or delete arbitrary secrets,
- external plugin access to raw secret values.

## Goals

- Keep `env:` support for CLI and local development.
- Support stable `keychain:` refs with fail-closed status until Desktop injects OS keychain storage.
- Keep secret values inside trusted daemon/desktop boundaries.
- Let providers and GitHub automation share the same secret model.
- Return only configured/missing status to clients.
- Preserve redaction in run events, artifacts, provider snapshots, and GitHub evidence.

## Secret Ref Schemes

Supported refs:

```text
env:OPENAI_API_KEY
env:ANTHROPIC_API_KEY
env:LOCAL_RELAY_API_KEY
keychain:provider_local
```

Reserved desktop naming examples:

```text
keychain:provider_<providerId>
keychain:github_<installationId>
keychain:custom_<stableId>
```

Rules:

- Persistent config stores only the ref.
- Raw secret values are never accepted for persistent provider creation.
- API responses may include the ref and configured status.
- API responses must not include the value.
- Renderer must not receive the value.

## Core Interfaces

```ts
export type SecretRefKind = "env" | "keychain";

export interface SecretRef {
  readonly raw: string;
  readonly kind: SecretRefKind;
  readonly name: string;
}

export type SecretPurpose =
  | "provider_api_key"
  | "github_token"
  | "linear_token"
  | "webhook_secret"
  | "custom_header"
  | "automation_token";

export interface SecretStatus {
  readonly ref: string;
  readonly configured: boolean;
  readonly kind: SecretRefKind;
  readonly errorCode?: "secret_missing" | "secret_access_denied" | "secret_store_unavailable" | "invalid_secret_ref";
  readonly message?: string;
}

export interface ResolvedSecret {
  readonly ref: string;
  readonly configured: boolean;
  readonly value?: string;
  readonly status?: SecretStatus;
}

export interface SecretResolver {
  status(ref: string, purpose?: SecretPurpose): SecretStatus;
  resolve(ref: string, purpose?: SecretPurpose): ResolvedSecret;
}
```

## Resolver Behavior

`env:` resolver:

- reads from the daemon process environment,
- reports `secret_missing` when the env var is absent,
- returns the value only to trusted daemon execution paths.

`keychain:` resolver:

- is injected by Desktop or provided by the daemon's macOS `/usr/bin/security`
  integration for external-work setup,
- returns `secret_store_unavailable` when daemon is running without keychain support,
- returns configured/missing status without value to API clients,
- returns value only inside trusted daemon execution paths.

Startup behavior:

- daemon startup constructs the composite resolver and reports resolver capability
  status through startup readiness,
- startup does not resolve every configured provider, MCP, GitHub, Linear, or
  automation secret value,
- `secret_store_unavailable` degrades startup status but does not make `/health` fail,
- provider/run preflight remains responsible for purpose-specific secret resolution.

## Daemon Integration

The daemon should use `SecretResolver` for:

- provider checks,
- run startup,
- live media transport,
- MCP status checks, tool sync, and runner MCP tool calls,
- GitHub and Linear token use,
- future webhook secret verification,
- future automation external actions.

Provider and automation errors should normalize to:

- `secret_missing`,
- `secret_access_denied`,
- `secret_store_unavailable`,
- `invalid_secret_ref`.

## Status API

Read-only status endpoint:

```http
GET /secrets/status?ref=keychain%3Aprovider_x&purpose=provider_api_key
```

Response:

```json
{
  "status": {
    "ref": "keychain:provider_x",
    "kind": "keychain",
    "configured": false,
    "errorCode": "secret_store_unavailable",
    "message": "Keychain secret store is unavailable in this runtime."
  }
}
```

No endpoint returns raw secret values.

External-work setup endpoints are intentionally narrower than a generic secret API:

```http
POST /external-work/secrets/configure?cwd=/path/to/project
POST /external-work/secrets/delete?cwd=/path/to/project
```

Secret setup/removal requires a valid channel-bound `WORKFLOW.md`, accepts only
`keychain:` refs for Web setup/removal, and persists only the `source.secretRef` string
to `WORKFLOW.md`. If `WORKFLOW.md` is missing or invalid, Web Settings first uses the
local-only workflow bootstrap endpoint to create or repair the file without handling any
token value.

Provider API-key setup endpoints are similarly narrow:

```http
POST /providers/:id/secrets/configure?cwd=/path/to/project
DELETE /providers/:id/secrets/keychain?cwd=/path/to/project
```

They accept only provider API-key material for a specific provider preset, persist only a
`keychain:` ref on the preset, and never expose a generic arbitrary-secret write/read
surface.

## Desktop Boundary

Trusted host code owns OS keychain writes and deletes. In the local daemon, the macOS
implementation shells out to `/usr/bin/security` with service `ling-stack`; non-macOS
runtimes report `secret_store_unavailable`. Renderer gets only a narrow facade:

```ts
export interface DesktopSecretApi {
  setSecret(input: {
    readonly ref: string;
    readonly value: string;
    readonly purpose: SecretPurpose;
    readonly label?: string;
  }): Promise<SecretStatus>;

  deleteSecret(ref: string): Promise<SecretStatus>;
  getSecretStatus(ref: string, purpose?: SecretPurpose): Promise<SecretStatus>;
}
```

There is no `getSecretValue()` method.

## GitHub Token Model

GitHub connections should store metadata and token refs:

- repository or installation metadata,
- `tokenRef`,
- scopes summary,
- configured status,
- created/updated timestamps.

GitHub automation resolves `tokenRef` only when executing a concrete GitHub API action.
If permission is insufficient, the GitHub adapter records an explicit permission failure
instead of asking the model to infer it.

The shipped external-work Settings setup uses deterministic refs:

```text
keychain:LING_STACK_GITHUB_<OWNER>_<REPO>_TOKEN
keychain:LING_STACK_LINEAR_<PROJECT>_TOKEN
```

## Redaction

Resolved secret values must be added to the redaction context before writing:

- run events,
- provider snapshots,
- MCP status snapshots,
- request snapshots,
- media artifacts,
- GitHub evidence artifacts,
- logs,
- approval payloads.

`apiKeyRef` and `tokenRef` may be displayed. Secret values may not.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/cli test
corepack pnpm typecheck
git diff --check
```

Required tests:

- `env:` and `keychain:` parse successfully,
- malformed refs fail,
- env resolver reports configured/missing,
- unavailable keychain resolver reports `secret_store_unavailable`,
- provider create/update accepts `env:` and `keychain:`,
- provider create/update rejects raw keys and unknown schemes,
- provider Keychain configure/delete stores only refs and never returns values,
- provider secret headers resolve through `custom_header` purpose and redact values,
- MCP create/update accepts secret refs and rejects raw secret payloads,
- MCP check/sync/tool calls resolve refs only inside trusted daemon paths,
- `/secrets/status` never returns a value,
- provider and MCP snapshots/artifacts redact resolved secrets,
- renderer preload never exposes raw secret values.

## Assumptions

- `env:` remains the default for development.
- OS keychain write/delete is implemented for external-work token setup and provider
  API-key setup; generic arbitrary-secret editing is still not exposed.
- No cloud secret sync exists in v0.1.
- Plugins and skills never receive raw secret values directly.
