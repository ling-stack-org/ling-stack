import { OfficeDirectoryCallCursorV2 } from "./host-office-local-directory-v2-replay-calls.js";
import { replayOfficeDirectoryReadV2 } from "./host-office-local-directory-v2-replay-io.js";
import { OfficeDirectoryReplayResourcesV2, sameOfficeDirectoryNodeV2 } from "./host-office-local-directory-v2-replay-resources.js";
import { directoryV2Failure, v2Same } from "./host-office-local-directory-v2-validation.js";

/** Original-parent-relative observer graph only, not an absolute ancestor namespace/window proof. */
export function replayOfficeDirectoryPublicationV2(cursor: OfficeDirectoryCallCursorV2, resources: OfficeDirectoryReplayResourcesV2): void {
  const { execution } = resources, publication = cursor.entry.result.publication;
  const parent = resources.retained(execution.destination.parentResourceSlotId);
  if (!publication || publication.entries.length !== execution.members.length || !publication.success
    || publication.nativeOutcome !== "returned_success" || !v2Same(publication.calls, cursor.entry.result.calls)) return directoryV2Failure();
  resources.refresh(parent, cursor.take("fstat", parent.fact.lifetimeId, parent.fact.parentLifetimeId));
  execution.members.forEach((member, index) => {
    const entry = publication.entries[index]!, original = resources.get(member.resourceSlotId);
    const observed = resources.acquire(cursor, member.publicationResourceSlotId, "openat", member.resourceSlotId);
    if (entry.originalLifetimeId !== original.fact.lifetimeId || entry.observedLifetimeId !== observed.fact.lifetimeId) return directoryV2Failure();
    if (member.kind === "created_file") {
      if (!entry.readback) return directoryV2Failure();
      replayOfficeDirectoryReadV2(cursor, resources, member.publicationResourceSlotId, entry.readback);
    } else if (entry.readback) return directoryV2Failure();
  });
  // Fence names AFTER all returned bytes, rooted in the same original destination parent.
  for (const member of execution.members) {
    const observed = resources.retained(member.publicationResourceSlotId);
    const call = cursor.take("fstatat_no_follow", observed.fact.lifetimeId, observed.fact.parentLifetimeId);
    if (!call.identity || call.entryName !== observed.fact.basename
      || (member.kind === "created_file" ? !v2Same(call.identity, observed.fact.identity)
        : !sameOfficeDirectoryNodeV2(call.identity, observed.fact.initialIdentity!))) return directoryV2Failure();
  }
  resources.refresh(parent, cursor.take("fstat", parent.fact.lifetimeId, parent.fact.parentLifetimeId));
  for (const member of [...execution.members].reverse()) {
    const observed = resources.retained(member.publicationResourceSlotId);
    resources.refresh(observed, cursor.take("fstat", observed.fact.lifetimeId, observed.fact.parentLifetimeId));
    resources.close(cursor, member.publicationResourceSlotId);
  }
  resources.published(publication);
}
