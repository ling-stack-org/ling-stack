# macOS development packaging source review, 2026-10-23

This review updates the fixed development packaging inputs for the current
mainline source and the hosted macOS build environment. It does not authorize
a production release, add a native capability, or replace installed-user
acceptance.

The independent root review confirmed that all 15 original Office native inputs
and 19 restricted-command native inputs still match their approved digests.
The original same-process publication receipts, staged file identities,
signature transforms and final descriptor checks remain in place. Tests cannot
generate or refresh these committed approval rows.

The fixed authored list now contains 1,501 inputs and 41 explicit roots. A
recursive Babel AST audit observed 4,496 literal authored edges, no unresolved
imports and no parse errors. The existing early-entry QA exclusion of
`apps/desktop/main/main.ts` remains explicit; this is not a claim to review the
entire Main graph. Nonliteral imports were checked against the fixed Builder
config and fixed third-party archive-reader selection. The four newly required
inputs cover private installer tooling, its NSIS macros, and fixed model-cache
code and pins. No automatic discovery is used during packaging.

The historic authored changes were reviewed through source provenance, their
current callers, generated locale data, and the capability, approval, lineage,
publication and recovery boundaries. The current changes preserve exact Host
ownership and fail-closed admission; this is a targeted packaging and trust
boundary review, not a line-by-line semantic audit of every feature inherited
from main.

