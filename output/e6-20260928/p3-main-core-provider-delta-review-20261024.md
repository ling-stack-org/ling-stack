# P3 Core / Provider main-delta independent content review

Date: 2026-10-24. Reviewer: `/root/p3_web_type_integration`, read-only review task.

## Scope and independence

Reviewed the complete working-tree delta relative to `17af63ac1b3218731db506e03e13f469cc8a1874` for the 24 Core / Providers rows listed below in `p3-main-office-closure-audit-20261024.json.changed`. Also read the complete two newly introduced Core runtime modules `string-boundaries.ts` and `storage/sqlite/work-summary-store.ts`. Read the necessary surrounding call sites and relevant test deltas, rather than claiming to reread all unchanged contents of the approximately 6,000-line `sqlite-run-store.ts`.

The existing frozen-baseline full-content review is reused only for unchanged baseline bytes. This report covers complete selected deltas/new files, not a new full audit of the whole dependency closure.

Explicit exclusions:

- `storage/sqlite/delegation-budget-migration.ts` and the new work-summary migration: the dedicated migration reviewer owns those contents. Only the RunStore placement of the work-summary migration invocation was reviewed here.
- `delegation-host-store-bridge.ts`, new `delegation-host-store-binding-types.ts`, and the binding import split in `sqlite-run-store.ts`: implemented by this same agent earlier, so not independently reviewed by this report. Their hash/implementation report is separate.
- No build, packaging, real database, Provider request, network fetch, permission change, approved-record update, source edit, index operation, or commit was performed by this review. One in-process pure-function reproduction used already-built Core code, as described below.

## Result: original finding repaired and independently closed

### P2 — Unicode case folding loses MCP tool claims and their risk warning (closed after repair)

Location: `packages/core/src/skill-source-sync.ts:777–787`, with the same offset issue in `findFirstMcpToolLine` at line 799.

The original reviewed linear MCP scanner searched `markdown.toLowerCase()` for an ASCII marker, but applied the resulting offset to the original Markdown. Unicode lowercasing can change UTF-16 length: U+0130 (`İ`) becomes `i` plus combining dot. Therefore an otherwise valid tool later in a multilingual skill document was sliced from the wrong original offset. Because `isMcpToolCharacter(markdown[start - 1])` was then evaluated at the wrong position, the scanner could skip the tool completely.

Read-only reproduction through the pre-repair public `buildSkillSourceSemanticProfile` function (Node actual exit code 0):

```text
"Use mcp__server__tool."       -> toolClaims: ["mcp__server__tool"]
"İ\nUse mcp__server__tool."    -> toolClaims: []
20 * "İ" + the same tool      -> toolClaims: []
```

The production code connects this same extraction to `findFirstMcpToolLine` and `classifySkillSourceWarnings`, so the `unsupported_tool` warning can disappear as well. `skill-source-health.ts` consumes that warning in `optimizationUnsafeFinding`, and skill-source-definition uses the warning when choosing the approval profile. This is a metadata/risk-classification regression, not evidence that runtime Host permission enforcement is bypassed.

Requested repair was to use offset-preserving folding/scanning and add Unicode-prefix claims/warning regressions. This is now complete in the exact follow-up bytes reviewed below.

### Final repair delta review

Read the entire follow-up source/test delta, not only the implementation summary:

- `string-boundaries.ts`: existing production `asciiLowercase` is exported with an offset-contract comment. Its implementation traverses UTF-16 code units and substitutes only ASCII `A–Z`, preserving each original code-unit index, including U+0130 and surrogate pairs. Existing wrapped-section users retain unchanged behavior; no test-only hook was introduced.
- `skill-source-sync.ts`: both searches that later use original Markdown offsets now call the shared `asciiLowercase`. The extracted candidate consists only of characters admitted by `isMcpToolCharacter`, so its retained `.toLowerCase()` cannot introduce Unicode offset expansion.
- `skill-source-sync.test.mjs`: the new regression first exercises the public semantic-profile API, then writes a real temporary skill directory and exercises the public preview/scanning path. Sixteen U+0130 characters precede the mixed-case MCP name, and the assertion requires both the normalized tool claim and `unsupported_tool` at the exact `SKILL.md:6` location. The existing long-delimiter regression remains intact. Temporary fixture cleanup is scoped to the test-created directory.

