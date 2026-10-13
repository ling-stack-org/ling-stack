# Windows release notes — 2026-10-13 (dfb61ac)

[GitHub Draft Release](https://github.com/ling-stack-org/ling-stack/releases/tag/untagged-017c4820c5c70ce0e906)

Freshly rebuilt Windows x64 unsigned development installer for Ling Stack 0.1.2-alpha.1 from source commit [`dfb61aca41dfb1ab9e91df028debb2c5f732c433`](https://github.com/ling-stack-org/ling-stack/commit/dfb61aca41dfb1ab9e91df028debb2c5f732c433). This Release remains Draft pending review; this documentation PR is intentionally unmerged.

The runtime was rebuilt from a clean fixed-SHA checkout with frozen dependencies. It includes the production dependency upgrades and OfficeParser 8 compatibility merged in [PR #537](https://github.com/ling-stack-org/ling-stack/pull/537), with Electron 44.7.0. Runtime files, bundle input verification, license inventories and SBOM were freshly generated for this commit.

Packaging verification passed: workspace build, native Browser Host and self-contained Office helper, original packaging safety and final-artifact hooks, final installer assembly, and independent extraction. All 762 fresh runtime files and 614 retained distribution-material files matched their SHA-256 inventories, including both embedded checksum manifests. The final SPDX 2.3 inventory contains 452 entries; 577 copyright, attribution, license and patent texts are retained, and 674 regenerated JavaScript bundle outputs match the packaged bytes.

The reviewed notices-r2 recipe retains full notices, corresponding StdUtils source, modified installer templates and MIT LingShell source. WinShell, SpiderBanner and nsis7z remain excluded. Extraction confirms that both installer and uninstaller contain only the byte-verified System, nsExec and StdUtils DLLs. The unchanged LingShell source reuses its recorded isolated fixture evidence from 2026-10-10; that fixture was not rerun.

All 33 dependency security regressions passed with an external Windows-compatible test harness. The unmodified stock command failed one Mobile test because a Windows disk path was used as an ESM import specifier. The external copy normalizes separators and uses file URLs, preserving every original assertion and timeout; tracked source and installed packages were unchanged. All five OfficeParser 8 compatibility regressions also passed, including real DOCX/XLSX/PPTX extraction, cancellation and conversion failures. Original and adapted test hashes are recorded in the packaging report.

- Installer: `Ling-Stack-0.1.2-alpha.1-windows-x64-dfb61ac-notices-r2-setup.exe`
- Size: 337,255,855 bytes
- SHA-256: `d485da78ffbdc74cca58f0308938584be832b446543e0c6a73dc047adac3f18f`

Attachments provide the installer, matching source archive, full distribution-material archive, final SPDX inventory, packaging reports, source provenance, tool versions, sanitized build logs and SHA-256 checksums. All 10 uploaded asset sizes and GitHub SHA-256 digests were verified.

This run covers packaging and distribution materials on Windows 11 x64. It does not claim fresh installation, upgrade, model tasks, UI, native Office interoperability, Computer Use, reboot, uninstall, Windows 10 or clean-machine acceptance. The installer is unsigned. Existing local installation, user settings and model configuration were preserved. The repository is Public; this new binary Release remains Draft pending review.
