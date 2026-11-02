# E6 generated-catalog stability repair

## Confirmed failure

The isolated v4 packaging run exited with status 1 during the early Core emit
preflight. Core's actual build succeeded. The subsequent unchanged-input check
correctly rejected a replaced generated file: `catalog-loaders.ts` had identical
bytes, owner, device, mode and size, but a different inode.

The real generator always wrote a temporary file and renamed it over every
output. Comparing all 2,971 frozen inputs after the run found exactly 57 inode
changes, all in localization's generated outputs, and no content changes. The
frozen `packages/core/dist/bundled-skill-source.js` identity was unchanged.

The run's retained `parent-result.json` records 56,058 ms, direct child 97282
closed with exit code 1, process group absent, output settled, lease released,
and no termination errors. It did not enter resource reconstruction or create
a new App, ZIP or DMG. The failed run is retained, not relabeled or restarted.

## Minimal implementation

`packages/localization/scripts/compile-catalogs.mjs` now skips a write only when
the existing output is a regular, single-link file with exactly equal bytes.
Changed and missing outputs retain the original atomic replacement path.
Symbolic links and hard links are replaced, not retained as stable inputs.
Only `ENOENT` is treated as absence; other filesystem errors propagate.

The packaging verifier is not weakened: content hashes, inode/owner/mode checks,
the frozen HEAD, Office review, selection custody and final process settlement
remain unchanged. The v5 QA wrapper adds explicit pins for the generator, its
catalog helper and its tracked source catalogs. It uses a new evidence directory
without modifying any v4 packet or result.

The generator is not an enumerated authored Office input; its generated runtime
outputs are. Their bytes are unchanged, so this repair does not rebind or mint
an Office approval. The existing real Office reader must still match every one
of its 1,621 inputs. No native code, dependency, resource policy or schema changes.

## Validation and remaining gate

- Disposable fixtures execute the real generator, not a mock writer.
- Before the fix: 2 of 4 cases failed, specifically unchanged-input preservation.
- After the fix: the final 5 cases pass, covering unchanged bytes/identity,
  changed messages, added/removed locales, symbolic links and hard links.
- Full localization package validation passed catalog audit (55/55 locales,
  6,851 keys), real catalog generation, TypeScript compilation and all 19 tests
  loaded at that run. The hard-link case was added afterward and passed in the
  final 5-case run; it is not retrospectively counted in that earlier result.
- The final combined localization test run then passed all 20 tests with no
  skips (333.138917 ms), including the hard-link case.
- `node --check` and `git diff --check` passed.

Full Core frozen-pin verification, resource assembly, macOS packaging and new
GUI acceptance remain separate real-run gates. No release is authorized, and
passing this small regression suite does not complete the E6 goal. Main CI stays
disabled as requested. Existing resource caps and retained artifacts are intact.
