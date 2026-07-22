# Bundled Embedded Cua Driver Detailed Design

## Status

Detailed design for the approved internal macOS and Windows Desktop alpha direction.
The shared contracts, feature gates, signing feasibility, activation fences, Desktop
supervisor, source-build pipeline and process-wide Desktop runtime composition are
implemented. The gate-off Darwin adapter implements Mach-O/code-sign identity,
direct-child lifecycle, host-owned TCC readiness and retrying permission-change
monitoring. The Win32 standard adapter implements policy-pinned identity, state-root
ACL/reparse protection, direct-child lifecycle, active-child readiness and Electron
recovery hints. A process-wide platform owner now loads the exact host policy from a fixed,
bounded, non-symlink resources path, owns the Darwin monitor/Win32 binding across authority
rotation and disposes after coordinator shutdown. A transient Darwin monitor-start failure
uses an unavailable binding; a later successful start on the same authority replaces that
fail-closed coordinator instead of requiring a Ling restart. The Desktop runtime now publishes lazy
coordinator availability and fences daemon status/authority loss. A separate authenticated
non-ready availability report uses Desktop instance/connection authority plus generation
and sequence fencing. It can retire a lease and project exact repair state but cannot report
`ready`. The daemon activation transport/fence foundation and
its composition have landed:
startup reset runs before route binding; first lease publication and replacement reconcile
retained intent; renewal reuses the same authenticated generation client; revoke and expiry
clear effective state and close the pool; the canonical plugin routes use the activation
transaction; the shared generation broker and generic MCP route fence prevent raw or
non-atomic bypass; runner cancellation and post-result checks discard late calls; and the
Catalog projects requested versus effective enablement only while exact host-platform
authority and a current Desktop lease remain live. The new composition is inert while
the gate is off, so external behavior and persisted external commands remain unchanged.
Opt-in pre-sign package staging and the
Darwin/Win32 native no-replace atomic publisher core are implemented without release signing
or promoted native final-identity authority. The normal package commands now use one
governed wrapper: provider-disabled builds remain unchanged, while explicit package
authority invokes production staging, generates the fixed trust-policy/capability documents,
adds the verified private resource root, and runs provider sign/seal plus post-sign/final
artifact verification. Per-output/architecture bindings prevent Electron Builder multi-arch
state reuse. Package intent is read from packaged `package.json` inside signed `app.asar`,
whose bytes are bound to the host executable by Electron's ASAR-integrity fuse. The governed
config enables `asar`, `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar`
for external-only packages as well as provider-bearing packages. Provider-bearing intent is
therefore still bundled-authoritative when a loose capability or runtime-policy file is
missing, malformed or fails its signed digest; runtime stays unavailable and never falls
back to `PATH`, Homebrew or `/Applications/CuaDriver.app`. Production staging authority is
pinned to the committed trust root and real verifier. The review-only promotion generator
now independently reverifies native candidates A/B, rereads bounded immutable snapshots,
requires identical stable artifact maps and emits separate macOS/Windows proposal artifacts
with `MANUAL_REVIEW_REQUIRED`; it never mutates the committed lock or source inputs.
The Plugin Manager renderer now maps the V2 bundled provider state through a dedicated pure
view model. The canonical `trusted-local:cua-driver` row remains the only visible row, the
historical package shell stays hidden, requested intent and effective readiness remain
separate, and bundled repair states cannot open the external install drawer. macOS and
Windows state copy, Windows standard-tier limitations, English/Chinese copy and renderer
E2E coverage are implemented; packaged clean-host product smoke remains a later release
gate.
Complete output-parent
staging/cleanup mutation sections use a cross-process native parent lease; temp-root
parent/root identities bind security and
publication, and retained failures have bounded identity-bound cleanup, including the
strict empty-unsecured-root fallback, rather than path-only recursive deletion. The final
artifact fixture uses macOS `--mac dmg zip` with verified roles `outer-dmg` and `outer-zip`,
and Windows `--win nsis` with verified role `outer-nsis`; `.blockmap` sidecars never count as
verified artifacts. The macOS run proves the packaged provider, generated runtime
policy/capability and post-seal digest stability. The committed lock still enables no
platform and contains no native binary, so promoted native payloads, release signing, a real provider-bearing
`Ling Stack Setup.exe`, Windows hosted-runner validation and real-machine acceptance are
not complete. Both Darwin and Win32 packaged-provider production gates remain off, so
packaged runtime still uses the external provider path. This does not complete
`bundled_embedded`; an active `external_local` installation such as
`/Applications/CuaDriver.app` must not be removed yet.

The paired product and architecture decision is
[Bundled Embedded Cua Driver](cua-driver-bundled-embedded.md).
The staged delivery plan is
[Bundled Embedded Cua Driver Implementation Plan](cua-driver-bundled-embedded-implementation-plan.md).

## Design Goals

- Ship one reviewed Cua Driver version with packaged macOS and Windows Desktop.
- Remove the normal user's separate driver download and install step.
- Make Ling Stack the only macOS Accessibility and Screen Recording identity required by
  the embedded path.
- Keep the Windows provider in the Desktop user's interactive session and state its
  integrity coverage without pretending a per-user install satisfies UIAccess.
- Keep the daemon as the authority for MCP tools, approvals, bindings, health, audit, and
  run snapshots.
- Work when Desktop reuses a compatible daemon that it did not spawn.
- Fail closed on version, protocol, artifact, bridge, permission, or process ownership
  mismatch.
- Preserve the current external provider flow for standalone/dev use without silently
  selecting it in packaged Desktop.
- Produce a deterministic Windows acceptance handoff even though Windows colleagues own
  real-machine execution and sign-off.

## Terminology And Stable Identities

| Term | Meaning |
| --- | --- |
| Plugin shell | Ling metadata under `packages/daemon/src/features/plugins/bundled/cua-driver`; it is not the native provider |
| Provider distribution | The Ling-carried platform binaries built from upstream `cua-driver-rs-v0.8.3` plus the locked managed-embedding patch series |
| Embedded host | The Electron main process inside the tier-appropriate Ling Desktop package |
| Provider host | Desktop module that owns the platform process group and stdio MCP connection |
| macOS provider | Universal Mach-O `cua-driver` launched directly in upstream embedded mode |
| Windows main provider | x64 `cua-driver.exe` launched directly in upstream embedded mode in the Desktop session |
| Windows UIAccess helper | Future x64 `cua-driver-uia.exe` secure-path artifact; audit-only in V1 and unusable unless signing, installer, ShellExecute, PID, routing and live UIAccess gates pass |
| Private helper payload | The versioned provider resource carried and installed only by Ling Setup; it is not a second Windows product, service, PATH command, Start-menu app or independently updated component |
| Signing tier | Windows artifact trust class: `unsigned_dev`, `test_signed_internal` or `production_signed` |
| Distribution channel | The only allowed signing-tier pairing: `development`, `internal` or `production` respectively |
| Internal acceptance | `INTERNAL_TEST_PASS`: real test-signed installed-package functional acceptance with `releaseReady=false`; it is not a public-release verdict |
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

Embedded mode disables the provider's standalone proxy/relaunch selection and keeps the
provider in its host process context. On macOS that preserves the TCC responsibility
chain. On Windows it preserves the interactive session, desktop and integrity level. The
host must still spawn the executable directly and communicate through line-delimited MCP
JSON-RPC on stdin/stdout.

Upstream explicitly documents one Windows exception: embedded mode does not route tool
calls through a running `cua-driver-uia.exe`. Ling therefore treats ordinary embedded
Windows execution and optional full-UIAccess execution as separate capability tiers. The
initial per-user/asInvoker package implements the ordinary Medium-IL tier. A future full
tier must add a signed secure-path helper lifecycle; simply shipping the second PE is not
sufficient.

Packaging carries one reviewed `ling-managed-embedded-v1` patch series because upstream
`0.8.3` does not isolate driver-owned config, expose a deterministic Windows managed
readiness contract, or return stable capability codes for UIAccess-only action paths.
Every patch and touched path is locked below; standalone behavior remains unchanged.

## Module Boundaries

Target modules should remain focused:

```text
apps/desktop/
  main/
    cua-driver/
      artifact-lock.ts          # read and validate the packaged lock
      provider-seal.ts          # validate platform-specific final identities and signing tier
      windows-integrity.ts      # tier-aware catalog/signature + system-tool verification
      resource-path.ts          # resolve only the packaged absolute path
      state-root.ts             # create the version-isolated provider state root
      provider-host.ts          # shared process-group lifecycle and stdio MCP session
      adapters/
        darwin.ts               # TCC, Mach-O, direct embedded child
        win32.ts                # session/desktop, PE seal, exact-PID process-tree cleanup
      windows-uia.ts            # conditional secure-path UIAccess helper, not V1 package
      mcp-proxy.ts              # authenticated loopback Streamable HTTP proxy
      lease-publisher.ts        # publish/renew/revoke the daemon lease
      readiness-controller.ts   # macOS permissions or Windows session/integrity state
      coordinator.ts            # enable/disable/restart reconciliation
      telemetry.ts              # bounded Desktop diagnostics
  resources/
    providers/cua-driver/0.8.3-ling.1/
      darwin/{cua-driver,provider-seal.json}
      win32-x64/provider-integrity.cat  # signed tiers only
      win32-x64/payload/{cua-driver.exe,provider-seal.json}
      provider-lock.json
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

The reviewed provider input is represented by one committed cross-platform lock. Shared
source provenance and distribution policy live at the top level; platform artifacts use
discriminated records. This lock is signer-agnostic: it freezes upstream provenance,
Ling's patch/build inputs and pre-sign bytes, while the candidate and channel policy freeze
the actual signer and final signed bytes. A TryCua tag/archive/binary hash is upstream
provenance, never the identity of the Authenticode signer applied to Ling's source build.
The existing macOS record becomes:

```ts
interface BundledCuaDriverUpstreamV1 {
  readonly repository: "https://github.com/trycua/cua";
  readonly tag: "cua-driver-rs-v0.8.3";
  readonly commit: "0612c26b2c7b8556f6de7f6b4f3927ecac914e4f";
  readonly tree: "831819eaf2b79c4d81c2b68773cd5920772e91e9";
  readonly version: "0.8.3";
  readonly releaseStage: "prerelease";
  readonly license: "MIT";
  readonly licenseSha256: string;
}

interface LingManagedEmbeddedPatchSetV1 {
  readonly id: "ling-managed-embedded-v1";
  readonly sha256: string;
  readonly patches: readonly [
    { readonly id: "ling-embedded-state-home-v1"; readonly sha256: string },
    { readonly id: "ling-managed-readiness-v1"; readonly sha256: string },
    { readonly id: "ling-managed-lifetime-v1"; readonly sha256: string },
    { readonly id: "ling-windows-capability-errors-v1"; readonly sha256: string },
  ];
  readonly touchedPaths: readonly string[];
}

