# Provider runtime authored packaging inputs checkpoint

## Scope and root cause

This follows the [runtime production cutover](provider-runtime-cutover-checkpoint-2026-10-10.md),
saved as `bfbcac2e`, with documentation corrections in `76c652cd` and `e8806711`.
The fixed Office authored-source inventory had not yet incorporated ten new
reachable Provider runtime leaves. The source-only bundler correctly refused
unlisted runtime code; this was an incomplete fixed inventory, not a deleted
production approval record or an external credential problem.

Only the reviewer-owned required-path list and its existing regression matrix
change. They add four Core, five Daemon and one Runner source paths explicitly.
No dynamic discovery/automatic digest updater enters the production build.
Native code, source reader, default signer, package builder, authority contract,
Provider source, published review frame and the independent writer WIP are unchanged.

## Evidence on frozen source

| Gate | Actual result |
| --- | --- |
| Static literal authored dependency baseline | exit1, 36 roots/1233 fixed paths, ten missing leaves; zero unresolved/absent |
| Regression before list fix, Node24 | actual exit1, 68/112 pass and 44 fail |
| Exact same expanded regression after fix, Node24 | actual exit0, 112/112, zero fail/cancel/skip/todo |
| Root Node22 source-input/projection/publication matrix | actual exit0, 331/331, zero fail/cancel/skip/todo |
| Root Desktop complete unit suite, Node22 | actual exit0, 1970 pass/3 Windows-only skips out of 1973; zero fail/cancel/todo |
| Root independent authored dependency audit | actual exit0, 36 roots/1243 unique fixed paths, 1209 reached; zero missing/unresolved/absent |
| Source identity | 1167 production source/native/script paths checked; only fixed inventory differs |
| Independent readonly review | no remaining P1/P2; exact ten-path addition, unchanged gates and zero-build GREEN verified |

The corrected digest record is 156138 bytes, within the existing 256KiB reader
limit. The separate embedded published-review frame remains 32KiB. This audit
resolves literal runtime imports/exports/import()/require() with type-only edges
excluded. It does not prove user-selected/nonliteral imports, vendor/toolchain
source, native linker behavior or OS trust.

The tests use the existing explicitly synthetic native compiler/SDK/signing
fixture and disposable source copies. Real esbuild is not replaced: its actual
metafile includes 3991 inputs, 1155 authored workspace inputs, all 27 targeted
new-runtime leaves and zero workspace-dist inputs. No bundle is executed.
Final missing-digest, mutated-source and missing-source-with-existing-dist
cases reject before native/sign/verify/normalize/esbuild, all counters zero.

The original RED is retained with its real counters: 60 synthetic native
compiler and 30 synthetic sign calls. It is **not** mislabeled zero-build;
that refusal guarantee is verified by the final GREEN. Counts overlap and
must not be summed into a unique-test total. Desktop unit completion does
not certify renderer/playwright, actual model, actual native build or GUI.

Raw evidence is under `output/e6-20260928/`:

- `office-provider-required-inventory-baseline-20261010.json`
- `office-provider-required-inventory-red-20261010.tap`
- `office-provider-required-inventory-green-20261010.tap`
- `office-provider-required-inventory-root-node22-20261010.tap`
- `office-provider-required-inventory-desktop-full-20261010.tap`
- `office-provider-required-inventory-root-closure-20261010.json`
- `office-provider-required-inventory-source-before-20261010.sha256`

Frozen changed-path SHA256:

```text
6e37570abbce201ca9b18ad9595ff610a368991d25798827269b06eb826249a3  apps/desktop/scripts/packaged-office-native-review-inputs.mjs
eafacf3d906d2a87349bfeffd160f07f10df9a6f8bc43f9689942a2a9359ffaf  apps/desktop/tests/packaged-office-daemon-source-inputs.test.mjs
```

## Formal approval remains a separate gate

The production `native/office-local/reviewed-packaged-source-v1.json` is still
absent and has no tracked Git history. No approved row is created/refreshed.
The current reader binds fixed reviewId/approval values and exact source,
packaging, compiler, SDK, headers, runtime, signer and trust facts; it has no
reviewer identity, public-key or signature field. Code therefore does not
establish who is authorized to issue that approval. A prior narrow native
source audit explicitly did not authorize it.

An independent review of the complete frozen inputs and an explicitly trusted
approval source remain required before fresh production packaging. This
checkpoint does not weaken that requirement or use a generic developer/old
mixed package as acceptance evidence. It adds no credentials, Keychain access,
native signing, installation, release, PR or cloud-CI operation.

## Verdict and next target

Fixed inventory and source-only rejection regressions are complete. No new
implementation choice is needed for this bounded fix. The actual formal
review/approval source remains unresolved; the consequence is that fresh
Office packaging and the required macOS 12-case acceptance cannot yet be
claimed complete. H09 producer/task foundation, H10's independent budget,
isolated Keychain and native Mobile acceptance remain separate active work.
