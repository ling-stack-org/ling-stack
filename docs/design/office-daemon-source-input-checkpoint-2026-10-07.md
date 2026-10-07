# Office daemon reviewed-source input checkpoint

Date: 2026-10-07. Implementation branch: `codex/e6-safe-continuation`.
Parent checkpoint: `8e4e1d6867cb1ba157baa34d8ff350a2aa1781d1`.

## Verdict

The Office-only daemon bundler now consumes retained reviewed authored workspace
bytes, not pre-existing or newly adopted workspace `dist`. This closes the
workspace generated-input gap. It is not approval to publish the product or a
final signed App, Electron, CLI/MCP, ZIP/DMG, or GUI acceptance result.

## Root cause and reproduced failure

Previously, independent review hashed authored TS while real esbuild loaded
workspace compiled JS. The unique esbuild output pins proved output custody,
not that its inputs came from reviewed sources.

A disposable, explicitly synthetic approved fixture ran the real fixed fresh
daemon/publication APIs and real esbuild. Only
`packages/core/dist/original-office-host-bridge.js` received a legal side effect;
the reviewed TS and fixture review row stayed byte-identical. The original
builder granted original emitted CLI pins containing that side effect.

The original semantic RED is preserved in
`output/e6-20260928/office-daemon-source-inputs-original-red-20261007.tap`:
one test, one failure, no skips. Missing approval, broken syntax/imports, and a
mocked esbuild output were not used to manufacture that failure.

## Implemented boundaries

- [Focused source input module](../../apps/desktop/scripts/packaged-office-daemon-source-inputs.mjs)
  owns the Office workspace input projection, not native signing or output
  publication. No caller-selected review, manifest, root or receipt is accepted.
- It captures the complete fixed reviewer-owned workspace source/package/config
  inventory before any native builder or asynchronous resolver runs. Each file
  uses a bounded no-follow FD, hash against the existing independent review,
  canonical path, regular-file/owner/link/mode checks and full before/after
  identity fences. Private retained bytes are not exposed. Limits are 8 MiB per
  file, 128 MiB total and 2,048 captured inputs.
- Nine workspace packages are explicit. Package exports and relative JS imports
  resolve to reviewed authored sources, not filesystem-discovered dist.
  Unknown/missing inputs, ambiguous exports, export traversal and illegal
  first-party back-edges are rejected. A graph change requires explicit review.
- The nine admitted compiler configs are explicitly reviewed and restricted to
  the current NodeNext/ES2022 policy. Explicit esbuild `tsconfigRaw` prevents
  ambient tsconfig discovery. No tsconfig, digest or approval row is regenerated.
- Workspace inputs are loaded from the original snapshot. After bundling, the
  actual metafile must agree with the consumed source set, and all captured
  identities, hashes and the original review identity are rechecked before any
  original output publication is issued.
- The [builder](../../apps/desktop/scripts/build-packaged-daemon.mjs) still copies
  the unique real `write:false` esbuild result into private memory first, then
  checks source inputs and the original native publications before publishing.
  Its native publication and source snapshot must share the same review SHA.
- Two build-time imports of the daemon dist review constant now import its
  self-contained authored TS directly. Fixed build Node 22.22.1 native TypeScript
  stripping was actually verified. Disabled/unsupported stripping fails, never
  falls back to dist. New runtime imports or non-erasable syntax in that module
  require review. This is authored bootstrap code, not a claim of protecting
  bootstrap execution with the later esbuild plugin.
- Ordinary developer daemon bundling retains its existing dist lane. No shared
  provider session, UI, database, Keychain, Windows, or dependency upgrade was
  modified.

## Exception handling and regression evidence

The first source integration exposed optional vendor dependency resolution
being promoted to fatal plugin errors. The fix preserves esbuild's own default
optional-import and package-sideEffects handling, without installing, stubbing
or externalizing the missing optional packages. Workspace back-edges are still
rejected by source loading and the metafile fence.

A second integration failure showed that Node's `builtinModules` enumeration
omits prefix-only `node:sqlite` on the fixed runtime. Admission now uses the
runtime's `isBuiltin` authority, not a new hardcoded exception. A real esbuild
`node:sqlite` regression test and non-builtin rejection remain in the suite.
Both intermediate FAIL TAPs remain separate from the final GREEN.

Final Root affected-neighborhood run: **400/400**, zero failures, cancellations,
skips or todos. Includes the source integration, focused projection, original
emitted output, original native publication, ASAR checks, package checks, hooks,
mac wrapper and codesign publication tests. This is not the repository full
suite or the packaged GUI matrix. Raw evidence:
`output/e6-20260928/office-daemon-source-root-final-neighborhood-20261007.tap`.

Independent integration evidence:

- Actual real esbuild metafile: 3,669 inputs, 1,125 reviewed authored workspace
  runtime inputs, **zero workspace dist inputs**, all nine packages.
- Polluting only the fixture dist leaves the original bundle byte hash unchanged
  and the side effect absent.
- An independent explicitly reviewed fixture TS change enters the real output
  while its corresponding dist stays unchanged. The observed API output bytes
  exactly match original publication/readback pins.
- Native compiler bodies and codesign transforms are synthetic; real esbuild,
  the fixed fresh builder and original publication APIs are not. Neither fixture
  product was executed. No production approval was created.

Focused projection owner: 117/117 including snapshot replacement/read races,
symlink/hardlink/invalid UTF-8, export/namespace/metafile boundaries, optional
vendor dependencies and prefix-only builtin behavior. These are included in the
Root 400, not an additional count.

Read-only authored closure audit: **35 fixed roots / 1,211 unique inputs**, no
missing/unresolved/absent literal authored edges. The audit does not approve
sources. The separate 15-file native source closure and 32 KiB runtime published
literal limit are unchanged. Ordinary real developer daemon bundle also exits 0.

Independent static narrow review found no confirmed P1/P2 for this source-input
slice; it is not approval of the cumulative PR.

## Remaining gates and decisions

No unresolved implementation decision for this workspace input slice.
External vendor inputs, native/toolchain/SDK/default signer review and dynamic
runtime assets are not attested by a workspace metafile. In particular,
browser-host developer native assets are a separate runtime boundary. Full
Access or arbitrary same-UID processes are not isolated by these JS guards.

The production independent approved source row is still absent. Real final
signed App/ZIP/DMG, same-package Electron/CLI/MCP formats, Core lease barriers,
the original startup Keychain failures, and twelve-category macOS Computer Use
acceptance remain open under the original D0/E1–E6/U/T/Harness goal. Remote
payments/spending-limit CI termination is not a source test failure or a CI pass.
No failed CI job is repeatedly rerun, no review/CI gate is bypassed, and this
checkpoint does not change the overall completion verdict.

Next internal gate: independently establish the fixed vendor/toolchain/SDK and
default signer input boundary, then obtain an actual approved review and prove
the final package chain. Do not redo the completed attachment/source, elapsed
duration, R03 or right-side UI slices without a concrete new regression.