interface DarwinBundledCuaDriverLockV1 {
  readonly schemaVersion: 1;
  readonly componentId: "cua-driver-darwin";
  readonly integrationMode: "embedded-stdio";
  readonly distributionRevision: "ling.1";
  readonly productVersionLabel: "0.8.3 (Ling build 1)";
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
    readonly patchSet: LingManagedEmbeddedPatchSetV1;
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

The same lock contains a Windows x64 record:

```ts
interface WindowsBundledCuaDriverLockV1 {
  readonly schemaVersion: 1;
  readonly componentId: "cua-driver-win32-x64";
  readonly integrationMode: "embedded-stdio";
  readonly distributionRevision: "ling.1";
  readonly productVersionLabel: "0.8.3 (Ling build 1)";
  readonly referenceReleaseArtifact: {
    readonly filename: "cua-driver-rs-0.8.3-windows-x86_64.zip";
    readonly sizeBytes: 10585087;
    readonly sha256: "6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0";
    readonly binaries: {
      readonly "cua-driver.exe": {
        readonly sha256: "3cc33572defac29e23bc07e211c20245da9f6ebe8e6481f865b31534b1de8cee";
      };
      readonly "cua-driver-uia.exe": {
        readonly sha256: "1b35a27d41008507d66f819248751b9e79a15c9e6e03390c56749c6fe5daca1c";
      };
    };
    readonly authenticodeStatus: "unsigned-reference";
  };
  readonly sourceBuild: {
    readonly cargoLockSha256: "098b0527c35def4fdd1d08e5dd3d1b0d5f5dda9a04b1888ec1bf15b52311c51b";
    readonly rustcVersion: string;
    readonly cargoVersion: string;
    readonly windowsSdkVersion: string;
    readonly msvcToolsetVersion: string;
    readonly target: "x86_64-pc-windows-msvc";
    readonly patchSet: LingManagedEmbeddedPatchSetV1;
    readonly binariesSha256BeforeSigning: {
      readonly main: string;
      readonly uiaAuditArtifact: string;
    };
  };
  readonly binary: {
    readonly architecture: "x86_64";
    readonly expectedUpstreamVersion: "0.8.3";
    readonly lingBuild: 1;
    readonly mainRelativePath: "payload/cua-driver.exe";
    readonly providerSealRelativePath: "payload/provider-seal.json";
    readonly mainManifestCanonicalSha256: string;
    readonly integrityCatalogRelativePathBySigningTier: {
      readonly unsigned_dev: null;
      readonly test_signed_internal: "provider-integrity.cat";
      readonly production_signed: "provider-integrity.cat";
    };
    readonly packagedFilesBySigningTier: {
      readonly unsigned_dev: readonly [
        "payload/cua-driver.exe",
        "payload/provider-seal.json",
      ];
      readonly test_signed_internal: readonly [
        "provider-integrity.cat",
        "payload/cua-driver.exe",
        "payload/provider-seal.json",
      ];
      readonly production_signed: readonly [
        "provider-integrity.cat",
        "payload/cua-driver.exe",
        "payload/provider-seal.json",
      ];
    };
    readonly uiaAuditArtifact: {
      readonly packaged: false;
      readonly relativeBuildOutput: "cua-driver-uia.exe";
      readonly manifestCanonicalSha256: string;
      readonly requestedExecutionLevel: "asInvoker";
      readonly uiAccess: true;
    };
  };
  readonly runtime: {
    readonly args: readonly ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"];
    readonly requiredSession: "interactive-user";
    readonly rejectSessionZero: true;
    readonly stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME";
    readonly stateSchemaVersion: 1;
    readonly telemetryEnabled: false;
    readonly startupUpdateCheckEnabled: false;
    readonly managedUpdaterToolsAllowed: false;
    readonly defaultIntegrityCoverage: "standard";
    readonly managedReadinessMethod: "ling/managed_readiness";
    readonly managedReadinessChangedNotification: "ling/managed_readiness_changed";
    readonly childInstanceNonceEnvironmentVariable: "CUA_DRIVER_CHILD_INSTANCE_NONCE";
    readonly leaseGenerationEnvironmentVariable: "CUA_DRIVER_LEASE_GENERATION";
    readonly readinessHeartbeatMs: 1000;
    readonly requiredHostIntegrityLevel: "medium";
    readonly requiredProviderIntegrityLevel: "medium";
    readonly killOnJobCloseRequired: true;
    readonly limitations: readonly ["elevated_pixel_input", "uwp_send_input"];
    readonly uiaHelperActivation: "not-packaged-until-secure-path-contract";
  };
  readonly compatibility: {
    readonly mcpClientSdk: "@modelcontextprotocol/sdk@1.29.0";
    readonly clientInitializeProtocolVersion: "2025-11-25";
    readonly serverInitializeProtocolVersion: "2025-06-18";
    readonly healthSchemaVersion: "1";
    readonly toolsListSha256: string;
  };
}

interface BundledCuaDriverDistributionLockV2 {
  readonly schemaVersion: 2;
  readonly componentId: "cua-driver";
  readonly distributionRevision: "ling.1";
  readonly upstream: BundledCuaDriverUpstreamV1;
  readonly enabledPlatforms: readonly ("darwin" | "win32-x64")[];
  readonly platforms: {
    readonly darwin?: DarwinBundledCuaDriverLockV1;
    readonly win32X64?: WindowsBundledCuaDriverLockV1;
  };
}
```

The shared upstream record and every platform named in `enabledPlatforms` must contain
reviewed non-placeholder toolchain, patch, pre-sign binary, manifest and tool-list values
before that platform's packaging gate can be enabled. A complete macOS record does not
wait for Windows values, and a complete Windows record does not wait for macOS values.
Missing or incomplete data for the active platform fails its package.

The upstream release binaries remain reference evidence for the reviewed `0.8.3` release;
they are not the binaries shipped by Ling. `CUA_DRIVER_STATE_HOME` does not exist in
upstream `0.8.3`, so every packaged provider binary must be built from the exact tag
commit, `Cargo.lock`, and the committed `ling-managed-embedded-v1` patch series. The
product-visible label is `0.8.3 (Ling build 1)` while the upstream semantic version
remains `0.8.3`.

Entitlement digests are computed from canonical JSON, not raw plist bytes: parse the
entitlement plist into key/value data, recursively sort keys, retain JSON booleans, and
serialize without insignificant whitespace. The release helper entitlement map must
equal the two-key allowlist in the lock; missing or additional release entitlements fail
the package.

`toolsListSha256` is computed from canonical UTF-8 JSON: sort tools by raw name, retain
name, description, input schema, and MCP annotations, recursively sort object keys, and
serialize without insignificant whitespace. Each platform records its own digest because
native tool availability may differ. CI must fail if repeated builds for the same locked
platform produce different canonical bytes without a lock update.

Protocol fields distinguish request from response. Ling's locked MCP SDK `1.29.0` sends
`2025-11-25` in the initialize request and accepts the older supported response. Cua
Driver `0.8.3` always returns `2025-06-18`; that returned value is the provider
compatibility gate. The `2024-11-05` value in an upstream embedding example is sample
client input, not the `0.8.3` server response contract.

Any MCP SDK upgrade that changes the request version or supported-version set requires a
provider-lock change and compatibility rerun.

The lock file records source provenance. Runtime integrity uses platform-specific final
provider seals plus the macOS outer code-resource seal or the Windows tier-appropriate
policy. Windows signed tiers require the signed resource catalog; `unsigned_dev` has no
trusted-catalog claim and is admitted only by a compile-time development gate. No tier
trusts only a pre-sign source-build hash or candidate-manifest assertion. Apple and
Windows signing fields are intentionally not shared.

## Build-Time Acquisition

Each platform release workflow builds only its enabled provider before Electron
packaging; a macOS package does not wait for Windows output, and a Windows package does
not wait for macOS output:

1. Fetch the exact upstream tag commit and require the locked Git tree id.
2. Verify `Cargo.lock`, the committed patch-series digest, and the patch touched-path
   allowlist. Reject uncommitted source changes or a patch that applies with fuzz.
3. Download, safely extract, and verify the active platform's locked upstream release
   asset as reference evidence only. On macOS verify signer/runtime/entitlements; on
   Windows verify zip size, binary hashes, PE32+ x64 headers, manifests and
   unsigned-reference status. Reference binaries are never copied into the Ling package.
4. Apply the exact `ling-managed-embedded-v1` patch series, then build `cua-driver` for
   the enabled platform targets: both `aarch64-apple-darwin` and
   `x86_64-apple-darwin` for macOS, or `x86_64-pc-windows-msvc` for Windows. The Windows
   workflow also builds `cua-driver-uia` as a CI audit output. The audit output is verified
   against the reference manifest but is not staged into the V1 user package. Use the
   platform's exact locked Rust/Cargo and native SDK toolchain with Cargo locked dependency
   mode.
5. Combine the macOS slices with `lipo`. Verify every output architecture, deployment or
   subsystem target, PE manifests, upstream `--version`, initialize response, health
   schema, per-platform tool digest, and embedded state-isolation contract.
6. Copy the exact upstream MIT license from the locked tag and verify its digest.
7. Generate or refresh third-party Rust dependency notices/SBOM; do not assume the root
   MIT text alone covers every statically linked dependency notice obligation.
8. Stage each provider into the platform Desktop resource tree. Sign macOS with the Ling
   release Developer ID, exact required entitlements and hardened runtime. On Windows,
   select exactly one allowed `signingTier` / `distributionChannel` pair before any final
   bytes are produced. `unsigned_dev + development` remains unsigned;
   `test_signed_internal + internal` and `production_signed + production` sign the main
   PE using the channel-policy-pinned Authenticode identity and timestamp policy.
9. Re-read the final shipped provider bytes and generate `provider-seal.json` from those
   bytes, manifests, derived signing tier and actual code-signing identity. The unsigned
   variant records `NotSigned` explicitly; it never fabricates empty signer fields or a
   `Valid` status.
10. For Windows signed tiers, generate and sign `provider-integrity.cat` outside the
    covered `win32-x64/payload` directory. The catalog covers exactly
    `payload/cua-driver.exe` and `payload/provider-seal.json`; the covered seal contains
    the exact provider-lock digest. `unsigned_dev` omits the catalog and remains gated to
    development. License/notices remain package-asserted release material, not executable
    trust anchors. Candidate-manifest JSON is evidence and is not a runtime integrity anchor.
11. Produce the outer Electron application, uninstaller and installer with the same
    effective tier. Production signing starts from the approved clean pre-sign payload,
    never by overwriting, appending to, or promoting a test-signed PE.
12. Record the clean pre-sign payload digest, every tier-specific final artifact hash,
    macOS notary/Gatekeeper evidence, Windows app/NSIS/catalog Authenticode evidence,
    build inputs, audit-only UIAccess hash and provider-seal digests in release evidence.

Source, reference artifact, and toolchain downloads are controlled build inputs. None is
fetched by the installed product.

### Platform signing choices

Every packaged provider is a Ling source build. The bundled signing authority is frozen as
`ling_approved_repackage`: Ling is not re-signing an upstream release binary or claiming
that a Ling certificate is the TryCua signer. It signs its own locked source build while
retaining TryCua repository/tag/archive hashes strictly as provenance and retaining all
required notices. The legal production Publisher identity remains a release-owner input.

On macOS, TCC access is still attributed to the responsible Ling host, not merely to the
helper's Team ID.

After signing, both Mach-O slices must report hardened runtime and the exact entitlement
allowlist. `codesign --verify --deep --strict` alone is insufficient because a valid
signature can still omit or add entitlements.

The release policy must supply the expected Ling Team ID. A locally ad-hoc signed helper
can be used only for development and cannot satisfy packaged TCC or public release gates.

Windows signing is a three-tier discriminated contract:

The tier-governed tuple is exactly the Ling NSIS installer, installed Ling main PE,
trusted uninstaller, private `cua-driver.exe`, and `provider-integrity.cat` for signed
tiers. The private provider payload allowlist permits no other member. Electron/Chromium
vendor DLLs and native resources outside that payload remain under the existing Electron
Builder package/signing policy; this design does not silently enable `signDlls` or require
vendor-signed DLLs to share Ling's certificate. Candidate v4 retains a normalized
path/hash/observed-signer inventory for those vendor native files, but they do not determine
`signingTier`. Any new Ling-owned executable or helper must be explicitly added to the
tier-governed policy and candidate schema before packaging.

- `unsigned_dev + development` is local/pre-sign engineering only. It has no trusted
  catalog, no promotion verdict and no path through an internal or production feature gate.
- `test_signed_internal + internal` uses genuine Authenticode on the main provider,
  catalog, Ling app, uninstaller and NSIS. The expected test authority is pinned by an
  internal policy and is provisioned outside Ling into a disposable CI VM or dedicated,
  isolated QA machine. Ling never distributes/imports the root or PFX. `ephemeral-ci`
  trust is removed by the external harness after the job or the VM is
  reverted; `managed-internal` trust may persist only in a dedicated isolated QA image/VM
  under external PKI lifecycle and must never enter a general developer image, product or
  production chain. This tier can reach `INTERNAL_TEST_PASS` only and always keeps
  `releaseReady=false`.
- `production_signed + production` requires the release-policy-pinned legal Publisher,
  certificate, Code Signing EKU and RFC 3161 timestamp policy for every member of the
  tier-governed tuple.
  Only this tier can enter public-release promotion.

The effective tier is derived from the actual signature chain of every tier-governed
artifact, not from a candidate field. Installer, app, uninstaller, provider and catalog
must agree. In an internal or production tuple, any unsigned governed member, mixed tier,
double signature, unexpected member in the private provider payload, or test root in
production fails closed. A development tuple is valid only when every expected governed PE
derives as `unsigned_dev`, the catalog is absent and the compile-time development gate is
active. Authenticode `Status=Valid` means only that the signature is valid in the current
trust context. It does not establish public Publisher identity, SmartScreen reputation, or
WDAC/App Control allowability.

The catalog must cover every file in the dedicated payload directory. The audit-only
UIAccess output is not signed or packaged for users. A future UIAccess helper additionally
requires its own tier-consistent Authenticode identity, `uiAccess=true` manifest,
ShellExecute launch and Windows secure path. Signing any shipped file after its seal or
catalog is generated is forbidden.

## Final Provider Identity Seal

The package contains a generated manifest for each platform's final provider bytes. The
macOS shape remains post-sign:

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

The Windows shape is a discriminated V2 contract rather than overloading Apple fields or
pretending that an unsigned dev payload is signed:

```ts
type WindowsSigningTier =
  | "unsigned_dev"
  | "test_signed_internal"
  | "production_signed";

type WindowsDistributionChannel = "development" | "internal" | "production";
type WindowsTestAuthorityKind = "ephemeral-ci" | "managed-internal";

interface WindowsBundledProviderSealCommonV2 {
  readonly schemaVersion: 2;
  readonly componentId: "cua-driver-win32-x64";
  readonly lockSha256: string;
  readonly distributionRevision: "ling.1";
  readonly providerVersion: "0.8.3";
  readonly serverInitializeProtocolVersion: "2025-06-18";
  readonly healthSchemaVersion: "1";
  readonly toolsListCanonicalSha256: string;
  readonly stateSchemaVersion: 1;
  readonly limitations: readonly ["elevated_pixel_input", "uwp_send_input"];
}

type WindowsBundledProviderSealV2 =
  | (WindowsBundledProviderSealCommonV2 & {
      readonly signingTier: "unsigned_dev";
      readonly distributionChannel: "development";
      readonly productionEligible: false;
      readonly main: WindowsUnsignedPeIdentity;
      readonly integrityCatalogRelativePath: null;
    })
  | (WindowsBundledProviderSealCommonV2 & {
      readonly signingTier: "test_signed_internal";
      readonly distributionChannel: "internal";
      readonly productionEligible: false;
      readonly testAuthorityKind: WindowsTestAuthorityKind;
      readonly main: WindowsInternalSignedPeIdentity;
      readonly integrityCatalogRelativePath: "provider-integrity.cat";
    })
  | (WindowsBundledProviderSealCommonV2 & {
      readonly signingTier: "production_signed";
      readonly distributionChannel: "production";
      readonly productionEligible: true;
      readonly main: WindowsProductionSignedPeIdentity;
      readonly integrityCatalogRelativePath: "provider-integrity.cat";
    });

interface WindowsBundledIntegrityCatalogEvidenceCommonV2 {
  readonly catalogRelativePath: "provider-integrity.cat";
  readonly authenticodeStatus: "Valid";
  readonly signerSubject: string;
  readonly certificateSha256: string;
  readonly members: readonly {
    readonly relativePath: string;
    readonly sha256: string;
  }[];
}

type WindowsBundledIntegrityCatalogEvidenceV2 =
  | (WindowsBundledIntegrityCatalogEvidenceCommonV2 & {
      readonly signingTier: "test_signed_internal";
      readonly distributionChannel: "internal";
      readonly timestampPolicy: "internal-policy";
      readonly timestampStatus: "NotRequired" | "Valid";
    })
  | (WindowsBundledIntegrityCatalogEvidenceCommonV2 & {
      readonly signingTier: "production_signed";
      readonly distributionChannel: "production";
      readonly timestampPolicy: "rfc3161-required";
      readonly timestampStatus: "Valid";
    });

interface WindowsUnsignedPeIdentity {
  readonly relativePath: string;
  readonly sha256: string;
  readonly architecture: "x86_64";
  readonly peManifestCanonicalSha256: string;
  readonly authenticodeStatus: "NotSigned";
}

interface WindowsSignedPeIdentity {
  readonly relativePath: string;
  readonly sha256: string;
  readonly architecture: "x86_64";
  readonly peManifestCanonicalSha256: string;
  readonly authenticodeStatus: "Valid";
  readonly signerSubject: string;
  readonly certificateSha256: string;
  readonly timestampPolicy: "internal-policy" | "rfc3161-required";
  readonly timestampStatus: "NotRequired" | "Valid";
}

interface WindowsInternalSignedPeIdentity extends WindowsSignedPeIdentity {
  readonly timestampPolicy: "internal-policy";
}

interface WindowsProductionSignedPeIdentity extends WindowsSignedPeIdentity {
  readonly timestampPolicy: "rfc3161-required";
  readonly timestampStatus: "Valid";
}
```

Bundled Slice 8 atomically versions the current candidate/policy/attestation contracts.
The target candidate manifest v4 records `signingTier`, `distributionChannel`,
`productionEligible`, `testAuthorityKind` when applicable, the clean
`preSignPayloadSha256`, tier-specific final hashes, and observed Authenticode subjects,
certificate SHA-256 values and timestamp policy for app, installer, uninstaller, provider
and catalog under `tierGovernedArtifacts`, plus the separate normalized
`vendorNativeInventory` path/hash/observed-signer inventory.
`providerRelease` continues to mean TryCua source/archive provenance; actual
PE fields use `providerAuthenticodeSignerSubject` and
`providerAuthenticodeCertificateSha256` so an internal Ling test certificate cannot be
misrepresented as an upstream signer.

Candidate v4 is also a discriminated union: `unsigned_dev + development` and
`test_signed_internal + internal` require `productionEligible=false`; only
`production_signed + production` may set it true. `productionEligible=true` permits entry
to production review only and does not imply `RELEASE_PASS` or `releaseReady=true`.

The policy v3 fixes the required tier/channel and expected actual signer identities. The
attestation and verification v2 contracts sign those values explicitly. The production
release-verification contract stays production-only. Internal output is frozen as
`windows-internal-verification.schema.json` v1 with
`kind="ling.windows.internal-verification"`; only
`verify-windows-internal-attestations.mjs` may emit it after profile-aware detached
verification with `verifier.name="ling.windows.internal-attestation-verifier"`. The
contract fixes `signingTier="test_signed_internal"`,
`distributionChannel="internal"`, `productionEligible=false`,
`promotionStatus="INTERNAL_TEST_PASS"`, `releaseReady=false`, and blocker
`production_signing_required`. The production verifier/schema must reject that kind.
These schema, expected-filename allowlist, producer, verifier, PowerShell, fixture and CI
changes must land atomically; this design-only change does not edit the current live v3/v2
schemas.

Per-case and functional gates keep `PASS | FAIL | BLOCKED | SKIP`; `fullAcceptanceStatus`
describes only the selected profile's functional matrix. `promotionStatus` is separately
`BLOCKED | MANUAL_REVIEW_REQUIRED | INTERNAL_TEST_PASS | RELEASE_PASS`. Reviewer
attestation v2 uses the exact internal or release verdict instead of generic `PASS`, and
build/review signatures cover tier/channel explicitly. A functional `PASS` can never be
interpreted as release promotion.

Generation order is strict on both platforms:

1. finish every tier-required nested provider signature, or explicitly retain
   `NotSigned` for the development-only unsigned tier;
2. compute the platform identity: macOS SHA/CDHashes/Team ID/designated requirement/
   entitlements, or Windows main-PE SHA/manifest/Publisher/certificate/timestamp;
3. write `provider-seal.json` and forbid any later provider mutation;
4. on Windows signed tiers, generate and sign `provider-integrity.cat` outside and over
   the exact two-file payload directory; omit it for `unsigned_dev`;
5. produce outer app, uninstaller and installer at the same effective tier.

`electron-builder@26.15.3` must prove this order in instrumented macOS and Windows package
spikes before the release pipeline relies on it. The implementation contract is:

1. `afterPack` signs the staged macOS provider and writes its seal from final Mach-O
   identity; on Windows it enforces the selected tier, signs the staged PE when required,
   derives `provider-seal.json`, and for signed tiers generates and signs the catalog over
   the dedicated payload;
2. the platform signing hook skips that canonical sealed provider path only after its
   expected digest matches, while delegating outer app/uninstaller/installer executables
   to normal signing;
3. any second provider signing attempt, unexpected member in the payload or
   post-seal provider mutation fails the package;
4. `afterSign` rehashes and reverifies the unpacked provider tuple;
5. `artifactBuildCompleted` extracts/reopens each final DMG/ZIP/NSIS artifact and proves
   its provider bytes, seal and platform identity/catalog are identical to the verified
   unpacked tuple.

Hosted macOS and Windows CI use disposable test identities to exercise the identical hook
code. Dedicated internal QA may use a managed internal test authority on isolated machines;
neither trust root is distributed by Ling or retained on general-purpose images. Release
lanes use a separately rebuilt clean pre-sign payload and production policy/credentials.
An Electron Builder upgrade must rerun the hook-order spikes and cannot inherit the prior
result by version assumption.

Outer app, ZIP, DMG and NSIS hashes remain in evidence because placing them inside the
provider seal would create a signing cycle. At Windows activation, Ling first enforces the
compile-time channel gate. Signed tiers validate the installed app signature, actual tier,
catalog signature/signer, catalog membership, then the seal's lock digest and actual
main-PE identity; the internal gate accepts only its policy-pinned test authority and the
production gate accepts only the production policy. `unsigned_dev` validates final bytes
without a catalog and cannot exist in an internal or production build. A candidate manifest
or pre-sign SHA match cannot make installed loose resources trusted. The V1 threat model detects accidental or
unauthorized resource replacement; it does not claim protection after the same user has
fully replaced both the Desktop runtime and its verification code.
For macOS, the designated requirement is stored as normalized UTF-8 text with normalized line
endings and its digest; CDHashes are collected separately for both universal slices.

## Pre-Sign Package-Staging Security Boundary

The implemented staging slice is an opt-in pre-sign boundary, not a final package or
release verdict. Its production entry points have no caller-selectable trust surface:
`stageCuaDriverProvider()` and `verifyCuaDriverSourceInput()` reject own
`trustedResourceRoot` and `sourceBuildVerifier` fields, including a paired override, before
use. They always bind to the independent committed lock digest, checked-in resource root
and real source-build verifier. Fixture trust is captured only by
`createCuaDriverPackageStagerForTest()` and is unreachable from production CLI arguments or
environment variables.

The parent first opens bounded package snapshots and passes the selected provider digest
and platform to the child source-build verifier. The child opens its own bounded snapshot,
compares it with that independent digest and does not execute the provider candidate in
package-staging mode. Version evidence must agree across the attestation, promotion input
and committed lock already bound to those exact bytes. A later receipt still binds every
staged allowlist member. The outer source verifier uses the owned process-tree runner.
Standalone source-build verification retains an owned version probe: on Unix the child
leads a detached process group, while on Windows the fixed native helper launches the owned
command inside a `KILL_ON_JOB_CLOSE` Job Object. Timeout, abort and output overflow fence
descendants on both paths.

Source-build promotion is a separate review-only boundary. Its production API fixes the
real verifier and exposes no verifier override; fixture injection exists only through a
test-only factory. `--platform`, `--candidate-a`, `--candidate-b`, `--output-dir` and an
optional relocated copy of the same anchored `--resource-root` are the only CLI inputs.
Candidate roots, the resource root and the fresh output root must be canonically disjoint.
Before candidate execution, the generator captures the canonical output parent and its
native identity. After verification it must reacquire the same parent identity, create and
secure an identity-checked private sibling under that lease, and publish only through the
native no-replace atomic primitive. Replacing an output ancestor with a symlink, junction,
reparse point or different directory during either verifier therefore cannot redirect the
proposal into resources or another root.
Each candidate is verified in its own owned child invocation, then every allowed file is
reread through a bounded no-follow snapshot. The committed provider-lock and non-promoting
source-build-input bytes have independent digest anchors. A/B must bind the same current
inputs, platform, patch/toolchain/runtime/tools evidence and identical stable artifact map;
missing/extra files, a packaged UIAccess audit helper, mixed locks, changed toolchains or
fabricated final identity fail closed.

CI makes the artifact boundary explicit. The macOS/Windows native build job uploads the
complete A/B output without producing a proposal. A dependent job on the same operating
system downloads that artifact into a fresh root and invokes the production promotion CLI.
The proposal therefore proves the uploaded bytes survive serialization, download and a
separate verifier invocation; it still does not prove that A and B came from independent
runners, so build-invocation provenance remains a manual review blocker.

When GitHub-hosted minutes are unavailable, the same boundary may execute on two
repository-scoped self-hosted profiles. The caller must already exist on the default
branch, accept only manual dispatch, and bind an owner-supplied full commit SHA before any
checkout. Each native runner has one custom label and no generic default labels; the
checked-in profile fixes repository, actor, runner name/root/work root, runner binary
version, OS/architecture and native toolchain. Checkout never persists credentials.
Run-specific temp roots and one-day artifacts prevent persistent work directories from
becoming implicit evidence. This changes runner ownership only: upload/download,
review-only proposal, independent lock anchor, second A/B build and Windows VM sign-off
remain mandatory.

The macOS final link keeps the default Apple linker `LC_UUID`. Swift 6.3 emits a non-runtime
16-byte `__LLVM,__swift_modhash` in otherwise identical `apple-cf` and `screencapturekit`
archive members. Because that input changes clean-build stub ordering, the builder first
primes each target, verifies the exact two locked archive/member inventories, zeroes only
those module-hash sections, and forces a final-only relink with fixed Rust metadata and
Apple ld `-reproducible -no_deduplicate`. The latter disables the linker pass whose
ordering races on the two upstream `CoreMediaBridge` definitions; it does not disable Rust
release optimization and does not change the arm64 slice size. Current ld then derives `LC_UUID` from the normalized output
bytes and emits a valid deterministic arm64 linker ad-hoc signature. `lipo` produces the
expected unsigned universal pre-sign candidate; product signing is applied only after
promotion during the packaging/signing stage. `-no_uuid` is forbidden
because current dyld refuses to execute a binary without `LC_UUID`; `-random_uuid` is
forbidden because it would defeat the byte-for-byte A/B comparison. Host build scripts
never receive final-only linker flags or archive normalization.

The generator preserves an already promoted other-platform record byte-for-byte, refuses
to overwrite the target platform and atomically publishes a fresh proposal directory containing only
`provider-lock.json` and `source-build-promotion-receipt.json`. The receipt status is
`MANUAL_REVIEW_REQUIRED`; it records both attestation digests and the proposed lock digest,
but is not an internal or release verdict. After review, committing a proposal requires the
independent committed-lock anchor to change in the same patch. Native A/B builds must then
run again against that new committed lock before package staging. The original
`source-build-inputs.json` remains closed with null output digests and cannot self-promote.
Staging tests cover the two-round boundary: an old-lock build fails the trusted-lock anchor,
rewriting only its lock still leaves a stale attestation that the fixed verifier rejects,
and only a fresh second build whose attestation binds the promoted lock is accepted.

Before creating a temp payload directory, staging builds and identity-preflights the fixed
native helper. Darwin executes the held helper vnode through its `/.vol/<dev>/<ino>`
identity; a harmless preflight probe makes unsupported volume-identity execution fail
before payload creation. Standalone calls recheck the compiled helper identity after
invocation, while a held RPC helper is rechecked when its lease session closes. The
build-only helper root contains no provider/package bytes and is retained
for OS temp reclamation; this slice performs no path-based deletion of it. Slice 6A's
signed/prebuilt helper removes the temporary compiler root entirely.

After helper preflight, every production stage enters one cross-process lease for the
canonical output parent. Source snapshot verification and payload-free helper build may run
before acquisition. While the holder is healthy, Node keeps the lease across its ordered
destination check, residue scan, temp-tree construction, copy/write/verification,
publication and retained-residue observation sequence. Explicit cleanup likewise keeps the
lease across identity checks, quarantine, remeasurement, native removal, safe rollback and
the final retryable receipt. Node still executes JavaScript `mkdir`, copy and write steps;
those steps are not native RPCs and are not claimed to share the holder process lifetime.
The fail-closed invariant is narrower: no production native mutation may execute without
the current lease capability, and a Node crash may leave residue that every next lease scans
and charges to the same bounded quota before creating another payload.

The native helper command is `hold-parent-lock <parentRoot> <timeoutMs>`. It flushes one
identity-bound `locked` receipt and becomes the synchronous RPC actor for that parent. The
same process and, on Windows, the same mutex-owning thread performs every allowed inspect,
private-security, verification, publish and removal operation before it can release the
lock. It never spawns a mutation child or moves mutation work to a worker thread. The
production native CLI exposes no standalone mutating command; native mutators are reachable
only as allowlisted calls on this held session. Read-only probe/inspection surfaces and the
separately owned-process launcher do not grant mutation authority. Requests use the bounded
session protocol below; `parentRoot` is fixed by process startup and never appears in a
request:

```text
LCRPC1\tcall\t<ID>\t<opcode>\t<argc>\t<lowercase-hex args...>\n
LCRPC1\trelease\t<ID>\n + EOF
```

Request ids are strictly monotonic, opcodes and arities are allowlisted, decoded arguments
must be strict UTF-8, and a line is rejected after 16 KiB while it is being read rather than
after an unbounded `getline()`. Each receipt binds `requestId`, `operation` and
`operationOwnerPid`; JavaScript requires the owner pid to equal the lease helper pid. A
module-private weak capability binds each public lease object to its native session, and
every mutating API rejects a missing, foreign, released or lost capability with
`staging_parent_lock_capability_required`. Calls are FIFO. Release first drains the queued
or in-flight call, then sends the final release frame and EOF. Timeout, malformed protocol,
receipt-context mismatch or another session invalidation kills the entire holder and waits
for its actual process exit before deleting the weak capability; a rejected or stale
capability cannot be reused. Each native operation has a fixed 30-second whole-holder
watchdog.

- macOS opens the exact no-link parent directory and applies exclusive `flock` directly to
  that already-open directory vnode. The held vnode is both the lock identity and the
  parent handle used by session operations. Staging creates or depends on no `.ling` lock
  file, so there is no lock-control entry to exclude from the residue or parent-entry quota.
- Windows derives `Global\\LingCuaStage-*` only from the opened parent's `FILE_ID`, not
  from path spelling. The named mutex has an exact protected DACL limited to the current
  user, SYSTEM and Administrators. `WAIT_ABANDONED` means a contender that already held an
  open handle and was waiting observed its predecessor die. It is not an acquisition
  failure, does not authorize deleting residue and is not guaranteed for a later contender
  after the last mutex handle closed.
- Publish reopens the canonical `parentRoot` component-by-component without following
  links immediately before its no-replace rename and again after observing the held-parent
  source/destination state. The named path must still resolve to the held vnode/`FILE_ID`.
  A pre-commit mismatch is `not_committed`; a post-commit mismatch is `ambiguous` and is
  never promoted to `committed`. The replacement path is untouched. If the rename already
  completed, its identity remains only in the displaced held parent for diagnosis.
- Clean idle EOF or explicit release drains queued/in-flight work and releases the lease
  normally. If the caller dies during an RPC, the holder retains the lock until that bounded
  operation completes, then observes EOF and exits. If the holder dies during an RPC, the
  in-process native mutation dies with it and the OS releases the lock afterward. Node can
  also die between native calls while performing `mkdir`, copy or write work; that work is
  not made atomic by the holder. A payload or quarantine already created remains in place
  and every next lease holder performs the same bounded residue inspection, independent of
  `recoveredAbandonedLock`.

Immediately after `mkdir`, staging reads the native parent and randomized sibling-root
identities before applying security, verifies that the parent identity equals the held
lease, and supplies both values as mandatory `secure-private` expectations. The exact root
is then secured through the native no-reparse operation and reverified before publication:

- macOS requires the current effective UID and exact mode `0700`;
- Windows requires a protected DACL owned by the current user and limited to the current
  user, SYSTEM and Administrators according to the native profile;
- parent and directory native identities are carried into private-security verification
  and the atomic no-replace rename.

A native `committed` receipt advances the staging state inside the guarded callback rather
than after its lease post-check. Therefore helper loss observed by either the nested publish
guard or the outer operation guard after commit produces an ambiguous `published=true`
failure whose `path` is the canonical final root; it has no temporary cleanup authority and
the final root is never automatically deleted. A failure before commit never triggers
path-only recursive deletion. In particular, a failure after identity capture but before
`secure-private` completes retains that exact root for the explicit cleanup path described
below. With a healthy lease, ordinary failure observation records `residuePath`, the
original native `residueIdentity`, entry count and byte count. Lease loss after identity
capture may return only the path and identity; lease loss after `mkdir` but before capture
may return only the path. The next lease can recover missing identity or inventory through
the read-only listing flow before cleanup.
Before another attempt, an `opendir` streaming scan fails early on excessive parent
entries, unsafe entry types, more than four matching residues, more than the fixed aggregate
entry budget, or more than the fixed aggregate byte budget derived from the four bounded
package members. Both `.tmp-*` trees and retryable `.cleanup-*` quarantine/rollback trees
are recognized by the same scan and consume the same quota. Test configuration may tighten
these limits but cannot raise them. macOS creates no lock-control child in the parent, so
the scan has no special lock-file exclusion.

Cleanup is an explicit operator action through `cleanupCuaDriverStagingResidue()` or:

```bash
node apps/desktop/scripts/cua-driver-package-staging.mjs \
  --list-residue \
  --output-root <originalOutputRoot>
```

Because a hard Node exit cannot return `error.cleanup`, and lease-loss windows can return
one without identity or inventory,
`listCuaDriverStagingResidues()` and this CLI mode acquire the same parent lease and return
the exact native identity, private/unsecured state and bounded inventory for at most four
matching roots. If a legacy directory already exceeds the count quota, the result is marked
`truncated`; the operator cleans one listed identity and repeats. Discovery is read-only
with respect to payload roots and never converts an unsafe path into cleanup authority.

```bash
node apps/desktop/scripts/cua-driver-package-staging.mjs \
  --cleanup-residue <residuePath> \
  --output-root <originalOutputRoot> \
  --expected-residue-identity <residueIdentity>
```

Cleanup requires the exact output-derived sibling name and matching native
parent/directory identity. It first verifies the platform-private security profile. If
staging failed before hardening completed, cleanup retries `secure-private` with the same
expected identities. If both verification and hardening fail, the only fallback is native
`remove-unsecured-empty`: it reopens the exact parent/root handle-relatively and deletes the
root only when it is still current-user-owned, no-reparse and completely empty. A replaced,
foreign-owned, reparse or non-empty root is retained and rejected. A private root then
performs a native no-replace rename into a unique quarantine name, reopens the same
identity and repeats the bounded inventory.
Final removal is not JavaScript path-recursive deletion: the native helper reopens the
parent and root handle-relatively, completes a deep no-reparse preflight of the entire tree,
requires the expected root/parent identities plus exact entry and total-byte counts, and
only then deletes members and returns matching removed-count evidence. If quarantine commit
or final removal fails, the wrapper re-observes the identity and rolls the same tree back to
its original residue name when safe. Ambiguous rollback retains an identity-bound retryable
quarantine receipt, and that quarantine remains visible to the quota scan. A replaced root,
unsafe member, quota violation or identity mismatch is retained and rejected. This is a
same-user race-hardening boundary, not permission to delete arbitrary matching paths.

The build-time scaffold trusts the current build account and checked-in verifier/compiler
inputs. It does not claim to withstand hostile code already executing as that account and
able to rewrite the verifier itself. Final signed helper/bootstrap identity is closed by
Slice 6A rather than promoted from this pre-sign receipt.

The Darwin behavior and cross-platform contract tests run on macOS. The Win32 native path,
parent-`FILE_ID` `Global` mutex, private DACL, `WAIT_ABANDONED` recovery and no-replace
logic are implemented, but this slice has not produced successful Windows hosted-runner
native-helper compilation, parent-lease or owned-process/Job Object runtime evidence;
Windows hosted and real-machine validation therefore remain open.

## Packaged Resource Layout

The provider must be outside `app.asar` and addressed by an absolute path derived from
`process.resourcesPath`:

```text
providers/
  cua-driver/
    runtime-trust-policy.json  # build-carried host policy; not provider-declared
    0.8.3-ling.1/
      provider-lock.json
      LICENSE.md
      THIRD_PARTY_NOTICES.md
      darwin/
        cua-driver
        provider-seal.json
      win32-x64/
        provider-integrity.cat  # signed tiers only; absent for unsigned_dev
        payload/
          cua-driver.exe
          provider-seal.json
```

The packaging spike may move the executable to a standard nested-helper directory if
required by strict Apple signing tools, but the logical resource id and versioned layout
must remain deterministic.

`runtime-trust-policy.json` has strict schema V1 and lives outside the provider's versioned
artifact tree so `provider-lock.json`, the seal and candidate/release manifests cannot
select their own trust anchor. Darwin policy contains only the expected Ling Team ID.
Windows policy contains the build-bound signing tier/channel and exact provider/catalog
signer identities. The Windows system root remains a separately injected host platform
fact. Gate-off startup never reads this file; a gate-on missing, symlinked, oversized,
cross-platform, mixed-tier or extra-field policy fails closed without starting a provider.

Packaged path resolution rules:

1. Build the absolute platform path from the compile-time distribution id and
   `process.resourcesPath`; do not trust a path read from the lock itself.
2. Reject symlinks, reparse points, junctions and any canonical path outside the expected
   provider root.
3. On Windows, enforce the compile-time distribution channel before reading candidate
   evidence. `unsigned_dev` is accepted only by the development build gate and requires an
   absent catalog plus explicit `NotSigned` identity. Signed tiers verify the installed
   Ling executable and provider catalog with the absolute in-box Windows PowerShell path,
   `-NoProfile -NonInteractive`, fixed UTF-8 locale-independent JSON and bounded
   stdout/stderr. The Windows system root is a required trusted platform fact; verifier
   code never falls back to caller-controlled `SystemRoot` or `WINDIR` environment values.
   Require the matching internal or production policy signer identity and
   run `Test-FileCatalog` against only the dedicated two-file payload directory. Missing
   PowerShell, process-launch denial, WDAC/AppLocker blocking, unavailable catalog cmdlets,
   oversized output or inability to obtain a verdict maps to
   `cua_windows_integrity_verifier_unavailable` / `platform_unavailable`; it does not claim
   the artifact is corrupt. A successfully executed verifier that reports an invalid
   signature, tier, signer, member or hash maps to `corrupt`. Never classify by parsing
   localized stderr text.
4. Read the final seal, hash the actual root provider lock, require `seal.lockSha256` to
   match it, then validate both records. Signed tiers additionally require the seal to be a
   catalog member; the development-only unsigned tier has no catalog trust claim.
5. Require the main provider to be an executable regular file with exact platform
   identity before starting the proxy lease.
6. Never consult `PATH`, Homebrew, user install junctions, `~/.local/bin`,
   `/Applications/CuaDriver.app`, or `%LOCALAPPDATA%\Programs\Cua` in
   `bundled_embedded` mode.

Source/dev builds may accept an explicit fixture or developer path, but must label the
mode `external_local` unless the build produced a validated local provider asset under the
explicit `unsigned_dev + development` gate.

## Ling-Carried Managed Embedded Patch Series

Upstream `0.8.3` reads and writes driver configuration at
`$HOME/.cua-driver/config.json`. That silently inherits standalone-driver values such as
`capture_scope=desktop` and `max_image_dimension`, and `set_config` can modify the same
file. Ling therefore carries one reviewed patch series. Its state-isolation member introduces
`CUA_DRIVER_STATE_HOME` for driver-owned state; later sections define the managed
readiness and structured capability-error members.

Patch-series contract:

- only upstream commit `0612c26b2c7b8556f6de7f6b4f3927ecac914e4f` is an accepted base;
- the complete ordered patch list, each patch SHA and the union of touched paths match the
  provider lock with no fuzzy application;
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
- no external macOS home or Windows profile `.cua-driver` / `.cua-driver-rs` state is
  imported automatically.

Desktop derives the root from Electron `app.getPath("userData")` and isolates it by state
schema and provider distribution revision. macOS creates directories with mode `0700`
and files with mode `0600`. Windows applies a current-user-only ACL and rejects reparse
points, junction escapes and paths outside the canonical userData root.

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
all driver-owned writes land under the locked state root. The same platform binary
launched in non-embedded mode must ignore `CUA_DRIVER_STATE_HOME` and retain upstream
path semantics. Separate Windows patch tests validate the exact no-content readiness JSON,
structured UIAccess capability details, stdin EOF, half-closed stdout and exact host-PID
death. Standalone mode must not gain Ling-only lifecycle or capability behavior.

## Runtime Environment

The main provider process uses the exact locked argv on both platforms:

```text
mcp --embedded --host-bundle-id com.lingstack.desktop
```

It also receives a narrow, explicit environment:

```text
CUA_DRIVER_EMBEDDED=1
CUA_DRIVER_HOST_BUNDLE_ID=com.lingstack.desktop
CUA_DRIVER_HOST_PID=<electron-main-pid>
CUA_DRIVER_CHILD_INSTANCE_NONCE=<memory-only-random-nonce>
CUA_DRIVER_LEASE_GENERATION=<positive-integer>
CUA_DRIVER_STATE_HOME=<Desktop userData>/providers/cua-driver/state/v1/0.8.3-ling.1
CUA_DRIVER_TELEMETRY_HOME=<CUA_DRIVER_STATE_HOME>/telemetry
CUA_DRIVER_RS_TELEMETRY_ENABLED=false
CUA_DRIVER_RS_UPDATE_CHECK=false
```

The first two values enforce the upstream embedding path. The state variables isolate
driver-owned data without replacing the user's real home/profile. The final two prevent the
Ling-managed child from sending default product telemetry or making the independent
GitHub release check performed by `mcp`, `serve`, and `doctor`.

The child nonce and lease generation bind private readiness messages to the exact spawn;
they are never persisted or logged.

Rules:

- Do not call `serve`, `update`, an installer, or a standalone daemon path.
- Filter or deny `check_for_update` and any future updater/install tool from the bundled
  tool catalog. The external provider mode may retain its own separately disclosed
  policy.
- Ling's managed embedded launch path never invokes or exposes provider update/install
  operations and never performs background provider downloads. Upstream `0.8.3` still
  contains the standalone CLI command `update --apply`; direct user or generic shell
  execution of that command is outside this provider-integration boundary.
- Inherit only environment variables required for native application interaction.
  Do not pass Ling secrets, provider API keys, release credentials, or bridge tokens to
  Cua Driver.
- On Windows, also inherit only the logged-in user's interactive session environment. Do
  not use a service token, Session 0, or a scheduled-task daemon as the bundled provider.
- Keep stderr diagnostic-only, bounded, and redacted. MCP stdout is protocol data and
  must never be mixed with product logs.

## Process Ownership

The accepted process trees are:

```text
macOS LaunchServices / user session
  -> Ling Stack.app Electron main
       -> packaged cua-driver mcp --embedded

Windows interactive user session
  -> Ling Stack.exe Electron main
       -> packaged cua-driver.exe mcp --embedded
       -. optional future full tier .-> signed secure-path cua-driver-uia.exe
```

These shapes are rejected:

```text
Ling daemon -> cua-driver --embedded
Windows service / Session 0 -> cua-driver.exe --embedded
scheduled task daemon -> cua-driver.exe
terminal -> cua-driver --embedded
open / NSWorkspace -> CuaDriver.app -> cua-driver
renderer -> cua-driver
```

The reason is platform authority, not ordinary parent-pid aesthetics. macOS requires the
Ling TCC responsibility chain. Windows requires the same logged-in interactive session,
input desktop and expected integrity tier. Desktop can reuse a daemon started outside
Ling, so that daemon cannot be trusted to carry either authority.

Runtime `check_permissions.source.attribution === "host"` is required but not sufficient.
Clean-host acceptance also verifies the real process ancestry, TCC AttributionChain logs,
and Privacy & Security rows.

Windows activation verifies Desktop/provider session ids, integrity levels, input desktop,
exact PID/nonce and executable identity through a content-free managed-readiness request
sent to the active MCP child. Windows acceptance
then uses a test-owned synthetic target for real WGC/UIA/input probes and process-tree
cleanup. Upstream
`health_report.session_active` is not accepted as proof because `0.8.3` reports that
check as a fixed pass on Windows.

### Windows managed readiness and lifetime boundary

Windows native checks live in the locked Rust patch series. Electron main does not add a
Node FFI or N-API addon. The bounded one-shot command remains build, preflight and
acceptance evidence only:

```text
cua-driver.exe diagnostics --managed-readiness --json
```

Its process identity can never make the runtime ready. After the long-lived child
completes MCP initialize, the provider host sends the embedded-only
`ling/managed_readiness` request over that child's existing stdio MCP session. The
response is authoritative only for the current lease generation and is never exposed as
a user-callable tool.

The one-shot stdout contract is evidence-only:

```ts
interface WindowsManagedPreflightV1 {
  readonly schemaVersion: 1;
  readonly evidenceOnly: true;
  readonly diagnosticProcessId: number;
  readonly diagnosticSessionId: number;
  readonly diagnosticIntegrityLevel: "medium" | "high" | "system" | "unknown";
  readonly inputDesktop:
    | "default_unlocked"
    | "locked"
    | "non_default"
    | "unavailable";
  readonly jobObjectApiAvailable: boolean;
  readonly uiaRuntime: "available" | "unavailable";
  readonly d3d11: "available" | "unavailable";
  readonly wgcApi: "supported" | "unsupported" | "unavailable";
  readonly contentObserved: false;
}
```

The active-child control response contract is:

```ts
interface WindowsManagedReadinessRequestV1 {
  readonly schemaVersion: 1;
  readonly childInstanceNonce: string;
  readonly leaseGeneration: number;
}

interface WindowsManagedReadinessV1 {
  readonly schemaVersion: 1;
  readonly childInstanceNonce: string;
  readonly leaseGeneration: number;
  readonly readinessSequence: number;
  readonly hostProcessId: number;
  readonly hostSessionId: number;
  readonly hostIntegrityLevel: "medium" | "high" | "system" | "unknown";
  readonly providerProcessId: number;
  readonly providerSessionId: number;
  readonly providerIntegrityLevel: "medium" | "high" | "system" | "unknown";
  readonly inputDesktop:
    | "default_unlocked"
    | "locked"
    | "non_default"
    | "unavailable";
  readonly jobObjectAssigned: boolean;
  readonly killOnJobClose: boolean;
  readonly uiaRuntime: "available" | "unavailable";
  readonly d3d11: "available" | "unavailable";
  readonly wgcApi: "supported" | "unsupported" | "unavailable";
  readonly contentObserved: false;
}

interface WindowsManagedReadinessChangedV1 extends WindowsManagedReadinessV1 {
  readonly reason:
    | "lock"
    | "unlock"
    | "disconnect"
    | "logoff"
    | "fast_user_switch"
    | "session_mismatch"
    | "input_desktop_changed"
    | "heartbeat";
}
```

Desktop generates the nonce and generation before spawn and passes them only through the
two locked environment variables above plus the private request. The child rejects a
missing or mismatched request/environment tuple. `readinessSequence` starts at `1` for
each new child nonce/generation and increases for every response or changed notification;
Desktop discards any sequence not greater than the last accepted value. Neither value is
persisted or logged.

The implementation reuses upstream Windows diagnostics around
`ProcessIdToSessionId`, token integrity, `OpenInputDesktop`, UI Automation initialization,
D3D11 and WGC API support. It must not enumerate user windows, return AX content, capture
a frame, or perform input. Desktop cross-checks the retained ChildProcess PID, Electron
main PID, a random memory-only `childInstanceNonce` supplied at spawn, both non-zero equal
session ids, both Medium integrity levels, Job Object flags, the echoed lease generation
and a strictly increasing readiness sequence.
The nonce is never logged or persisted. Extra stdout, an unknown schema field or any
identity mismatch fails closed.

For the long-lived embedded process, the Rust patch opens a `SYNCHRONIZE` handle to the
exact `CUA_DRIVER_HOST_PID` before reporting ready. Before creating any worker it also
creates a private non-inheritable Job Object, assigns the active MCP process to it, sets
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and forbids breakaway descendants. Failure to
establish that boundary exits before initialize and projects
`cua_windows_lifecycle_unavailable` / `platform_unavailable`. Stdin EOF,
stdout/protocol closure, host-process death or main-process termination closes the Job
Object and removes every provider descendant within the locked managed-exit deadline.
Child-created workers must not inherit host/provider stdio or Job Object handles.
Path/reparse validation remains in TypeScript through `lstat` plus canonical `realpath`;
ACL evidence may use the absolute trusted `%SystemRoot%\System32\icacls.exe`.

## Embedded Provider Host

`CuaDriverProviderHost` owns one main provider process and one stdio MCP session per
active Desktop lease generation. A future full Windows tier may additionally own one
UIAccess helper; the initial standard tier owns none.

Responsibilities:

- single-flight start;
- direct `spawn` with the packaged absolute executable and locked arguments;
- line-delimited JSON-RPC framing with bounded message size;
- startup deadline, initialize handshake, and exact server version checks;
- stderr capture with secret/content redaction;
- cancellation and request-id tracking;
- graceful shutdown followed by bounded termination;
- treat stdin EOF, child stdout EOF and host-process death as terminal lifecycle signals;
- orphan detection and cleanup; while Desktop remains alive, Windows first closes
  MCP/stdin and waits, then may terminate only through the retained ChildProcess handle.
  Managed production mode never invokes `taskkill.exe /PID ... /T`;
- hard Desktop crash relies on the child host-death/stdio-EOF contract and the Rust-owned
  `KILL_ON_JOB_CLOSE` boundary. Main-child, grandchild and repeated-restart zero-orphan
  tests are required; no Node N-API addon is introduced;
- independently check process/pipe/listener residue before restart or shutdown completes;
- generation replacement after child crash, permission change, unexpected MCP session
  loss, daemon authority-epoch change, or Desktop restart.

The child starts lazily on the first authenticated daemon MCP session. Starting Desktop
alone does not activate Computer Use or raise permission prompts.

One provider MCP session is sufficient because Desktop is bound to one daemon authority per
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
  bridge secret plus the daemon-issued Desktop instance epoch, bridge connection id and
  lease generation;
- reject browser Origin/CORS access and non-MCP routes;
- never persist the endpoint or authorization secret;
- accept exactly one initialized Streamable HTTP session for the current lease generation;
- preserve MCP request ids, notifications, cancellation, errors, content blocks, and
  structured content without interpreting tool semantics or remapping ids across clients,
  except for the locked embedded-control namespace below;
- reserve string request ids beginning `ling-control:` and methods beginning `ling/` for
  Desktop-owned embedded control. Reject daemon-originated ids/methods in that namespace;
  serialize `ling/managed_readiness` after initialize and before activation continues,
  intercept its response, and never expose it as an MCP tool;
- intercept `ling/managed_readiness_changed` notifications carrying nonce, generation and
  monotonic sequence for the Windows readiness controller. All non-reserved standard MCP
  traffic remains transparent;
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
  readonly desktopInstanceEpoch: number;
  readonly bridgeConnectionId: string;
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
  readonly providerCatalogDigest?: string;
  readonly platform: "darwin" | "win32";
  readonly architecture: "arm64" | "x86_64";
  readonly integrityCoverage?: "standard" | "uiaccess";
}
```

The authenticated Desktop bridge publishes and renews this lease. The endpoint is
loopback-only; the proxy secret is derived independently and kept in process memory.

Suggested route contract:

```text
PUT    /desktop/capabilities/cua-driver/lease
DELETE /desktop/capabilities/cua-driver/lease/:desktopInstanceEpoch/:generation
```

Both routes require the existing Desktop bridge token and exact workspace authority.

Lease behavior:

- Desktop publishes after artifact validation and proxy bind, before the child starts.
- Desktop renews periodically; the daemon expires a missing heartbeat within a bounded
  interval.
- The authenticated bridge handshake carries the daemon authority epoch and issues a
  random `bridgeConnectionId` plus a `desktopInstanceEpoch` that increases
  monotonically within that daemon authority epoch.
- Before accepting the first lease from a new bridge connection, the daemon atomically
  fences the previous Desktop instance, pool entries and activation tokens.
- A newer Desktop instance epoch replaces an older instance regardless of their numeric
  generations. Within one instance epoch, only a higher generation can replace the
  current generation; a new Desktop process may restart generation at `1`.
- Renew and revoke require the exact authority epoch, instance epoch, bridge connection
  id and generation. An older instance cannot replace, renew or revoke the current lease.
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

Packaged macOS and Windows choose `bundled_embedded` by default. They return a stable
`cua_desktop_lease_unavailable` transport error if no valid lease exists. The UI projects
`desktop_unavailable`. It must not fall through
to an existing external command.

A reused daemon must advertise support for the lease protocol during the existing Desktop
bridge compatibility probe. If it does not, Desktop treats it as bridge-incompatible
rather than opening the product with a partially working provider path.

Current Slice 3 daemon-composition sub-slice status:

- one process-wide composition owner instantiates the activation service, generation pool
  and shared broker while leaving the gate-off external broker path unchanged;
- startup reset commits before the daemon listens, and a reset failure prevents route
  binding;
- first publication and a replacement synchronously hide prior effective state, close stale
  pool entries and reconcile retained intent in the background; renewal changes only the
  lease deadline and reuses the generation HMAC/session/client;
- if the durable invalidation write throws or loses its CAS, the coordinator clears the
  accepted lease, closes the pool, returns HTTP 503 for a publication, retries the durable
  fence after authority removal and poisons renewal deduplication until a later fence
  succeeds;
- explicit revoke is idempotent and returns retryable HTTP 503 until its durable fence
  commits; expiry and authenticated-handshake retirement have no waiting requester, so a
  single unref'ed bounded-backoff retry remains active until persistence recovers or daemon
  shutdown begins;
- revoke, expiry, a new authenticated handshake and shutdown remove current authority before
  draining or aborting the generation client;
- canonical `trusted-local:cua-driver` enable/check/disable routes are workspace-bound to the
  Desktop authority and every mutating/action route on the historical
  `bundled:cua-driver` compatibility record is rejected, so it cannot become a second
  runtime surface;
- generic MCP check/tool-sync routes reject bundled Cua mutation outside the activation
  transaction, while normal broker calls use the generation pool and never reach the raw
  Streamable HTTP tool-list fallback;
- runner cancellation reaches the pooled call, and lease generation, persisted monotonic
  server/tool authority revisions plus bundled requested revision/activation epoch are
  checked again before a completed result is exposed; revisions are independent of
  wall-clock timestamps, so same-millisecond disable/re-enable ABA is also rejected;
- activation admits only the reviewed pinned `0.8.3` tool surface, removes
  `check_for_update` and `install_ffmpeg`, rejects unknown future tools as an embedded
  protocol mismatch, and locally forces read/ask/deny policy without trusting provider
  annotations;
- Computer Use run snapshots and private preview ownership select the canonical embedded
  provider from the activation row plus exact logical placeholder, require the atomic ready
  projection, current host platform and a live lease, and use the generation broker; the
  live-lease condition also hides a stale ready projection during storage recovery. The legacy package resolver remains the
  gate-off fallback and is never selected by the embedded discriminator;
- Catalog setup/actions derive `requestedEnabled` independently from effective plugin,
  contribution and logical-MCP flags, and require exact host-platform authority plus a
  current Desktop lease before projecting any effective flag. Lease retirement therefore
  hides stale ready contribution/resource state even while durable projection recovery is
  retrying.

The Slice 3 non-ready product-state path now uses an authenticated Desktop availability
record separate from the executable lease. The record is bound to Desktop instance id/
epoch, bridge connection, daemon authority, workspace, platform, generation and a monotonic
same-authority sequence. It permits only `included`, `permission_required`,
`interactive_session_required`, `platform_unavailable`, `incompatible`, `corrupt` and
`desktop_unavailable`. It never permits `ready`. A current or newer non-ready report clears
the live lease before the daemon atomically hides tools/effective flags and persists the
exact repair state; stale generation/sequence reports are rejected. `ready` continues to
require a current lease plus the full activation CAS.

Focused branch coverage includes startup reset failure, first publication, inert renewal,
replacement/revoke/expiry races, bounded generation abort, shutdown cleanup, canonical route
workspace/identity fencing, broker no-fallback behavior, updater/unknown-tool rejection,
retirement/availability projection recovery and private-preview late-result invalidation. macOS and
Windows artifact workflows run the complete daemon and Pi runner test packages. This
coverage is implementation evidence only; it does not prove final Desktop platform-owner
packaging, signing, Windows hosted execution or real-machine acceptance.

### Lease-generation MCP client pool

Bundled embedded mode uses a pool entry keyed by
logical server id, Desktop instance id, Desktop instance epoch, bridge connection id,
daemon authority epoch, lease generation, endpoint, lock digest, provider-seal digest and
optional Windows catalog digest.

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
and activation result carries the captured Desktop instance id/epoch, bridge connection
id, daemon authority epoch, lease generation, lock/seal/catalog digests, activation epoch,
and requested-enable revision. Before
any status, tool catalog, or enabled flag is written, the daemon performs a generation
compare-and-swap against current state. Results
from a replaced generation or superseded user intent are discarded even if the old
operation completed successfully after cancellation.

## Activation Transaction

The existing user enable action remains the consent boundary.

Bundled mode separates durable user intent from effective tool availability:

```text
requestedEnabled = user wants the provider on
effectiveEnabled = artifact + lease + protocol + health + platform readiness all pass
```

The user enable action persists `requestedEnabled=true` and increments a requested-enable
revision. The existing plugin, contribution, and MCP `enabled` flags continue to represent
effective availability and remain false until the transaction commits. This lets a
permission flow survive a Desktop restart without making tools eligible early. Disable
clears the requested flag and advances the revision before process shutdown.

### Durable activation fence and Store API

The workspace store adds one Cua-specific fence row:

```sql
CREATE TABLE cua_driver_activation_state (
  plugin_id TEXT PRIMARY KEY,
  requested_enabled INTEGER NOT NULL CHECK (requested_enabled IN (0, 1)),
  requested_revision INTEGER NOT NULL CHECK (requested_revision >= 0),
  activation_epoch INTEGER NOT NULL CHECK (activation_epoch >= 0),
  updated_at TEXT NOT NULL
);
```

Migration seeds `requested_enabled` from the existing canonical plugin effective flag so
an already-enabled external installation is not silently forgotten. Every intent,
not-ready, retry, effective-enable and disable transition uses one synchronous Store entry
point, `commitCuaDriverActivation()`. Its input carries expected requested revision and
activation epoch, the next requested/effective values, optional revision/epoch advances,
the exact tool replacement, MCP/plugin health status and the three effective flag groups.

The Store method executes `BEGIN IMMEDIATE`, reads and compares the fence, replaces tools
and status, writes plugin/contribution/logical-MCP enabled flags, updates the fence, then
commits. A mismatch returns `committed:false` without any write; any exception rolls back
the complete transition. Request-enable and disable use the same API. Lease replacement,
daemon-authority replacement and serialized retry advance `activation_epoch` before a new
lease becomes usable. Immediately before the synchronous Store call, the activation
service rechecks the in-memory lease token with no intervening `await`.

Before a newly started daemon binds public HTTP/SSE/MCP routes or reports ready, one
startup Store transaction enumerates every `bundled_embedded` Cua Driver row, advances
its `activation_epoch`, preserves `requested_enabled` and `requested_revision`, replaces
tools with empty, writes `desktop_unavailable` when requested intent is enabled or
`included` when it is disabled, and clears plugin/contribution/logical-MCP effective
flags. External-provider rows are untouched. If this transaction fails, daemon startup
fails closed. Therefore a client snapshot arriving before Desktop reconnect can observe
retained user intent but can never observe the old daemon's tools or ready flags.

Required Store tests use two SQLite connections to race activation against disable and
inject failure after tool replacement, status write, each enabled-flag group and fence
update. Exactly one matching CAS may commit and every injected crash must leave all rows
at the pre-transaction state.

Bundled activation is:

1. Confirm a supported packaged Desktop platform and `bundled_embedded` distribution.
2. Require an active compatible Desktop lease.
3. Issue a monotonic activation epoch and capture a token containing it, requested-enable
   revision, Desktop instance id/epoch, bridge connection id, daemon authority epoch,
   lease generation, lock digest, provider seal digest, and optional Windows catalog
   digest. Keep all persisted effective enabled flags false.
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
   displays raw upstream health hints. Ling's readiness controller supplies the correct
   embedded repair UX for the active platform.
7. Run platform readiness. On macOS call `check_permissions` with `{"prompt":false}` and
   require host attribution plus live capturability. On Windows call
   `ling/managed_readiness` over the active child's existing stdio session and consume the
   structured no-content report: exact child PID/nonce/generation, matching non-zero
   host/provider session ids, Medium integrity for both processes, assigned
   `KILL_ON_JOB_CLOSE` boundary, default/unlocked input desktop, UIA runtime
   initialization, D3D11 device creation and WGC API support. Normal activation must not
   enumerate a user target, capture a frame, inspect AX content or perform input.
8. If readiness is incomplete and the activation token is still current, keep effective
   enabled flags false and retain the user's requested-enabled intent. Project
   `permission_required` for macOS TCC, `interactive_session_required` for Windows
   Session 0/locked/wrong input desktop, or `platform_unavailable` for a failed standard
   UIA runtime or WGC/D3D capability probe.
9. If the declared platform tier is ready, set activation-local
   `providerState="ready"`. The Windows standard tier also sets
   `integrityCoverage="standard"` and limitations
   `["elevated_pixel_input","uwp_send_input"]`. Then list tools, apply the Cua approval
   overlay, and remove denied
   updater tools in memory.
10. Compare-and-swap the activation token against current intent and lease state. Only on
    an exact match call `commitCuaDriverActivation()` to replace tools/status and set the
    plugin, contribution, and logical MCP server effective-enabled flags in one
    `BEGIN IMMEDIATE` transaction.
11. Freeze the final committed capability set into subsequent run snapshots.

Intermediate ready snapshots and discovered tools remain activation-local. A current
token may persist normalized `permission_required` or failure health while effective
flags remain false; final `ready`, integrity coverage, limitations, tools, status and
enabled flags commit in one store transaction. No run snapshot can observe the
activation-local catalog.

For the filtered health report, `binary_version` and `platform_supported` must pass.
`session_active` is useful on macOS but does not replace Ling's Windows session probe.
TCC failures project `permission_required`; Windows session failures project
`interactive_session_required`; Windows standard no-content UIA-runtime/WGC-D3D failures project
`platform_unavailable`; malformed schema or core-check failure is incompatible.
Host identity remains proven by platform-native evidence rather than health text alone.

Any artifact, lease, connection, version, protocol, health, or tool-sync failure leaves
the plugin, contribution, and logical MCP server disabled/unavailable. A stale activation
result is discarded without changing current health, tools, or enablement.

Platform readiness failures are recoverable setup state, not artifact corruption. After
the macOS host obtains a grant or the Windows host returns to a valid interactive desktop,
Desktop restarts the provider generation and the daemon resumes requested activation
without requiring a second Enable click.

## Platform Readiness Controller

### macOS permissions

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

### Windows interactive session and integrity

Windows readiness has no permission prompt. The exact signed active MCP child reports and
Desktop verifies:

- active child PID and memory-only nonce match the retained ChildProcess and current
  generation;
- Desktop and provider `ProcessIdToSessionId` values are equal and greater than zero;
- Desktop and provider token integrity levels are both `medium` for standard tier;
- the provider Job Object is assigned with `KILL_ON_JOB_CLOSE` and no breakaway path;
- the current process is attached to the default interactive input desktop and the user
  session is not locked;
- D3D11 feature level 11 device creation and Windows Graphics Capture API support;
- UI Automation runtime initialization without enumerating user content;
- provider PID, executable path, PE seal and architecture match the package;
- `integrityCoverage="standard"` for the initial bundled per-user/asInvoker candidate.

The active Rust child owns the authoritative Windows session monitor. WTS session-change
signals provide immediate hints, and a locked at-most-one-second heartbeat rechecks the
child session and `OpenInputDesktop` so missed notifications or secure-desktop switches
cannot leave stale readiness. Electron's Windows-supported `unlock-screen` event is a
recovery hint, not the source of truth; the macOS-only `user-did-become-active` event is
never treated as Windows session evidence. Every notification carries the child nonce,
lease generation and a monotonic readiness sequence. A lock, disconnect, logoff,
fast-user-switch, session
mismatch, non-default/unavailable input desktop or expired heartbeat triggers:

```text
ready(G)
  -> revoking(G): close proxy call gate; reject new and stale calls
  -> revoke lease/client and atomically commit disabled tools/effective flags
  -> project interactive_session_required; retain requestedEnabled=true
  -> cancel calls and stop child G
  -> unlock/session-active hint starts probing(G+1)
  -> fresh child -> initialize -> active-child readiness -> exact CAS -> ready(G+1)
