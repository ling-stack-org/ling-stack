# Windows distribution materials — 2026-10-10

Status: runtime materials prepared; original installer questions retained; replacement candidate verified technically; binary Releases remain Draft
Runtime source: `f0a632b1bd5bd09b12778cbd7da3d26c354b832f`
Packaging revision: `notices-r1`

Current follow-up candidate: `notices-r2` replaces WinShell, SpiderBanner and nsis7z
with NSIS built-in functionality and MIT Windows COM macros. The actual final
installer and uninstaller exclude all three plug-ins, retaining the same 762
runtime files and embedding 605 checked distribution-material files. See the
[replacement record](INSTALLER_REPLACEMENT.md). Full new installation/application
acceptance and publication approval remain pending.

The [English release notes](RELEASE_NOTES.md) record the current packaging revision,
distribution materials, verification scope, and draft download location.

The original Windows development Release was returned to Draft before any repository
visibility change. The repository remains Private. Its existing standalone installer
is retained as internal evidence, not the current public distribution candidate.

## Generated material set

| Material | Scope and result |
| --- | --- |
| `windows-package.spdx.json` | SPDX 2.3 inventory with 443 runtime/upstream components, including 320 packaged npm or verified bundle-input packages |
| `source-lock.spdx.json` | 1,221 canonical installed real package identities associated with the frozen lockfile; aliases are deduplicated; all workspace targets, not a Windows-shipped list |
| `THIRD_PARTY_NOTICES.txt` and `licenses/` | 576 retained copyright, license, attribution and patent files |
| `ATTRIBUTIONS.md` | Font Awesome CC-BY-4.0, Simple Icons CC0-1.0, Inter OFL-1.1, Lucide ISC, and FreeType FTL attribution |
| `packaged-file-inventory.json` | Actual original runtime file inventory and archive identity |
| `bundle-byte-verification.json` | 674 regenerated outputs across daemon, preload, Web, and Desktop preview match the packaged bytes |
| `DISTRIBUTION_REVIEW.md` | Scope, license restoration records, and remaining product acceptance boundaries |
| `validation.json` and `SHA256SUMS.txt` | SPDX schema, relationship, notice checksum and sanitized-material checks |

The inventory includes exact vendor notices for Electron 44.5.1/Chromium/Node.js,
.NET 8.0.30, and Rust standard library 1.97.1. Native canvas npm provenance pins its
upstream source and Skia revision. All 93 Cargo source archives were checked against
Cargo.lock SHA-256 values; twelve enabled Skia dependency notice sets were recovered
at their exact Git commits. Native source inventories conservatively include build
tools and alternate-platform dependencies, which are explicitly identified.

The original installer checksum is
`2bb170ce7bd16032cbba5cbe56ee655fcdaed46c80f9de94f1231ba7a19c50a9`.
The revised installer adds distribution materials to the original tested runtime;
the installer itself receives a new checksum. Source and binary identities must not
be inferred from the filename alone.

The final `notices-r1` installer is 248,975,701 bytes, with SHA-256
`69cf35afc819d06e63d68a78e4630233d0faee70465bcc02fdd8333ca217e6b2`.
Its actual final executable was reopened and extracted: all 762 original runtime
files match, all 586 distribution material files match, and the embedded checksum
manifest matches. It remains an unsigned development package. The external
`windows-installer-notices-r1.spdx.json` identifies the final installer; the embedded
SBOM identifies the stable runtime payload, avoiding a circular installer checksum.

Machine-readable results are in [material validation](validation.json) and
[final installer verification](final-installer-verification.json).

Repackaging used Electron Builder 26.15.3, Node 22.22.1 and pnpm 10.0.0,
with the original verified `win-unpacked` payload and materials copied under
`resources/distribution`. The original package hooks ran against that exact
staging directory before artifact creation and after completion; their checks
were retained. The [packaging recipe](packaging-recipe-notices-r1.json) records
the runtime pins, development profile and material manifest hash. It describes
this distribution revision, rather than claiming a new application source build
or a deterministic installer checksum on every future rebuild.

