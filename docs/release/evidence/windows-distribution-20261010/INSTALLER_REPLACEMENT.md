# Windows installer component replacement — notices-r2

Status: replacement candidate built and technically verified; full candidate
installation/application acceptance and public distribution approval pending.

Runtime source: `f0a632b1bd5bd09b12778cbd7da3d26c354b832f`.
All 762 original runtime files remain byte-identical. This is an installer revision,
not a new application source build.

## Resolution of the three earlier questions

| Original component | Replacement in notices-r2 | Evidence |
| --- | --- | --- |
| WinShell | New MIT LingShell macros using NSIS System and Windows COM for shortcut AppUserModelID, destination cleanup and shortcut unpinning | Real NSIS fixture created an isolated shortcut with the expected AppUserModelID; register preservation, a missing shortcut and isolated destination cleanup were checked |
| SpiderBanner | Existing NSIS MUI installation progress page | Two banner call sites are removed; actual final installer contains no SpiderBanner DLL |
| nsis7z | NSIS built-in `File /r` and Deflate for the application payload | Builder configuration selects the same staged x64 payload as `APP_BUILD_DIR`; final EXE contains runtime files directly and no nsis7z DLL |

The original supplier permissions have not been expanded or invented. The three
questions remain applicable to the historical notices-r1 package. They do not apply
to the absent components in notices-r2.

An additional source check recovered the official nsis7z 19.00 archive and exact
paired DLL: SHA-256 `b393f05e8ff919ef071181050e1873c9a776e1a0ae8329aefff7007d0cadf592`.
The supplier archive includes plug-in source and the SDK's public-domain text;
its documentation also retains the older LGPL statement. The full plug-in is not
labelled public domain. This recovery is retained for provenance; notices-r2 does
not use the plug-in or depend on concluding its license variant.

## Embedded materials and verification

The final installer and uninstaller each contain only System, nsExec and StdUtils.
All three retained DLLs match their previously verified compiler/resource files.
The runtime notices, original supplier attribution and the two MIT license-restoration
records remain retained. A new `resources/distribution/installer-bootstrap` directory
contains NSIS COPYING, Electron Builder MIT, StdUtils LGPL/clarification, its paired
official corresponding-source archive, subsidiary notices, modified template files,
and the new LingShell/build source.

The final external SPDX 2.3 inventory contains 451 installer/runtime/upstream entries.
It is a conservative technical inventory, retaining `NOASSERTION` where an automatic
license conclusion is not established. Schema and component identity checks are not
a new legal approval claim.

Independent final EXE extraction verified 762 original runtime files, 605 material
files and both embedded checksum manifests. The original packaging safety hooks and
final Office/Cua artifact checks ran against the exact staged payload. The real shell
fixture touched only its isolated test shortcut/application identifier; it did not
change the installed Ling or user/model configuration.

Installer: `Ling-Stack-0.1.2-alpha.1-windows-x64-f0a632b-notices-r2-setup.exe`.
Size: 331,951,347 bytes.
SHA-256: `a39327e161d031c59e29aa246121a84d02dc8df3c51dabccedde6f3342e1e922`.
Built-in Deflate produces a larger installer than the preceding 248,975,701-byte
notices-r1 package. Both are unsigned development candidates.

Machine-readable evidence is in [final extraction verification](final-installer-verification-r2.json),
[shell fixture verification](shell-fixture-verification.json), and
[official source recovery](nsis7z-official-recovery.json).

The candidate and eight matching material/evidence attachments are delivered in the
[notices-r2 Draft Release](https://github.com/ling-stack-org/ling-stack/releases/tag/untagged-c14fdafb1b4b106e70bd). All assets are checked against their local sizes and SHA-256 digests before this documentation update is submitted.

## Reproduction and acceptance boundary

The material attachment contains the modified/new source and the preparation/build
scripts under `installer-bootstrap/sources`. They accept explicit desktop-source,
prior-material and work-directory arguments rather than personal machine paths.
The isolated tooling copy preserves the shared original toolchain; its three template
changes and original/modified hashes are recorded in `packaging-patch.json`.
The builder uses its supported `effectiveOptionComputed` callback to bind the same
x64 staging directory to the built-in compressor. Original safety hooks remain enabled.

Full new installation, upgrade, uninstall, restart, system reboot, UI, model task,
Office, Computer Use, Windows 10 and clean-machine acceptance were not performed.
Before public binary distribution, complete those applicable release gates and review
the retained license/restoration records. Documentation and sanitized evidence were
merged into `main` through [PR #524](https://github.com/ling-stack-org/ling-stack/pull/524).
The repository remains Private and all Windows Releases remain Draft.