```

Unlock never restores `ready` directly and never reuses the old child, readiness result or
lease. Stale notifications are discarded by nonce/generation/sequence. Rapid transitions
are single-flight with bounded backoff. The provider also rechecks session/input-desktop
state before each tool dispatch so a call cannot slip through the notification window.
Readiness recovery does not reopen PiP; presentation still follows descriptor, first-frame
and user-hide rules.

Windows acceptance, not normal activation, creates a test-owned synthetic target window
and known-content surface to prove real UIA actions, WGC frames and ordinary input. The
Windows team owns that evidence.

A future `uiaccess` tier additionally requires:

- valid final Authenticode identity for both PEs;
- `cua-driver-uia.exe` installed below a release-policy-approved secure path, normally
  `Program Files`, without disabling `EnableSecureUIAPaths`;
- ShellExecute launch, server PID verification, exact worker seal and a live elevated/UWP
  pixel-input probe;
- lifecycle ownership through an exact-PID shutdown contract, with no global pipe
  collision or surviving helper. If exact PID/pipe ownership is insufficient, that
  future slice must freeze a separate native lifecycle design; the standard tier does not
  preselect one.

The initial package contains no UIAccess helper. Calls that require UIAccess-only
pixel/SendInput semantics return a structured error:

```ts
{
  code: "cua_windows_uiaccess_required",
  requiredIntegrityCoverage: "uiaccess",
  limitation: "elevated_pixel_input" | "uwp_send_input"
}
```

The locked Rust patch produces this code from target/action capability classification;
Ling never matches upstream error text. Element actions and ordinary Medium-IL input
remain supported and are validated separately.

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

## Supported Windows Matrix And Handoff

The engineering baseline for the first bundled Windows implementation is Windows 11 x64 in a logged-in,
unlocked interactive user session. Upstream WGC requires Windows 10 1903+ and D3D11
feature level 11, but neither the engineering baseline nor those framework limits are a
final Ling support claim. The release owner still must name every accepted Windows build;
Windows 10 and Windows ARM64 remain unclaimed until separately added.

Two capability tiers are explicit:

| Tier | Installer/runtime contract | Declared capability |
| --- | --- | --- |
| `standard` | Existing per-user, LocalAppData, `asInvoker`; bundled main PE in embedded stdio mode, with integrity material selected by the independent signing tier | Normal Medium-IL Win32/UWP element actions, WGC capture, ordinary input |
| `uiaccess` | Future release-policy-approved secure-path helper artifact, valid main/helper Authenticode, ShellExecute and live UIAccess proof; this OS requirement does not imply `production_signed` | Adds elevated/UWP pixel and SendInput coverage |

The standard tier is part of this implementation plan. The UIAccess tier is a separate
release slice and cannot be simulated by setting `EnableSecureUIAPaths=0`, launching an
unsigned helper or treating file presence as readiness.

Signing tier is a second, independent dimension:

| Signing tier | Channel | Runtime/package use | Verdict ceiling |
| --- | --- | --- | --- |
| `unsigned_dev` | `development` | Explicit development gate; no trusted catalog | No promotion |
| `test_signed_internal` | `internal` | Real in-Setup private helper, installed candidate and isolated CI/QA trust | `INTERNAL_TEST_PASS`, always `releaseReady=false` |
| `production_signed` | `production` | Production policy and legal Publisher | `RELEASE_PASS` only after every production gate |

Thus `standard + test_signed_internal` is the required Windows implementation target.
It is fully bundled while remaining non-promotable. `standard + production_signed` is the
public-release candidate. `uiaccess` cannot be inferred from either signing tier.

Windows functional acceptance covers, for each applicable policy build and DPI profile:

- installed tier-consistently signed Ling app, NSIS, main provider seal and signed resource
  catalog;
- exact provider PID/path/session plus default input desktop and unlocked-session proof;
- normal Win32 and UWP UIA, ordinary input and real WGC frames against a test-owned
  synthetic target, plus window/source revision and Desktop restart;
- one and two displays with at least 100% and 150%/200% DPI coverage;
- Narrator and NVDA operation, install, update, rollback and uninstall;
- child crash, Desktop crash, daemon restart and zero process/pipe/state
  residue;
- explicit `standard` limitation tests, or elevated/UWP pixel-input tests when the
  candidate claims `uiaccess`.

Production acceptance additionally binds SmartScreen observations to the exact candidate,
time, VM, Mark-of-the-Web, network and policy state. If WDAC/App Control compatibility is
claimed, evidence binds the exact policy id, version, hash and enforcement mode. Neither
surface is derived from Authenticode `Status=Valid`, and neither blocks
`INTERNAL_TEST_PASS`. SmartScreen may record the bounded observation
`observed_no_warning`; it must not claim that an artifact is SmartScreen-certified or
permanently trusted.

Ling's implementation owner must produce the candidate, schemas, runner, verifier,
release-policy template and deterministic handoff manifest. Windows colleagues own the
actual Windows host execution, evidence capture, review and PASS/FAIL sign-off. A macOS
or hosted non-interactive check can validate scripts and schemas but cannot close a
Windows acceptance cell.

## Setup Projection

The current `local_binary` setup model is retained for wire compatibility. Schema V2 adds
a detailed provider state beside the existing legacy state instead of replacing the
existing `kind` or state values.

Target wire shape:

```ts
type CuaDriverDistribution = "bundled_embedded" | "external_local";

