# macOS development packaging source review, 2026-10-29

This review rebinds the existing unsigned development packaging lane to main
`05aca19cd015719a4c245b587c581526349c189e` plus the fixed inventory correction in
this change. It addresses the two blocked prerequisites observed in
[hosted build 40883523332](https://github.com/ling-stack-org/ling-stack/actions/runs/40883523332).
It does not grant final App, ZIP, DMG, public signing or installed-user acceptance.

## Review and adoption order

1. Compare the committed source records with current source and the hosted
   toolchain/runtime observations. Keep native source, toolchain, OS, trust,
   signing and capability boundaries fixed.
2. Independently review the changed packaging inputs and audit the authored
   dependency graph from its existing 41 roots. Explicitly add missing modules;
   do not discover or approve new inputs during a build.
3. Rebuild the unchanged native inputs and check actual Electron compatibility.
   Regenerate locale modules from their committed catalogs and verify determinism.
4. Adopt the sandbox runtime row first, then bind the Office row to the final
   sandbox bytes, final fixed inventory and reviewed packaging inputs.
5. Verify the strict source reader and existing rejection regressions. A fresh
   hosted build remains necessary for final compiler and archive verification.

## Source and runtime decision

An independent packaging reviewer checked the changed source against the last
record update, `9e7c13ee`, including release/local admission, receipt custody,
fixed source projection, package resources, dependency manifests and the inherited
core/daemon changes. The 83 changed tracked inputs match their old approved Git
bytes at that baseline. The other 55 initially stale inputs are generated locale
modules; all 55 were rebuilt twice with identical output from committed catalogs.

A separate Babel 7.29.8 TypeScript AST audit found 25 newly reached modules:
contract exports, runner-ID and permission migrations, engine lifecycle,
conversation metrics, deliverables, diagnostics, IM destinations, notifications,
marketplace routing and the media permission/protocol contracts. Their explicit
addition increases the fixed inventory from 1,501 to 1,526 inputs. All 41 roots
and all existing inputs remain. The final audit found 1,464 reachable authored
files and 4,564 literal runtime edges, no missing inputs, no unresolved authored
imports and no parse errors. The two existing nonliteral loads retain their
fixed Builder configuration and pinned archive-reader selections. Existing Main
graph exclusions remain; this is a scoped packaging review of inherited code,
not a complete semantic or security certification of every product feature.

Both records now admit Electron **44.9.1**, retaining embedded Node **24.22.0**
and libuv **1.52.1**. Actual local Electron runtime and OS observations exactly
match the hosted observations. All 15 Office and 19 sandbox native input hashes
remain unchanged. Darwin 25.6.0, backend/codesign/template identities, Rust 1.97.1,
N-API 8, deployment target 13.0, ad-hoc signing, `unsigned_dev`, `provider=false`,
headers and the approved hosted Xcode 26.6 profile remain unchanged.

The local Command Line Tools compiler has a different binary digest despite the
same version first line. It was used for local compatibility testing only; it
was **not added** to the approved hosted toolchains and remains rejected by the
strict profile check.

The Office row changes 140 existing packaging digests: the 138 initially stale
inputs, the corrected inventory itself and the updated sandbox record. It adds
25 digests without removing any existing entry. No approval generator, production
code fallback or weakened guard is introduced by this change.

## Bound record identities

Aggregates encode the fixed-order `[path, sha256]` pairs as JSON plus a newline.

| Input | SHA-256 |
| --- | --- |
| Office record | `5d9e60a681849a0ba4fed7b61041efe841d78c831fb079db9bef29b276d18692` |
| Sandbox record | `5a54ea7f3aeb3afd80d3019bdd4c802d074a6bef61f5c72b5cba18ef1c0c36db` |
| Packaging aggregate | `c56cfad9763cd01ccad191bbf7d618ff66c8d2d1d729a40cc5ddf8be30600ff8` |
| Unchanged Office native aggregate | `715c56bcc31a2f6fbf546e86c2a937702305675cd17e6f69136089f09a4b7c0f` |
| Unchanged sandbox native aggregate | `6770a6864706c68c41ed4998c826daeff7e33baf7d59d9d9cfca8a9b63da1dbd` |

## Validation and limits

- Current daemon and its workspace dependencies build successfully.
- Fresh Office compilation passed; all 48 primitive/publication/readback tests
  passed under Node and all 48 under actual Electron 44.9.1. The confined actor
  uses the existing test-only `OFFICE_LOCAL_TEST_ACTOR_NODE` setting to select
  standalone Node; the addon and test host run in Electron. Initial runs exposed
  missing local dependencies and then the missing actor setting; both were
  corrected without changing the tests or native sources.
- Fresh sandbox compilation passed with Rust 1.97.1: 26 Rust tests passed and
  two existing tests remained ignored. Process protocol 19/19, input-read 10/10
  and codesign rejection protocol 18/18 passed.
- Actual restricted-command dispatch using the newly built helper and Electron
  44.9.1 passed 10/10 tests.
- Strict source/native digest readers accepted all final inputs using the
  recorded hosted toolchain observation. This check substituted only the
  toolchain observation and is a snapshot comparison, not fresh hosted execution.
  The real profile validator still rejects the local compiler digest.
- Final Office/codesign publication, authored-source projection, toolchain,
  hooks, ASAR, archive and packaging-entry contracts passed 957/957 with no
  skips. Desktop release workflow contracts passed 23/23. Markdown links,
  public-repository safety and whitespace checks passed.

The existing source-projection regressions first failed because newly reached
authored inputs were absent from the approved inventory; they pass after the
inventory correction. Native fixture
contracts do not replace original same-process publication, strict signature,
resource, ASAR or final archive checks. These remain mandatory in the next
`Desktop candidate` build using the updated commit, rather than a rerun of the
old immutable SHA.
