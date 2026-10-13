# Windows x64 packaging evidence — 2026-10-13

Source: [`dfb61aca41dfb1ab9e91df028debb2c5f732c433`](https://github.com/ling-stack-org/ling-stack/commit/dfb61aca41dfb1ab9e91df028debb2c5f732c433).
Candidate: [Draft Release](https://github.com/ling-stack-org/ling-stack/releases/tag/untagged-017c4820c5c70ce0e906).

This fresh build follows the existing notices-r2 distribution recipe and English release-note format. See [release notes](RELEASE_NOTES.md) for installer identity, licensing scope, actual checks and acceptance limits.

- [Packaging verification](packaging-verification.json): final installer and uninstaller extraction, exact runtime/material hashes, plug-in exclusions, 33 dependency regressions and five OfficeParser compatibility regressions.
- [Material summary](material-summary.json): current source/runtime inventory counts, retained notice coverage and SPDX/bundle validation.
- [Source provenance](source-provenance.json): pinned source and lockfile/archive checksums.
- [Tool versions](tool-versions.json): actual Windows x64 build environment.

Large artifacts and sanitized build logs are attached to the Draft Release. The PR contains documentation and sanitized summary records only. Historical [Windows distribution evidence](../windows-distribution-20261010/README.md) and [earlier functional acceptance](../windows-dev-20261009/README.md) retain their original scope and dates.
