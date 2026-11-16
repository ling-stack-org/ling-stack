# macOS development packaging source review, 2026-11-17

This scoped source prerequisite covers the Locked Use integration in the fixed
Office packaging closure for Darwin arm64, `unsigned_dev`, ad-hoc signing and
`provider=false`.

Candidate: `9cf708628b92bb1748400e0371f712e7ec72e59e`.
Base: `27a9ccb23c59bcb890d556767f175830717b94cc`.

## Independent decision

The independent in-host Codex reviewer `/root/locked_use_adversarial` returned
`APPROVE_SCOPED_DEVELOPMENT_PACKAGING` and `VERDICT CLEAN` before the persistent
review record was changed. This is a separate review context on the same model
host, not human or cross-model approval.

The decision permits only the 20 `packagingSha256` entries below: 15 existing
digests and five added keys. All other frozen-review fields, including native
sources, runtime, compiler/SDK/header profiles, deployment target, signing and
trust, remain unchanged. The candidate's 1,846 fixed inputs have no extra key;
1,826 match the previous record. All 15 Office native inputs match it.

The reviewer read the current changed inputs and the hook/config/signer paths.
Its prior complete Locked Use/native source review remains byte-identical except
for the inspected package manifest and inventory changes from main. Tests and
fixtures were summary-only; their content was not independently reviewed.

The actual esbuild `write:false` metafile for the three signing hook/config
entrypoints contains 46 authored runtime inputs, all in the fixed inventory.
Independent negative-lane checks verified that ordinary provider-free development
packaging adds no Locked Use metadata/resources, rejects supplied Locked Use
roots before reading them, and retains default ad-hoc signing and ASAR fuses.
The new signing readers perform no installation or authorization at import.

## Exact approved inputs

| Packaging input | Change | SHA-256 |
| --- | --- | --- |
| apps/desktop/main/main.ts | updated digest | e134064529a08d323d713f34dbb636e317e44fdac32e5bcb0f2a2e51ecd5ab11 |
| apps/desktop/main/ipc.ts | updated digest | 7489c5a7266f9e55823d10a483e770cc876a240e30757135d5a28eda24c89dc8 |
| apps/desktop/preload/main-window.ts | updated digest | aa15c5df0cfc97dae62ec33b62f00fecc2e8f384e101e9d54fddba848932dd00 |
| apps/desktop/shared/ipc-channels.ts | updated digest | a3b5df9c9b0cd8826a188fa53ccf11fe5aa52da388106154a2b728c91a7884b5 |
| apps/desktop/shared/desktop-capabilities.ts | updated digest | ad8de6b6f84518524f129ce8fb1825a2e794bfc8c62a45d0dc74b46c09e1e01c |
| apps/desktop/main/desktop-runtime.ts | updated digest | 2fca91586c146cdd0e8dc02e0e0e18f57cf703b0d276e6784550abeddd3c3dc1 |
| apps/desktop/scripts/after-sign.mjs | updated digest | aad855e29a1bced51906f8e019ee00278accd10f718ee3da97f6e05a55bfe175 |
| apps/desktop/scripts/locked-use-release-build.ts | added input | 1ff723acaeccace664b48ad697c900d315d186ed4c49990bac221487e8895add |
| apps/desktop/scripts/locked-use-release-evidence.ts | added input | b4631458b4de70141b431b91fbaada9af6bb01573804e8789f915841655951d3 |
| apps/desktop/scripts/locked-use-release-files.ts | added input | ffbc6c360a2a62548699852e5aae7d0d0ecc6134cc9421b26987d1cbf22a5419 |
| apps/desktop/scripts/locked-use-validation-build.ts | added input | 61544dc2f00370546d0944bc010d6e7288acdd4c914609313a8d89760eac2b4b |
| apps/desktop/shared/locked-use-validation-contract.ts | added input | 255c453d9ca6964466f2d8755500eb9a8bd58f9066a8bef2de20bab429ec04e1 |
| apps/desktop/package.json | updated digest | ad89cdfab5d9c1f3eae7b1d20044b338bdceef006d9380dad1705b2c81567614 |
| apps/desktop/scripts/cua-driver-electron-builder.config.mjs | updated digest | b601d4a1fffd3547b59189af673f2959cee6c765605b1439cbbe02a53e1dbb0f |
| apps/desktop/scripts/cua-driver-signing/electron-builder-mac-sign.mjs | updated digest | 231fd566a5ce8403d7a098f1bd7ad055f80f2edd98950fa00cdc9a8b11fe64cc |
| apps/desktop/scripts/packaged-office-native-review-inputs.mjs | updated digest | ace11ebd80515d057b147259bbdaa415ef7d15d8a1c2220b8643201bae52b46f |
| packages/contracts/src/locked-computer-control.ts | updated digest | 144d5031dcc9bf32b6389fb230cfc9901739babda7935abeb6c2c8373e797365 |
| packages/daemon/src/features/computer-use/locked-control-registry.ts | updated digest | 0099f29a7f5820d446eb2acd167023c7bb7d4984a1848998d427f149b4929046 |
| packages/daemon/src/features/computer-use/locked-control-routes.ts | updated digest | 914644d50623c50f81d29d46ab20921695d08fd1f855a19b8da7c78f2b0e29c4 |
| packages/daemon/src/features/plugins/presets.ts | updated digest | 52ee781e58064764a2fd5f90a10491c70edab4b8ca404a772e74f5dd659852ff |

The previous review record SHA-256 is
`0b3c9bd7bbe68b01100bc62724fa69340c9840bc4fb672619c7cb5b41826fca2`.
The adopted record SHA-256 is
`efe75d3af7195c9b5f6edf62f14af7a25aa197a78f2273397f98f3e3fe7e53ce`.
The full 1,846-input aggregate is
`8ab7acf666b259bdc96b368cdff2a46ce271d12d0b1dbb3902982b82868276c5`;
the 20-input delta aggregate is
`00e7399724c481279cd6ae1def50d0ac029031bb1b4a27e35548220154d27a0e`.
Aggregates encode compact JSON `[path, sha256]` pairs in
`PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS` order plus one LF.

## Validation and limits

The current candidate passed 153 focused Desktop/provider/Daemon tests,
Desktop main emission, all five Desktop typechecks and both Daemon typechecks.
The 55 localization catalogs were generated from current authored sources.
After adoption, the focused signing/hook/publication/QA-lane selection passed
276/276 tests with no skips, including the real frozen input-digest check.
Its compiler/signature fixtures are synthetic and do not attest an actual App.

This source decision does not accept a final App, ZIP or DMG, change the existing
reviewed runtime/toolchain constraints, or certify signing, notarization, public
binary distribution, GUI behavior, native installation or a real provider.
Missing release prerequisites remain enforcing checks.

The read-only native preflight reports not-installed and ready=false, with
missing installed components, Client approval, authentication policy and Guardian
permissions. Administrator installation and permission grants have not occurred.
Attended capture/input/Keychain, relock/manual unlock, physical display coverage,
takeover and fault-matrix acceptance remain incomplete. Apple Development native
fixture evidence cannot qualify the production Desktop/provider lane. Locked Use
therefore remains `disabled_by_build`, and Pre-Landing Review is INCOMPLETE.
