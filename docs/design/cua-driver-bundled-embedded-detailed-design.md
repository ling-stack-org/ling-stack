# Bundled Embedded Cua Driver Detailed Design

## Status

Detailed design for the approved internal macOS Desktop alpha direction. This document
defines the target contracts; the current code still uses the external provider path.

The paired product and architecture decision is
[Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md).

## Design Goals

- Ship one reviewed Cua Driver version with packaged macOS Desktop.
- Remove the normal user's separate driver download and install step.
- Make Ling Stack the only macOS Accessibility and Screen Recording identity required by
  the embedded path.
- Keep the daemon as the authority for MCP tools, approvals, bindings, health, audit, and
  run snapshots.
- Work when Desktop reuses a compatible daemon that it did not spawn.
- Fail closed on version, protocol, artifact, bridge, permission, or process ownership
  mismatch.
- Preserve the current external provider flow for standalone/dev use without silently
  selecting it in packaged Desktop.
- Leave Windows behavior unchanged.

## Terminology And Stable Identities

| Term | Meaning |
| --- | --- |
| Plugin shell | Ling metadata under `packages/daemon/src/features/plugins/bundled/cua-driver`; it is not the native provider |
| Provider | The Ling-carried Mach-O built from upstream `cua-driver-rs-v0.8.3` plus the locked embedded-state patch |
| Embedded host | The Electron main process inside signed `Ling Stack.app` |
| Provider host | Desktop module that owns the child process and stdio MCP connection |
| MCP proxy | Desktop loopback Streamable HTTP surface that proxies to the child stdio session |
| Desktop lease | Short-lived daemon memory record advertising one authenticated proxy generation |
| Bundled mode | `bundled_embedded`; the packaged provider is authoritative |
| External mode | `external_local`; an explicitly selected executable uses the legacy stdio path |

Stable product identifiers remain:

```text
plugin id:       trusted-local:cua-driver
logical MCP id:  mcp_cua_driver
Ling bundle id:  com.lingstack.desktop
```

The historical `bundled:cua-driver` package id remains hidden compatibility data. Its
package version must never be presented as the native provider version.

## Upstream Contract

The runtime embedding boundary depends on the public MIT-licensed Cua Driver interface
shipped in upstream tag `cua-driver-rs-v0.8.3`:

<https://github.com/trycua/cua/blob/cua-driver-rs-v0.8.3/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md>

```text
cua-driver mcp --embedded --host-bundle-id com.lingstack.desktop
```

The equivalent environment contract is:

```text
CUA_DRIVER_EMBEDDED=1
CUA_DRIVER_HOST_BUNDLE_ID=com.lingstack.desktop
```

Only the exact string `1` enables embedded mode. The host bundle id is diagnostic text,
not authentication.

Embedded mode disables the provider's standalone responsibility-disclaim and
LaunchServices relaunch paths. The host must still spawn the executable directly and
communicate through line-delimited MCP JSON-RPC on stdin/stdout.

Packaging also carries one source-level state-root patch because upstream `0.8.3` does
not isolate driver-owned config from the user's standalone Cua installation. That patch
does not change MCP tools or native automation behavior and is locked separately below.

## Module Boundaries

Target modules should remain focused:

```text
apps/desktop/
  main/
    cua-driver/
      artifact-lock.ts          # read and validate the packaged lock
      provider-seal.ts          # validate the final post-sign helper identity
      resource-path.ts          # resolve only the packaged absolute path
      state-root.ts             # create the version-isolated provider state root
      embedded-host.ts          # direct child lifecycle and stdio MCP session
      mcp-proxy.ts              # authenticated loopback Streamable HTTP proxy
      lease-publisher.ts        # publish/renew/revoke the daemon lease
      permission-controller.ts  # host-owned AX and Screen Recording UX/state
      coordinator.ts            # enable/disable/restart reconciliation
      telemetry.ts              # bounded Desktop diagnostics
  resources/
    providers/cua-driver/0.8.3-ling.1/
      cua-driver
      provider-lock.json
      provider-seal.json
      LICENSE.md
      THIRD_PARTY_NOTICES.md

packages/contracts/
  src/plugins.ts                # provider distribution/setup wire state

packages/daemon/
  src/features/plugins/
    cua-driver-runtime.ts       # bundled/external runtime selection
    cua-driver-lease.ts         # in-memory active Desktop lease registry
    cua-driver-activation.ts    # health/tool sync plus generation-fenced commit
  src/features/mcp/
    transport-factory.ts        # lease -> Streamable HTTP transport
    lease-client-pool.ts        # one long-lived MCP client per lease generation
```

The final filenames can follow nearby repository conventions, but responsibilities must
not collapse into `apps/desktop/main/main.ts`, daemon routes, or the Web Plugin Manager
component.

## Provider Lock

The reviewed provider input is represented by a committed lock file. The initial schema
is:

