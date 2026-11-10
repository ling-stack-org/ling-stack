# Third-Party Notices

Ling Stack source code is licensed under the [MIT License](LICENSE). Third-party
dependencies, fonts, tools, and optional native components remain under their respective
licenses.

## Dependency Audit Baseline

Last verified: 2026-10-10

The pnpm source audit currently reports 1,221 canonical dependency versions across 23 license
families. The dependency set is predominantly MIT, Apache-2.0, BSD, ISC, BlueOak, and
other permissive licenses.

The automated source-tree policy check is:

```bash
corepack pnpm check:licenses
```

The audit currently reports one dependency, `khroma`, with missing license metadata in
its `package.json`; its distributed `license` file contains the MIT License and is checked
by the repository policy script.

License families that require explicit notice or distribution review include:

- Apache-2.0;
- CC-BY-4.0, used by browser compatibility data;
- MPL-2.0, including Lightning CSS;
- OFL-1.1, including the Inter font source used by Desktop builds;
- Python-2.0.

Expressions that offer a permissive license choice are evaluated under that permissive
option. A new unknown, proprietary, source-available, AGPL, or unreviewed copyleft-only
license must fail review instead of being silently accepted.

## Native And Bundled Components

Repository artwork, screenshots, and font provenance are tracked separately in the
[asset provenance inventory](docs/maintenance/asset-provenance.md). Passing the dependency
check does not establish the origin or publication rights of every media asset.

### Scene theme backgrounds
The locked Cua Driver source-build input carries its own
[MIT license](apps/desktop/resources/providers/cua-driver/0.8.3-ling.1/LICENSE.md) and
[third-party notices](apps/desktop/resources/providers/cua-driver/0.8.3-ling.1/THIRD_PARTY_NOTICES.md).
Its current repository resource contains source-build metadata, not a distributable
provider executable.

## Binary Distribution Boundary

This file documents the source-tree audit; it is not a complete generated notice bundle
for a Desktop binary. Before publishing any DMG, ZIP, installer, or bundled provider, the
release process must:

1. generate notices from the exact release lockfile and packaged file inventory;
2. include required license and attribution text in the product artifact;
3. include native, font, media, and copied asset licenses not represented as runtime npm
   dependencies;
4. verify that package pruning did not remove required notices;
5. archive the generated notice and SBOM with release evidence.

Public source availability does not imply that unsigned or locally built binary artifacts
are cleared for distribution.

The Windows development runtime at `f0a632b` now has a separate generated notice,
attribution and SPDX inventory. Its scope, restored upstream-license records, checks
and Draft-only publication status are recorded in the
[Windows distribution preparation evidence](docs/release/evidence/windows-distribution-20261010/README.md).
That generated artifact does not make this source-tree overview a complete binary
notice bundle, and does not clear unrelated or future Desktop builds.

The subsequent installer bootstrap audit identified three unresolved supplier
license/source questions. Its external SPDX inventory, available notices and paired
StdUtils LGPL source are recorded in the
[bootstrap review](docs/release/evidence/windows-distribution-20261010/BOOTSTRAP_REVIEW.md).
The standalone notices-r1 EXE remains an internal Draft candidate; runtime notice
coverage must not be presented as complete installer distribution approval.

The subsequent [notices-r2 replacement candidate](docs/release/evidence/windows-distribution-20261010/INSTALLER_REPLACEMENT.md)
excludes those three affected plug-ins. It embeds the retained bootstrap licenses,
paired StdUtils corresponding source, and modified/new installer source. Technical
component verification passes; complete candidate acceptance and distribution
approval are still separate. The original notices-r1 questions remain historical
evidence and are not retroactively cleared.