type LegacyManagedPluginSetupState =
  | "detected"
  | "missing"
  | "unsupported"
  | "connected"
  | "ready";

type CuaDriverProviderState =
  | "included"
  | "desktop_unavailable"
  | "permission_required"
  | "interactive_session_required"
  | "platform_unavailable"
  | "ready"
  | "incompatible"
  | "corrupt"
  | "external_missing"
  | "external_detected"
  | "external_connected"
  | "unsupported";

interface CuaDriverSetupView {
  readonly kind: "local_binary";
  readonly schemaVersion: 2;
  readonly distribution: CuaDriverDistribution;
  readonly platform: "darwin" | "win32" | "unsupported";
  readonly state: LegacyManagedPluginSetupState;
  readonly providerState: CuaDriverProviderState;
  readonly checkedAt: string;
  readonly requestedEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly integrityCoverage?: "standard" | "uiaccess";
  readonly limitations: readonly CuaDriverLimitation[];
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
  readonly windowsReadiness?: {
    readonly interactiveSession: "ready" | "session_zero" | "locked" | "unknown";
    readonly wgcApi: "supported" | "unsupported" | "unavailable" | "unknown";
    readonly d3d11: "available" | "unavailable" | "unknown";
    readonly uiaRuntime: "available" | "unavailable" | "unknown";
    readonly contentObserved: false;
    readonly integrityCoverage: "standard" | "uiaccess" | "unknown";
    readonly uiaHelper: "not_required" | "ready" | "unavailable" | "invalid";
  };
  readonly externalOverride?: {
    readonly command: string;
    readonly explicit: true;
  };
  readonly guide?: ManagedPluginInstallGuide;
}

