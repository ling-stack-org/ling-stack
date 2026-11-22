# Runtime Provider Model Catalog Implementation Plan

Status: implemented
Design: [Runtime Provider Model Catalog](runtime-provider-model-catalog.md)

- [x] Implement validated normalized snapshots, provider lookup and immutable provenance.
- [x] Implement bounded, credential-free refresh and last-good user-state cache.
- [x] Connect the daemon lifecycle, discovery and import to the same catalog snapshot.
- [x] Remove repository catalog-sync automation and update the superseded design.
- [x] Cover refresh, failures, cache/restart, concurrency, precedence and import behavior.
- [x] Complete owning package checks and local serving-path validation; record exact results.
- [x] Submit and merge the PR after required checks; clean task-owned test data and processes.

Local validation: Core and daemon typechecks, Web build, runtime catalog and provider API
tests (30 passing), and Markdown links passed. An isolated daemon and browser fetched the
real public catalog and imported a model from a local simulated provider. The Office native
publication review on the base revision is stale, and the packaged daemon source input
test rejects the base daemon tsconfig include list. Desktop release approval and packaged
validation remain open; this change does not grant a release approval.
