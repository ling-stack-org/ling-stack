# Dependency Security Patches

These patches are applied by root `pnpm.patchedDependencies` and pinned by patch
hashes in `pnpm-lock.yaml`. Review this file when upgrading the affected packages;
do not remove a patch merely because an advisory stops matching a version number.

Reviewed baseline: `fd39ec302cbae759e4d4a866172a804e1bc5abfd`, 2026-10-12.

| Package | Advisory / purpose | Actual consumer | Removal gate |
| --- | --- | --- | --- |
| `@expo/cli@58.1.13` (historical bridge, no longer enabled) | Preserve the optional MCP tunnel's Zod 3 schema protocol while the old CLI used fixed Zod 4 for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | Expo dev-tools MCP command schemas | Met with CLI 58.1.18: upstream injects expo-mcp's own Zod into the command factory; actual entry, tunnel serialization, strict schemas and executor regressions pass without the bridge |
| `node-forge@1.4.2` (upstream fix; local patch removed) | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv): reject unconsumed nested DigestAlgorithm elements | Expo code-signing certificates | Met on 2026-11-02: upstream canonical DER validation plus malformed-signature and valid-certificate regressions |
| `braces@3.0.3` | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): cap brace/parenthesis nesting and validate direct AST inputs | Metro file matching via micromatch | Upstream depth protection covering parse, compile, expand and stringify |
| `sprintf-js@1.0.3`, `sprintf-js@1.1.3` | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c): bound floating-point precision | Mammoth CLI via argparse; Desktop downloader logger via Roarr | Upstream protection plus formatter, CLI help and logger regressions |
| `http-cache-semantics@4.3.0` | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp): never revive zero-freshness entries via max-stale; retain upstream Vary fixes | Desktop Electron downloader via got/cacheable-request | Released fix passing all private, cookie, no-cache, no-store, Vary and public-cache tests |
| `metro@0.87.0` (historical patch, not enabled) | Adapt image-size v2 named exports and asynchronous file API | Current SDK58 resolves RN Metro 0.87.2 and Expo Metro 0.87.1; both use an internal parser | Re-enable only for an actual matching version whose asset implementation needs this adaptation, and verify both asset paths |
| `image-size@2.0.4` | Retain strict ICNS header/entry bounds from the old local patch in both CJS and ESM | PPTX dependency tree | Upstream equivalent boundary validation passing image regressions |
| `minimatch@9.0.9`, `minimatch@10.2.6` | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): bound globstar-parent preprocessing and quadratic deduplication | Pi SDK, Electron builder/universal and Expo CLI | Compatible upstream release containing both limits, passing both module-format and consumer regressions |
| `glob@11.1.0`, `glob@13.0.6` | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4): stop directory traversal after abort | Expo MCP, Electron/Expo packaging tools | Compatible upstream release containing all walker cancellation/resume fixes, passing abort, stream and ASAR regressions |

## Patch Behavior And Provenance

- `minimatch`: backport the two preprocessing limits from official commit
  [`77a0f5c4`](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8)
  to both CJS and ESM. Version 10 shares its existing `braceExpandMax` (default
  100,000) with globstar-parent splitting. Version 9 has no such public option,
  so it uses the same fixed default budget without inventing a new option or
  changing its brace-expansion API. Both skip optional pairwise deduplication
  above 1,000 patterns while preserving matching. The regression uses a
  near-budget pattern set and a small explicit limit, not an unbounded input
  that could hang a CI worker. Legacy versions 3 and 5 have no level-two
  preprocessing implementation; this backport does not upgrade them or claim
  that version-based advisories have disappeared.
