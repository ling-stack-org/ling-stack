# Runtime Provider Model Catalog Implementation Plan

Status: in progress
Design: [Runtime Provider Model Catalog](runtime-provider-model-catalog.md)

- [x] Implement validated normalized snapshots, provider lookup and immutable provenance.
- [x] Implement bounded, credential-free refresh and last-good user-state cache.
- [x] Connect the daemon lifecycle, discovery and import to the same catalog snapshot.
- [x] Remove repository catalog-sync automation and update the superseded design.
- [x] Cover refresh, failures, cache/restart, concurrency, precedence and import behavior.
- [ ] Complete owning package checks and local serving-path validation; record exact results.
- [ ] Submit and merge the PR after required checks; clean task-owned test data and processes.

Local validation: Core and daemon typechecks, Web build, runtime catalog tests and
Markdown links passed. An isolated daemon and browser fetched the real public catalog
and imported a model from a local simulated provider. Provider API and CI workflow tests
passed before the final version-binding change; the subsequent full rerun was interrupted
by disk-space and SQLite I/O errors. The Office native publication review on the base
revision is stale, and the packaged daemon source input test rejects the base daemon
tsconfig include list. Desktop release approval and packaged validation remain open.
