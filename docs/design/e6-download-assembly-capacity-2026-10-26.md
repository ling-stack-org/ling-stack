# E6 download assembly capacity repair — 2026-10-26

Status: implementation and isolated regression validated; real successor package
and GUI acceptance remain pending. This is not release approval.

## Observed failure and scope

The v2 owned-scratch run actually exited 1 after 481,155 ms. Source, native,
parser, resource, archives and inspection completed; assembly rejected before
copying because it unconditionally required another 4 GiB. Used logical bytes
were 10,161,421,930 and the unchanged cap was 12,884,901,888. Disk free was not
the failing gate. Parent records confirm direct child close, absent POSIX group,
settled output and lease release. Original v2 evidence stays immutable.

Only the combination `modelMode=download-required` and
`browserMode=download-required` uses measured two-phase assembly. Other modes
retain their original 4 GiB initial gate. Every mode still calls
`managedResourceWrite` to enforce lease/path/generation admission.

## Preparation before full copying

Authenticate the complete resource inventory, both receipts, reviewed source,
native receipt and tool inputs. Invoke the existing real production server,
worker and packaged native compiler in private owned scratch. Original
32/256 MiB checkpoints, repeated compilation and 128 MiB native output limits
remain in their helpers; the fixed native-stage 6 GiB gate is unchanged.

Browser preparation still validates all three archives. Download mode creates
only its descriptor and FFmpeg, with cache temporarily under `compiled`.
Copy Node only after exact-size admission and verify the new bytes. Browser
selection is serialized and admitted before writing. These preparation trees
are already part of current workspace usage, not free future space.

## Measured copy and incremental writes

Before the complete stage copy, measure `resourceTreeBytes(stageRoot)` including
directories and both resource receipts. Reserve it plus every complete fresh
replacement copy and the actual serialized model-acquisition, executable-build
and final manifest lengths. Do not credit deleted candidate files, APFS clone
savings, future cleanup or retiring an input/old generation.

The original exclusive `cp` is retained. Its async filter triggers single-flight
usage checks after 64 MiB or 1,024 entries, retaining headroom for subsequent
replacements and metadata. A pre-copy callback is not a copy receipt: it never
deducts an allegedly completed file from a pending ledger. On copy completion,
measure the destination tree, admit every remaining write again, verify exact
inventory and recheck source/tool pins. Log the admission and measured sizes.

**This remains cooperative admission plus watchdog, not an OS hard quota.**
Measured source directory sizes are an estimate for destination metadata, not a
mathematical bound. Creation can reveal a directory/chunk excess at the next
measurement; that fails without publication and leaves owned failed work for
outer settlement. It is not a guarantee against unrestricted same-user writes.
Do not replace this with invented per-directory constants or claim exact
pre-allocation control over filesystem metadata.

Move prepared FFmpeg using same-lease, same-device rename into a nonexistent
canonical destination. Existing destinations, aliases and `EXDEV` fail; there
is no implicit full-copy fallback. Each subsequent replacement is pinned,
size-admitted, copied exclusively and verified. Every assembler JSON/manifest is
serialized before its size gate, written exclusively and followed by a usage
check. Final inventory must match the planned manifest before publication.

All prerequisite stages and compiled outputs remain until ordinary successful
builder cleanup or final owner settlement. No old App, selection, resource
generation, data or unknown Run is removed to make this fit.

## Regression evidence and remaining gates

Evidence root: `output/e6-20260928/p5-merged-input-review-20261026/`.

- `assembly-capacity-regression-red.json`: valid original-code RED, 0/2. One
  test observes the fixed budget rejection; the other observes premature full
  copying. Earlier fixture syntax errors are not RED evidence.
- `assembly-capacity-regression-green.json`: final focused combination 33/33,
  actual exit 0, 809.304875 ms; no cancelled/skipped tests. Includes complete
  synthetic assembly under 10 GiB logical pressure, later pressure refusal
  before full copying, source drift, EXDEV without fallback, and other-mode
  admission preservation. Compiler/browser/final-verifier fixtures do not
  authenticate a real production binary or App.
- Separately, all seven materializer tests ran through `runManagedNode` in an
  invocation-owned local-bounded temporary workspace. Actual exit 0, 385 ms;
  child 90885 closed, group absent, output settled, lease released. Synthetic
  archives test descriptor/FFmpeg and changed unused archive rejection; no
  real archive download, compiler or GUI claim follows from this fixture.

The assembler changes executable adaptation, not the three source-producing
recipe inputs. Do not rebind source/catalog pins merely because this scheduling
code changed. Save the narrow checkpoint and freeze the new v3 wrapper/HEAD in
its separate evidence directory before one new real build. Actual resource
usage, original selection restoration, old generation/App preservation,
container readback, final process settlement and GUI cases remain required.

H09 hard-output-cap route certification is an independent open external gate.
Main CI remains off; Windows, global gstack upgrades and release are excluded.
