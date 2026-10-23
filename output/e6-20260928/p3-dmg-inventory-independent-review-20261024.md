# P3-DMG-001 independent source delta review

Reviewed at: 2026-10-24 01:15 Asia/Shanghai (2026-10-23T17:15Z).

Verdict: **zero confirmed defects in the specified DMG inventory delta and the inspected attachment-lineage guards**. This is a bounded independent source review, not full-branch approval, an approved Office record, complete packaging acceptance, or packaged GUI acceptance.

## Candidate and exact coverage

Worktree: `/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`.
Candidate commit: `17af63ac1b3218731db506e03e13f469cc8a1874`.
Other staged/unstaged main-integration work exists and is outside this report.

| Input | SHA256 | Read coverage |
| --- | --- | --- |
| `apps/desktop/scripts/cua-driver-signing/dmg-attachment-custody.mjs` | `e8a9103a9b86ec9cc906c91b265d5af2d790d1537eacea3ffeaa1bb51d05f75d` | Full current file, lines 1–278; full commit delta against `17af63ac^` |
| `apps/desktop/tests/cua-driver-dmg-attachment-custody.test.mjs` | `eeccf51b5d1aabfed72e8dfe03158a73419c77d4f37e172bfc6e9ec3cdc14234` | Full current file, lines 1–626; full commit delta against `17af63ac^` |
| `apps/desktop/scripts/cua-driver-signing/final-artifact-extractor.mjs` | `26c78d05923bab03edb1b0f4b5a73e8af7ebde6c1fd18f6ebb698c073633129d` | Necessary context only: lines 1–260, 343–364, 525–598 and 700–785. Not a full-file review. |

Both changed inputs were rehashed after the read. `git diff --exit-code 17af63ac -- <the two changed inputs>` actually exited 0: their reviewed worktree bytes match that commit.

## Findings and invariant checks

No confirmed actionable finding was identified in this scope.

1. **Inventory observation does not confer detach authority.** Only `normalizeInventory` opts into `allowMultipleWholeDevices` (custody lines 173–202). It preserves every normalized device/mount and rejects duplicate images, devices and mounts globally. A multi-whole inventory image exposes `wholeDevice: undefined`, not an arbitrarily selected disk.
2. **Each partition still needs a listed whole-device root.** `DEVICE_PATTERN` constrains the entire string, and the root check requires either the exact whole device or its `s`-prefixed partition lineage (lines 205–234). `/dev/disk9` cannot accidentally authorize `/dev/disk90s1`. Duplicate devices/mounts, unsafe paths/types, array bounds and bounded transport parsing remain enforced.
3. **The target receipt remains stricter than inventory.** Attach output calls `normalizeEntities` without the permissive option (line 95), requiring exactly one whole device. Every receipt device must be absent from pre-attach inventory (lines 96–97). The fresh target inventory must have the same complete sorted entities and expected UID before binding (lines 98–109). A multi-whole target inventory cannot match the strict receipt. Binding does not adopt a background image's selected device.
4. **Changed ownership cannot be released as the original attachment.** `association` checks snapshot image path, selected whole device, helper PID, owner UID and all original device/mount entities (lines 48–61). It also searches all retained background entities for conflicts. A replacement image containing the original device or mount is `changed`, not `absent` or `exact`.
5. **Ordinary/force detach retain fresh exact-lineage checks.** Both use the originally frozen binding, never a newly observed device. Force follows a failed ordinary detach only after two fresh exact observations; successful command exit alone does not prove absence (lines 118–152). A later reattachment after confirmed absence cannot authorize a new detach.
6. **Caller cleanup ordering remains fail-closed.** The inspected extractor mounts an immutable snapshot, rechecks original host directory/snapshot identity before attach, awaits custody detach, and only then permits original-host-directory and backing-image cleanup (extractor lines 85–188). On unknown/changed ownership, it retains residue and an attachment receipt rather than path-detaching or deleting a possibly mounted backing image. Its command transport preserves bounded complete nonzero-exit output without promoting timeout/signal/pipe/maxBuffer output to authority (lines 739–780).
7. **Regression additions exercise the changed boundary.** The new cases cover unrelated multi-disk coexistence without foreign detach, occupied requested mount, reuse of a pre-existing device, a foreign partition without its root, and replacement containing the original device (test lines 197–245). Existing strict target `two-whole` rejection (lines 142–164), global duplicates, PID/UID/entity changes, fresh pre-force guards, and residue retry tests remain present. No existing assertion or rejection was removed by this delta.

## Independent commands and reused execution evidence

Commands actually executed by this reviewer, each separately observed with exit 0:

```text
node --check apps/desktop/scripts/cua-driver-signing/dmg-attachment-custody.mjs
node --check apps/desktop/tests/cua-driver-dmg-attachment-custody.test.mjs
git diff --exit-code 17af63ac -- apps/desktop/scripts/cua-driver-signing/dmg-attachment-custody.mjs apps/desktop/tests/cua-driver-dmg-attachment-custody.test.mjs
```

These are syntax/byte-identity checks, not behavioral suites. The already completed suites were not rerun. Their retained log endings were independently read; the parent agent owns the observed process exit receipts:

| Reused evidence | Log SHA256 | What the log proves / limit |
| --- | --- | --- |
| `p3-dmg-inventory-regression-green-20261024.log` | `e7c20f941fe8ef9e63fef086b118e64d5d3737b9c9c1112268719212fced4b01` | 130 tests, 130 pass, 0 fail/cancel/skip. Parent reports actual exit 0. Synthetic hdiutil; native plutil-only parsing is explicitly distinguished in the tests. |
| `p3-dmg-inventory-neighbor-20261024.log` | `97d3d76c1157311bafef4d8f1e27e72fe70fd9bee0a458a1a8fcdb7305bf489b` | 185 tests, 185 pass, 0 fail/cancel/skip. Parent reports actual exit 0. Test diagnostics explicitly limit the native/signing/extractor fixtures. |
| `p3-dmg-inventory-live-extractor-20261024.log` | `49c74f1e02feaa0cb9ae0ae3e79aa07209d5088b630b72aa3c69efcc60b6cc5c` | Contains `mounted`, then `cleaned`, original DMG SHA256 unchanged and mountpoint absent. This reviewer did not execute the mount, observe its outer process exit, or infer full package/GUI success from those two records. |

Live extractor record names artifact digest `f6efb701404fc5ca2a2446b0c308770858e0d66011c639e83b5ecdbc19e58ff1`; this report does not independently re-attest the artifact or extend that run to a later package.

## Coverage limits and handoff

- No production source, manifest, approved record, actual volume, model, QA database or App state was changed by this reviewer. Only this report was written.
- No mount, detach, force-detach, package build, model call or long test suite was executed by this reviewer.
- The helper explicitly disclaims atomic query-to-detach and same-UID adversarial isolation (custody lines 14–18). This change does not introduce or claim that stronger guarantee.
- The current delta deliberately tolerates valid unrelated multi-whole APFS inventory; it does **not** add multi-whole target-attachment support. Such a target remains rejected without binding. Broadening that contract would need a separate design and evidence.
- Full packaging must be rerun after the applicable main-integration and review-input changes are finalized. Real packaged GUI acceptance remains separate and unproved by this source audit.
- Core/Provider follow-up review was canceled by the parent and was not performed. This is not a full `/review` landing workflow and creates no skill-level approval receipt.