```ts
interface BundledCuaDriverLockV1 {
  readonly schemaVersion: 1;
  readonly componentId: "cua-driver-darwin";
  readonly integrationMode: "embedded-stdio";
  readonly distributionRevision: "ling.1";
  readonly productVersionLabel: "0.8.3 (Ling build 1)";
  readonly upstream: {
    readonly repository: "https://github.com/trycua/cua";
    readonly tag: "cua-driver-rs-v0.8.3";
    readonly commit: "0612c26b2c7b8556f6de7f6b4f3927ecac914e4f";
    readonly tree: "831819eaf2b79c4d81c2b68773cd5920772e91e9";
    readonly version: "0.8.3";
    readonly releaseStage: "prerelease";
    readonly license: "MIT";
    readonly licenseSha256: string;
  };
  readonly referenceReleaseArtifact: {
    readonly filename: "cua-driver-rs-0.8.3-darwin-universal-binary.tar.gz";
    readonly sizeBytes: 15320898;
    readonly sha256: "a2a29f3ccbd45989819df639d60fa68ac6f28b844f74d7d2b0a1495e4359c6a1";
    readonly binaryArchivePath: "cua-driver";
    readonly teamId: "YCK386LBJ7";
    readonly authority: "Developer ID Application: Cua AI, Inc. (YCK386LBJ7)";
    readonly hardenedRuntime: true;
    readonly entitlementsCanonicalSha256: "5c301f02f6b64d3feb13c1b0f29f4135174132b33a828b85264aee8b8a5ac7ac";
  };
  readonly sourceBuild: {
    readonly cargoLockSha256: "098b0527c35def4fdd1d08e5dd3d1b0d5f5dda9a04b1888ec1bf15b52311c51b";
    readonly rustcVersion: string;
    readonly cargoVersion: string;
    readonly xcodeBuildVersion: string;
    readonly macOSSDKVersion: string;
    readonly targets: readonly ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    readonly patchSet: {
      readonly id: "ling-embedded-state-home-v1";
      readonly sha256: string;
      readonly touchedPaths: readonly string[];
    };
    readonly universalBinarySha256BeforeSigning: string;
  };
  readonly binary: {
    readonly architectures: readonly ["arm64", "x86_64"];
    readonly minimumMacOS: "13.0";
    readonly supportedMacOSCells: readonly [
      { readonly major: "13"; readonly architectures: readonly ["arm64", "x86_64"] },
      { readonly major: "14"; readonly architectures: readonly ["arm64", "x86_64"] },
      { readonly major: "15"; readonly architectures: readonly ["arm64", "x86_64"] },
      { readonly major: "26"; readonly architectures: readonly ["arm64", "x86_64"] },
    ];
    readonly expectedUpstreamVersion: "0.8.3";
    readonly lingBuild: 1;
    readonly hardenedRuntime: true;
    readonly requiredEntitlements: {
      readonly "com.apple.security.automation.apple-events": true;
      readonly "com.apple.security.device.screen-capture": true;
    };
    readonly requiredEntitlementsCanonicalSha256: "5c301f02f6b64d3feb13c1b0f29f4135174132b33a828b85264aee8b8a5ac7ac";
  };
  readonly runtime: {
    readonly args: readonly ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"];
    readonly stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME";
    readonly stateSchemaVersion: 1;
    readonly stateHomeRequiredInEmbeddedMode: true;
    readonly telemetryEnabled: false;
    readonly startupUpdateCheckEnabled: false;
    readonly managedUpdaterToolsAllowed: false;
  };
  readonly compatibility: {
    readonly mcpClientSdk: "@modelcontextprotocol/sdk@1.29.0";
    readonly clientInitializeProtocolVersion: "2025-11-25";
    readonly serverInitializeProtocolVersion: "2025-06-18";
    readonly healthSchemaVersion: "1";
    readonly embeddedHealthSkipChecks: readonly ["bundle_identity"];
    readonly toolsListSha256: string;
  };
}
```

`licenseSha256`, the exact source-build toolchain fields, patch digest and path list,
`universalBinarySha256BeforeSigning`, and `toolsListSha256` must contain reviewed values
before packaging can be enabled. They are not runtime-generated placeholders.

The upstream release binary remains reference evidence for the reviewed `0.8.3` release;
it is not the binary shipped by Ling. `CUA_DRIVER_STATE_HOME` does not exist in upstream
`0.8.3`, so the packaged helper must be built from the exact tag commit, `Cargo.lock`, and
the one committed Ling patch. The product-visible label is `0.8.3 (Ling build 1)` while
the upstream semantic version remains `0.8.3`.

Entitlement digests are computed from canonical JSON, not raw plist bytes: parse the
entitlement plist into key/value data, recursively sort keys, retain JSON booleans, and
serialize without insignificant whitespace. The release helper entitlement map must
equal the two-key allowlist in the lock; missing or additional release entitlements fail
the package.

`toolsListSha256` is computed from canonical UTF-8 JSON: sort tools by raw name, retain
name, description, input schema, and MCP annotations, recursively sort object keys, and
serialize without insignificant whitespace. CI must fail if two platforms or repeated
runs of the same locked macOS provider produce different canonical bytes.

Protocol fields distinguish request from response. Ling's locked MCP SDK `1.29.0` sends
`2025-11-25` in the initialize request and accepts the older supported response. Cua
Driver `0.8.3` always returns `2025-06-18`; that returned value is the provider
compatibility gate. The `2024-11-05` value in an upstream embedding example is sample
client input, not the `0.8.3` server response contract.

Any MCP SDK upgrade that changes the request version or supported-version set requires a
provider-lock change and compatibility rerun.

The lock file records source provenance. Apple code signing seals the final nested
executable and outer app. Runtime integrity uses the final post-sign provider seal and
the outer app code-resource seal, never the pre-sign source-build hash.

## Build-Time Acquisition

The release workflow builds the provider before Electron packaging:

1. Fetch the exact upstream tag commit and require the locked Git tree id.
2. Verify `Cargo.lock`, the committed patch-series digest, and the patch touched-path
   allowlist. Reject uncommitted source changes or a patch that applies with fuzz.
3. Download, safely extract, and verify the locked upstream release binary, source signer,
   hardened runtime, and entitlement digest as reference evidence only. It is never copied
   into the Ling package.
4. Apply `ling-embedded-state-home-v1`, then build `cua-driver` for
   `aarch64-apple-darwin` and `x86_64-apple-darwin` with the exact locked Rust, Cargo,
   Xcode, and macOS SDK versions using Cargo's locked dependency mode.
5. Combine the two slices with `lipo`, then verify architectures, deployment target,
   upstream `--version`, initialize response, health schema, tool digest, and the embedded
   state-isolation contract.
6. Copy the exact upstream MIT license from the locked tag and verify its digest.
7. Generate or refresh third-party Rust dependency notices/SBOM; do not assume the root
   MIT text alone covers every statically linked dependency notice obligation.
8. Stage the provider into the Desktop resource tree and sign the nested helper with the
   Ling release Developer ID, exact required entitlements, and hardened runtime.
9. Re-read the signed helper and generate `provider-seal.json` from its final bytes and
   final code-signing identity.
10. Sign the outer Electron application after both the helper and provider seal are final.
11. Record outer artifact hashes, notarization, Gatekeeper, build inputs, and the provider
    seal digest in release evidence.

Source, reference artifact, and toolchain downloads are controlled build inputs. None is
fetched by the installed product.

### Signing choice

The packaged helper is a Ling source build and must be signed by the Ling release
pipeline. TCC access is still attributed to the responsible Ling host, not merely to the
helper's Team ID.

After signing, both Mach-O slices must report hardened runtime and the exact entitlement
allowlist. `codesign --verify --deep --strict` alone is insufficient because a valid
signature can still omit or add entitlements.

