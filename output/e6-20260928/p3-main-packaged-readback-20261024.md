# P3 integrated main: actual package, launch and remaining GUI gate

2026-10-24, isolated QA only. This is not complete E6 acceptance or release.

## Package and exact inputs

Original command `LING_DESKTOP_PACKAGE_HUMAN_QA=1 corepack pnpm --filter
@ling-stack/desktop package:mac`, session3129, completed with actual exit0.
Source/approved-manifest checkpoint: `7170fb80a68a36426fa7432b63c3f7a680eca809`.
The native build, original signature chain, final ZIP/DMG extraction and cleanup
were not bypassed. This package closes the previous DMG build failure, not GUI.

| Artifact | SHA256 |
| --- | --- |
| `human-qa-package-main-reviewed-20261024.log` | `26a1d2570e7bfca3f150d840b4be6829af0b01e1a538bbd707553adfab01d309` |
| ZIP | `1fc99a97eb4b239a1563a718c96d922f8ecfa37ce97fed03996c4749b343cfe9` |
| DMG | `95bf84daeb78a97bc1f4c736bbe74c4265eb1a88955591a62697130ec8bb653f` |
| `Contents/Resources/app.asar` | `9a3f5450456f868ad232d51f02de53bec5eb96d6c8f289777521bd0f29c258f8` |
| ASAR `dist/daemon/cli.mjs` | `d53556bcfb917a30e44763c1f955261affe0ca4ef678268f3c3d600d9d672bff` |
| ASAR `dist/main/entry.js` | `a6603506d01f7ebdb25e499e6be02ba9e21ad4748d7c9f4f76ec8bc5ad32498c` |
| ASAR `dist/main/daemon-lifecycle.js` | `a32d46da283a70ed2af88a4d806b3d7bf82f1ed2932d89d6b8610e3e33b15698` |

Installed `@electron/asar` independently extracted all three modules; each exactly
matches current dist. QA package marker: schemaVersion1,
purpose=synthetic-human-evaluation, release=false.
Fixed GStack manifest SHA remains
`42e8edca5d7f7ba275d462756fc8ab85e1c9638b69f9811994bafb895b034d00`,57 skills.
No P1 resource rebuild or global GStack upgrade occurred.

`codesign --verify --deep --strict --verbose=2` actual exit0; bundle identifier
`com.lingstack.desktop.human-qa`, thin arm64, ad-hoc, TeamIdentifier not set.
Not notarized or approved for publication. Nonfatal existing bundle/directive,
optional cross-platform dependency and absent optional distribution warnings
remain in the log; no CI result is claimed.

## Exact isolated launch and readback

Launched the packaged app with both exact flags:

- `--ling-desktop-owned-qa-profile=/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack/output/e6-20260928/h09-packaged-human-qa-20261010/profile`
- `--user-data-dir=/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack/output/e6-20260928/h09-packaged-human-qa-20261010/profile/user-data`

Readback: Main69127, direct child Daemon69142, its argv points into this App's
ASAR, and 127.0.0.1:17928 belongs to69142. No other client was stopped/reseeded.
Startup log UTC23Oct:21:29:10.555Z spawned/resources_preparing;
21:29:22.781Z resources_ready;21:29:23.114Z ready;
21:29:23.116Z connected ownedByDesktop=true;21:29:23.252Z main_window.loaded.
These are process/log observations, not visual acceptance.

## Real GUI blocker; no substitute pass

Built-in Computer Use `cua.getApp('com.lingstack.desktop.human-qa')` returned:
`The Mac is locked and automatic unlock could not unlock it. Ask the user to
unlock the Mac manually before continuing.` No authentication, unlock workaround,
cua-driver fallback, synthetic screenshot or task submission was attempted.
User was told this new environmental blocker. Existing approval covers QA;
no repeated approval request is needed after manual unlock.

Original public Host capture command
`node output/e6-20260928/capture-p3-private-lineage-20261023.mjs` actual exit0.
Evidence: `p3-live-20261023/private-host-lineage-2026-10-23T23-31-39-962Z.json`,
SHA`03730243bb5a82d8b26818c37278bdc3001040a0e0dda9068d2a3e0e67ca8a5d`.
Both old private Run and Turn reviews now return exact3-file diff,+36/-0,
in the new packaged Daemon, with original IDs/approval-expired history preserved.
This is only Host recovery evidence; P01 live approval and actual file navigation
remain unverified on the new UI. No new model request was made this turn.

## Direct continuation

App is already correctly isolated and listening. After manual unlock, select the
running bundle via built-in Computer Use; do not restart/rebuild or re-ask QA
approval. Follow `p3-main-packaged-gui-charter-20261024.md`: private history/diff,
new live approval, explicit offline/no-prefetch, channel localized clarification
and actual required-participant fan-in, then remaining recovery/Office matrix.
H09 hard-cap external condition remains unchanged; no pilot or CPA modification.
Goal remains active; PR/main merge, final matrix and release are not claimed.
