# P3 main integration — Office literal authored-closure inventory audit

2026-10-24. Reviewer: real independent agent `/root/p3_main_office_closure_audit`.

## Superseding final inventory — 2026-10-24

After the primary agent explicitly added the nine necessary runtime leaves and repaired the HTML scanner,
the final inventory is **1603 fixed inputs, 1536 root-reachable authored paths, zero missing, zero unresolved**.
Against the still-unchanged 1594-row approved manifest there are **99 changed/new rows**:
**43 source modules + one fixed-list module + 55 generated catalogs**. Three of the 43 source-module
changes are the type-only deltas described below. This final inventory remains **not approval**.

Final evidence: `output/e6-20260928/p3-main-office-closure-audit-final-20261024.json`, SHA256
`794c76a536c5ab4c1389796ca0813ba5cb29eb6b8b03426f24a5cc8f41219c88`.
All final fixed and traversed rows were rehashed twice with no drift. The complete earlier Babel graph
was reused only where bytes were identical; all three changed visited code files were reparsed, and their
literal runtime edges were unchanged. Root arrays and the nine pinned workspace package target files
were verified unchanged. Generated output/provenance hashes were also rechecked unchanged.

| Final snapshot | SHA256 |
| --- | --- |
| All 1603 `{path,sha256}` fixed rows | `02fd113282bdfea1eea050c6c01dd4c32c94357f9a0799bad0871bad9f5b232c` |
| 99 changed/new rows | `292c9aadbcf0800e201f49d5538a2c90fb648955b8f4d9f9dc09a7490300feff` |
| Fixed-list module | `be1e759cde00fe1f23e013bd965554738cb36b4791e7099cd1f83c3548dd34b3` |
| Repaired HTML helper | `7f60e054030a40f98cc4f9af2eff4e7f2cec62c6e8ccd01748ad6514b64478c2` |
| Final budget migration | `c8a1a2bd0f4f5487fa0bee1a145110f367da1ef97bf3212434e77dbe834878d3` |
| Still-unchanged approved manifest | `a2101cb33860669399da6967e61185663b69906374b52b40cb4e0c579ed8a78e` |

The initial 1594/89/9-missing snapshot and hashes below are retained as discovery evidence, not presented
as final state. Content review is separately recorded in `p3-main-daemon-delta-independent-review-20261024.md`;
Core/migration and DMG review remain their own exact-byte scopes.

**Inventory/provenance audit only. Not whole-file content review, Office approval, human authentication, package success or GUI acceptance.** The reviewer changed no production source, fixed list, manifest, Git index/history or database, did not run builds/packages/models, and only wrote this report and its evidence JSON.

## Scope and snapshot

- Authorized worktree: `/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`.
- Observed HEAD: `17af63ac1b3218731db506e03e13f469cc8a1874`.
- Merge target: `7bd33739852cec139822b33e12b4f8189b3964de`; merge was still in progress. This is a dirty-worktree byte snapshot, not a claim that HEAD already contains these sources.
- Fixed roots: **39**; fixed unique packaging inputs: **1594**; existing approved packaging map: **1594**.
- Actual recursive authored paths visited: **1536**; unresolved authored literal edges/parse errors: **0**; necessary authored runtime inputs missing from the fixed list: **9**.
- Existing fixed entries changed against the manifest: **89** = **34 source modules** (31 executable deltas + 3 type-only deltas) + **55 generated locale catalogs**. No already-fixed new key was absent from the manifest at capture.
- Every fixed row and every discovered missing row was rehashed after traversal; final recheck differences: **0**. This only establishes the recorded instant, not a frozen tree after this report.

The complete machine-readable evidence is `output/e6-20260928/p3-main-office-closure-audit-20261024.json` (SHA256 `bb347f1e6509354b79f1179a8b4142b4f4ed4163e0efd86bab0f9fa641789ff6`). It includes all **1594** current fixed rows, all **89** changed current/previous hashes, all closure edges, the nine missing rows, provenance and resolution limits. No several-hundred-line hash dump is needed in chat.

## Necessary explicit fixed-list additions

All nine have actual runtime value imports; none is included merely through a pure type edge. New roots were not invented. The existing fixed roots reach these files through the exact first edge below. Each needs explicit list membership and applicable exact-byte content review before any new approved digest can cover it.

