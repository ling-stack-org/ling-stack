# P3-DMG-001: unrelated APFS inventory blocks final artifact verification

Status: repair under independent review; not package acceptance or release.

## Contract and scope

The final DMG verifier must inspect global attachment inventory without claiming
ownership of unrelated devices. A valid unrelated APFS image may expose both a
backing whole disk and a synthesized whole disk. Preserve its device and mount
conflict information, but never derive detach authority from that inventory.
The current target's attach receipt must still have one coherent whole-device
tree, exact image/helper/owner/entity lineage, and matching mountpoint.

Surface: Desktop build-time native CLI verification. Only the custody parser and
its existing native regression suite are changed. Do not detach foreign images,
change QA history, skip final checks, update global tools, or publish artifacts.
Commands use existing bounded hdiutil/plutil transports (10s inventory, 30s
detach, 120s attach). Synthetic tests do not mount real volumes. The subsequent
live check may attach only the newly built owned DMG's immutable snapshot and
must prove cleanup; it is not the complete package lane or GUI acceptance.

## Evidence before repair

- Package session58680 actually exited1. Compilation/signing/archive generation
  completed; final DMG extraction and cleanup raised an AggregateError.
  Original log: `p3-human-qa-package-reviewed-delta-20261023.log`.
- Read-only production custody probe used real hdiutil info and plutil only.
  It rejected `dmg_attachment_whole_device_invalid` before attach; receipt
  remained `not_attempted`, `attempted=false`, no binding. No filesystem or
  mount command was dispatched by this probe.
- Real inventory included a foreign APFS sparsebundle with disk5 and disk6.
  Neither it nor any other pre-existing volume is this repair's cleanup target.
- Native regression command on old source exited1:
  `node --test --test-name-pattern='unrelated multi-disk|multi-disk background' apps/desktop/tests/cua-driver-dmg-attachment-custody.test.mjs`.
  Original result: `p3-dmg-inventory-regression-red-20261024.log`.

## Change and regression value

Inventory normalizes multiple whole disks, requiring every partition to belong
to a listed whole disk. It retains every device/mount and all global duplicate
checks. Such an image has no selected wholeDevice. Attach output still uses
the default strict single-whole rule, and its complete entities must match
the same snapshot's fresh inventory before binding. Detach still requires exact
immutable lineage and never adopts a changed association.

Value: protects=valid background APFS coexistence without foreign detach;
fails_when=inventory imposes one whole disk on all unrelated images;
why_new=existing fixtures only covered single-disk background images;
seam=none;
no_claim=synthetic hdiutil authority, not real mount/package/GUI acceptance.

Green command: `node --test apps/desktop/tests/cua-driver-dmg-attachment-custody.test.mjs`.
Actual exit0,130/130,no skips. Log: `p3-dmg-inventory-regression-green-20261024.log`.
Coverage includes background attach/detach coexistence, occupied mountpoint,
reused device, missing partition root, replacement association, and existing
strict target multi-whole rejection. Independent review and adjacent/native
live results are recorded separately when completed, without rewriting failures.