[Hosted inspection](https://github.com/ling-stack-org/ling-stack/actions/runs/39938470722)
and the [first complete build](https://github.com/ling-stack-org/ling-stack/actions/runs/39944618701)
observed the same Darwin 25.6.0 OS profile, SDK settings and four Node header
digests as the previous review. The runtime row admits the currently pinned
Electron 44.8.0 / Node 24.22.0 / libuv 1.52.1. The schema-v2 toolchain profile
pins the exact hosted Xcode 26.6 compiler binary, version first line, SDK
identity and SDK settings digest. Paths may relocate; compiler or header byte
changes do not become approved by relocation.

The root reviewer adopted the restricted runtime row first and then bound the
Office row to its final bytes and the fixed authored inputs. Native and source
publication regression tests retain their original rejection cases. Local
actual Office compilation and the complete isolated Electron suite passed;
the hosted compiler build and final archive verification remain separate
required workflow steps. Developer ID, notarization, GUI acceptance, and new OS
capability certification are outside this development review.

After mainline PR #583 was incorporated, a separate deterministic generation
comparison found changes in 55 existing locale inputs: the same seven file-preview
messages were added to every locale, with no existing messages changed or removed.
The fixed 1,500-input list and 41 roots are unchanged. The root reviewer checked
every resulting digest and rebound those 55 entries plus the independently
reviewed model-cache empty-lock recovery. That recovery only removes an empty
owned lock with nonrecursive `rmdir`; competing live owner directories remain
protected. Its regression first reproduced `cache_busy_timeout` under Windows
directory-rename semantics and passed after the repair. The existing native,
runtime, toolchain and Main-graph scope boundaries remain unchanged; the local-file
IPC/preload/Web capability is outside this Office packaging review.

Forced owner-release interleavings also reproduced and then verified cleanup
when another recovery removes the empty lock or replaces it with a live owner.
All lock-removal sites share the same nonrecursive operation: an absent or
nonempty directory is left alone, and unexpected filesystem failures still fail.

Hosted Windows run 39954972186 then exposed NTFS delete-pending sharing denial
while two recoveries released the same dead-owner lock. Recovery probes and
owner release now retry only `EPERM`, `EACCES` and `EBUSY`, at most eight attempts
with 25 ms between attempts. Each recovery repeats the original ownership
checks; persistent denial retains its filesystem error. Forced transient and
persistent denial regressions passed with the existing recovery/ownership
suite (25 tests). The other 1,499 packaging inputs were independently checked
unchanged before rebinding this cache implementation only. Abandoned partial
directory cleanup stays outside the lock retry; a forced persistent cleanup
denial failed before that separation and retains its original error afterward.

Forced interleavings also cover the collision target disappearing before its
lookup, another recovery deleting the same partial directory, and lock removal
sharing denial after owner release. Confirmed dead-owner cleanup paths survive
lock retries; only concurrent absence is tolerated during partial cleanup.
Persistent claim/removal errors still fail after the bounded retry budget.

On 2026-10-24, hosted packaging diagnostics identified the ASAR duplicate-Office
name check as the App-copy failure. The newly collected distribution sources
included `native/office-local` and were inadvertently selected a second time by
`dist/**/*`. A separate static review approved excluding `dist/distribution`
from the runtime ASAR while retaining its unchanged complete `extraResources`
copy. Actual Builder matchers confirmed the before/after selection; a regression
uses the real copy and ASAR APIs to retain the CLI and compare external source,
license and manifest bytes. Only the `apps/desktop/package.json` packaging pin
was rebound, to `52497a6d81dba42d11f03729c5d5bb7b86339b3ad993703bd83177d7917ea3cb`.
The other 1,499 packaging pins, native inputs, source list and original
ASAR/native/signature/final-archive gates remain unchanged. This source review
does not grant build, signature, runtime or final-archive acceptance.

Mainline PR #585 added a durable compaction-lifecycle projection. An independent
static review checked the five changed daemon inputs and the new
`context-compaction-projection.ts`: existing visible conversation/run anchors
and event-persistence fences remain, and no Office, signing or permission
authority changes. An in-memory Babel audit added exactly three authored edges
to that one type-import-only module, with no new unresolved imports or parse
errors. After merging main, only those five existing daemon digests, the new
source entry and the fixed list's own digest were rebound. The closure now has
1,501 inputs and 4,496 edges; its 41 roots and existing Main early-entry exclusion
remain unchanged. All 15 original Office native source digests remain unchanged.
This static review is separate from candidate build and installed-user acceptance.

The merged #585 localization inputs were also rebuilt independently. All 55 old
catalog modules exactly reproduced their previously reviewed pins; all 55 new
modules exactly reproduced the current generated bytes. Each locale adds the
same 22 messages, with no old message or source-hash changes or removals. The
generator is unchanged. AST inspection of all 110 old/new modules found only
type imports and constant string-data objects, with no runtime dependency edges.
Only the 55 reviewed catalog digests were rebound; loaders and server catalogs
remain unchanged. The closure still contains 1,501 inputs and 4,496 edges.

A separate scoped review approved retaining authenticated `.gitkeep` and
`.DS_Store` resources that Builder's directory walker otherwise omits. Exact
file mappings come from the verified gstack manifest; generated source and
destination paths reject macro syntax before Builder can expand them. The
original directory selection, manifest identity, source revalidation and final
packaged-resource gates remain in place. Only the
`apps/desktop/scripts/packaged-gstack-resources.mjs` packaging digest was rebound,
to `928069518382b89bbcfcac8a95e469e14c62543de139f43f79e22413cb88f466`.
The real Builder-copy regression fails with the original inventory error before
the fix and passes after it. These reviews do not grant native candidate or
installed-client acceptance.

Hosted run 40028538469 reached the original strict signature check, which
rejected Builder's PR signing skip. An independent review approved setting
`CSC_FOR_PULL_REQUEST=true` only inside the fixed entry's final admitted,
awaited Builder call, with unconditional cleanup. Caller-supplied signing inputs
remain rejected; fixed ad-hoc configuration, default signer, no credential
import, no notarization, native publication and final archive gates remain.
Only `apps/desktop/scripts/package-macos-with-office.mjs` was rebound, to
`0c96a59d1a4e15f3dedd739ef59c0f79668ad155408103b8f11197a05f29e5d2`.
Imports and fixed roots are unchanged. Orchestration regressions cover success,
failure, external-input rejection and cleanup; actual hosted ad-hoc identity,
strict signature and final ZIP/DMG acceptance remain required.