Evidence read: `p3-main-mcp-offset-red-20261024.log` fails at the missing public tool claim, not an import/fixture error; the main agent captured actual exit 1. `p3-main-mcp-offset-green-20261024.log` records all 14 tests passing with zero failure, cancellation or skip, including both Unicode and long-delimiter regressions. The main agent confirmed its actual exec tool result was exit 0 (completed without an outstanding session), and confirmed Core typecheck actual exit 0. This reviewer read those logs and reviewed the source/test delta, but did not rerun builds or claim to own the parent process receipts.

Conclusion: the original P2 is closed for the final hashes below, with no remaining confirmed issue in this selected content-review scope. This does not certify package/GUI acceptance or grant approval authority.

## Content observations for the remaining selected delta

- The new `trimBoundaryCharacters` implementation scans existing string boundaries and preserves the old slash/underscore/dash trimming semantics at the inspected URL, sandbox-path, memory-source, trace-ID and composer-label call sites. `collapseRepeatedCharacter` is used with the one-character ASCII delimiter `-`; it does not add path or permission authority.
- `extractWrappedSection` uses length-preserving ASCII folding, explicit label/colon rules, and bounded label lists. The terminal-report call keeps full objective evidence unchanged while selecting only a visible title, and retains the 120-character title bound. It is not a source of execution/evidence truth.
- External-work prompt rendering now advances a single scanner index and retains the existing item-only variable lookup/validation. The complete changed scanner and surrounding error/value handling were inspected; the new long-malformed-placeholder regression was read. URL trimming helpers do not change GitHub request authorization, HTTP methods or token forwarding.
- BFL edit-family detection uses an explicit forward scan instead of the overlapping regex. The surrounding family gate, known capabilities and new long-model regression were read. No new remote endpoint or Host permission is introduced by the delta.
- Skill preview/health frontmatter extraction now shares `parseSkillFrontMatter`; the called parser was read, including YAML parse errors, alias limit 100, object-only acceptance and string-only metadata. Tool/permission source text remains metadata rather than Host authority. The MCP regression above was independently re-reviewed and closed after repair.
- The channel snapshot change is confined to evaluation risk inference; it does not replace real tool/approval checks. The explicit destructive target search can span lines, making evaluation inference more conservative than the previous dot regex.
- Work-summary PR storage uses prepared SQL, project-owned Store context, a 30-binding limit, idempotent insert and exact-url delete. Its caller normalizes URLs with `parseSummaryPullRequest` and the route requires an initialized local workspace. RunStore only adds the facade/type methods, constructs the same-DB store, and places the migration call; no existing execution/approval/recovery methods were removed by this delta.
- Providers' `stripTrailingSlashes` preserves `undefined` and otherwise strips only trailing `/`. The complete four vendor-module diffs were read with endpoint/status-builder context. Existing protocol, credential/query/hash checks, request bodies, cancellation controllers, terminal task identity logic and transport choice are unchanged.

## Exact reviewed hashes

All original selected rows matched the initial inventory at the first review. Two source hashes below supersede that inventory after the independently reviewed Unicode repair, and the test hash is additionally frozen for that repair. The `sqlite-run-store.ts` hash includes the excluded binding import split; only its independent main delta is covered here. Newly authored modules were read in full; existing modules were read as complete deltas plus necessary context.