| Missing authored runtime source | Actual SHA256 | First literal importer |
| --- | --- | --- |
| `packages/core/src/storage/sqlite/work-summary-migration.ts` | `1b48d6b16f1c6f243b8ffa385b661081f0fda46d8d94fe1b7e1fb897c22a10d5` | `packages/core/src/storage/sqlite-run-store.ts:2` |
| `packages/core/src/storage/sqlite/work-summary-store.ts` | `da2894cbdb6958b342297510bb4f0224addeda424ac3efcdf90eb01f8f6b5b88` | `packages/core/src/storage/sqlite-run-store.ts:1` |
| `packages/core/src/string-boundaries.ts` | `aee1b601ff02ae63224f14a91c24a4b6c855689736f263ab7e219d59511aa048` | `packages/core/src/memory-markdown-import.ts:8` |
| `packages/daemon/src/features/work-summary/cache.ts` | `2e52b3b890ba2e5794f0a1efc16226c95e6fa06463f3d86dc207b76b71ec59a3` | `packages/daemon/src/features/work-summary/service.ts:6` |
| `packages/daemon/src/features/work-summary/git-summary.ts` | `536971ef4ce30127491831498f8658e0e37a5b79ec342bcc6de69f3313fd6d88` | `packages/daemon/src/features/work-summary/service.ts:4` |
| `packages/daemon/src/features/work-summary/pull-requests.ts` | `b1cc41a5d55fc7e1583783c07cd77a3c0df168aec42c7a6e7fdb3d726d3daa79` | `packages/daemon/src/features/work-summary/routes.ts:8` |
| `packages/daemon/src/features/work-summary/routes.ts` | `f1a9f0dcca770af1852c7ef49a77b8f6991d1b881d9746881885476893d3bdfd` | `packages/daemon/src/server/router.ts:1` |
| `packages/daemon/src/features/work-summary/service.ts` | `d81d750e08f96ab7ece9fa190b919e2cd6bd9de640f1dee6e11b7e95c2d89c93` | `packages/daemon/src/features/work-summary/routes.ts:7` |
| `packages/daemon/src/shared/html-text.ts` | `7e1618867d99492f1fa3e4e2027215108581cad50ce88e4a6bdf39910703db4b` | `packages/daemon/src/features/channels/link-previews.ts:10` |

Expected membership after exactly these additions is **1603**. The fixed-list module itself will change when the primary agent adds them, so its new bytes also require explicit review/pinning. This report does not edit that list, refresh hashes or authorize a build. The two migration hashes remain subject to the primary agent's final freeze/recheck.

The local-file preview module `packages/daemon/src/features/previews/workspace-file-preview.ts` and the related capability/open-route modules are **already fixed and byte-identical to this manifest**. They are not new omissions. `packages/contracts/src/work-summary.ts` and `packages/core/src/delegation-host-store-binding-types.ts` are reached only through excluded type edges, not necessary new runtime inputs under this policy.

## Existing changed source modules needing review coverage

This table records current hashes, not content approval. Reuse a separate independent exact-byte report only when its source hash matches; otherwise read the current contents/delta explicitly. The dedicated DMG reviewer and migration reviewer may provide traceable narrow coverage, but their existence is not an automatic approval here.