type CuaDriverLimitation =
  | "elevated_pixel_input"
  | "uwp_send_input";
```

Legacy mapping is deterministic:

| Provider state | Legacy `state` |
| --- | --- |
| `external_missing` | `missing` |
| `external_detected` | `detected` |
| `included`, `external_connected`, `permission_required`, `interactive_session_required`, `platform_unavailable`, `incompatible`, `corrupt`, `desktop_unavailable` | `connected` |
| `ready` | `ready` |
| `unsupported` | `unsupported` |

New clients use `providerState`; existing clients continue to receive a known `kind` and
legacy `state`. `externalOverride` is a badge/detail field, not a state.

The external install guide is returned only for `external_local` plus
`external_missing`. A damaged bundled component directs the user to update or reinstall
Ling, never to run the Cua public installer.

## Visible State Matrix

| Condition | Provider state | Legacy state | Enabled tools | User action |
| --- | --- | --- | --- | --- |
| Valid packaged artifact, plugin disabled | `included` | `connected` | None | Enable |
| Desktop lease missing | `desktop_unavailable` | `connected` | None | Open/restart Desktop |
| Version/protocol mismatch | `incompatible` | `connected` | None | Update/reinstall Ling |
| Signature/hash/path invalid | `corrupt` | `connected` | None | Reinstall Ling |
| AX or screen grant missing | `permission_required` | `connected` | None | Review permissions |
| Windows Session 0, locked or non-interactive desktop | `interactive_session_required` | `connected` | None | Return to interactive desktop / restart Ling |
| Windows standard UIA runtime or WGC/D3D capability probe fails | `platform_unavailable` | `connected` | None | Restart/update Ling or Windows; inspect support bundle |
| Windows trusted integrity verifier missing or blocked | `platform_unavailable` | `connected` | None | Update/repair Windows policy or Ling; inspect support bundle |
| Windows standard tier is ready | `ready` | `ready` | Policy-filtered standard catalog | Disable; detail shows `integrityCoverage=standard` and both limitations |
| Artifact, lease, health, and platform readiness pass | `ready` | `ready` | Policy-filtered catalog | Disable |
| Explicit external command missing | `external_missing` | `missing` | None | External install guide/path |
| External command found but not connected | `external_detected` | `detected` | None | Automatic connect / retry detection |
| Explicit external command connected but disabled | `external_connected` | `connected` | None | Enable override |
| Linux or another unsupported packaged platform | `unsupported` | `unsupported` | None | None |

## Disable, Quit, Crash, And Restart

### Disable

1. Through one `commitCuaDriverActivation()` transaction, clear durable
   requested-enabled intent, replace tools/status with disabled state, and clear the
   contribution, server, plugin and logical-MCP effective flags; reject new provider calls.
2. Wait a bounded interval for active calls or cancel them.
3. Close the daemon MCP client.
4. Ask Desktop proxy to stop the provider process group.
5. Confirm the already-committed disabled projection still matches the current revision
   fence; stale cleanup completion must not alter a newer enable request.
6. Keep macOS grants unchanged; Windows has no equivalent stored grant.

### Window close or hide

Do not stop the provider process group while the Desktop application remains running and the plugin is
enabled. Provider lifetime follows the app process, not BrowserWindow visibility.

### Desktop quit

Revoke the lease, close the proxy, terminate the provider process group, and leave the external/reused
daemon running. Active provider calls fail with a stable unavailable/cancelled result;
unrelated work continues. A hard Desktop crash cannot run `taskkill`; it is closed by the
child's host-process-death/stdin-EOF contract and verified by a bounded zero-orphan test.

### Provider crash

Invalidate the current lease/session before publishing any replacement, capture bounded
exit diagnostics for child exit or unexpected stdout EOF, and
allow one serialized restart when the plugin remains enabled. Repeated crashes enter a
failed state and require user retry; they do not loop forever or select an external
binary.

### Desktop restart

Complete a new authenticated bridge handshake, receive a newer Desktop instance epoch,
then publish generation `1` for the new instance. The daemon fences the old instance
regardless of its prior numeric generation, reconnects, rechecks version/platform
readiness, and synchronizes tools before marking ready.

### Daemon restart or MCP session loss

On daemon startup, before serving any client, the Store startup transaction advances the
durable activation epoch, empties tools, projects `desktop_unavailable` or `included`
from retained intent and clears every bundled effective flag. When Desktop observes the
new authority epoch or the
accepted MCP session disappears unexpectedly, it stops the current provider process group
and proxy session, increments the lease generation and republishes a fresh endpoint after
bridge reconnection. The new daemon may
initialize only that new generation. A bounded serialized restart prevents reconnect
storms; repeated loss returns `cua_desktop_lease_unavailable` and projects
`desktop_unavailable` until user retry.

## Upgrade And Rollback

Ling does not expose or use an independent update channel for the embedded provider. The
upstream binary's standalone updater remains outside the managed Desktop path described
here.

Upgrade sequence:

1. Stop the old Desktop provider process group before replacing the application.
2. Install the signed Ling update containing the new reviewed provider and lock.
3. Start Desktop with the same platform product identity: macOS bundle id/Team ID or
   Windows tier/channel signing policy.
4. Validate the new artifact and publish a new lease generation.
5. Recheck MCP protocol, health schema and tool catalog plus macOS live capture or
   Windows no-content managed readiness as applicable.
6. Require re-grant UX if macOS invalidated the previous signing requirement; on Windows
   require the accepted interactive session and declared integrity tier.

Rollback sequence:

1. Quit Desktop and its provider process group.
2. Reinstall the previous accepted Ling artifact.
3. Validate the previous lock and provider.
4. Re-run the same platform-readiness and health checks.

Do not replace the provider inside an already signed Ling app/package, repoint a runtime
symlink/junction, or call the Cua installer. The rollback unit is the signed Ling release.

Release retention must keep the previous Ling artifact, provider lock, upstream asset
digest, third-party notices, and acceptance report for the supported rollback window.

## External Override

External mode exists for advanced development and standalone products, not as automatic
recovery.

Rules:

- The user or developer must explicitly select `external_local` and an absolute command.
- Packaged UI labels the active override and its detected version.
- Switching modes disables the current MCP session, stops the provider process group, and performs a full
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
| Tampered macOS nested executable | Source/reference digest, post-sign seal, nested signing and signed outer package |
| Tampered Windows loose provider resource | Signed tiers use an Authenticode-signed catalog, exact membership and main-PE seal; unsigned dev uses final-byte checks behind a non-promotable compile-time gate |
| Test root leaks into user or production trust | Root/PFX never enters Setup; external harness removes/reverts ephemeral trust, while managed trust stays only in an external-PKI-controlled dedicated QA image/VM |
| Candidate self-asserts a stronger signing tier | Independent verifier derives the lowest tier from every tier-governed artifact chain and channel policy |
| Test-signed bytes are promoted or appended with a production signature | Production rebuilds from the approved clean pre-sign payload; mixed/double signatures and pre-sign/final digest mismatch fail closed |
| Authenticode Valid is treated as SmartScreen or WDAC trust | Separate environment-bound evidence; SmartScreen binds candidate/time/VM/MOTW/network/policy and WDAC binds exact policy identity/mode |
| Local browser calls the proxy | Loopback bind, no CORS, origin rejection, per-instance secret, no renderer disclosure |
| Stale Desktop endpoint reused | Memory-only lease, expiry, daemon-issued instance epoch/bridge connection id, then monotonic per-instance generation |
| Reused daemon spawns its own provider | Runtime resolution uses the Desktop lease; daemon spawn is forbidden in bundled mode |
| Provider escapes Ling TCC identity | Direct child requirement, embedded mode, process/TCC acceptance evidence |
| Windows provider runs in Session 0 or another user session | Structured no-content session/input-desktop check plus exact PID/path; real target probes remain acceptance-only |
| UIAccess helper appears in the standard package | Exact signed-catalog/package member allowlist rejects the extra file |
| Unsigned or LocalAppData UIAccess helper is treated as ready | Future helper seal plus Authenticode, secure-path, ShellExecute and live UIAccess gates |
| Old/global Windows driver or UIA named pipe answers requests | Standard bundled mode uses exact child stdio only; pre-bound-pipe regression requires zero connection attempts |
| Provider sends telemetry or update-check traffic during managed use | Explicit environment opt-outs, isolated state, denied update tool, and network-free managed-path test |
| Provider bypasses daemon approvals | Proxy is transport-only; agent calls originate in daemon broker/policy path |
| Crash leaves input-capable orphan | Host PID monitor plus stdin EOF, Desktop-live exact-PID fallback, lease expiry and hard-crash residue tests |
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
- platform readiness/integrity tier and provider exit class with bounded timing;
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
| `cua_windows_interactive_session_required` | Windows provider is in Session 0, locked, or on the wrong input desktop |
| `cua_windows_lifecycle_unavailable` | Windows Job Object/exact-handle lifetime boundary could not be established |
| `cua_windows_integrity_verifier_unavailable` | Trusted Windows signature/catalog verifier could not produce a bounded integrity verdict |
| `cua_windows_platform_unavailable` | Standard Windows UIA runtime or WGC/D3D capability readiness failed |
| `cua_windows_uiaccess_required` | Requested target/action needs the unconfigured UIAccess tier |
| `cua_windows_uia_helper_invalid` | Optional helper signature, path, manifest, PID, pipe or live probe failed |
| `cua_external_override_invalid` | Explicit external command is absent or incompatible |

Messages shown to users must not expose absolute internal resource paths, tokens, raw
stderr, or signature internals. Those details belong in redacted release/support bundles.

## Verification Matrix

### Lock and supply chain

- exact tag, commit, Git tree, prerelease state, both reference-asset filenames, sizes,
  SHA values and extracted binary identities;
- traversal- and symlink-safe reference archive extraction;
- exact `Cargo.lock`, Rust/Cargo, Xcode/macOS SDK, MSVC/Windows SDK versions, patch digest,
  and touched-path allowlist;
- clean patch-series application and every platform binary SHA before signing;
- macOS arm64/x86_64 slices plus Windows PE32+ x86_64 main and audit-only UIAccess output;
- minimum macOS, Windows product policy, upstream `0.8.3`, and Ling revision `ling.1`;
- macOS reference signer/runtime/entitlements, Windows unsigned-reference status, and
  final platform signing identities;
- MIT license digest and third-party notices/SBOM;
- SDK request `2025-11-25`, provider response `2025-06-18`, health schema, embedded
  health skip list, and tools-list digest.

### Package

- macOS arm64/x64 and Windows x64 Ling artifacts contain the locked platform provider
  outside `app.asar`;
- no standalone `CuaDriver.app`, installer, updater script, or PATH shim is packaged;
- nested helper and outer app pass `codesign --verify --deep --strict`;
- final helper bytes, per-slice CDHashes, Team ID, designated requirement, hardened
  runtime, and canonical entitlements match `provider-seal.json`;
- the outer app code-resource seal covers both the final helper and provider seal;
- DMG and ZIP contents bind to the same provider identity;
- notarization, staple, Gatekeeper, and mounted-DMG smoke pass;
- packaged tests prove a conflicting PATH version is ignored;
- Windows signed-tier standard packages contain only the expected main PE, exact main manifest
  and final tier-aware seal inside the two-file payload, plus an outer valid signed catalog
  covering that payload; the covered seal anchors the lock. `unsigned_dev` explicitly
  omits the catalog and cannot pass an internal/production gate. Extra
  `cua-driver-uia.exe`, downloader or external install junction fails package;
- the installed Ling executable, uninstaller, NSIS, provider and catalog agree with the
  derived tier/channel and channel policy; candidate-manifest data alone cannot satisfy
  runtime integrity;
- the initial Windows package projects `standard` coverage and both limitations.
- test-signing tests provision trust outside Setup and prove it absent from the package;
  ephemeral trust is removed/reverted, managed trust is confined to its dedicated
  external-PKI-controlled QA image/VM, and fixtures reject tier/channel mismatch, test
  roots in production, mixed/double signatures, PE/seal/catalog mutation and post-seal
  resigning;
- an installed Setup smoke proves Electron spawns the exact private
  `resources/providers/.../payload/cua-driver.exe` path; a runner-temp PE is not accepted as
  bundled evidence.

### Runtime and bridge

- Desktop main is the direct provider process-group owner;
- compatible reused daemon uses the Desktop lease rather than spawning a provider;
- wrong token, origin, workspace, expired lease, stale instance epoch/bridge connection
  and stale generation fail closed;
- one lease generation creates one daemon MCP client, one initialize sequence, one proxy
  session, and one child; a second initialize is rejected;
- one-shot diagnostics PASS cannot make runtime ready; active-child PID/nonce/session/
  integrity/Job Object mismatch fails, and generation G readiness arriving after G+1 is
  discarded;
- requested enable keeps persisted plugin/contribution/MCP flags false until the final
  `BEGIN IMMEDIATE` revision/epoch CAS commits tools, status and all effective flags;
  two-connection races and crash injection prove complete rollback;
- check/list/health/call concurrency reuses the pooled client and preserves MCP calls,
  notifications, cancellation, content, and structured errors;
- delayed generation G check/list/health results cannot overwrite generation G+1 status,
  tools, or enabled flags after lease replacement, disable, or retry;
- with Desktop still running, daemon restart or unexpected MCP session loss stops the old
  child, rotates authority epoch/generation, republishes, and completes exactly one fresh
  initialize without reusing the old stdio session;
- bundled mode never enters the raw HTTP tools-list fallback;
- `health_report` skips `bundle_identity`; macOS adds `check_permissions` and TCC evidence,
  while Windows consumes the content-free managed-readiness schema;
- with incompatible servers pre-bound on `\\.\pipe\cua-driver` and
  `\\.\pipe\cua-driver-uia`, plus an old external binary first on `PATH`, bundled
  initialize/list/call still come from the sealed child PID/path over stdio and both fake
  servers observe zero connections;
- enable/disable, child crash, Desktop restart, and daemon reconnect are single-flight;
- lock/disconnect/input-desktop change closes the proxy call gate, atomically hides tools,
  stops the old generation and requires fresh-child readiness after unlock;
- graceful quit, provider stdout EOF and hard Desktop kill each leave no provider,
  grandchild, helper, pipe, proxy process or listener residue before retry completes;
- missing/blocked PowerShell, WDAC/AppLocker denial, unavailable catalog cmdlets and
  oversized/malformed UTF-8 JSON map to verifier unavailable, while an executed invalid
  signature/catalog maps to corrupt.

### State isolation

- embedded mode requires an absolute, version-isolated `CUA_DRIVER_STATE_HOME` under
  Desktop `userData` and rejects symlink escape;
- config read/write, restart, PiP config, telemetry markers, and version-check state touch
  only the locked state root;
- sentinel external macOS home and Windows profile `.cua-driver` / `.cua-driver-rs` roots
  remain absent or byte-identical;
- macOS symlink and Windows reparse-point/junction escape attempts fail closed;
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

### Windows acceptance handoff

The release policy freezes explicit immutable cells rather than treating one host whose
build appears in an allowlist as matrix coverage:

```ts
interface WindowsAcceptanceCellV1 {
  readonly id: string;
  readonly windowsBuild: string;
  readonly architecture: "x64";
  readonly displayTopology: "single" | "dual";
  readonly displayScalePercents: readonly (100 | 150 | 200)[];
  readonly requiredEvidenceKinds: readonly string[];
}
```

A `single` cell has exactly one scale entry. A `dual` cell has exactly two entries; a
required mixed-DPI cell must contain two distinct values. The finalizer derives topology
and DPI coverage from this array rather than accepting a free-form label.

`supportedWindowsBuilds` remains a validity allowlist. Separate
`requiredAcceptanceCells` defines what must run; each supported build includes at least
one single-display cell and one dual-display mixed-DPI cell covering 100% plus 150% or
200%. The runner creates one report with exclusive-create semantics for one exact cell.
A rerun gets a new `runId` and file; PASS/FAIL and attachments are never modified in
place. Every attachment is report-relative and SHA-256-bound.

`handoff-index.json` contains the common candidate/policy/artifact anchors and exact
required cell definitions, but not per-cell manifest hashes or output paths. Each cell
manifest binds the common `handoffIndexSha256` and adds its own evidence/output paths;
each cell report binds both that common digest and its unique `cellManifestSha256`.

`finalize-windows-signed-acceptance.mjs` rereads and hashes the index, every cell manifest,
report and attachment, requires every policy/index cell exactly once, rejects
missing/extra/duplicate/cross-cell evidence, and requires the same candidate commit,
signing tier/channel, app/installer hashes, provider seal, catalog, policy, handoff-index
digest and harness closure. Cell and matrix producers cannot self-promote. The
profile-aware independent verifier may emit `INTERNAL_TEST_PASS` for an exact
`test_signed_internal + internal` tuple, always with `releaseReady=false`, or
`RELEASE_PASS` for an exact `production_signed + production` tuple after all production
gates. Every other combination remains `BLOCKED` or `MANUAL_REVIEW_REQUIRED`.

Full mode accepts one operator-supplied input:

```powershell
pwsh -File apps/desktop/tests/run-windows-acceptance.ps1 `
  -HandoffManifest <windows-cell-handoff.json>
```

