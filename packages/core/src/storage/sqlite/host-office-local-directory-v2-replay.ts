import type { OfficeLocalDirectoryReplayInputV2, OfficeLocalDirectoryReplayResultV2 } from "../../host-office-local-directory-v2-replay-types.js";
import type { HostOfficeLocalDirectoryEffectRecordV2 } from "../../host-office-local-directory-v2-types.js";
import { OfficeDirectoryCallCursorV2 } from "./host-office-local-directory-v2-replay-calls.js";
import { officeDirectoryReplayIntegrityV2, type CompleteOfficeDirectoryEntryV2 } from "./host-office-local-directory-v2-replay-integrity.js";
import { replayOfficeDirectoryReadV2, replayOfficeDirectoryWriteV2 } from "./host-office-local-directory-v2-replay-io.js";
import { replayOfficeDirectoryPublicationV2 } from "./host-office-local-directory-v2-replay-publication.js";
import { OfficeDirectoryReplayResourcesV2 } from "./host-office-local-directory-v2-replay-resources.js";
import { directoryV2Failure, v2Same } from "./host-office-local-directory-v2-validation.js";

/**
 * Pure fixed missing-subtree graph over getter facts. No SQLite/FS access, FD replay,
 * live issuer checks, canonical window, journal fan-in or safety/settlement issuance.
 * Failed/unknown histories remain recordable; they cannot satisfy this complete success graph.
 */