| Existing fixed source | Actual SHA256 | Classification |
| --- | --- | --- |
| `packages/daemon/src/features/conversations/context-compaction-projection.ts` | `864e2ff72cf2af7eca0c8bc3aa54130324aef31e20b02de703166888dfe5cbe4` | Executable module delta; content review still required |
| `apps/desktop/scripts/cua-driver-signing/dmg-attachment-custody.mjs` | `e8a9103a9b86ec9cc906c91b265d5af2d790d1537eacea3ffeaa1bb51d05f75d` | Executable module delta; content review still required |
| `packages/contracts/src/index.ts` | `d055ede0a549222563c13e865dd7b76fff40d878f2928bbdc917c6ee365b1c10` | Type-only delta; hash remains pinned |
| `packages/core/src/channel-team-snapshot-harness.ts` | `83c857476a269bfd8b2a9e12cec37c7263109834d37fbb33825c684feb6deb44` | Executable module delta; content review still required |
| `packages/core/src/composer-slash-intents.ts` | `2f1bd0dcb569ec33b9b3f837ba5d6af917d1a3154cdc6f65483b0ef447306e6c` | Executable module delta; content review still required |
| `packages/core/src/external-work-actions.ts` | `2e43e9e3ea084ba3f012cebc64823f83c4581358a5cbcf76c981a9b695973d5a` | Executable module delta; content review still required |
| `packages/core/src/external-work-ci-triage.ts` | `c4427eb289404cb87a6678dc72e000baa17e8eae61c01bf591e2ced2aefbe73c` | Executable module delta; content review still required |
| `packages/core/src/external-work-scheduler.ts` | `a25e974d57db23be49af01ac3dd9970f583d9681be587acfa7662309b02bfb35` | Executable module delta; content review still required |
| `packages/core/src/external-work.ts` | `1a12627874a1a24f362b26ffac51d27b4e82e2dc9d53445695b8ead44252f40e` | Executable module delta; content review still required |
| `packages/core/src/managed-official-skill-source.ts` | `9c12253e12c3cbe46f832987be40659e356bb44abfcb0faaaf064405ac2f8bf6` | Executable module delta; content review still required |
| `packages/core/src/memory-markdown-import.ts` | `a884f0b67ace04b24844c37111e73aeafb4f3424fc25a619c126f2490c8155c6` | Executable module delta; content review still required |
| `packages/core/src/provider-adapters.ts` | `9d118bd05f21843cacf661dd8e548c638aabfde30da890a9bcaa32a2cd6a7f0a` | Executable module delta; content review still required |
| `packages/core/src/provider-generation-models.ts` | `56a4a6b524c72e44cf47f25c023e6eb6916b78833d140e4b89cf7b1feb38f123` | Executable module delta; content review still required |
| `packages/core/src/run-types.ts` | `e7ce6adeca9ac4850293b4e233581a6e8d122c833193af41a2f544638b8a0a99` | Type-only delta; hash remains pinned |
| `packages/core/src/runtime-trace-projection.ts` | `53a654cbe3ad94951f00da47c69e89430d117463679e7200dc9849edef5dca2f` | Executable module delta; content review still required |
| `packages/core/src/sandbox-types.ts` | `ee170ccce240405445754e6985775d8da7a811c5221ec509853a447bd5ba3d67` | Executable module delta; content review still required |
| `packages/core/src/sandbox/execution-policy-paths.ts` | `7b2125f47fb62dee465353962962b55fcdf53bb4d7c3f91b237bfdf7a9583e9a` | Executable module delta; content review still required |
| `packages/core/src/skill-optimization-preview.ts` | `75e0ebf8a5b5989a11fcab98793df363b57eeb4490a0989a9b5ce2d9023264ac` | Executable module delta; content review still required |
| `packages/core/src/skill-source-health.ts` | `771633af2b334a0ff0188a9f69f0884de782d2ec036250a59d2b7fbf1b410d81` | Executable module delta; content review still required |
| `packages/core/src/skill-source-sync.ts` | `3cb0a908999528279911998c306bc25cbaafa57b809017e27a18dce5fc412fdb` | Executable module delta; content review still required |
| `packages/core/src/storage/sqlite-run-store.ts` | `1e36bb717a8df454bab8352fd587cb7c606fa35f2e9459a5f2b91339e133f913` | Executable module delta; content review still required |
| `packages/core/src/terminal-report-fallback.ts` | `91e137c39a0a0d71a4d462d98efb145ecb06fb14785975ec2e6de50f9310ff65` | Executable module delta; content review still required |
| `packages/daemon/src/features/channels/link-previews.ts` | `d87e359dc8ac94dadf6263519e722ca703f800079244ee2effbd1095dfcaf73f` | Executable module delta; content review still required |
| `packages/daemon/src/features/channels/materialization/extractors/link-body.ts` | `eeecdf0ff22e53f14ded1d4965b188e0595575d0e6fba0f9cc5a2d7bffb9f4c5` | Executable module delta; content review still required |
| `packages/daemon/src/features/previews/workspace-changes.ts` | `911aa998f89e9bb0dc92614a7cc731d724b9a101e717ee1aa72838bb9addf314` | Executable module delta; content review still required |
| `packages/daemon/src/features/web/web-search-adapters.ts` | `4e4447bdc6d62f38723c60c6b2c1a387aeb9bc648063f6f08af108e4577ff6e7` | Executable module delta; content review still required |
| `packages/daemon/src/server/router.ts` | `f29ce746d9507fb727ef98124ad6778005092a79254b071de8a725dc8ea2c6ae` | Executable module delta; content review still required |
| `packages/providers/src/utils.ts` | `ac825bee3c864ee9a0d1e2e32f1effdfebe653b915f0b52689231e647aba23ea` | Executable module delta; content review still required |
| `packages/providers/src/vendors/openai-images.ts` | `bf282133c3805d154e5967fef13d52bacd4405192ec7d7f30cc34faf31f8e441` | Executable module delta; content review still required |
| `packages/providers/src/vendors/seedance-task-status.ts` | `4b9667af1be831a65dd8af06f5f2d3a9e390d0af66b18b02a4a9103e09d2e5b0` | Executable module delta; content review still required |
| `packages/providers/src/vendors/seedance.ts` | `5e2151b067ea09e5119f252075c6644f04dbf8d574ff88652aa10f5a24268bd1` | Executable module delta; content review still required |
| `packages/providers/src/vendors/seedream.ts` | `ff5aa403cd3f6ae50ec4f4e245b55f6cef17be89877f02f6116dc94b2b321562` | Executable module delta; content review still required |
| `packages/core/src/delegation-host-store-bridge.ts` | `eb4cee8804af907ffe72caa658c4ebf29fd25aa4bd311aeeea6a07e18de93570` | Type-only delta; hash remains pinned |
| `packages/core/src/storage/sqlite/delegation-budget-migration.ts` | `3f5d1f62f7dad11d7ff2c62d65f822ee84d3193481a687a3f0ed6f91678d3b58` | Executable module delta; content review still required |