The per-cell manifest contains `handoffIndexSha256`, cell id, expected candidate commit, a manifest-relative
clean repository root, candidate/policy/artifact/evidence/output paths and hashes, harness
closure and required tool versions. Every relative path resolves beneath the handoff root
without symlink or reparse escape. The manifest improves operator usability but is not a
trust root: the protected release workflow or a policy-pinned detached signature supplies
the expected handoff-index, candidate and policy digests; the finalizer independently
rehashes every unique cell manifest.

The live producer is `produce-windows-acceptance-handoff.mjs`. Its first exclusive-create
phase derives candidate v4 from the clean repository commit, policy, pre-sign provider,
final governed artifacts, seal/catalog, audit-only UIAccess output and normalized observed
signer inventory. After manual evidence binds that candidate digest, its second phase
recomputes the candidate, rejects artifact drift, clones the exact clean commit, copies each
evidence document, attachment and vendor-native inventory member, rehashes every copied byte,
and publishes a new handoff root through an atomic no-replace directory claim. It moves the
repository/candidate/evidence/cell/report trees first and the common index last, so the index
is the ready boundary; a concurrent empty-root claim or crash residue is never replaced.
Candidate-source and evidence-map references
cannot escape their owner through a parent symlink. It fixes
minimum tools to Node 22.0.0, PowerShell 7.4.0 and Git 2.45.0; the Full runner enforces these
requirements before candidate execution. The installed verifier parses the sealed
`provider-lock.json`/`provider-seal.json` tuple and uses trusted Windows
`Test-FileCatalog` plus Authenticode to validate the exact current payload set. The Full
smoke may call the exact installed provider directly only for target discovery. Before
launching packaged Desktop it removes the legacy provider-command override, then invokes the
daemon bundled activation route. Acceptance requires a ready generation lease, provider
health, non-empty tool catalog, standard integrity coverage, source/seal/catalog digests, and
a Desktop-observed ready child whose absolute executable path equals the installed private
resource path. After activation, Desktop calls the bridge-token-protected
`POST /computer-use/provider-target/verify`; the daemon invokes `list_windows` through the
current generation client and returns only an exact PID/HWND match plus the current lease
tuple. Desktop emits one structured proof binding that result to its instance id/epoch,
generation, child PID, child-nonce digest, executable path and lock/seal/catalog digests.
The runner compares every shared field with activation, repeats the proof after Desktop
restart, requires a new Desktop instance and child PID/nonce, and observes the old child PID
gone before launching the replacement. Numeric generation may restart at `1` in the new
Desktop instance; authority rotation is the full instance-id/epoch/generation tuple, not a
cross-process numeric counter. The injected descriptor remains capture-target input only and
cannot satisfy bundled resolver, daemon tool exchange, platform-owner, child or readiness
evidence. Candidate, handoff root, cell reports, matrix and
verification outputs cannot be overwritten.