The release policy must supply the expected Ling Team ID. A locally ad-hoc signed helper
can be used only for development and cannot satisfy packaged TCC or public release gates.

## Post-Sign Provider Seal

The package contains a generated manifest for the final signed helper:

```ts
interface BundledProviderSealV1 {
  readonly schemaVersion: 1;
  readonly componentId: "cua-driver-darwin";
  readonly lockSha256: string;
  readonly distributionRevision: "ling.1";
  readonly executableRelativePath: "cua-driver";
  readonly executableSha256: string;
  readonly architectures: readonly ["arm64", "x86_64"];
  readonly cdhashes: {
    readonly arm64: string;
    readonly x86_64: string;
  };
  readonly codeIdentifier: string;
  readonly teamId: string;
  readonly designatedRequirement: string;
  readonly designatedRequirementSha256: string;
  readonly hardenedRuntime: true;
  readonly entitlementsCanonicalSha256: "5c301f02f6b64d3feb13c1b0f29f4135174132b33a828b85264aee8b8a5ac7ac";
  readonly providerVersion: "0.8.3";
  readonly serverInitializeProtocolVersion: "2025-06-18";
  readonly healthSchemaVersion: "1";
  readonly toolsListCanonicalSha256: string;
  readonly stateSchemaVersion: 1;
}
```

Generation order is strict:

1. finish the nested helper's Ling Developer ID signature;
2. compute the post-sign SHA-256, per-architecture CDHashes, Team ID, designated
   requirement, hardened-runtime state, and canonical entitlement digest;
3. write `provider-seal.json` and forbid any later helper mutation;
4. sign the outer app so its code-resource seal protects both files.

Outer app, ZIP, and DMG hashes remain in release evidence because placing them inside the
provider seal would create a signing cycle. At activation, Ling validates the outer app
signature, the seal's lock digest, the actual helper bytes and code identity, and the
outer code-resource seal. A pre-sign SHA match cannot make a post-sign helper trusted.
The designated requirement is stored as normalized UTF-8 text with normalized line
endings and its digest; CDHashes are collected separately for both universal slices.

## Packaged Resource Layout

The provider must be outside `app.asar` and addressed by an absolute path derived from
`process.resourcesPath`:

```text
Ling Stack.app/
  Contents/
    Resources/
      providers/
        cua-driver/
          0.8.3-ling.1/
            cua-driver
            provider-lock.json
            provider-seal.json
            LICENSE.md
            THIRD_PARTY_NOTICES.md
```

The packaging spike may move the executable to a standard nested-helper directory if
required by strict Apple signing tools, but the logical resource id and versioned layout
must remain deterministic.

Packaged path resolution rules:

1. Read the committed provider lock.
2. Build the absolute packaged path.
3. Reject symlinks and any real path outside the expected provider root.
4. Require an executable regular file.
5. Validate the outer signature, post-sign provider seal, lock digest, and packaged
   helper identity before starting the proxy lease.
6. Never consult `PATH`, Homebrew, `~/.local/bin`, or `/Applications/CuaDriver.app` in
   `bundled_embedded` mode.

Source/dev builds may accept an explicit fixture or developer path, but must label the
mode `external_local` unless the build produced a validated local provider asset.

## Ling-Carried Embedded State Isolation Patch

Upstream `0.8.3` reads and writes driver configuration at
`$HOME/.cua-driver/config.json`. That silently inherits standalone-driver values such as
`capture_scope=desktop` and `max_image_dimension`, and `set_config` can modify the same
file. Ling therefore carries one minimal source patch that introduces
`CUA_DRIVER_STATE_HOME` for driver-owned state.

Patch contract:

- only upstream commit `0612c26b2c7b8556f6de7f6b4f3927ecac914e4f` is an accepted base;
- `CUA_DRIVER_STATE_HOME` is consulted only when upstream embedded mode is active;
- packaged embedded startup fails closed when the value is absent, empty, relative,
  symlink-escaped, or outside the Desktop-created provider state root;
- non-embedded execution ignores the variable and preserves upstream standalone paths;
- the real `HOME` remains unchanged because app discovery, browser access, path expansion,
  and user-selected recording destinations require the user's actual home directory;
- Cua-owned config, PiP config, version-check cache, and related state use the new root;
  upstream `CUA_DRIVER_TELEMETRY_HOME` is set to a child of that same root;
- config tool descriptions and diagnostics must describe the active driver-state root
  accurately instead of claiming embedded writes still target `~/.cua-driver`;
- explicit user output paths, browser profiles, application data, and files under the
  real home are not redirected;
- no external `~/.cua-driver` or `~/.cua-driver-rs` state is imported automatically.

Desktop derives the root from Electron `app.getPath("userData")`, isolates it by state
schema and provider distribution revision, creates directories with mode `0700`, creates
files with mode `0600`, and rejects symlinks:

```text
<Desktop userData>/providers/cua-driver/state/v1/0.8.3-ling.1/
  config.json
  telemetry/
  version-check/
```

Rollback reuses the previous distribution's directory; an upgrade starts from reviewed
defaults unless a future explicit migration is designed. The initial defaults remain
`capture_scope=window` and `max_image_dimension=1568`.

The patch acceptance test launches embedded mode with a sentinel-filled temporary real
`HOME`, reads and writes config, restarts the child, and runs health. External
`$HOME/.cua-driver` and `$HOME/.cua-driver-rs` must remain absent or byte-identical, while
all driver-owned writes land under the locked state root. The same binary launched in
non-embedded mode must ignore `CUA_DRIVER_STATE_HOME` and retain upstream path semantics.

## Runtime Environment

The child process receives a narrow, explicit environment:

```text
CUA_DRIVER_EMBEDDED=1
CUA_DRIVER_HOST_BUNDLE_ID=com.lingstack.desktop
CUA_DRIVER_STATE_HOME=<Desktop userData>/providers/cua-driver/state/v1/0.8.3-ling.1
CUA_DRIVER_TELEMETRY_HOME=<CUA_DRIVER_STATE_HOME>/telemetry
CUA_DRIVER_RS_TELEMETRY_ENABLED=false
CUA_DRIVER_RS_UPDATE_CHECK=false
```

