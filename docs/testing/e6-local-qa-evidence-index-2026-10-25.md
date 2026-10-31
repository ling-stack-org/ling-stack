# E6 local QA evidence index — 2026-10-25

Status: partial verification, not complete E6 acceptance, a merge receipt or release approval.

The implementation checkpoint is `bb009269`. Its source-bound cwd regression actually exited 1:
Core 185, Contracts 95, Web 798 and real macOS native conformance 5 passed; Daemon had
7562 pass, 2 failures and 12 pre-existing skips. The original failed log remains immutable.
The two failures were traced to a lost binding-error explanation and incomplete synthetic cwd
evidence. A successor repair preserves the authority/evidence conditions: targeted 5/5,
all 683 tests in 22 affected Daemon files, real native conformance 5/5, and independent
delta review passed. The repair run actually exited 0 with all 7316 inputs unchanged.
None of these are packaged GUI acceptance or a claim that the original full suite passed.

Successor local raw verification log: `channel-followup-repair-verification-20261025.log`,
SHA256 `d18655d9ff36ab2c48dd307000e8351cd93efa0c5dafd3009c2b222bb726c64b`.
Independent incremental review: `channel-followup-repair-independent-review-20261025.md`,
SHA256 `5ccf86c0d152ed8d3dff91f01c8850421da977cf272c634c9d97a2f54be44c95`.
These local-only records are not replacements for the original 35 immutable records below.

## Immutable local-only records

The following 35 files contain machine-local paths. They are retained unchanged in
the dedicated local QA workspace, with their original hashes; only their inclusion
in subsequent public commits is removed. No product source, history or artifact bytes
are deleted or sanitized in place. Earlier Git commits also retain their historical copies.
This index is a public digest index, not a replacement for the original signed/reviewed inputs.
Historical helper scripts are local audit tools, not portable public build entry points.

