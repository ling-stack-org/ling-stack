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
