# Secrets and Keychain

## Purpose

This document records the secret reference and future keychain design.

Ling Stack supports `env:NAME` secret refs for local development and accepts stable
`keychain:NAME` refs as a fail-closed contract. Desktop packaging, GitHub automation,
provider API keys, webhook secrets, and future automation tokens all use this same
boundary.

The goal is to keep a shared SecretResolver abstraction without ever
storing raw secrets in SQLite, logs, artifacts, Web state, renderer IPC responses, or
plugin manifests.

## Implementation Status

Implemented in v0.1:

- core exports `SecretResolver`, `parseSecretRef()`, `createEnvSecretResolver()`, and `createCompositeSecretResolver()`,
- `env:` and `keychain:` refs are valid; raw keys, empty names, and unknown schemes are rejected,
- daemon provider check, run startup, live media transport, and public provider mapping resolve through the injected resolver,
- daemon exposes read-only `GET /secrets/status`,
- contracts and API client expose secret status DTOs and `getSecretStatus()`,
- Web and CLI accept/display `keychain:` refs without exposing values,
- run events, run snapshots, provider snapshots, and generated artifacts redact resolved secret values.

Not implemented in v0.1:

- macOS Keychain write/delete UI,
- renderer APIs that set or delete secrets,
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

- is injected by Desktop or another trusted host,
- returns `secret_store_unavailable` when daemon is running without keychain support,
- returns configured/missing status without value to API clients,
- returns value only inside trusted daemon execution paths.

## Daemon Integration

The daemon should use `SecretResolver` for:

- provider checks,
- run startup,
- live media transport,
- future GitHub token use,
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

## Desktop Boundary

Desktop main process owns OS keychain writes and deletes. Renderer gets only a preload
facade:

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

## Redaction

Resolved secret values must be added to the redaction context before writing:

- run events,
- provider snapshots,
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
- `/secrets/status` never returns a value,
- provider snapshots and artifacts redact resolved secrets,
- renderer preload never exposes raw secret values.

## Assumptions

- `env:` remains the default for development.
- OS keychain write/delete should be implemented before serious desktop or GitHub token work.
- No cloud secret sync exists in v0.1.
- Plugins and skills never receive raw secret values directly.
