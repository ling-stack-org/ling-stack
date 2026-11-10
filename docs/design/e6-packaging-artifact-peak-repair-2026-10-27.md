# E6 final-artifact peak repair — 2026-10-27

Status: source repair, focused regression and reviewed source-binding application
verified; a new frozen QA package and packaged GUI acceptance are outstanding.
Not a release.

## Observed cause

The v9 package was terminated by the unchanged 12 GiB logical-resource guard.
The root contained 13,453,073,048 bytes: cache 1,028,070,719, retained artifacts
5,416,126,058 and the current run 7,008,871,212. This was not the 20 GiB free
space floor; the filesystem still had roughly 176 GiB available.

The current run's temporary directory simultaneously exposed ZIP extraction
(2,261,620,383 bytes), a DMG mounted view (2,262,070,399 bytes), and its private
backing image (811,108,261 bytes). The earlier 4 GiB packaging estimate counted
ZIP expansion and the backing image, but omitted the concurrent mounted view.
The resource walker intentionally counts logical contents, including mounted
views; APFS cloning is not a reason to exclude those contents.

Electron Builder 26.15.3 queues ArchiveTarget ZIP work internally and immediately
returns from build(); finishBuild() awaits its real completion later. DMG can
therefore overlap ZIP artifact callbacks despite concurrency.jobs=1. That
option controls architecture jobs, not final-artifact verification concurrency.
Individual Office and CUA verifiers already await their cleanup correctly.

## Recovery already performed

The original package remains failed. Its child/group had settled, but macOS
still retained its read-only DMG attachment. The first recovery preflight
correctly rejected that consumer. Only the freshly bound private image/device
was normally detached, without force; no other attachments were changed.

The next fixed recovery restored the original selection checksum and inode,
preserved the complete executable plus browser sibling under a new same-root
handoff, archived failed output without deletion, and retired only the exact
dead invocation's remaining temporary directory and locks. Old Apps, artifact
generations and conversation history retained their inventories. Resource-root
logical usage fell to 7,946,848,586 bytes (7.40 GiB). This includes disappearance
of the mounted view, not an equal guarantee of physical APFS space reclaimed.

## Source fix and failure behavior

`artifact-build-completed.mjs` now queues the complete callback per actual
Packager identity. The lane is stored before yielding and spans both Office and
CUA verification promises, including their existing awaited cleanup. It does
not replace or skip original extraction, signature or identity checks.

A failed lane retains the original rejected promise. Already queued and later
artifacts from that Packager reject without allocating new extraction roots.
Observing the stored rejection does not turn the returned result into success.
Another Packager has its own lane. Missing/primitive Packager identity rejects
before verification; the real ZIP, DMG and blockmap events provide the shared
Packager. Metadata-only companion-blockmap behavior is otherwise unchanged.

## Evidence and remaining gate

- Valid original-code RED: eight tests, one passed/seven failed; eight concurrent
  callbacks entered Office before the first was released. Not an import failure.
- Focused GREEN: eight/eight. Deferred barriers hold Office and CUA independently;
  four verification/cleanup failure cases reject queued and later work.
- Final four-file adjacency: 193/193 passed, no failures/cancellations/skips,
  2890.807916 ms. Includes Office ASAR checks, signing contracts and extractor
  regressions. These are authored-code tests with synthetic boundary components,
  not successful real container/signature/GUI acceptance.
- Ignored successor budget helper tests: four/four. The model explicitly counts
  DMG backing plus mounted view and uses max(ZIP, DMG) only for concurrency=1.
  The prior frozen helper and failed v9 packet remain unchanged.

The hook belongs to the approved Office packaging closure. Its new bytes need
an independent delta review and the existing concrete QA approval/freeze flow;
the former approved JSON did not approve the new hash. The independent source
delta review completed with zero confirmed findings. Root then applied exactly
the reviewed hook digest under the human's existing standing isolated-QA
authorization, recording the predecessor/candidate hashes separately; the
production source reader passed all15 native/1621 packaging inputs. The pending
proposal remains unapproved, and this is not new human authentication or a
release. The successor wrapper/budget review and actual build remain pending. Do not
rerun the failed packet, raise the 12 GiB cap, move scratch outside accounting,
delete retained generations, use a fixture approval or launch the failed App.

Continue with a new packaging-only wrapper consuming the recovered whole
handoff once, pinning the serialized hook and corrected model, retaining original
package/App/ZIP/DMG/Office/signing checks and final group/readback settlement.
Only after that succeeds may remaining P3/P5 GUI cases resume. H09 hard output
cap remains its independent external prerequisite; CI stays disabled and no
global GStack upgrade or production release is included.