| Local-only artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `output/e6-20260928/a28-approval-shutdown-independent-review-20261023.md` | 14145 | `44fbb8abc47373700c9ea126c15d583a7487cd330072f0f644b2fe20f8d5e250` |
| `output/e6-20260928/full-regression-repairs-20261023.md` | 18321 | `b1aeb4f4a86122e0f62cdb3c35b885479a3c5e21fa14ffc05cddeb3a87bf6de0` |
| `output/e6-20260928/human-qa-package-memory-reviewed-20261025.log` | 111277 | `96774bde4f39ed7ab5e1604ebefe6218fb4ff31a155043ef9cb4a7e48378876a` |
| `output/e6-20260928/office-final-incremental-content-review-20261023.md` | 20871 | `31e4725947ff79e2bdac9714d42c78a87bb32ce6202e307b524807184730822a` |
| `output/e6-20260928/p2-bootstrap-independent-review-20261023.md` | 10330 | `78d6143c644ff90184ae9a3bf49080e722c37bc1b3248ea300a30194d10202f9` |
| `output/e6-20260928/p2-cold-preflight-independent-review-20261023.md` | 4962 | `3235c989dda879509336abdaa3f0fbe7fbe584bc6efc6746538b2aeaf6a1a041` |
| `output/e6-20260928/p2-resource-bootstrap-real-probe-20261023.json` | 481 | `c2f239e6d21d02f86b0eb5bdf5d86316458288453d9e236ff3613ca0f796afff` |
| `output/e6-20260928/p3-channel-checkpoint-red-20261024.log` | 2387 | `5a29b868cb48cf5efb7683b0fe9919eed6c378d06aa7241e8ebbbc4d82a5c3d0` |
| `output/e6-20260928/p3-child-status-aggregate-red-20261024.log` | 8050 | `f55bb4cc68995188861a375f82593f6047809a5f8b1b4eed1ccb12c71c7f9f06` |
| `output/e6-20260928/p3-child-status-core-red-20261024.log` | 3863 | `9bc265ef908f6baf50526014c20c85b4cd8b080005d8dbfb89dd0c61a0e1bc6a` |
| `output/e6-20260928/p3-child-status-web-red-20261024.log` | 2056 | `03d92193fa930b355109a051717c1d850b282e2b78c0e7f05ed6bd1927bcacf9` |
| `output/e6-20260928/p3-dmg-inventory-independent-review-20261024.md` | 7742 | `bc8900738062bef2c51a685454e490aa9ba7e0fb73ad690e64ae73458179b7b1` |
| `output/e6-20260928/p3-live-20261023/private-host-lineage-2026-10-23T23-31-39-962Z.json` | 81938 | `03730243bb5a82d8b26818c37278bdc3001040a0e0dda9068d2a3e0e67ca8a5d` |
| `output/e6-20260928/p3-live-20261024/c01-checkpoint-blocked-full-ax.txt` | 19657 | `1be122505bcff44d3e1a35037cad29e17889039b20a8888374f7e356c82a35cb` |
| `output/e6-20260928/p3-main-daemon-delta-independent-review-20261024.md` | 14203 | `3bf2a8d81b8771982866b0d3b56401436b36a4cc78bf39f798de3806ebf6a12b` |
| `output/e6-20260928/p3-main-integration-migration-20261024.md` | 5149 | `07baff41ad1b79a23dd5d0d2e3f01a304dcc36108bc571d786c50a73169b1591` |
| `output/e6-20260928/p3-main-migration-independent-review-20261024.md` | 20968 | `f1aaab09ca7b1e3cc7f3b73e8525f76a065d63b20dcf7c2ac86a84d1aed7e6e4` |
| `output/e6-20260928/p3-main-office-closure-audit-20261024.md` | 17959 | `25db2f86eef19cd334a540fa851a48f6152f69eb4e1e483657ce89563e0c32d7` |
| `output/e6-20260928/p3-main-packaged-readback-20261024.md` | 4484 | `5c608e1be53441bd1af5af3a7e32e90b66f2d22685700eca2c5feaade59d0438` |
| `output/e6-20260928/p3-memory-package-readback-20261025.json` | 3436 | `f6033259eeda0ccf4bad16b4df4aeb3908c06fdee7feb7d81df188d4b0862b97` |
| `output/e6-20260928/p3-memory-source-independent-review-20261024.md` | 12590 | `9508c35a1eb433400ca870b95ec9823436af927ad0a350b5273200b24b61f0c6` |
| `output/e6-20260928/p3-office-closure-independent-review-20261023.md` | 25716 | `e87a6c820d49e7367cc7d6e4c3ee989f12c8e79bc966331be2d9a25780cd043c` |
| `output/e6-20260928/p3-pi-memory-source-negative-final-20261024.log` | 3314 | `65fd9a5374524c53ede5ff50f04026a92445b75bf8642f0aacc8800047303849` |
| `output/e6-20260928/p3-project-inputs-independent-review-20261025.md` | 14038 | `dcb292064c43bbbb9974cf8a9e68cd96f1496e78d3ee6206e88383019e659bdf` |
| `output/e6-20260928/p3-public-workflow-search-negative-20261024.log` | 3018 | `d5aaf7ff6d1e52b72b0b7b5dc02e6850343f2af8a44372d443561d9c2255ed32` |
| `output/e6-20260928/p3-standard-dist-full-20261025.log` | 1240399 | `2c82488dbc3afd26f17f1daff7589c1c7b78692c31a602cf34e84cf62a4408e4` |
| `output/e6-20260928/p3-standard-dist-revalidated-20261025.log` | 17689 | `0f563a7ac0b0f10863de301a63f4a9d69649cfb0669485d369389b6fca364814` |
| `output/e6-20260928/prepare-office-cold-bootstrap-delta-packet-20261023.mjs` | 9827 | `ba5971c52227ae75773eb5ff2f9eef76c001e94956618a07aa90fed24078cc10` |
| `output/e6-20260928/prepare-office-p3-c01-delta-packet-20261024.mjs` | 8449 | `1d91975c68d55b90d64d0997daa43c9686d47e690b7def4ce6422b3abdbe68a3` |
| `output/e6-20260928/prepare-office-p3-delta-packet-20261023.mjs` | 8920 | `89c4e8802bbd71833e31a064297b83cb4df6887f74ea1dbd35d99ed2bb6084b5` |
| `output/e6-20260928/prepare-office-p3-main-delta-packet-20261024.mjs` | 10037 | `cb95ae3311124aae5589d40403b849482f2509d6234126671d19d3a3428eebea` |
| `output/e6-20260928/prepare-office-p3-memory-delta-packet-20261025.mjs` | 12105 | `04035f8d1448a272f3990c1c1bb0af3636c778b68a47873fc3721faadc8e0ec5` |
| `output/e6-20260928/run-p3-memory-final-regression-20261025.mjs` | 2979 | `45d15c417073f7e8ccb0bc6447137b4bd39e38a2729e25125f82cba5b025a1ec` |
| `output/e6-20260928/run-p3-standard-dist-full-20261025.mjs` | 4118 | `168fb7d7bab6d3020e99e6c7ce80e5a672a285029f1349db733455e33f59160a` |
| `output/e6-20260928/run-p3-standard-dist-revalidation-20261025.mjs` | 3429 | `2c8f6b41e6706556ed1ed434a474f519cd9efbb80ce264da4f8a0372d13e6508` |

The separate untracked Node diagnostic report is also retained locally and ignored
because diagnostic reports may include process credentials. Its contents are not
published here. The public scanner retains credential checks; only three exact known
C010/B009 synthetic sentinel digests have been added, with mutation-rejection tests.

The remaining real-client C01, recovery/delegation/Office matrix and H09 hard-output-cap/
personal-authentication gates remain open. Windows, global GStack upgrade, CI re-enablement
and formal publication are outside this isolated macOS QA scope.
