# Third-Party Notices

Ling Stack source code is licensed under the [MIT License](LICENSE). Third-party
dependencies, fonts, tools, and optional native components remain under their respective
licenses.

## Dependency Audit Baseline

Last verified: 2026-10-08

The pnpm lockfile currently resolves 1,223 dependency versions across 23 reported license
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