The first two values enforce the upstream embedding path. The state variables isolate
driver-owned data without replacing the user's real `HOME`. The final two prevent the
Ling-managed child from sending default product telemetry or making the independent
GitHub release check performed by `mcp`, `serve`, and `doctor`.

Rules:

- Do not call `serve`, `update`, an installer, or a standalone daemon path.
- Filter or deny `check_for_update` and any future updater/install tool from the bundled
  tool catalog. The external provider mode may retain its own separately disclosed
  policy.
- Ling's managed embedded launch path never invokes or exposes provider update/install
  operations and never performs background provider downloads. Upstream `0.8.3` still
  contains the standalone CLI command `update --apply`; direct user or generic shell
  execution of that command is outside this provider-integration boundary.
- Inherit only environment variables required for normal macOS application interaction.
  Do not pass Ling secrets, provider API keys, release credentials, or bridge tokens to
  Cua Driver.
- Keep stderr diagnostic-only, bounded, and redacted. MCP stdout is protocol data and
  must never be mixed with product logs.

## Process Ownership

The accepted process tree is:

```text
launchservices / user session
  -> Ling Stack.app Electron main
       -> packaged cua-driver mcp --embedded
```

These shapes are rejected:

```text
Ling daemon -> cua-driver --embedded
terminal -> cua-driver --embedded
open / NSWorkspace -> CuaDriver.app -> cua-driver
renderer -> cua-driver
```

The reason is macOS responsibility attribution, not ordinary parent-pid aesthetics.
Desktop can reuse a daemon started outside Ling, so the daemon cannot be trusted to carry
the GUI application's TCC identity.

Runtime `check_permissions.source.attribution === "host"` is required but not sufficient.
Clean-host acceptance also verifies the real process ancestry, TCC AttributionChain logs,
and Privacy & Security rows.

## Embedded Provider Host

`EmbeddedCuaDriverHost` owns one child and one stdio MCP session per active Desktop lease
generation.

Responsibilities:

- single-flight start;
- direct `spawn` with the packaged absolute executable and locked arguments;
- line-delimited JSON-RPC framing with bounded message size;
- startup deadline, initialize handshake, and exact server version checks;
- stderr capture with secret/content redaction;
- cancellation and request-id tracking;
- graceful shutdown followed by bounded termination;
- orphan detection and cleanup;
- generation replacement after child crash, permission change, unexpected MCP session
  loss, daemon authority-epoch change, or Desktop restart.

The child starts lazily on the first authenticated daemon MCP session. Starting Desktop
alone does not activate Computer Use or raise permission prompts.

One provider session is sufficient because Desktop is bound to one daemon authority per
workspace. The daemon must reuse one initialized MCP client for the entire lease
generation. A second HTTP initialize/session for that generation is rejected; it never
creates another child or replays initialize onto the existing stdio server.

## Desktop MCP Proxy

Cua Driver natively provides stdio MCP. The daemon already supports Streamable HTTP MCP.
Desktop therefore owns a transport proxy for one logical daemon session:

```text
daemon StreamableHTTPClientTransport
  -> 127.0.0.1:<ephemeral>/mcp
  -> Desktop MCP proxy
  -> cua-driver stdin/stdout
```

Proxy rules:

- bind only to `127.0.0.1` or `::1` with an explicit loopback policy;
- choose an ephemeral port;
- require a per-Desktop-instance authorization secret derived from the existing Desktop
  bridge secret plus the Desktop instance id and lease generation;
- reject browser Origin/CORS access and non-MCP routes;
- never persist the endpoint or authorization secret;
- accept exactly one initialized Streamable HTTP session for the current lease generation;
- preserve MCP request ids, notifications, cancellation, errors, content blocks, and
  structured content without interpreting tool semantics or remapping ids across clients;
- cap request, response, image, and stderr sizes using the same or stricter limits as the
  daemon MCP broker;
- close the stdio child when the accepted session is released for disable or Desktop quit;
- on unexpected HTTP/MCP session loss, terminate the old child, invalidate the lease,
  increment generation, bind a fresh proxy session, and republish before accepting a new
  initialize. Never initialize a second client against the old stdio child.

Renderers do not receive the proxy URL or secret.

The one-client rule keeps the proxy transport-level. Supporting multiple independently
initialized daemon clients would require an application gateway that rewrites request
ids, multiplexes cancellation, and synthesizes initialize state; that is not this design.

## Desktop Lease

The daemon keeps the live Desktop provider route in memory only:

```ts
interface DesktopCuaDriverLease {
  readonly providerId: "cua-driver";
  readonly desktopInstanceId: string;
  readonly generation: number;
  readonly daemonAuthorityEpoch: string;
  readonly workspaceCwd: string;
  readonly endpoint: string;
  readonly providerVersion: "0.8.3";
  readonly distributionRevision: "ling.1";
  readonly integrationMode: "embedded-stdio";
  readonly expiresAt: string;
  readonly lockDigest: string;
  readonly providerSealDigest: string;
}
```

The authenticated Desktop bridge publishes and renews this lease. The endpoint is
loopback-only; the proxy secret is derived independently and kept in process memory.

Suggested route contract:

```text
PUT    /desktop/capabilities/cua-driver/lease
DELETE /desktop/capabilities/cua-driver/lease/:generation
```

Both routes require the existing Desktop bridge token and exact workspace authority.

Lease behavior:

- Desktop publishes after artifact validation and proxy bind, before the child starts.
- Desktop renews periodically; the daemon expires a missing heartbeat within a bounded
  interval.
- The Desktop bridge handshake carries a daemon authority epoch. A changed epoch means the
  daemon restarted or authority changed, so Desktop rotates the provider generation even
  if the Desktop process remained alive.
- A higher generation atomically replaces the previous generation.
- Replacement invalidates the old pooled client and every activation token before the
  new generation can publish ready state.
- A stale generation cannot replace, renew, or revoke the current lease.
- Desktop quit performs best-effort revoke; expiry is the crash-safe authority.
- The lease is never written to SQLite, plugin events, ordinary logs, or run snapshots.

## Daemon Runtime Resolution

The persisted `mcp_cua_driver` record remains the logical capability and enabled/disabled
source of truth. Runtime transport resolution depends on the explicit distribution mode:

```text
bundled_embedded
  -> require active compatible Desktop lease
  -> acquire the lease-generation MCP client from the in-memory pool

external_local
  -> use the existing persisted stdio executable path
```

