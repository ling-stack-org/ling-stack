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

The fixed authored list now contains 1,500 inputs and 41 explicit roots. A
recursive Babel AST audit observed 4,493 literal authored edges, no unresolved
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