export function verifyOfficeLocalDirectoryReplayV2(input: OfficeLocalDirectoryReplayInputV2): OfficeLocalDirectoryReplayResultV2 {
  const entries = officeDirectoryReplayIntegrityV2(input), { execution } = input;
  const resources = new OfficeDirectoryReplayResourcesV2(execution);
  let index = 0;
  const take = (kind: HostOfficeLocalDirectoryEffectRecordV2["kind"], slotId?: string): OfficeDirectoryCallCursorV2 => {
    const entry = entries[index++];
    if (!entry || entry.effect.kind !== kind || slotId !== undefined && (!("resourceSlotId" in entry.effect) || entry.effect.resourceSlotId !== slotId)) return directoryV2Failure();
    if ("nativeLifetimeId" in entry.effect) resources.get(entry.effect.resourceSlotId, entry.effect.nativeLifetimeId);
    return new OfficeDirectoryCallCursorV2(entry);
  };
  const finish = (cursor: OfficeDirectoryCallCursorV2): void => { cursor.finish(); resources.checkpoint(cursor.entry); };
  const capture = take("capture_parents");
  for (const role of ["stage", "destination"] as const) {
    execution[role].ancestors.forEach((ancestor, ordinal) => resources.acquire(capture, ancestor.resourceSlotId, ordinal === 0 ? "open" : "openat"));
  }
  finish(capture);
  const directories = execution.members.slice(0, -1), file = execution.members.at(-1)!;
  for (const member of execution.members) {
    const directory = member.kind === "created_directory", cursor = take(directory ? "create_directory" : "create_file", member.resourceSlotId);
    const effect = cursor.entry.effect;
    if (effect.kind !== "create_directory" && effect.kind !== "create_file") return directoryV2Failure();
    const parent = resources.retained(member.parentResourceSlotId), binding = resources.binding(cursor.entry, member.resourceSlotId);
    if (effect.parentNativeLifetimeId !== parent.fact.lifetimeId || effect.parentResourceSlotId !== member.parentResourceSlotId
      || effect.basename !== member.basename) return directoryV2Failure();
    if (directory) cursor.take("mkdirat", binding.nativeLifetimeId, parent.fact.lifetimeId);
    resources.acquire(cursor, member.resourceSlotId, directory ? "openat" : "openat_create_exclusive");
    finish(cursor);
  }
  let written = 0;
  while (written < execution.output.sizeBytes) {
    const cursor = take("write_file", file.resourceSlotId), effect = cursor.entry.effect;
    if (effect.kind !== "write_file" || effect.offset !== written) return directoryV2Failure();
    replayOfficeDirectoryWriteV2(cursor, resources); written += effect.sizeBytes; finish(cursor);
  }
  const sync = (slotId: string): void => { const cursor = take("fsync_resource", slotId); resources.sync(cursor, slotId); finish(cursor); };
  sync(file.resourceSlotId);
  const read = take("read_file", file.resourceSlotId);
  resources.requireSynced(file.resourceSlotId);
  if (!read.entry.result.readback || !read.entry.observation.readbackBytes) return directoryV2Failure();
  replayOfficeDirectoryReadV2(read, resources, file.resourceSlotId, read.entry.result.readback); finish(read);
  const close = take("close_resource", file.resourceSlotId);
  resources.close(close, file.resourceSlotId); finish(close);
  for (const member of [...directories].reverse()) sync(member.resourceSlotId);
  const install = take("install_tree", directories[0]!.resourceSlotId), effect = install.entry.effect;
  if (effect.kind !== "install_tree") return directoryV2Failure();
  const tree = resources.retained(directories[0]!.resourceSlotId), stage = resources.retained(execution.stage.parentResourceSlotId),
    destination = resources.retained(execution.destination.parentResourceSlotId), installation = install.entry.result.snapshot.installation;
  for (const member of directories) resources.requireSynced(member.resourceSlotId);
  if (resources.requireSynced(file.resourceSlotId).fact.state !== "closed" || !installation
    || effect.sourceParentNativeLifetimeId !== stage.fact.lifetimeId || effect.destinationParentNativeLifetimeId !== destination.fact.lifetimeId
    || effect.sourceParentResourceSlotId !== stage.slot.resourceSlotId || effect.destinationParentResourceSlotId !== destination.slot.resourceSlotId
    || effect.sourceBasename !== tree.fact.basename || effect.destinationBasename !== execution.destination.firstMissingComponent || effect.flags !== "RENAME_EXCL") return directoryV2Failure();
  const call = install.take("renameatx_np_RENAME_EXCL", tree.fact.lifetimeId, stage.fact.lifetimeId);
  const expectedEntries = execution.members.map(member => {
    const resource = resources.get(member.resourceSlotId);
    return { resourceLifetimeId: resource.fact.lifetimeId, parentLifetimeId: resource.fact.parentLifetimeId,
      expectedBytes: member.kind === "created_file" ? String(execution.output.sizeBytes) : "0" };
  });
  if (!v2Same(installation, { treeLifetimeId: tree.fact.lifetimeId, sourceParentLifetimeId: stage.fact.lifetimeId,
    destinationParentLifetimeId: destination.fact.lifetimeId, destinationName: execution.destination.firstMissingComponent,
    entries: expectedEntries, entered: true, nativeReturnState: "returned", calledAtMonotonicNs: call.calledAtMonotonicNs,
    returnedAtMonotonicNs: call.returnedAtMonotonicNs, returned: 0, errno: 0 })) return directoryV2Failure();
  resources.installed(installation, call.returnedAtMonotonicNs); finish(install);
  // Both are mandatory post-install, adjacent and exactly once; native permits either order.
  const parents = new Set([stage.slot.resourceSlotId, destination.slot.resourceSlotId]);
  for (let count = 0; count < 2; count++) {
    const next = entries[index]?.effect;
    if (!next || next.kind !== "fsync_resource" || !parents.delete(next.resourceSlotId)) return directoryV2Failure();
    sync(next.resourceSlotId);
  }
  if (parents.size) return directoryV2Failure();
  const publication = take("observe_publication", tree.slot.resourceSlotId);
  if (!publication.entry.observation.publicationBytes) return directoryV2Failure();
  replayOfficeDirectoryPublicationV2(publication, resources); finish(publication);
  const closeSession = take("close_session");
  resources.closeSession(closeSession); finish(closeSession);
  if (index !== entries.length) return directoryV2Failure();
  resources.finish(input.terminal);
  const callCount = entries.reduce((count: number, entry: CompleteOfficeDirectoryEntryV2) => count + entry.result.calls.length, 0);
  return Object.freeze({ kind: "graph_verified_only", executionId: execution.executionId, executionIdentityDigest: execution.identityDigest,
    targetMemberId: file.memberId, effectCount: entries.length, resourceCount: resources.ordered.length, callCount,
    coreSafe: false, canonicalVisibility: "unverified", scopeBinding: "unbound", packaged: false });
}