The lease transport and pooled client are not saved back into the MCP server row. This
prevents stale ports and proxy secrets from surviving a Desktop restart.

Packaged macOS chooses `bundled_embedded` by default. It returns a stable
`desktop_provider_unavailable` error if no valid lease exists. It must not fall through
to an existing external command.

A reused daemon must advertise support for the lease protocol during the existing Desktop
bridge compatibility probe. If it does not, Desktop treats it as bridge-incompatible
rather than opening the product with a partially working provider path.

### Lease-generation MCP client pool

The current broker creates, initializes, and closes an MCP client for every check, list,
and tool call. Bundled embedded mode must replace that behavior with a pool entry keyed by
logical server id, Desktop instance id, daemon authority epoch, lease generation,
endpoint, and lock digest.

Each entry owns:

- one serialized connection promise and one initialized `McpClient`;
- the resolved secret statuses and negotiated server protocol;
- an in-flight operation count plus cancellation forwarding;
- the lease expiry and a generation-level abort controller.

`checkServer`, `listTools`, health calls, and normal tool calls acquire the same entry and
may run concurrently through the SDK after initialization. The bundled path must not use
the raw HTTP list fallback because that would create an uninitialized side channel.

The pool closes an entry on lease replacement or expiry, plugin disable, distribution-mode
switch, Desktop quit, protocol failure, or daemon shutdown. A stale generation can never
reopen or retain the prior client. Closing waits a bounded interval for active operations,
then cancels them and closes the SDK client exactly once.

Client cancellation is not a persistence fence. Every asynchronous check, list, health,
and activation result carries the captured Desktop instance id, daemon authority epoch,
lease generation, lock digest, activation epoch, and requested-enable revision. Before
any status, tool catalog, or enabled flag is written, the daemon performs a generation
compare-and-swap against current state. Results
from a replaced generation or superseded user intent are discarded even if the old
operation completed successfully after cancellation.

## Activation Transaction

The existing user enable action remains the consent boundary.

Bundled mode separates durable user intent from effective tool availability:

```text
requestedEnabled = user wants the provider on
effectiveEnabled = artifact + lease + protocol + health + permissions all pass
```

The user enable action persists `requestedEnabled=true` and increments a requested-enable
revision. The existing plugin, contribution, and MCP `enabled` flags continue to represent
effective availability and remain false until the transaction commits. This lets a
permission flow survive a Desktop restart without making tools eligible early. Disable
clears the requested flag and advances the revision before process shutdown.

Bundled activation is:

1. Confirm packaged macOS and `bundled_embedded` distribution.
2. Require an active compatible Desktop lease.
3. Issue a monotonic activation epoch and capture a token containing it, requested-enable
   revision, Desktop instance id, daemon authority epoch, lease generation, lock digest,
   and provider seal digest. Keep all persisted effective enabled flags false.
4. Create an in-memory activation server view with `enabled=true` and acquire the
   lease-generation pooled MCP client. This internal view permits probing without making
   the persisted contribution or tools eligible. The Desktop proxy lazily starts the
   child and accepts this single initialize session.
5. Complete MCP initialize. Require client request `2025-11-25`, server response
   `2025-06-18`, and server version `0.8.3`; also require that the response version remains
   in the locked SDK's supported-version set.
6. Call `health_report` with `{"skip":["bundle_identity"]}` and require schema `1`.
   Upstream `0.8.3` hard-codes that check to standalone `com.trycua.driver`, so it is not
   a valid embedded identity check. Bundled mode consumes structured status only and never
   displays raw upstream health hints, because several `0.8.3` macOS hints direct users to
   standalone `CuaDriver.app`; Ling's permission controller supplies embedded repair UX.
7. Call `check_permissions` with `{"prompt":false}` and verify
   `source.attribution === "host"` as a sanity check.
8. If permissions are missing and the activation token is still current, keep effective
   enabled flags false, retain the user's requested-enabled intent, and project
   `permission_required`; Desktop owns the next user-triggered permission action.
9. If permissions are ready, list tools, apply the Cua approval overlay, and remove denied
   updater tools in memory.
10. Compare-and-swap the activation token against current intent and lease state. Only on
    an exact match atomically replace tools and set the plugin, contribution, and logical
    MCP server effective-enabled flags true.
11. Freeze the final committed capability set into subsequent run snapshots.

Intermediate ready snapshots and discovered tools remain activation-local. A current
token may persist normalized `permission_required` or failure health while effective
flags remain false; final `ready`, tools, and enabled flags commit in one store
transaction. No run snapshot can observe the activation-local catalog.

For the filtered health report, `binary_version`, `platform_supported`, and
`session_active` must pass. TCC or live capability failures project
`permission_required`; malformed schema or core-check failure is incompatible. Host
identity remains proven by the actual parent process, `check_permissions`, signed
clean-host TCC AttributionChain evidence, and Privacy & Security rows.

Any artifact, lease, connection, version, protocol, health, or tool-sync failure leaves
the plugin, contribution, and logical MCP server disabled/unavailable. A stale activation
result is discarded without changing current health, tools, or enablement.

Permission-required is recoverable setup state, not artifact corruption. After the host
obtains a grant, Desktop restarts the child and the daemon resumes the requested activation
transaction without requiring a second Enable click.

## Permission Controller

Desktop owns both macOS permission flows.

Accessibility:

- inspect via Electron/macOS host APIs;
- prompt only after explicit user action;
- show System Settings repair guidance when denied or removed.

Screen Recording:

- inspect from the host application;
- use the existing Electron capture path to trigger and verify the host grant;
- require a live capturability probe, not only a cached preflight boolean.

General rules:

- The embedded child never raises its own permission prompt.
- After either grant changes, stop and restart the child before trusting the next result.
- Do not reset TCC automatically.
- Do not equate provider presence with permission readiness.
- Do not claim success from a black screenshot, empty AX tree, or cached `true` when the
  live probe fails.
- If Ling later enables App Sandbox, this embedded contract must be re-reviewed before a
  release; the current design assumes a non-App-Sandbox host.

The shared Web surface reaches the host permission controller only through a narrow typed
Desktop preload capability, for example `computerUse.requestHostPermissions()`. The
capability returns normalized permission state only. Browser/standalone surfaces do not
receive this method and show `desktop_unavailable` or the external fallback instead.

