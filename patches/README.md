# Dependency Security Patches

These patches are applied by root `pnpm.patchedDependencies` and pinned by patch
hashes in `pnpm-lock.yaml`. Review this file when upgrading the affected packages;
do not remove a patch merely because an advisory stops matching a version number.

Reviewed baseline: `fd39ec302cbae759e4d4a866172a804e1bc5abfd`, 2026-10-12.

| Package | Advisory / purpose | Actual consumer | Removal gate |
| --- | --- | --- | --- |
| `node-forge@1.4.0` | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv): reject unconsumed nested DigestAlgorithm elements | Expo code-signing certificates | Released upstream fix plus malformed-signature and valid-certificate regressions |
| `braces@3.0.3` | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): cap brace/parenthesis nesting and validate direct AST inputs | Metro file matching via micromatch | Upstream depth protection covering parse, compile, expand and stringify |
| `sprintf-js@1.0.3`, `sprintf-js@1.1.3` | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c): bound floating-point precision | Mammoth CLI via argparse; Desktop downloader logger via Roarr | Upstream protection plus formatter, CLI help and logger regressions |
| `http-cache-semantics@4.2.0` | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp): never revive zero-freshness entries via max-stale | Desktop Electron downloader via got/cacheable-request | Released fix passing all private, cookie, no-cache, no-store and public-cache tests |
| `metro@0.87.0` | Adapt image-size v2 named exports and asynchronous file API | React Native asset metadata and in-memory asset sizing | Upstream v2-compatible implementation passing both asset paths |
| `image-size@2.0.4` | Retain strict ICNS header/entry bounds from the old local patch in both CJS and ESM | Metro assets; PPTX dependency tree | Upstream equivalent boundary validation passing image regressions |

## Patch Behavior And Provenance

- `node-forge`: backport the `lib/rsa.js` change from
  [official PR 1152](https://github.com/digitalbazaar/forge/pull/1152), reviewed at
  `ceba34402e329f0365134f23fe19898756527d65`. No cryptographic primitive is replaced.
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
  Updating only the version would lose this protection.
- `image-size`: the override replaces every locked `1.2.1` instance with `2.0.4`,
  which includes fixes for
  [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
  [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
  Metro's buffer calls use `imageSize`; filesystem calls await
  `imageSizeFromFile`. The obsolete `1.2.1` patch is removed only after the
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
to flag `node-forge`, `braces`, `sprintf-js` and the cache package. Keep those
alerts auditable; do not silently dismiss them or claim remote closure before
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
