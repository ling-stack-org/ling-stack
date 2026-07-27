# P7C.D Desktop Theme Pack Persistence Packaged Evidence

## Scope

- Function ID: `DESKTOP-THEME-PACK-PERSISTENCE-001`.
- Harness: `P7CD-T09`.
- Platform: real Apple Silicon macOS, packaged `darwin-arm64` application.
- Evidence date: `2026-07-26`.
- Evidence bundle:
  `apps/desktop/release/evidence/theme-package-persistence/macos-arm64-20260726T151813Z`.
- Smoke source directory: `/tmp/ling-theme-package-persistence-0mkrpg`.
- The evidence bundle is self-contained and intentionally remains under the Git-ignored Desktop release directory.
  The 144 MB candidate archive is not duplicated under `docs`.

This closes the real macOS arm64 packaged gate only. It does not close the real Intel macOS x64 or Windows 11 x64
gates, so the canonical Function ID remains `inventory / partial` and must not be marked `verified`.

## Candidate Identity

| Field | Value |
|---|---|
| Version | `0.0.0` |
| Application ID | `com.lingstack.desktop` |
| Source HEAD | `0a0b80502715d0333342422e6dc8cedd2cd77b14` |
| Artifact ZIP SHA-256 | `e4fe5020141eb6533f7819ffaace1c61b796a4f5c36cd8bf99642385fbbb312a` |
| Executable SHA-256 | `997d6e26011b89344f98626987155158f13f492148f79bc00f24d841ae693b60` |
| `app.asar` SHA-256 | `da25639265ef2829d187b8851f7b6793d042649a05fdf2f4cc007e439dd32f6b` |
| Candidate state | unsigned; captured from a dirty working tree with 945 changes |

The candidate is suitable for implementation evidence, not for release promotion. The hashes bind every packaged
claim in this document to the exact archive, executable and renderer payload that were exercised.

## Packaged Lifecycle Result

The final harness report records `19/19` required lifecycle steps as passed:

- inspect the packaged candidate and isolated `userData`;
- generate deterministic `.ling-theme` fixtures;
- initial launch and built-in first paint;
- install, relaunch and restore the active native Theme Pack;
- reimport, relaunch and restore the updated package;
- Preview availability after restart;
- inactive delete and restart persistence;
- abandoned staging recovery;
- corrupt-final quarantine and built-in fallback;
- active-delete guard and fallback behavior;
- permission, write-failure, rename-failure and recovery branches covered by the harness contract;
- final runtime-error and evidence-completeness gate.

Across seven packaged launches, the report records zero runtime errors. Every launch uses a fresh isolated test
profile under the smoke run root; no real user profile is read or modified.

## Self-Contained Evidence Verification

Verification command:

```bash
node apps/desktop/tests/verify-theme-package-persistence-evidence.mjs \
  --evidence apps/desktop/release/evidence/theme-package-persistence/macos-arm64-20260726T151813Z
```

Verified result:

| Evidence item | Count |
|---|---:|
| Files with path-containment and SHA-256 verification | 44 |
| Original PNG screenshots | 26 |
| Captured stdout/stderr logs | 14 |
| Required lifecycle steps | 19 |
| First-frame transitions | 6 |

The verifier rejects symlinks, unsafe or non-canonical relative paths, duplicate declarations, missing files and
SHA-256 mismatches. It verifies only the declared `darwin-arm64` evidence and does not infer coverage for another
platform or architecture.

## Screenshot Review

- Thirteen `*-window.png` captures show the real Ling Stack packaged window, macOS window chrome and AppShell.
- Thirteen matching `*-content.png` captures preserve renderer pixels for first-observed and React-ready comparison.
- Install, reimport, inactive delete, abandoned staging, corrupt final and active delete are each represented by
  first-observed and React-ready evidence where applicable.
- Some `first-observed-content` captures are intentionally near-solid first-paint frames sampled before React mount;
  they are timing evidence, not missing AppShell evidence.
- A supporting Preview content capture catches the Menu exit animation during sampling. The corresponding formal
  window capture has no stale overlay, so this transient frame is not used as the visual acceptance image.
- All 26 PNG files were inspected at their original dimensions. No formal window capture is blank, belongs to another
  application or omits the required Ling Stack window boundary.

## Honest Boundaries

- No real Intel macOS x64 machine was available. Rosetta or an arm64 host cannot close that architecture gate.
- No real Windows 11 x64 machine was available. Wine, WSL and browser fixtures cannot close the Windows gate.
- The application is unsigned, version `0.0.0` and built from a dirty worktree, so this bundle is not a release
  candidate or signing/notarization proof.
- The bundle proves packaged native persistence and first-paint behavior for the declared macOS arm64 candidate. It
  does not prove production distribution, auto-update, notarization, Windows ACL/DPI/title-bar behavior or Intel
  binary execution.
- `P7CD-T11` can perform partial mechanical reconciliation from this bundle, but final cross-platform closeout waits
  for the real Intel and Windows evidence.