## Supported macOS Matrix

`LC_BUILD_VERSION minos=13.0` proves only that the Mach-O can be loaded by macOS 13 or
newer. It does not prove runtime compatibility. Cua Driver `0.8.3` uses the private
SkyLight SPI for background mouse and keyboard delivery, so Ling declares Computer Use
support only for signed, installed-app cells with archived evidence.

For the 2026-07-17 internal-alpha baseline, the required GA matrix is:

| macOS major | Architectures | Required status before declaring support |
| --- | --- | --- |
| 13 Ventura | arm64 and supported x86_64 hardware | Signed installed-app acceptance |
| 14 Sonoma | arm64 and supported x86_64 hardware | Signed installed-app acceptance |
| 15 Sequoia | arm64 and supported x86_64 hardware | Signed installed-app acceptance |
| 26 Tahoe | arm64 and supported x86_64 hardware | Signed installed-app acceptance |

Because this matrix claims Ventura support, the outer app must declare
`LSMinimumSystemVersion=13.0` exactly. The bundled provider must retain
`LC_BUILD_VERSION minos=13.0`, and every other shipped Mach-O must have a deployment
target at or below `13.0`; any component requiring 14 or newer blocks the macOS 13 cell.
A successful notarization, deployment target, or test on one major must not be
extrapolated to another cell.

Every claimed cell verifies:

- signed Ling launch from `/Applications`, provider seal, spawn, and MCP initialize;
- Accessibility and Screen Recording denied, granted, revoked, and re-granted;
- live ScreenCaptureKit window/display capture and a non-black frame;
- Finder/AppKit AX read and action;
- Chromium/Electron background click and typing;
- agent cursor overlay and cleanup;
- child restart, Desktop quit, lease expiry, and no process/listener residue;
- real behavior when a required SkyLight symbol or delivery path is unavailable, not only
  symbol presence.

The provider lock's `supportedMacOSCells` is the finalizer's required set. Evidence is
indexed by `(macOS major, execution architecture)`, not architecture alone. Each TCC and
provider report records both full `host.macosVersion` and normalized `host.macosMajor`;
the schema constrains the major to its manifest cell, and the finalizer recomputes the
major from `sw_vers` output before acceptance.

For the initial four-major, two-architecture matrix, denied/prompt/granted/revoked means
32 distinct TCC reports. Each revoked report is an ordered recovery record for the same
cell and candidate: active capture -> manual revoke -> observed capability loss -> manual
re-grant -> child restart -> health/capture/input recovery. The granted report for each
cell also binds AX, live capture, AppKit input, Chromium/Electron background input,
cursor, and SkyLight behavior to the same signed candidate executable. A report path or
digest cannot satisfy two cells, and missing or duplicate cell coverage fails closed.
Existing architecture-only/two-phase evidence schemas and finalizer loops must be upgraded
before this matrix can close; merely storing an unchecked `macosVersion` string is
insufficient.

Developer-beta macOS runs are early-warning evidence, not a GA release gate. Adding or
dropping a supported major requires an explicit release-policy and matrix update.

## Setup Projection

The current `local_binary` setup model must distinguish distribution, integrity, bridge,
and permission state.

Target wire shape:

```ts
type CuaDriverDistribution = "bundled_embedded" | "external_local";

type CuaDriverSetupState =
  | "included"
  | "desktop_unavailable"
  | "permission_required"
  | "ready"
  | "incompatible"
  | "corrupt"
  | "external_missing"
  | "external_detected"
  | "external_connected";

interface CuaDriverSetupView {
  readonly kind: "computer_use_provider";
  readonly distribution: CuaDriverDistribution;
  readonly state: CuaDriverSetupState;
  readonly checkedAt: string;
  readonly requestedEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly providerVersion?: string;
  readonly providerDistributionRevision?: string;
  readonly providerDisplayVersion?: string;
  readonly expectedProviderVersion?: string;
  readonly integrity?: "verified" | "failed" | "unknown";
  readonly bridge?: "available" | "missing" | "incompatible";
  readonly permissions?: {
    readonly accessibility: "granted" | "denied" | "prompt" | "unknown";
    readonly screenRecording: "granted" | "denied" | "prompt" | "unknown";
    readonly capturable?: boolean;
  };
  readonly externalOverride?: {
    readonly command: string;
    readonly explicit: true;
  };
  readonly guide?: ManagedPluginInstallGuide;
}
```

The external install guide is returned only for `external_local` plus
`external_missing`. A damaged bundled component directs the user to update or reinstall
Ling, never to run the Cua public installer.

## Visible State Matrix

| Condition | State | Enabled tools | User action |
| --- | --- | --- | --- |
| Valid packaged artifact, plugin disabled | `included` | None | Enable |
| Desktop lease missing | `desktop_unavailable` | None | Open/restart Desktop |
| Version/protocol mismatch | `incompatible` | None | Update/reinstall Ling |
| Signature/hash/path invalid | `corrupt` | None | Reinstall Ling |
| AX or screen grant missing | `permission_required` | None | Review permissions |
| Artifact, lease, health, and permissions pass | `ready` | Policy-filtered catalog | Disable |
| Explicit external command missing | `external_missing` | None | External install guide/path |
| Explicit external command found but disabled | `external_connected` | None | Enable override |

## Disable, Quit, Crash, And Restart

### Disable

1. Clear durable requested-enabled intent and prevent new provider calls.
2. Wait a bounded interval for active calls or cancel them.
3. Close the daemon MCP client.
4. Ask Desktop proxy to stop the child.
5. Mark contribution, server, and plugin disabled.
6. Keep macOS grants unchanged.

### Window close or hide

Do not stop the child while the Desktop application remains running and the plugin is
enabled. Provider lifetime follows the app process, not BrowserWindow visibility.

### Desktop quit

Revoke the lease, close the proxy, terminate the child, and leave the external/reused
daemon running. Active provider calls fail with a stable unavailable/cancelled result;
unrelated work continues.

### Child crash

Invalidate the current MCP session and health, capture bounded exit diagnostics, and
allow one serialized restart when the plugin remains enabled. Repeated crashes enter a
failed state and require user retry; they do not loop forever or select an external
binary.

### Desktop restart