- `glob`: backport official commit
  [`4682e8c9`](https://github.com/isaacs/node-glob/commit/4682e8c9babee1b385202ede36389634e12076d7)
  without crossing consumer-declared majors. All four recursive walker entry
  points return immediately after completing an aborted callback; resume
  callbacks must still settle already-paused work. Version 13's default exports,
  `main` and `module` select its existing unbundled entrypoints (also published as
  `glob/raw`), retaining the same public API and types. This ensures real
  consumers load both the patched walker and the separately patched minimatch,
  instead of unchanged copies embedded in `index.min.js`. No dependency majors
  or dependency declarations change. Both default and raw entries, in both
  module formats, have cancellation and pattern-budget regressions. Legacy
  glob 7 is outside the cancellation advisory and remains unchanged.
- `@expo/cli`: Expo 58.0.21 resolves CLI 58.1.18, which no longer depends on
  Zod for plugin or output collection validation. Both actual consumers use
  `@expo/schema-utils`; its bounded-array regression checks rejection before
  visiting elements. The real `MCP.js` entry resolves Zod and the tunnel relative
  to `expo-mcp`, then injects that Zod into the CLI command-schema factory.
  `expo-mcp@0.2.4` and `@expo/mcp-tunnel@0.2.4` share Zod 3.25.76, preserving the
  command enum, optional string/number/boolean parameters and strict JSON Schema
  conversion. The tunnel still uses Zod 3, not Zod 4. The old bridge is inactive
  because this upstream injection replaces its purpose, not because the tunnel
  gained Zod 4 support. Its historical patch file remains for provenance.
  The mobile devDependency on `expo-mcp` makes the optional integration's actual
  entry and tunnel part of the security regression gate without enabling MCP or
  opening a connection; tests also execute a local plugin and reject invalid
  calls before spawning it. Fixed Zod's original bounded-array regression is
  retained through the daemon MCP consumer, separately from the new Expo path.
- `node-forge`: the former local patch backported the `lib/rsa.js` change from
  [official PR 1152](https://github.com/digitalbazaar/forge/pull/1152), reviewed at
  `ceba34402e329f0365134f23fe19898756527d65`. Published 1.4.2 now re-encodes
  DigestInfo as canonical DER and checks the encoded bytes, rejecting the extra
  nested elements guarded by that patch. The obsolete patch was removed only
  after a real frozen install and all 47 dependency-security regressions passed,
  including malformed signatures, valid optional NULL parameters and Expo
  certificate/signature round-trips through the actual consumers.
- `braces`: the fixed maximum is 100 nested containers. Parsing rejects excessive
  brace and parenthesis depth before recursive work. An iterative preflight also
  protects caller-supplied deep or cyclic ASTs. Escaped and quoted literals do not
  count as containers. This is a local mitigation while
  [upstream issue 70](https://github.com/micromatch/braces/issues/70) remains open.
- `sprintf-js`: preserve valid precision, clamp excessive numeric precision to
  100 and `%g` zero precision to 1. Only formerly invalid numeric formats change;
  string truncation and normal formatting are unchanged. Do not replace the
  RangeError with another uncaught exception. This mitigation does not make
  arbitrary invalid format strings or argument types safe. See
  [upstream issue 237](https://github.com/alexei/sprintf.js/issues/237).
- `http-cache-semantics`: preserve the existing conservative zero-freshness
  guard. The published `4.3.0` was independently tested on 2026-10-12 and still
  reused private, cookie, no-store and no-cache responses with `max-stale`.
  Updating only the version would lose this protection. The current branch
  carries that guard on `4.3.0`, without rolling back its upstream Vary fixes.
- `image-size`: the override replaces every locked `1.2.1` instance with `2.0.4`,
  which includes fixes for
  [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
  [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
  The historical Metro 0.87 patch uses `imageSize` for buffers and awaits
  `imageSizeFromFile` for files. SDK57 with Metro 0.84.5 was the historical
  baseline, not the current dependency graph. SDK58 currently resolves RN Metro
  0.87.2 and Expo Metro 0.87.1; both use their internal image parser. Their buffer
  and file asset paths have independent regressions; malformed-image proofs
  resolve image-size through the actual PPTX consumer. The obsolete
  `1.2.1` patch is removed only after the
  parser, asset and PPT generation checks pass.

## Verification And Alert Boundaries

Run `corepack pnpm install --frozen-lockfile`, then
`corepack pnpm check:dependency-security`. CI already runs the latter command.
Tests resolve dependencies through their real consumers, not a separate root
copy. Image hang proofs run in child processes with a one-second deadline.
Certificate tests use fresh, test-only keys and perform no network operations.

Also build Web and Desktop when changing dependency resolution. Successful
source builds are not signed macOS/Windows installer acceptance.

Local patches do not change upstream package versions, so Dependabot can continue
to flag `braces`, `sprintf-js` and the cache package. Keep those
alerts auditable; this also applies to the `minimatch` and `glob` backports. Do
not silently dismiss them or claim remote closure before
the changes are merged and GitHub rescans the dependency graph.

### Local Validation Snapshot (2026-10-12)

- Frozen pnpm installation: passed.
- Dependency-security regressions: 33 passed (16 Mobile/tooling, 2 Daemon,
  15 Desktop downloader/formatting).
- Daemon Office artifact preparation: 105 passed.
- Selected Desktop Office runtime and emitted-bundle contracts: 33 passed.
  Native publication/signing in those bundle tests is synthetic, not installer
  acceptance.
- Desktop build, including Web, Daemon, macOS Office helper and preload/renderer:
  passed. Desktop and Mobile typechecks passed.
- Web lint, 55-locale i18n audit, license policy, Markdown links, public-repo
  safety and diff whitespace: passed.
- Registry version audit no longer reports either image-size advisory. It still
  reports the other four advisory families (sprintf-js occurs at two versions)
  because local patches do not update their upstream version metadata.
- No remote alert dismissal, push, PR, signed installer or real Windows
  acceptance was performed.
