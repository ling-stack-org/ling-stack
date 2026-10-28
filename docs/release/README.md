# Release Policy

Status: active release boundary
Owner: repository maintainers
Last verified: 2026-10-13
Document type: release policy
Code and workflow anchors: `package.json`, `apps/desktop/package.json`,
`.github/workflows/ci.yml`

## Release Classes

| Class | Purpose | Current status |
| --- | --- | --- |
| Public source snapshot | Review and source-based development | Allowed after the open-source readiness checklist passes |
| Alpha GitHub tag | Named historical prerelease source baseline | `v0.1.2-alpha.1` has been published; [published Releases](https://github.com/ling-stack-org/ling-stack/releases) record publication status |
| Local Desktop development candidate | Engineering checks on a platform host | See the [Mac and Windows packaging checklist](development-packages.md); macOS currently requires an independent Office source review record |
| Public Desktop binary | End-user installation | Blocked by signing, platform, notice, and clean-machine gates |
| Numeric product version | Source and potential GitHub Release identity | Current version `0.1.3`, intended tag `v0.1.3`; publication remains subject to applicable gates |

Making the repository public is not permission to publish an unsigned Desktop artifact.

For the maintainer-triggered native build and Draft release workflow, see
[GitHub Actions desktop candidates](github-actions.md). Draft creation preserves
the development-only signing and acceptance boundaries described here.

## Versioning

Future releases use Semantic Versioning. Before `1.0.0`, incompatible product or API
changes may occur in minor releases but must still be documented.

- The current product version is `0.1.3`; the next release tag is `v0.1.3`.
  The already-published `v0.1.2-alpha.1` remains historical and immutable. Tags and Releases
  are created explicitly after maintainer review and applicable release gates.
- Release tags must point to reviewed commits on `main`.
- `VERSION`, root, and Desktop package versions must match the approved tag.
- Internal workspace packages still using `0.0.0` have a development sentinel, not the
  product release number.
- Integration components such as the Chrome Extension and Browser Host have independent
  compatibility versions; do not rewrite them merely to match the product release tag.
- Do not create or move a release tag to repair an artifact. Advance to a new product version and tag.

### Release Naming

- Use `v<product-version>` for every new release tag: this version is `v0.1.3`.
  Older prerelease tags retain their original meaning; numeric naming by itself does not close release gates.
- Use `Ling Stack <tag>` as the GitHub Release title, for example
  `Ling Stack v0.1.3`.
- Do not include a platform, `dev` prefix, date, commit hash, or packaging recipe
  revision in the tag or title. Record the full source commit, date, development-only
  status, verification scope, and known limits in the release notes and evidence.
  A concise name does not change release readiness or signing requirements.
- Publish one Release per product version. macOS and Windows assets belong to the
  same Release and must use the same reviewed source commit. Identify platform and
  architecture in asset filenames, not separate release tags. Different source
  commits require different product versions and Releases.
- Check the remote tag before publication. An existing published tag is never
  overwritten or reused for a different commit. A new candidate advances the
  product version and matching version files before building.
- Keep historical platform/date/SHA tags and immutable release assets unchanged.
  The published `desktop-dev-0.1.2-alpha.1-20261013-dfb61ac` tag is a legacy
  naming exception; it must not be renamed or mapped onto the existing
  `v0.1.2-alpha.1` source tag. Editing a display title does not rename its tag or
  invalidate the original artifact checksums and evidence.

## Source Release Checklist

1. Start from a clean, reviewed `main` commit.
2. Run the generic CI workflow without repository secrets when Actions capacity is
   available. During the current quota-related pause, record local checks and their
   scope; do not claim an online CI pass.
3. Run documentation, license, public-repository safety, typecheck, unit, and build gates.
4. Complete a current-tree and Git-history secret scan.
5. Confirm the changelog and implementation-status index are current.
6. Confirm Security, Support, Contributing, and Code of Conduct links work publicly.
   The current maintainer preparation scope defers branch-protection and private
   vulnerability-reporting verification; record their status separately from local checks.
7. Review third-party source licensing and trademark/name/logo authority.
8. After applicable gates pass, create the reviewed tag and GitHub Release with verified assets; a Draft alone is not publication.
9. Verify the published tag and source archive checksums from a clean checkout.

No automatic release-on-push workflow exists. Publishing a GitHub Release remains an
explicit maintainer action. A `v0.1.3` Release eligible for GitHub's
`/repos/ling-stack-org/ling-stack/releases/latest` requires publication in that repository
with `draft=false` and `prerelease=false` after the applicable gates; numeric naming and
an unsigned Draft do not establish release readiness.

## Current Preparation Evidence

On 2026-10-08, a clean checkout of the reviewed source baseline was installed with the
frozen lockfile. The CLI dependency build (including daemon and Web) and the Desktop
source build passed. A fresh local workspace reached the homepage and Model Workbench.
No provider key or real model task was used in that check.

Documentation links, source dependency licenses, current-tree public-repository safety,
and a redacted Git-history scan are checked separately in the
[open-source readiness checklist](../maintenance/open-source-readiness.md). These local
results do not establish Windows execution, signed installation, or public binary readiness.

Windows development packaging and manual acceptance are assigned to a Windows host;
the [colleague checklist](development-packages.md#windows-x64同事执行清单) records the
required tools, fixed source ref, commands, and evidence to return.

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