| File | SHA-256 | Coverage |
| --- | --- | --- |
| `packages/core/src/channel-team-snapshot-harness.ts` | `83c857476a269bfd8b2a9e12cec37c7263109834d37fbb33825c684feb6deb44` | Complete delta |
| `packages/core/src/composer-slash-intents.ts` | `2f1bd0dcb569ec33b9b3f837ba5d6af917d1a3154cdc6f65483b0ef447306e6c` | Complete delta |
| `packages/core/src/external-work-actions.ts` | `2e43e9e3ea084ba3f012cebc64823f83c4581358a5cbcf76c981a9b695973d5a` | Complete delta |
| `packages/core/src/external-work-ci-triage.ts` | `c4427eb289404cb87a6678dc72e000baa17e8eae61c01bf591e2ced2aefbe73c` | Complete delta |
| `packages/core/src/external-work-scheduler.ts` | `a25e974d57db23be49af01ac3dd9970f583d9681be587acfa7662309b02bfb35` | Complete delta |
| `packages/core/src/external-work.ts` | `1a12627874a1a24f362b26ffac51d27b4e82e2dc9d53445695b8ead44252f40e` | Complete delta |
| `packages/core/src/managed-official-skill-source.ts` | `9c12253e12c3cbe46f832987be40659e356bb44abfcb0faaaf064405ac2f8bf6` | Complete delta |
| `packages/core/src/memory-markdown-import.ts` | `a884f0b67ace04b24844c37111e73aeafb4f3424fc25a619c126f2490c8155c6` | Complete delta |
| `packages/core/src/provider-adapters.ts` | `9d118bd05f21843cacf661dd8e548c638aabfde30da890a9bcaa32a2cd6a7f0a` | Complete delta |
| `packages/core/src/provider-generation-models.ts` | `56a4a6b524c72e44cf47f25c023e6eb6916b78833d140e4b89cf7b1feb38f123` | Complete delta |
| `packages/core/src/run-types.ts` | `e7ce6adeca9ac4850293b4e233581a6e8d122c833193af41a2f544638b8a0a99` | Complete delta |
| `packages/core/src/runtime-trace-projection.ts` | `53a654cbe3ad94951f00da47c69e89430d117463679e7200dc9849edef5dca2f` | Complete delta |
| `packages/core/src/sandbox-types.ts` | `ee170ccce240405445754e6985775d8da7a811c5221ec509853a447bd5ba3d67` | Complete delta |
| `packages/core/src/sandbox/execution-policy-paths.ts` | `7b2125f47fb62dee465353962962b55fcdf53bb4d7c3f91b237bfdf7a9583e9a` | Complete delta |
| `packages/core/src/skill-optimization-preview.ts` | `75e0ebf8a5b5989a11fcab98793df363b57eeb4490a0989a9b5ce2d9023264ac` | Complete delta |
| `packages/core/src/skill-source-health.ts` | `771633af2b334a0ff0188a9f69f0884de782d2ec036250a59d2b7fbf1b410d81` | Complete delta |
| `packages/core/src/skill-source-sync.ts` | `464e2efb7e3f4da2e0dab7896e508ac69dec34f166f5103894a1ff0287f4d321` | Complete delta and repair; finding closed |
| `packages/core/src/storage/sqlite-run-store.ts` | `1e36bb717a8df454bab8352fd587cb7c606fa35f2e9459a5f2b91339e133f913` | Main delta except own binding import split |
| `packages/core/src/terminal-report-fallback.ts` | `91e137c39a0a0d71a4d462d98efb145ecb06fb14785975ec2e6de50f9310ff65` | Complete delta |
| `packages/providers/src/utils.ts` | `ac825bee3c864ee9a0d1e2e32f1effdfebe653b915f0b52689231e647aba23ea` | Complete delta |
| `packages/providers/src/vendors/openai-images.ts` | `bf282133c3805d154e5967fef13d52bacd4405192ec7d7f30cc34faf31f8e441` | Complete delta |
| `packages/providers/src/vendors/seedance-task-status.ts` | `4b9667af1be831a65dd8af06f5f2d3a9e390d0af66b18b02a4a9103e09d2e5b0` | Complete delta |
| `packages/providers/src/vendors/seedance.ts` | `5e2151b067ea09e5119f252075c6644f04dbf8d574ff88652aa10f5a24268bd1` | Complete delta |
| `packages/providers/src/vendors/seedream.ts` | `ff5aa403cd3f6ae50ec4f4e245b55f6cef17be89877f02f6116dc94b2b321562` | Complete delta |
| `packages/core/src/string-boundaries.ts` | `e4b5a0ca3310371f82b4cf53962f1bb794a3faff646045a9d8b21a8e4608cce2` | Entire new file and repair |
| `packages/core/src/storage/sqlite/work-summary-store.ts` | `da2894cbdb6958b342297510bb4f0224addeda424ac3efcdf90eb01f8f6b5b88` | Entire new file |
| `packages/core/test/skill-source-sync.test.mjs` | `c3989e17dbce3cab62c9c2bd191766515ad7dfbc726d130b1638ee7f54917618` | Complete test delta including repair regression |

## Limits and next action

Selected content review is complete; its one confirmed finding is repaired and closed at the listed final hashes. This is not a blanket approval. New bytes after these hashes require a delta recheck. Migration, binding extraction, Daemon/Desktop/UI closure and generated localization review are separate owners/tasks. This report grants neither QA package approval nor release approval, and makes no claim about packaged GUI or end-to-end execution acceptance.
