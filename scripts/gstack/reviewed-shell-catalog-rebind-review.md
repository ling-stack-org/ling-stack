# Shell catalog source binding review, 2026-10-23

The source-producer review in `reviewed-source-bundle-review.md` admitted a newly
reproduced source manifest. Three existing shell catalogs still named the prior
unreproducible manifest. This change updates only `sourceManifestChecksum` in
`pinned-shell-inventory.json`, `reviewed-shell-dependencies.json` and
`reviewed-shell-commands.json`, and the corresponding detached catalog checksum
constants in their verifiers. No path, classification, prerequisite, runtime
control, source hash, target, expression, or graph pin changed.

The resource producer generated candidate catalogs in an exclusively owned
managed scratch directory. The existing Go AST parser and Bash syntax verifier
processed the actual current source: 136 scripts and 14,990 calls, covering 128
source sites, 26 dynamic sites, and 270 indirect command expressions in 99
groups. The unchanged dependency and command verifiers checked every reviewed
mapping and all 20/50 actual resource counterparts.

The root reviewer independently reran the real parser, rehashed each candidate
catalog, checked every graph against the previous catalog, and restored the old
manifest field to prove complete JSON equality with each old catalog:

- Call graph: `sha256:5dc13f5ff671e44102cb3dab305952bfebb40a3e126113dcdd879aa6d06503df`
- Source sites: `sha256:2020036c8d5ade3b67ab6945e56f33d691afe939f797a5a4f75717a2767bfa64`
- Dynamic sites: `sha256:a64c741a942b286d307eddab1bc864a450fab1d91d96687292ad13445af653b6`
- Command sites: `sha256:ea8006d2f66b7574dc1ea27e7b9663dda16f668b10aa2a99daf1d021a7ce913d`

The source binding is now
`sha256:25e50f1790d789b85d7c99f808a41726f922029b5f8a92874383c9912fc0a384`.
The catalogs still state `releaseEligible: false`. This identity-only review
does not grant runtime authority, redistribution approval, complete dependency
closure, native Windows acceptance, or installed-client acceptance.