Publish a new instance id and lease generation. The daemon discards the old generation,
reconnects, rechecks version/permissions, and synchronizes tools before marking ready.

### Daemon restart or MCP session loss

When Desktop remains alive but the daemon authority epoch changes or the accepted MCP
session disappears unexpectedly, Desktop stops the current child and proxy session,
increments the lease generation, and republishes a fresh endpoint. The new daemon may
initialize only that new generation. A bounded serialized restart prevents reconnect
storms; repeated loss enters `desktop_provider_unavailable` until user retry.

## Upgrade And Rollback

Ling does not expose or use an independent update channel for the embedded provider. The
upstream binary's standalone updater remains outside the managed Desktop path described
here.

Upgrade sequence:

1. Stop the old Desktop child before replacing the application.
2. Install the signed Ling update containing the new reviewed provider and lock.
3. Start Desktop with the same Ling bundle id and release Team ID.
4. Validate the new artifact and publish a new lease generation.
5. Recheck TCC, live capture, MCP protocol, health schema, and tool catalog.
6. Require re-grant UX if macOS invalidated the previous signing requirement.

Rollback sequence:

1. Quit Desktop and its child.
2. Reinstall the previous accepted Ling artifact.
3. Validate the previous lock and provider.
4. Re-run the same permission and health checks.

Do not replace the provider inside an already signed Ling app, repoint a runtime symlink,
or call the Cua installer. The rollback unit is the signed Ling release.

Release retention must keep the previous Ling artifact, provider lock, upstream asset
digest, third-party notices, and acceptance report for the supported rollback window.

## External Override

External mode exists for advanced development and standalone products, not as automatic
recovery.

Rules:

- The user or developer must explicitly select `external_local` and an absolute command.
- Packaged UI labels the active override and its detected version.
- Switching modes disables the current MCP session, stops the child, and performs a full
  health/tool resync.
- Removing the override restores the bundled provider on the next enable.
- A saved legacy command is retained for audit but does not become an implicit override.
- The external provider keeps its own install/update/TCC behavior and is outside the
  bundled compatibility guarantee.

## Approval Policy

Distribution mode does not weaken tool policy.

The existing clearly read-only allowlist may remain allowed after tool sync. The
following families remain `ask` or stronger:

- screenshots and page extraction;
- application launch, quit, activation, and window mutation;
- click, type, scroll, hotkey, drag, and other input;
- configuration mutation;
- recording and replay;
- any future tool whose side effects are unknown.

Bundled mode additionally denies provider update/install tools. Plugin enablement does
not create teammate bindings or add tools to an existing run snapshot retroactively.

## Security Threat Model

| Threat | Required control |
| --- | --- |
| Malicious `cua-driver` earlier on `PATH` | Packaged mode resolves only the validated in-app absolute path |
| Tampered nested executable | Source digest, extracted binary digest, nested signing, outer signing, strict notarization/Gatekeeper |
| Local browser calls the proxy | Loopback bind, no CORS, origin rejection, per-instance secret, no renderer disclosure |
| Stale Desktop endpoint reused | Memory-only lease, expiry, instance id, monotonic generation |
| Reused daemon spawns its own provider | Runtime resolution uses the Desktop lease; daemon spawn is forbidden in bundled mode |
| Provider escapes Ling TCC identity | Direct child requirement, embedded mode, process/TCC acceptance evidence |
| Provider sends telemetry or update-check traffic during managed use | Explicit environment opt-outs, isolated state, denied update tool, and network-free managed-path test |
| Provider bypasses daemon approvals | Proxy is transport-only; agent calls originate in daemon broker/policy path |
| Crash leaves input-capable orphan | Desktop-owned child handle, quit cleanup, lease expiry, process residue test |
| Old external install answers requests | No standalone daemon handoff; acceptance checks process path and instance generation |
| External config widens capture or changes image behavior | Embedded-only state root, reviewed defaults, version isolation, and no import from the real home |
| SkyLight SPI drifts across macOS releases | Disclosed private dependency plus signed per-major compatibility cells; no support extrapolation from deployment target |

## Privacy And Diagnostics

Allowed ordinary diagnostics:

- distribution mode;
- expected and observed provider version;
- lock digest prefix;
- bridge state and generation without endpoint/token;
- permission enum values without screen content;
- child exit class and bounded timing;
- health check names and pass/fail state.

Never log:

- bridge tokens or full endpoints;
- screenshots or image bytes;
- AX trees;
- typed text or tool arguments;
- window titles, application names, URLs, or file paths from provider responses;
- raw MCP payloads;
- Cua telemetry installation ids or update cache contents.

## Stable Errors

Suggested error codes:

| Code | Meaning |
| --- | --- |
| `cua_bundled_artifact_missing` | Expected packaged provider path is absent |
| `cua_bundled_artifact_invalid` | Lock, path, hash, architecture, or signature validation failed |
| `cua_bundled_version_mismatch` | `--version` or MCP server version differs from the lock |
| `cua_desktop_lease_unavailable` | No current compatible Desktop provider lease |
| `cua_desktop_lease_stale` | Lease generation or expiry check failed |
| `cua_embedded_spawn_failed` | Electron main could not start the locked child |
| `cua_embedded_protocol_mismatch` | MCP initialize/schema/tool surface is incompatible |
| `cua_embedded_permission_required` | Host Accessibility or Screen Recording is not ready |
| `cua_embedded_attribution_invalid` | Embedded sanity/acceptance identity checks failed |
| `cua_embedded_child_exited` | Child exited during an active session |
| `cua_external_override_invalid` | Explicit external command is absent or incompatible |

Messages shown to users must not expose absolute internal resource paths, tokens, raw
stderr, or signature internals. Those details belong in redacted release/support bundles.

## Verification Matrix

### Lock and supply chain

- exact tag, commit, Git tree, prerelease state, reference-asset filename, size, and SHA;
- traversal- and symlink-safe reference archive extraction;
- exact `Cargo.lock`, Rust/Cargo/Xcode/SDK versions, patch digest, and touched-path allowlist;
- clean patch application and universal binary SHA before signing;
- arm64 and x86_64 slices;
- minimum macOS, upstream `0.8.3`, and Ling distribution revision `ling.1`;
- reference-release signer plus final hardened-runtime and exact entitlement allowlist;
- MIT license digest and third-party notices/SBOM;
- SDK request `2025-11-25`, provider response `2025-06-18`, health schema, embedded
  health skip list, and tools-list digest.

