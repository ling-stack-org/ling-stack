# Windows release notes - notices-r2

[GitHub draft release](https://github.com/ling-stack-org/ling-stack/releases/tag/untagged-c14fdafb1b4b106e70bd)

Windows x64 unsigned development installer for Ling Stack 0.1.2-alpha.1. This release remains a draft.

Runtime source: [`f0a632b1bd5bd09b12778cbd7da3d26c354b832f`](https://github.com/ling-stack-org/ling-stack/commit/f0a632b1bd5bd09b12778cbd7da3d26c354b832f).

This packaging revision replaces WinShell, SpiderBanner, and nsis7z with NSIS built-in compression, standard MUI progress pages, and MIT-licensed LingShell shortcut macros. Extraction of the final installer and uninstaller confirms that the three former plug-ins are absent; only System, nsExec, and StdUtils remain. The earlier licensing questions for those removed components do not apply to this candidate.

The installer includes third-party notices, retained installer-component licenses, the official corresponding-source archive for StdUtils, modified installer templates, and the new LingShell source. The accompanying SPDX 2.3 inventory contains 451 runtime, upstream, and installer entries. Existing upstream license-restoration records and runtime limitations remain applicable.

Packaging and material verification passed: all 762 original runtime files are byte-identical, 605 embedded distribution-material files and both embedded checksum manifests match, and the original packaging safety hooks completed successfully. An isolated NSIS shortcut test also passed. Built-in compression produces a larger installer than notices-r1. This verification covers packaging and distribution materials; it does not claim a new full application acceptance run.

The eight attachments provide the installer, distribution-material archive, SPDX inventory, SHA-256 checksum list, and verification records. All uploaded file sizes and SHA-256 digests were verified. Documentation and sanitized evidence were merged into `main` through [PR #524](https://github.com/ling-stack-org/ling-stack/pull/524).

- Installer: `Ling-Stack-0.1.2-alpha.1-windows-x64-f0a632b-notices-r2-setup.exe`
- Size: 331,951,347 bytes
- SHA-256: `a39327e161d031c59e29aa246121a84d02dc8df3c51dabccedde6f3342e1e922`
