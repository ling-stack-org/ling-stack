# Runtime, Provider, and Secrets Inheritance

Status: Slice 4 runtime inheritance implemented; provider profiles and keychain cleanup remain follow-up slices
Date: 2026-06-14
Scope: Field-level runtime defaults, provider profile import semantics, and secret reference boundaries for the two-layer configuration model.

## Summary

The user layer can seed new workspace behavior, but the workspace layer remains the execution authority. The rule is:

```text
user layer = defaults and templates
workspace layer = executable policy and durable run evidence
run snapshot = immutable evidence for that run
```

This means runtime settings inherit user defaults field by field until the workspace writes a runtime settings file. Provider profiles are importable templates, not live dependencies. Secrets cross layers only as refs and status, never as raw values.

## Runtime Settings

Runtime settings are resolved field by field:

| Field | Resolution order | Implemented behavior |
| --- | --- | --- |
| `defaultRunnerId` | workspace runtime file -> user `runtimeDefaults.defaultRunnerId` -> built-in `pi` | User value must resolve to an enabled runner. Invalid or disabled runners warn and fall back. |
| `explicitRunnerFallback` | workspace runtime file -> user `runtimeDefaults.explicitRunnerFallback` -> built-in `disabled` | Explicit requests stay fail-closed unless the user/workspace explicitly changes the field. |
| `implicitRunnerFallback` | workspace runtime file -> user `runtimeDefaults.implicitRunnerFallback` -> built-in `allow_to_default` | User default can make new workspaces stricter without editing each workspace. |
| `allowedRunnerIds` | workspace runtime file -> enabled runners from registry | User layer does not set the allowed list in this slice. |

`GET /config/effective` reports the source per runtime field:

```json
{
  "values": {
    "runtime": {
      "defaultRunnerId": {
        "value": "pi",
        "source": "user",
        "path": "/Users/me/.ling-stack/config.json",
        "key": "runtime.defaultRunnerId"
      }
    }
  }
}
```

`PATCH /runtime/settings` writes a complete workspace `runtime-settings.json` using the current effective settings plus the patch. After this write, all runtime fields present in that file are workspace-owned. This is intentional: saving runtime settings turns inherited defaults into an explicit workspace policy.

Invalid user runtime defaults are non-fatal diagnostics. Workspace runtime settings remain strict and may reject invalid fields because they are execution policy.

At daemon startup, this same resolution runs for the default workspace as part of the
startup readiness chain. User defaults are re-read on each process start, then merged
with workspace runtime settings into an in-memory effective config snapshot. That
snapshot is explanatory state only; run creation still validates runtime policy before
claiming work and rejects invalid workspace runtime policy fail-closed.

## Provider Profiles

The provider split uses two product nouns:

| Noun | Layer | Purpose | Mutability effect |
| --- | --- | --- | --- |
| Provider profile | User | Reusable personal template, refs only | Changing it never changes existing workspace runs or presets automatically. |
| Provider preset | Workspace | Runtime-selectable provider record referenced by channels, teammates, and runs | Changing it affects future workspace use according to existing preset rules. |
| Provider snapshot | Run | Redacted evidence captured at run creation | Immutable after the run starts. |

Import flow:

```text
~/.ling-stack/providers/profiles.json
-> explicit import/update action
-> provider_presets row in <workspace>/.ling-stack/ling-stack.sqlite
-> redacted run snapshot at run creation
```

The import action should copy the profile fields into a workspace preset and may store provenance:

```ts
interface ProviderPresetProvenance {
  readonly sourceKind: "user_profile" | "template" | "manual";
  readonly sourceId?: string;
  readonly importedAt?: string;
}
```

The Web UI may show "profile changed, refresh this workspace preset?" but must require an explicit user action. Runtime code must never dereference a mutable user profile while starting a run.

## Secrets And Keychain

Secret inheritance is refs-only:

| Data | User layer | Workspace layer | Run snapshot |
| --- | --- | --- | --- |
| Secret ref such as `env:OPENAI_API_KEY` or `keychain:provider_openai` | Allowed | Allowed | Allowed if redacted and needed for evidence |
| Configured/missing status | Allowed | Allowed | Allowed |
| Raw secret value | Not allowed in JSON config | Not allowed in SQLite preset rows except existing `local:` provider compatibility | Never allowed |

The current `local:<providerId>` provider path remains a workspace-local compatibility mechanism. It must not expand to GitHub tokens, MCP secrets, webhook secrets, plugin secrets, or generic automation tokens.

Keychain support is fail-closed until a trusted desktop/keychain resolver is available:

- `keychain:` refs parse and persist as stable refs.
- secret status can report `secret_store_unavailable`.
- clients receive configured/missing/unavailable status, not values.
- doctor should warn when local provider secrets exist and keychain support is available.

## Implementation Boundaries

- Runtime inheritance is implemented in the daemon loader and applies to execution paths that call `loadWorkspaceRuntimeSettings()`.
- `/config/effective` sanitizes user runtime defaults once and reports per-field source metadata.
- Provider profile import remains a follow-up API and UI slice.
- Generic provider keychain write/delete remains a follow-up desktop slice.
- No migration may copy or re-encrypt secret values without explicit user action.

## Tests

Required runtime coverage:

- missing user config returns built-in runtime defaults,
- valid user runtime defaults source fields from user config,
- invalid user runtime defaults warn and fall back,
- workspace runtime fields override user defaults field by field,
- `PATCH /runtime/settings` solidifies inherited fields into workspace source.

Provider and secrets follow-up coverage:

- importing a profile creates a workspace preset snapshot,
- changing a profile does not mutate an existing preset,
- run creation snapshots the workspace preset and redacts secret refs/status,
- `keychain:` reports unavailable without a resolver and never returns a value,
- `local:` provider secrets remain readable only through the existing provider compatibility path.

## Related

- [Two-Layer Configuration](two-layer-configuration.md)
- [Startup Readiness Chain](startup-readiness-chain.md)
- [Secrets and Keychain](secrets-keychain.md)
