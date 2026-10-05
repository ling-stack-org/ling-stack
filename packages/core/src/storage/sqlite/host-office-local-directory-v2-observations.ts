import { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, type HostOfficeLocalDirectoryExecutionRecordV2,
  type HostOfficeLocalDirectoryEffectRecordV2, type HostOfficeLocalDirectoryObservationV2 } from "../../host-office-local-directory-v2-types.js";
import { officeDirectorySlotsV2, validateOfficeDirectoryBindingV2 } from "./host-office-local-directory-v2-effects.js";
import { validateOfficeNativeResultFactsV2 } from "./host-office-local-native-v2-schema.js";
import { validateOfficeDirectoryCloseSessionV2 } from "./host-office-local-directory-v2-cleanup.js";
import { directoryV2Failure, v2Exact, v2Object, v2OptionalKeys, v2Same, v2Source, v2Text, v2Timestamp, v2Digest, v2Size } from "./host-office-local-directory-v2-validation.js";

/** Host wall-clock envelope binds the whole actual monotonic call batch to one original Core effect. */
export function validateOfficeLocalDirectoryObservationPayloadV2(execution: HostOfficeLocalDirectoryExecutionRecordV2,
  effect: HostOfficeLocalDirectoryEffectRecordV2, value: unknown, sealedAt: string): HostOfficeLocalDirectoryObservationV2 {
  if (!v2Object(value) || !v2Exact(value, ["schemaVersion", "protocol", "kind", "executionId", "executionIdentityDigest", "source", "effectId", "effectDigest",
    "native", "host", "resourceBindings", "completedAt", ...v2OptionalKeys(value, ["readbackBytes", "publicationBytes"])])
    || value.schemaVersion !== 2 || value.protocol !== HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL || value.kind !== "office_local_directory_effect_v2"
    || value.executionId !== execution.executionId || value.executionIdentityDigest !== execution.identityDigest || value.effectId !== effect.effectId
    || value.effectDigest !== effect.effectDigest || !v2Source(value.source) || !v2Same(value.source, execution.source)
    || !v2Object(value.native) || !v2Object(value.host) || !Array.isArray(value.resourceBindings) || value.resourceBindings.length > 384) return directoryV2Failure();
  const completedAt = v2Timestamp(value.completedAt), native = value.native, host = value.host;
  if (completedAt < v2Timestamp(effect.enteredAt ?? effect.preparedAt) || completedAt > v2Timestamp(sealedAt)) return directoryV2Failure();
  if (host.state === "returned") {
    if (!v2Exact(host, ["state"]) || native.state !== "returned") return directoryV2Failure();
  } else if (host.state !== "unconfirmed" || !v2Exact(host, ["state", "errorCode"]) || !v2Text(host.errorCode)) return directoryV2Failure();
  if (native.state === "not_entered") {
    if (!v2Exact(native, ["state"]) || host.state !== "unconfirmed" || value.resourceBindings.length || Object.hasOwn(value, "readbackBytes") || Object.hasOwn(value, "publicationBytes")) return directoryV2Failure();
    return value as unknown as HostOfficeLocalDirectoryObservationV2;
  }
  if (!effect.enteredAt) return directoryV2Failure();
  if (native.state === "threw") {
    if (!v2Exact(native, ["state", "calledAt", "completedAt", "errorCode"]) || !v2Text(native.errorCode) || host.state !== "unconfirmed"
      || value.resourceBindings.length || Object.hasOwn(value, "readbackBytes") || Object.hasOwn(value, "publicationBytes") || v2Timestamp(native.calledAt) < v2Timestamp(effect.enteredAt)
      || v2Timestamp(native.completedAt) < v2Timestamp(native.calledAt) || v2Timestamp(native.completedAt) > completedAt) return directoryV2Failure();
    return value as unknown as HostOfficeLocalDirectoryObservationV2;
  }
  if (native.state !== "returned" || !v2Exact(native, ["state", "calledAt", "returnedAt", "result"])
    || v2Timestamp(native.calledAt) < v2Timestamp(effect.enteredAt) || v2Timestamp(native.returnedAt) < v2Timestamp(native.calledAt)
    || v2Timestamp(native.returnedAt) > completedAt) return directoryV2Failure();
  const result = validateOfficeNativeResultFactsV2(native.result), slots = new Map(officeDirectorySlotsV2(execution).map(item => [item.resourceSlotId, item]));
  const emptyOperation = effect.kind === "capture_parents" || effect.kind === "close_session";
  if (result.operationId !== (emptyOperation ? "" : effect.effectId) || value.resourceBindings.length !== result.snapshot.resources.length) return directoryV2Failure();
  const bindings = value.resourceBindings.map(validateOfficeDirectoryBindingV2), lifetimes = new Map(bindings.map(item => [item.nativeLifetimeId, item])), used = new Set<string>();
  if (lifetimes.size !== bindings.length) return directoryV2Failure();
  for (const resource of result.snapshot.resources) {
    const binding = lifetimes.get(resource.lifetimeId), slot = binding && slots.get(binding.resourceSlotId);
    if (!binding || !slot || used.has(slot.resourceSlotId) || slot.kind !== resource.kind || slot.basename !== resource.basename
      || (slot.parentResourceSlotId ? lifetimes.get(resource.parentLifetimeId)?.resourceSlotId !== slot.parentResourceSlotId : resource.parentLifetimeId !== "")
      || (slot.initialIdentity && resource.identityObserved && !v2Same(slot.initialIdentity, resource.initialIdentity))) return directoryV2Failure();
    used.add(slot.resourceSlotId);
    if (resource.identityObserved && !binding.firstFstatCallRef) return directoryV2Failure();
    if (resource.state !== "not_acquired" && !binding.acquisitionCallRef) return directoryV2Failure();
  }
  const allowed = ({ capture_parents: ["open", "openat", "fstat"], create_directory: ["mkdirat", "openat", "fstat"],
    create_file: ["openat_create_exclusive", "fstat"], write_file: ["write"], read_file: ["fstat", "pread", "pread_eof_probe"],
    observe_publication: ["openat", "fstat", "fstatat_no_follow", "pread", "pread_eof_probe", "close"],
    fsync_resource: ["fsync"], observe_resource: ["fstat"], close_resource: ["close"], install_tree: ["renameatx_np_RENAME_EXCL"], close_session: ["fstat", "close"] } as Record<string, string[]>)[effect.kind]!;
  if (result.calls.some(call => !allowed.includes(call.syscall))) return directoryV2Failure();
  if (effect.kind === "close_session") validateOfficeDirectoryCloseSessionV2(result);
  if ("nativeLifetimeId" in effect && effect.kind !== "observe_publication" && (result.resourceFact?.lifetimeId !== effect.nativeLifetimeId
    || bindings.find(item => item.resourceSlotId === effect.resourceSlotId)?.nativeLifetimeId !== effect.nativeLifetimeId
    || result.calls.some(call => call.resourceLifetimeId !== effect.nativeLifetimeId))) return directoryV2Failure();
  if (effect.kind === "create_directory" || effect.kind === "create_file") {
    const binding = bindings.find(item => item.resourceSlotId === effect.resourceSlotId);
    if (!binding || result.resourceFact?.lifetimeId !== binding.nativeLifetimeId
      || result.resourceFact.parentLifetimeId !== effect.parentNativeLifetimeId
      || bindings.find(item => item.resourceSlotId === effect.parentResourceSlotId)?.nativeLifetimeId !== effect.parentNativeLifetimeId
      || result.calls.some(call => call.resourceLifetimeId !== binding.nativeLifetimeId)) return directoryV2Failure();
  }
  if (["fsync_resource", "observe_resource", "close_resource", "install_tree"].includes(effect.kind) && result.calls.length !== 1) return directoryV2Failure();
  if (result.success && result.calls.some(call => call.nativeReturnState !== "returned" || !call.success)) {
    // EINTR is an allowed finite retry only for the original bounded I/O APIs.
    if (!["write_file", "read_file", "observe_publication"].includes(effect.kind) || result.calls.some(call => call.nativeReturnState !== "returned"
      || (!call.success && (call.errno !== 4 || !["write", "pread", "pread_eof_probe"].includes(call.syscall))))) return directoryV2Failure();
  }
  if (effect.kind === "write_file") {
    let offset = effect.offset;
    for (const call of result.calls) {
      if (call.offset !== String(offset) || Number(call.requestedBytes) > effect.offset + effect.sizeBytes - offset) return directoryV2Failure();
      if (call.nativeReturnState === "returned" && call.success) offset += Number(call.returned);
    }
    if (result.maximumSyscallAttempts !== String(Math.ceil(effect.sizeBytes / 65536) + 32)
      || result.resourceFact?.bytesWritten !== String(offset) || (result.success && offset !== effect.offset + effect.sizeBytes)) return directoryV2Failure();
  }
  const hasBytes = Object.hasOwn(value, "readbackBytes");
  if (effect.kind === "read_file") {
    const read = result.readback;
    if (!read || read.expectedBytes !== String(effect.expectedBytes) || read.budgetBytes !== String(effect.budgetBytes)
      || read.resourceLifetimeId !== effect.nativeLifetimeId || hasBytes !== result.success) return directoryV2Failure();
  } else if (result.readback || hasBytes) return directoryV2Failure();
  if (hasBytes) {
    const bytes = value.readbackBytes;
    if (!v2Object(bytes) || !v2Exact(bytes, ["bytesSha256", "sizeBytes"]) || !v2Digest(bytes.bytesSha256) || !v2Size(bytes.sizeBytes)
      || bytes.sizeBytes !== execution.output.sizeBytes || bytes.bytesSha256 !== execution.output.bytesSha256) return directoryV2Failure();
  }
  if (effect.kind === "install_tree") {
    const install = result.snapshot.installation;
    if (!install || install.treeLifetimeId !== effect.nativeLifetimeId || install.sourceParentLifetimeId !== effect.sourceParentNativeLifetimeId
      || install.destinationParentLifetimeId !== effect.destinationParentNativeLifetimeId || install.destinationName !== effect.destinationBasename
      || result.calls[0]?.calledAtMonotonicNs !== install.calledAtMonotonicNs || result.calls[0]?.returnedAtMonotonicNs !== install.returnedAtMonotonicNs) return directoryV2Failure();
  }
  if (effect.kind === "observe_publication") {
    const publication = result.publication, install = result.snapshot.installation;
    if (!publication || !install || install.treeLifetimeId !== effect.nativeLifetimeId || publication.budgetBytes !== String(effect.budgetBytes)
      || bindings.find(item => item.resourceSlotId === effect.resourceSlotId)?.nativeLifetimeId !== effect.nativeLifetimeId
      || Object.hasOwn(value, "publicationBytes") !== result.success) return directoryV2Failure();
    if (result.success) {
      if (!Array.isArray(value.publicationBytes) || value.publicationBytes.length !== 1) return directoryV2Failure();
      const bytes = value.publicationBytes[0], original = bindings.find(item => item.resourceSlotId === execution.members.at(-1)!.resourceSlotId),
        observed = bindings.find(item => item.resourceSlotId === execution.members.at(-1)!.publicationResourceSlotId);
      if (!v2Object(bytes) || !v2Exact(bytes, ["originalLifetimeId", "observedLifetimeId", "bytesSha256", "sizeBytes"])
        || bytes.originalLifetimeId !== original?.nativeLifetimeId || bytes.observedLifetimeId !== observed?.nativeLifetimeId
        || bytes.bytesSha256 !== execution.output.bytesSha256 || bytes.sizeBytes !== execution.output.sizeBytes) return directoryV2Failure();
    }
  } else if (result.publication || Object.hasOwn(value, "publicationBytes")) return directoryV2Failure();
  return value as unknown as HostOfficeLocalDirectoryObservationV2;
}
