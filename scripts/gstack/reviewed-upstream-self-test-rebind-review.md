# macOS upstream self-test package exclusion review

The root reviewer independently verified all 3,714 pinned source files and the
29 marker-reference files against the existing catalog. The references classify
the Agent SDK as upstream development self-tests, paid eval fixtures, preflight,
dependency metadata, or documentation. No other retained dependency references
the Agent SDK. This does not remove the separate direct Anthropic API SDK.

Five independent import scopes contain 274, 416, 81, 982 and 4 inputs. Their
graph checksums are unchanged from the previous catalog. Every input's actual
bytes and size were verified; none requires either excluded Agent SDK package.
The client graph still contains 52 direct Anthropic API SDK inputs. Both
excluded package metadata digests and versions remain unchanged. All 57 skill
bodies are preserved.

[Hosted run 39944618701](https://github.com/ling-stack-org/ling-stack/actions/runs/39944618701)
independently reproduced all five macOS graph checksums and the exact Bun 1.4.4
compiler checksum. The only catalog changes are the previously reviewed source
manifest checksum and that exact compiler checksum. No graph, package, marker,
classification or target is broadened.

This permits SDK-only exclusion inside private macOS staging. Build-only type
packages stay retained. SDK-dependent upstream development self-tests and
preflight are not provided as runnable client tools; the normal 57 skills and
their client commands remain available. Windows needs its own observed native
package metadata and all five graph bindings before an independent review.
This review does not grant redistribution, installed-client or production
release approval.

## Accurate source-recipe consumer binding, 2026-10-26

The source-only recipe review now admits manifest
`sha256:46d0b73ac3efa12039ea2332f03782b9d940cdd47c3798bf99cd75406166f866`.
The macOS catalog's source identity is rebound to that actual object only after
new fixed-object source generation, native compilation and all five real Bun
import checks. The compiler pin, five graph hashes, 3,714 source records, 29
marker classifications, two SDK 0.2.117 package metadata records and 57 skills
are unchanged. The production SDK filter checked all those bindings and removed
781 files solely below the two excluded SDK roots in private scratch. It did
not remove the separate direct Anthropic API SDK or build-only declarations.

Evidence: `catalog-binding-review-run-v2` under the existing
`output/e6-20260928/p5-merged-input-review-20261026/` directory, frozen packet
`sha256:03647695e9bc5278e1d076e188206afc5c9d02d0e3d6c4ed05a5b799d156ceb1`.
The actual managed child 84234 closed with exit 0 after 259,651 ms; process
group absent, output settled and lease released. The independent result review
checks the retained receipts and complete JSON/graph bindings, not already
released scratch bytes. The catalog's exact checksum is
`sha256:42768b824169b16450a53518b069f105c818f357428fca777d648fa7b02f2315`.

The earlier full package attempt failed strictly on the old catalog binding.
The first review-preparation attempt then failed because its wrapper omitted
production command-link materialization; the corrected v2 uses the original
materialize/platform-filter/import/filter order. Both failed executions remain
unaltered. This source-consumer rebind neither refreshes the Windows catalog nor
grants native redistribution, executable/package, GUI or release acceptance.