The standard cell contract fixes `requiredEvidenceKinds` to `accessibility`, `display`,
`install-lifecycle` and `provider-runtime`. Full acceptance re-observes every installed vendor
native hash and Authenticode result. Even failure cleanup may execute the uninstaller only after
both its policy signer and candidate-bound SHA-256 are rechecked.

- static tests validate the Windows lock, main-PE manifest, audit-only UIAccess manifest,
  tier-discriminated seal/catalog and candidate/policy schema, package layout,
  exact runner files and release-policy/candidate-manifest bindings on non-Windows hosts;
- Ling-owned automated Windows CI builds the Rust target, exercises injectable native
  session/integrity/API fixtures, test-certificate PE/catalog signing, Electron Builder
  hook ordering, embedded stdio/global-pipe conflicts, retained-handle/Job Object cleanup,
  PowerShell verifier failures, package allowlists, silent install/uninstall, and
  test-owned Win32 plus installable/removable MSIX/UWP targets before handoff. If public
  hosted runners cannot install the test-signed target, a managed automated Windows pool
  closes the gate; it is not deferred to manual acceptance;
- Windows colleagues run the test-signed installed candidate on every internal-policy
  Windows 11 x64 build and DPI/display cell to close functional implementation acceptance;
  Ling maintainers do not self-attest those cells. The production candidate reruns every
  `requiredAcceptanceCells` entry. Test definitions and runner code may be reused, but no
  internal cell report, attachment, candidate-bound evidence or verdict may enter the
  production matrix;
