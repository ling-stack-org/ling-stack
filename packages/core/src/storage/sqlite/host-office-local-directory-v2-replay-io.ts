import type { HostOfficeNativeReadbackV2 } from "../../host-office-local-native-v2-types.js";
import { OfficeDirectoryCallCursorV2 } from "./host-office-local-directory-v2-replay-calls.js";
import { OfficeDirectoryReplayResourcesV2, sameOfficeDirectoryLifetimeNodeV2 } from "./host-office-local-directory-v2-replay-resources.js";
import { directoryV2Failure, v2Same } from "./host-office-local-directory-v2-validation.js";

/** Exact native bounded-write grammar, including finite EINTR and positive short progress. */
export function replayOfficeDirectoryWriteV2(cursor: OfficeDirectoryCallCursorV2, resources: OfficeDirectoryReplayResourcesV2): void {
  const { effect } = cursor.entry;
  if (effect.kind !== "write_file") return directoryV2Failure();
  const file = resources.retained(effect.resourceSlotId, effect.nativeLifetimeId), result = cursor.entry.result;
  if (file.fact.kind !== "created_file" || file.fact.bytesWritten !== String(effect.offset)) return directoryV2Failure();
  const maximum = Math.ceil(effect.sizeBytes / 65536) + 32;
  let consumed = 0, attempts = 0;
  while (consumed < effect.sizeBytes) {
    if (++attempts > maximum) return directoryV2Failure();
    const call = cursor.take("write", file.fact.lifetimeId, file.fact.parentLifetimeId, true);
    if (call.requestedBytes !== String(Math.min(65536, effect.sizeBytes - consumed)) || call.offset !== String(effect.offset + consumed)) return directoryV2Failure();
    if (!call.success) continue;
    if (typeof call.returned !== "number" || call.returned <= 0) return directoryV2Failure();
    consumed += call.returned; resources.wrote(file, call.returned, call.returnedAtMonotonicNs);
  }
  if (result.maximumSyscallAttempts !== String(maximum) || result.syscallAttempts !== String(attempts)) return directoryV2Failure();
}

/** Consume this returned read's contiguous actual sub-batch once; snapshot copies never add I/O. */
export function replayOfficeDirectoryReadV2(cursor: OfficeDirectoryCallCursorV2, resources: OfficeDirectoryReplayResourcesV2,
  slotId: string, read: HostOfficeNativeReadbackV2): void {
  const file = resources.retained(slotId), expected = resources.execution.output.sizeBytes;
  const start = cursor.ordinal, maximum = Math.ceil(expected / 65536) + 33;
  if (!read.success || read.nativeOutcome !== "returned_success" || read.operationId !== cursor.entry.effect.effectId
    || read.resourceLifetimeId !== file.fact.lifetimeId || read.expectedBytes !== String(expected) || read.budgetBytes !== String(expected + 1)
    || read.maximumSyscallAttempts !== String(maximum) || read.blockerCode !== undefined) return directoryV2Failure();
  const before = cursor.take("fstat", file.fact.lifetimeId, file.fact.parentLifetimeId);
  resources.refresh(file, before);
  if (!before.identity || before.identity.sizeBytes !== String(expected)
    || !sameOfficeDirectoryLifetimeNodeV2(file.fact.initialIdentity!, before.identity) || !v2Same(read.identityBefore ?? null, before.identity)) return directoryV2Failure();
  let consumed = 0, attempts = 0;
  while (consumed < expected) {
    if (++attempts > maximum) return directoryV2Failure();
    const call = cursor.take("pread", file.fact.lifetimeId, file.fact.parentLifetimeId, true);
    if (call.requestedBytes !== String(Math.min(65536, expected - consumed)) || call.offset !== String(consumed)) return directoryV2Failure();
    if (!call.success) continue;
    if (typeof call.returned !== "number" || call.returned <= 0) return directoryV2Failure();
    consumed += call.returned;
  }
  for (;;) {
    if (++attempts > maximum) return directoryV2Failure();
    const call = cursor.take("pread_eof_probe", file.fact.lifetimeId, file.fact.parentLifetimeId, true);
    if (call.requestedBytes !== "1" || call.offset !== String(expected)) return directoryV2Failure();
    if (!call.success) continue;
    if (call.returned !== 0) return directoryV2Failure();
    break;
  }
  const after = cursor.take("fstat", file.fact.lifetimeId, file.fact.parentLifetimeId);
  resources.refresh(file, after);
  if (!v2Same(before.identity, after.identity) || !v2Same(read.identityAfter ?? null, after.identity)
    || read.bytesRead !== String(expected) || read.syscallAttempts !== String(attempts) || !read.eofObserved || !read.identitiesMatch
    || !v2Same(read.calls, cursor.entry.result.calls.slice(start, cursor.ordinal))) return directoryV2Failure();
  resources.readback(read);
}
