# Release Policy

Status: active release boundary
Owner: repository maintainers
Last verified: 2026-08-03
Document type: release policy
Code and workflow anchors: `package.json`, `apps/desktop/package.json`,
`.github/workflows/ci.yml`

## Release Classes

| Class | Purpose | Current status |
| --- | --- | --- |
| Public source snapshot | Review and source-based development | Allowed after the open-source readiness checklist passes |
| Alpha GitHub tag | Named prerelease source baseline | Not created yet |
| Internal Desktop artifact | Platform and signing evidence | Available only through governed manual workflows |
| Public Desktop binary | End-user installation | Blocked by signing, platform, notice, and clean-machine gates |
| Stable release | Supported product line | Not defined yet |

Making the repository public is not permission to publish an unsigned Desktop artifact.

## Versioning

Future releases use Semantic Versioning. Before `1.0.0`, incompatible product or API
changes may occur in minor releases but must still be documented.

- Source prereleases use tags such as `v0.1.0-alpha.1`.
- Release tags must point to reviewed commits on `main`.
- `VERSION`, root, and Desktop package versions must match the approved tag.
- The current `0.0.0` package version is a development sentinel, not a release number.
- Integration components such as the Chrome Extension and Browser Host have independent
  compatibility versions; do not rewrite them merely to match the product release tag.
- Do not create or move a release tag to repair an artifact. Publish a new prerelease.

## Source Release Checklist

1. Start from a clean, reviewed `main` commit.
2. Confirm the generic CI workflow passes without repository secrets.
3. Run documentation, license, public-repository safety, typecheck, unit, and build gates.
4. Complete a current-tree and Git-history secret scan.
5. Confirm the changelog and implementation-status index are current.
6. Confirm Security, Support, Contributing, and Code of Conduct links work publicly.
7. Review third-party source licensing and trademark/name/logo authority.
8. Create an annotated prerelease tag and GitHub prerelease with source archives only.
9. Verify the published tag and source archive checksums from a clean checkout.

No automatic release-on-push workflow exists. Publishing a GitHub Release remains an
explicit maintainer action.

## Desktop Release Gates

Desktop binaries additionally require every applicable gate in
[Desktop Release And Acceptance](desktop.md), including:

- Developer ID signing, notarization, and Gatekeeper verification on macOS;
- Authenticode, SmartScreen/WDAC, and signed installer verification on Windows;
- target-platform Computer Use and accessibility acceptance;
- clean-machine install, launch, update, and uninstall evidence;
- exact packaged-provider authority and no fallback to untrusted local binaries;
- generated third-party notices and SBOM from the exact packaged inventory;
- checksums and immutable release evidence.

Private native release automation may produce internal evidence. Its success does not
authorize a public release.

## Native Release Boundary

Native Cua Driver builds, signing, and Desktop artifact publication are not hosted in
this source repository. They require interactive platform hosts and private credentials,
so the release lane must live in a separately reviewed private repository or protected
runner boundary. The public repository intentionally retains only generic hosted CI.

## Release Notes

Release notes should explain user-visible changes, migrations, security impact, known
limitations, supported platforms, and verification evidence. Do not paste implementation
diaries, raw test logs, local paths, credentials, or unredacted diagnostics.