- Session 0, locked desktop, wrong active-child PID/nonce/path/session/integrity, missing
  Job Object boundary and failed managed-readiness capabilities fail closed without
  observing user content;
- ready -> locked/disconnected -> revoked -> fresh-generation unlocked recovery is proven;
  the old child, lease, tool catalog and late readiness/notification never become usable;
- standard-tier evidence proves normal Win32/UWP element actions and explicit rejection of
  UIAccess-only pixel/SendInput cases through structured capability codes;
- a test-owned target proves real UIA, ordinary input and WGC content; pre-bound global
  driver/UIA pipes and a conflicting PATH provider receive zero bundled connections;
- a future uiaccess-tier candidate additionally proves signed secure-path ShellExecute,
  exact worker PID/pipe, elevated/UWP pixel input and zero helper residue;
- Narrator, NVDA, install/update/rollback/uninstall and crash cleanup evidence bind to the
  exact signed app, NSIS, main-provider seal/catalog, tier/channel, candidate commit and
  policy, so none is reusable across internal and production candidates. Production-only
  SmartScreen/WDAC evidence additionally binds its exact observed environment;
- the report remains `MANUAL_REVIEW_REQUIRED` until independent reviewer and build-attestor
  detached signatures pass the profile-aware verifier. Internal verification stops at
  `INTERNAL_TEST_PASS`; only production verification may reach `RELEASE_PASS`.

Windows colleagues own the internal real-build/DPI/display, Narrator/NVDA and
installation-lifecycle evidence, then rerun the complete required-cell matrix for the
production candidate with production-only SmartScreen/WDAC evidence. They are not the
first testers of Windows native code, catalog verification, packaging hooks or process
cleanup.

### Upgrade and rollback

- N-1 Ling plus provider to N Ling plus provider;
- no old provider process, helper, pipe or daemon handoff survives update;
- same Ling bundle/team identity preserves grants where macOS permits;
- changed or revoked grants produce explicit recovery instead of false readiness;
- reinstalling N-1 restores its locked provider and protocol surface;
- Ling-managed startup, health, and tool use do not invoke the updater or emit provider
  update-check/telemetry traffic; generic direct shell execution remains outside scope.

### Product and compatibility

- packaged macOS and Windows show bundled provider states, not the install drawer;
- Windows distinguishes interactive-session failure, standard integrity coverage and full
  UIAccess readiness without claiming unsupported targets;
- standalone/dev external mode keeps missing/detected/connected/ready and install guide;
- historical plugin records do not produce duplicate rows or MCP resources;
- GUI mutation tools remain approval-gated;
- Windows verifier/runner/schema changes remain compatible with externally produced
  acceptance evidence and never synthesize a local PASS.

## Release Gates

### Bundled implementation complete

The cross-platform implementation is complete only after:

- the complete provider lock contains reviewed non-placeholder values;
- the source patch series, post-sign provider seal/catalog, package, state, and runtime
  matrices pass;
- managed-path telemetry and update network checks are proven disabled;
- the Desktop-owned process and lease architecture passes with a reused daemon;
- both platform adapters, setup states, package assertions and acceptance handoff artifacts
  are implemented and statically verified;
- the Windows signing ladder derives tier/channel from actual artifacts, rejects every
  invalid combination, and the final Setup payload contains and runs the private helper;
- a real `test_signed_internal + internal` Windows candidate passes automated native,
  package, MCP, lifecycle and install/update/uninstall gates and the Windows acceptance
  owner returns `INTERNAL_TEST_PASS`; that verdict remains `releaseReady=false` and carries
  production blockers;
- Windows handoff documentation names the acceptance owner and produces no self-attested
  Windows verdict.

The production Windows Publisher, production certificate service, SmartScreen reputation,
WDAC policy evidence and production detached attestations do not block this implementation
verdict.

### Public release ready

A platform may be declared release-ready only after its external machine evidence closes:

- macOS: all claimed major/architecture cells plus signed clean-host TCC evidence;
- Windows: a newly produced `production_signed + production` candidate passes the legal
  Publisher/certificate/EKU/RFC 3161 policy, all release-policy build/DPI/display/
  accessibility/lifecycle cells, candidate-bound SmartScreen and any claimed WDAC gates,
  plus independent reviewer/build-attestor verification. Only `RELEASE_PASS` sets
  `releaseReady=true`.

Public release additionally requires one of:

1. a stable upstream Cua Driver version that passes the same locked review; or
2. an explicit release-policy exception accepting prerelease `0.8.3`, with external
   reviewer evidence bound to the exact signed Ling artifacts.

## Unresolved Decisions

No product or architecture choice remains open for the standard-capability internal alpha:

- provider: upstream Cua Driver Rust `0.8.3` plus locked Ling build `1` managed
  embedded patch series;
- ownership: Electron main provider process group;
- transport: Desktop stdio-to-Streamable-HTTP proxy plus memory-only daemon lease;
- platform authority: Ling TCC identity on macOS; Ling interactive session and declared
  integrity tier on Windows;
- update and rollback unit: signed Ling Desktop release;
- external provider: explicit fallback only;
- Windows: bundled x64 main provider in standard Medium-IL mode; real-machine acceptance
  is owned by the Windows team.

Release inputs still require concrete values before packaging a public candidate: the
macOS Team ID/toolchain, Windows legal Publisher/production certificate service/toolchain,
and exact supported Windows build allowlist. Deferring the Windows production values
prevents `production_signed` evidence and `RELEASE_PASS`, but it does not prevent a
test-signed bundled implementation or reopen the standard architecture.

One future capability decision remains: whether public Windows support must include
UIAccess-only elevated/UWP pixel input. If yes, a separate secure-path/per-machine helper
installation strategy must be approved and implemented. Deferring it blocks full
integrity-level parity, but not the bundled Windows standard tier. Public distribution on
either platform separately remains gated on a stable upstream provider or an explicit
prerelease exception.