The three type-only delta classifications were verified against the actual merge diff: `contracts/src/index.ts` adds only `export type *`; `run-types.ts` adds three interface methods; `delegation-host-store-bridge.ts` moves its erased brand/interface to a type-only import/export. Their file bytes still need correct fixed digests, but these changes do not add runtime dependencies or executable logic.

There are **40 executable source modules** in the immediate new/delta content-review target (31 existing changed + 9 missing), before exact-hash reuse from the dedicated independent reviews. The 3 type-only changes and later fixed-list edit still require bounded review of their claims. This count is **not** a claim that this reviewer performed those 40 full-file reviews.

## AST construction and limitations

Used installed `@babel/parser 7.29.8` with TypeScript/JSX/import-attributes parsing. Followed runtime import declarations, value re-exports, literal `import()`, literal `require()` and runtime TS import-equals edges. Excluded pure import/export type declarations/specifiers and TS import types. Relative `.js`/`.mjs`/`.cjs` resolves to a unique existing authored source, workspace `dist/` resolves to `src/`, and workspace package exports select supported import/node/default targets. Every visited code source parsed; no authored edge was left unresolved.

The old `audit-review-source-inventory.mjs` was read completely but **not executed**: it hard-codes obsolete HEAD `3ffd26818bb399c5bf7350ed38a14e6db0d26ed1` and inventories Git dirty rows, not runtime closure. Only its read-only hashing and repeated-snapshot principles were reused. The audit followed the fixed list's existing root policy instead of broadening QA entry/lifecycle pins to the entire Electron Main graph.

Third-party imports (**26 unique specifiers**) remain vendor resolution/trust limits, not reviewed vendor source. Two nonliteral edges remain explicitly outside literal-closure proof:

- `apps/desktop/scripts/cua-driver-signing/final-artifact-extractor.mjs:287` (require).
- `apps/desktop/scripts/package-macos-with-office.mjs:57` (dynamic_import).

The package config URL's target is already an explicit root. The extractor's require selects electron-builder vendor bytes; it is not an unlisted authored workspace import. Existing native/sandbox/non-import fixed inventories remain explicit inputs; this audit does not prove OS/kernel, linker or arbitrary user-selected imports.

## Generated localization provenance

The compiler/catalog utility sources were read; the compiler was **not run**. Reconstructed all 55 catalog output templates from current catalog JSON in memory; mismatches: **0**. Reconstructed both entry modules as well: `catalog-loaders.ts` and `server-catalogs.ts` each match byte-for-byte and remain unchanged against the manifest.

The 55 changed locale modules are data literals with type-only imports, not 55 new executable modules or 55 independent human content reviews. Their exact current/catalog hashes are in the evidence JSON. This proves generated-source provenance, not translation accuracy.

## Hash aggregates

All digests are SHA256 of file bytes. Row-array digests use UTF-8 `JSON.stringify(rows)` without added whitespace/newline, in the exact evidence order.

| Snapshot | SHA256 |
| --- | --- |
| Current 1594 fixed `{path,sha256}` rows | `e02feb1d354c7b448877a919123ffc0d7dbc361d7ae9afcaf33a4dee2b6d756a` |
| Existing 89 changed rows, including previous hash/classification fields | `630e1a6b1ac9845389c82802c6aa47708b349e0568277ee58f6001cb28474f3e` |
| Nine missing closure rows, including first-edge fields | `02429903c75da30621c40dad36dc969760bf89d7fcdc3b58bd558fe2e4469e41` |
| Generated provenance rows, including catalog path/hash | `e16356ca47b00c5353e538e6032a6315999caa5800d5c62ab73e1a21d9d0aecb` |
| Fixed list module at capture | `318749559e1660b9d08524c46cce2011c4d745b56d9bcaa4da92b6de504b081e` |
| Approved manifest at capture | `a2101cb33860669399da6967e61185663b69906374b52b40cb4e0c579ed8a78e` |

## Gate and next action

Keep packaging fail-closed until the primary agent explicitly adds the nine entries, completes applicable independent content review, freezes final bytes and creates the traceable QA-only review packet under standing authorization. Rehash the moving migration/binding sources after final fixes. Do not promote this inventory to `approved`, do not re-run unrelated GUI/history cases merely because this list changed, and do not claim package success from this audit.