## Review records

Two packages declare MIT but omit their full license files. Their notice text was
restored from pinned later upstream license-file commits, retaining original versions:
`react-remove-scroll-bar@2.3.8` (`7301c16`) and `tr46@0.0.3` (`feff5a1`). This restoration
is recorded separately from exact-source recovery, and requires explicit review when
approving public binary distribution. Source URLs and file checksums accompany it.

The original runtime material set has no unresolved notice-file gap. SPDX `NOASSERTION` values are
retained where machine metadata does not establish a license variant or conclusion.
This is a technical inventory and notice collection, not a new legal approval claim.

## Installer wrapper follow-up

The runtime inventory does not cover the complete installer wrapper. A subsequent
forced NSIS extraction identified six actual installer plug-ins and four used by
the uninstaller. All six DLLs match the exact cached compiler/resource toolchain.
StdUtils, SpiderBanner and WinShell also match original supplier archive DLLs.
The expanded external installer SPDX inventory lists 453 packages including its
parent EXE and conservative upstream/source components.

The bootstrap companion retains NSIS vendor COPYING, the exact-version Electron
Builder MIT text for incorporated template code, StdUtils 1.14 full LGPL and
author clarification, its paired corresponding-source archive, subsidiary notices
and supplier records. The app-builder-lib package declares MIT but omits LICENSE;
the text is retained from its same-version electron-builder project package.
These additions are separate from the runtime material already embedded in
the standalone notices-r1 installer.

Three installer questions remain open: WinShell's Freeware label does not provide
complete redistribution/source-license terms; SpiderBanner has no complete explicit
plug-in license; nsis7z 19.00 needs exact source correspondence and clarification
of the plug-in license beyond the SDK text and older LGPL context. Public Windows
binary distribution remains **NO-GO** until these questions and applicable release
gates are resolved. Source publication with binary Releases kept Draft is separate.
See the [bootstrap review](BOOTSTRAP_REVIEW.md),
[component and source inventory](installer-bootstrap-inventory.json) and
[technical validation](bootstrap-validation.json).

## Source preparation checks

The shallow clone was expanded to the complete main history. Gitleaks 8.30.1
checked 1,111 main commits plus the only additional remote-head commit, with all
Git objects available. Its 881 scanned diff commits exactly match an independent
Git count. No findings remained under the unchanged policy and 32 exact historical
fixture fingerprints. Existing release tags are ancestors of main. Documentation,
current-tree safety and the 1,221-version / 23-family source license policy pass;
see the [source preparation receipt](source-preparation-checks.json). The PR's final
documentation commit is checked separately before submission.

## Publication boundary

The installer and seven matching runtime evidence/material attachments, followed
by six installer-bootstrap/source-review attachments, were uploaded to the
[notices-r1 Draft Release](https://github.com/ling-stack-org/ling-stack/releases/tag/untagged-036e97ea11df8fabbd13).
All fourteen uploaded sizes, upload states and GitHub SHA-256 digests match their local
files. Both Windows Releases remain Draft, and the repository remains Private;
see the [GitHub verification receipt](github-draft-verification.json).
The [original functional report](../windows-dev-20261009/README.md) remains the evidence
for the original development runtime. This material preparation does not create new
UI, Office interoperability, Computer Use, Windows 10, signed-installer, or clean-machine
acceptance. Keep those limits explicit when approving a future binary release.

Source publication remains subject to the [open-source checklist](../../../maintenance/open-source-readiness.md).
The binary distribution requirements are recorded in [Third-Party Notices](../../../../THIRD_PARTY_NOTICES.md#binary-distribution-boundary).

## Fresh Windows build — 2026-10-13

The [2026-10-13 packaging evidence](../windows-dev-20261013/README.md) records a fresh build from `dfb61ac` with updated dependencies, matching source/SBOM materials, verified Draft assets and English release notes. It retains the notices-r2 installer recipe and describes packaging-only acceptance.