### Package

- arm64 and x64 Ling artifacts contain one locked provider outside `app.asar`;
- no standalone `CuaDriver.app`, installer, updater script, or PATH shim is packaged;
- nested helper and outer app pass `codesign --verify --deep --strict`;
- final helper bytes, per-slice CDHashes, Team ID, designated requirement, hardened
  runtime, and canonical entitlements match `provider-seal.json`;
- the outer app code-resource seal covers both the final helper and provider seal;
- DMG and ZIP contents bind to the same provider identity;
- notarization, staple, Gatekeeper, and mounted-DMG smoke pass;
- packaged tests prove a conflicting PATH version is ignored.

### Runtime and bridge

- Desktop main is the direct child owner;
- compatible reused daemon uses the Desktop lease rather than spawning a provider;
- wrong token, origin, workspace, expired lease, and stale generation fail closed;
- one lease generation creates one daemon MCP client, one initialize sequence, one proxy
  session, and one child; a second initialize is rejected;
- requested enable keeps persisted plugin/contribution/MCP flags false until the final
  generation compare-and-swap commits, so probing never exposes tools early;
- check/list/health/call concurrency reuses the pooled client and preserves MCP calls,
  notifications, cancellation, content, and structured errors;
- delayed generation G check/list/health results cannot overwrite generation G+1 status,
  tools, or enabled flags after lease replacement, disable, or retry;
- with Desktop still running, daemon restart or unexpected MCP session loss stops the old
  child, rotates authority epoch/generation, republishes, and completes exactly one fresh
  initialize without reusing the old stdio session;
- bundled mode never enters the raw HTTP tools-list fallback;
- `health_report` skips `bundle_identity`, while core checks, `check_permissions`, process
  ancestry, and TCC evidence enforce embedded health and host identity;
- enable/disable, child crash, Desktop restart, and daemon reconnect are single-flight;
- Desktop quit leaves no provider or proxy process/listener residue.

### State isolation

- embedded mode requires an absolute, version-isolated `CUA_DRIVER_STATE_HOME` under
  Desktop `userData` and rejects symlink escape;
- config read/write, restart, PiP config, telemetry markers, and version-check state touch
  only the locked state root;
- sentinel external `~/.cua-driver` and `~/.cua-driver-rs` remain absent or byte-identical;
- non-embedded mode ignores the Ling variable and retains upstream standalone semantics;
- upgrade and rollback do not silently migrate state across distribution revisions.

### TCC clean-host

- run the installed signed app from `/Applications`, not a mounted DMG;
- denied, prompt, granted, revoked, and re-granted Accessibility cases;
- denied, prompt, granted, revoked, and re-granted Screen Recording cases;
- each revoked report proves the ordered same-cell transition through re-grant, child
  generation restart, and recovered health/capture/input before it can pass;
- Privacy & Security lists Ling Stack only for the embedded path;
- no second Cua Driver prompt or row appears;
- `check_permissions` reports host attribution and live capturability;
- TCC AttributionChain evidence names the Ling host;
- Finder AX read, window screenshot, background input, and agent cursor pass;
- permission changes restart the child before success is reported.

### macOS version compatibility

- signed installed-app acceptance passes for every declared macOS 13, 14, 15, and 26
  architecture cell;
- evidence schemas, manifests, and the finalizer key coverage by normalized macOS major
  plus execution architecture, reject cross-cell report reuse, and require all 32 TCC
  case reports for the initial matrix;
- each cell covers AX, live capture, AppKit and Chromium/Electron background input,
  cursor overlay, restart, and cleanup;
- SkyLight failures are exercised as behavior, not inferred from symbol presence;
- outer `LSMinimumSystemVersion` equals `13.0`, the provider `minos` equals `13.0`, and
  every other shipped Mach-O deployment target is at or below `13.0`;
- no support claim is extrapolated from `minos`, notarization, or another macOS major.

### Upgrade and rollback

- N-1 Ling plus provider to N Ling plus provider;
- no old child or daemon handoff survives update;
- same Ling bundle/team identity preserves grants where macOS permits;
- changed or revoked grants produce explicit recovery instead of false readiness;
- reinstalling N-1 restores its locked provider and protocol surface;
- Ling-managed startup, health, and tool use do not invoke the updater or emit provider
  update-check/telemetry traffic; generic direct shell execution remains outside scope.

### Product and compatibility

- packaged macOS shows included/permission/ready/repair states, not the install drawer;
- standalone/dev external mode keeps missing/detected/connected/ready and install guide;
- historical plugin records do not produce duplicate rows or MCP resources;
- GUI mutation tools remain approval-gated;
- no Windows provider, NSIS, allowlist, or acceptance fixture changes.

## Release Gates

Internal alpha can ship only after:

- the complete provider lock contains reviewed non-placeholder values;
- the source patch, post-sign provider seal, package, state, and runtime matrices pass;
- all claimed macOS-major and architecture cells pass signed installed-app acceptance;
- managed-path telemetry and update network checks are proven disabled;
- the Desktop-owned process and lease architecture passes with a reused daemon;
- signed clean-host TCC evidence proves the single Ling permission identity.

Public release additionally requires one of:

1. a stable upstream Cua Driver version that passes the same locked review; or
2. an explicit release-policy exception accepting prerelease `0.8.3`, with external
   reviewer evidence bound to the exact signed Ling artifacts.

## Unresolved Decisions

No product or architecture choice remains open for the internal alpha:

- provider: upstream Cua Driver Rust `0.8.3` plus locked Ling build `1` state patch;
- ownership: Electron main direct child;
- transport: Desktop stdio-to-Streamable-HTTP proxy plus memory-only daemon lease;
- permission identity: Ling Stack;
- update and rollback unit: signed Ling Desktop release;
- external provider: explicit fallback only;
- Windows: unchanged.

Two release inputs still require concrete values before implementation can package a
candidate: the exact Ling release Team ID and exact Rust/Cargo/Xcode/macOS SDK toolchain.
Deferring either prevents reproducible signing and makes the provider lock incomplete; it
does not reopen the architecture. Public distribution separately remains gated on a
stable upstream provider or an explicit prerelease exception.
