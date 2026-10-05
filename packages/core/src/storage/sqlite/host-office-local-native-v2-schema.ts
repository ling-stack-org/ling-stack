import type { HostOfficeNativeCallV2, HostOfficeNativeIdentityV2, HostOfficeNativeReadbackV2,
  HostOfficeNativeResourceFactV2, HostOfficeNativeResultFactsV2, HostOfficeNativeSnapshotV2 } from "../../host-office-local-native-v2-types.js";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES } from "../../host-office-local-directory-v2-types.js";
import { directoryV2Failure, v2Component, v2Decimal, v2Exact, v2Object, v2OptionalKeys,
  v2Same, v2SignedDecimal, v2Size, v2Text } from "./host-office-local-directory-v2-validation.js";
import { validateOfficeNativeInstallationV2, validateOfficeNativePublicationV2 } from "./host-office-local-native-v2-publication-schema.js";

const syscalls = new Set(["open", "openat", "openat_create_exclusive", "mkdirat", "fstat", "fstatat_no_follow", "write", "pread", "pread_eof_probe", "fsync", "close", "renameatx_np_RENAME_EXCL"]);
const resourceKinds = new Set(["ancestor", "stage_parent", "destination_parent", "created_directory", "created_file", "publication_directory", "publication_file"]);
const descriptorCalls = new Set(["open", "openat", "openat_create_exclusive"]);
const ioCalls = new Set(["write", "pread", "pread_eof_probe"]);

/** Native identity strings are range-checked without lossy Number conversion. */
export function validateOfficeNativeIdentityV2(value: unknown): HostOfficeNativeIdentityV2 {
  if (!v2Object(value) || !v2Exact(value, ["device", "inode", "sizeBytes", "modifiedNs", "changedNs", "mode", "isFile", "isDirectory"])
    || !v2Decimal(value.device) || !v2Decimal(value.inode) || !v2Decimal(value.sizeBytes, (1n << 63n) - 1n)
    || !v2SignedDecimal(value.modifiedNs) || !v2SignedDecimal(value.changedNs) || !v2Size(value.mode) || value.mode > 0xffffffff
    || typeof value.isFile !== "boolean" || typeof value.isDirectory !== "boolean"
    || value.isFile !== ((Number(value.mode) & 0o170000) === 0o100000)
    || value.isDirectory !== ((Number(value.mode) & 0o170000) === 0o040000)) return directoryV2Failure();
  return value as unknown as HostOfficeNativeIdentityV2;
}

export function validateOfficeNativeCallV2(value: unknown): HostOfficeNativeCallV2 {
  if (!v2Object(value) || !v2Text(value.syscall) || !syscalls.has(value.syscall) || !v2Text(value.resourceLifetimeId)
    || typeof value.parentLifetimeId !== "string" || (value.parentLifetimeId !== "" && !v2Text(value.parentLifetimeId))
    || !v2Decimal(value.calledAtMonotonicNs) || !v2Decimal(value.returnedAtMonotonicNs)) return directoryV2Failure();
  const returned = value.nativeReturnState === "returned", io = ioCalls.has(value.syscall);
  if (!v2Exact(value, ["syscall", "resourceLifetimeId", "parentLifetimeId", "nativeReturnState", "calledAtMonotonicNs", "returnedAtMonotonicNs",
    ...(returned ? ["returned", "success", "errno"] : []), ...(io ? ["requestedBytes", "offset"] : []), ...v2OptionalKeys(value, ["identity", "entryName"])])
    || (!returned && value.nativeReturnState !== "not_returned")
    || (returned ? BigInt(value.returnedAtMonotonicNs) < BigInt(value.calledAtMonotonicNs) : value.returnedAtMonotonicNs !== "0")) return directoryV2Failure();
  if (io && (!v2Decimal(value.requestedBytes, 65536n) || BigInt(value.requestedBytes) < 1n || !v2Decimal(value.offset, BigInt(HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES)))) return directoryV2Failure();
  if (returned) {
    const acquired = value.returned === "descriptor_acquired_redacted";
    if (typeof value.success !== "boolean" || !v2Size(value.errno) || value.errno > 0x7fffffff
      || (acquired ? !descriptorCalls.has(value.syscall) || !value.success : !Number.isSafeInteger(value.returned) || Number(value.returned) < -1)
      || value.success !== (acquired || Number(value.returned) >= 0) || (value.success ? value.errno !== 0 : value.errno === 0)
      || (descriptorCalls.has(value.syscall) && value.success && !acquired)
      || (io && value.success && Number(value.returned) > Number(value.requestedBytes))
      || (!io && !descriptorCalls.has(value.syscall) && value.success && value.returned !== 0)) return directoryV2Failure();
  }
  if (Object.hasOwn(value, "identity")) {
    if (!["fstat", "fstatat_no_follow"].includes(value.syscall) || !returned || value.returned !== 0) return directoryV2Failure();
    validateOfficeNativeIdentityV2(value.identity);
  }
  if (["fstat", "fstatat_no_follow"].includes(value.syscall) && returned && value.returned === 0 && !Object.hasOwn(value, "identity")) return directoryV2Failure();
  if (Object.hasOwn(value, "entryName") && (!v2Component(value.entryName) || !["openat", "fstatat_no_follow"].includes(value.syscall))) return directoryV2Failure();
  if (value.syscall === "fstatat_no_follow" && !Object.hasOwn(value, "entryName")) return directoryV2Failure();
  return value as unknown as HostOfficeNativeCallV2;
}

export function validateOfficeNativeCallsV2(value: unknown): readonly HostOfficeNativeCallV2[] {
  if (!Array.isArray(value) || value.length > 8192) return directoryV2Failure();
  let previous = 0n, incomplete = false;
  for (const raw of value) {
    const call = validateOfficeNativeCallV2(raw);
    if (incomplete || BigInt(call.calledAtMonotonicNs) < previous) return directoryV2Failure();
    previous = BigInt(call.returnedAtMonotonicNs); incomplete = call.nativeReturnState === "not_returned";
  }
  return value as readonly HostOfficeNativeCallV2[];
}

export function validateOfficeNativeResourceV2(value: unknown): HostOfficeNativeResourceFactV2 {
  if (!v2Object(value) || typeof value.identityObserved !== "boolean"
    || !v2Exact(value, ["lifetimeId", "kind", "basename", "parentLifetimeId", "state", "identityObserved", "device", "inode", "bytesWritten", "fsyncReturned",
      ...(value.identityObserved ? ["initialIdentity", "identity", "initialObservedAtMonotonicNs", "observedAtMonotonicNs"] : [])])
    || !v2Text(value.lifetimeId) || !v2Text(value.kind) || !resourceKinds.has(value.kind)
    || !(value.basename === "/" ? value.kind === "ancestor" && value.parentLifetimeId === "" : v2Component(value.basename))
    || typeof value.parentLifetimeId !== "string" || (value.parentLifetimeId !== "" && !v2Text(value.parentLifetimeId))
    || !["not_acquired", "retained", "closed", "unknown"].includes(String(value.state))
    || !v2Decimal(value.device) || !v2Decimal(value.inode) || !v2Decimal(value.bytesWritten, BigInt(HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES))
    || typeof value.fsyncReturned !== "boolean") return directoryV2Failure();
  if (value.identityObserved) {
    const initial = validateOfficeNativeIdentityV2(value.initialIdentity), identity = validateOfficeNativeIdentityV2(value.identity);
    if (!v2Decimal(value.initialObservedAtMonotonicNs) || !v2Decimal(value.observedAtMonotonicNs)
      || BigInt(value.observedAtMonotonicNs) < BigInt(value.initialObservedAtMonotonicNs)
      || value.device !== identity.device || value.inode !== identity.inode) return directoryV2Failure();
  }
  if (["publication_file", "publication_directory"].includes(value.kind) && (value.bytesWritten !== "0" || value.fsyncReturned !== false)) return directoryV2Failure();
  return value as unknown as HostOfficeNativeResourceFactV2;
}

export function validateOfficeNativeReadbackV2(value: unknown): HostOfficeNativeReadbackV2 {
  if (!v2Object(value) || !v2Exact(value, ["operationId", "resourceLifetimeId", "expectedBytes", "budgetBytes", "bytesRead", "maximumSyscallAttempts",
    "syscallAttempts", "eofObserved", "identitiesMatch", "success", "nativeOutcome", "calls", ...v2OptionalKeys(value, ["blockerCode", "identityBefore", "identityAfter"])])
    || !v2Text(value.operationId) || !v2Text(value.resourceLifetimeId) || !v2Decimal(value.expectedBytes, BigInt(HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES))
    || !v2Decimal(value.budgetBytes, BigInt(HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES + 1)) || BigInt(value.budgetBytes) !== BigInt(value.expectedBytes) + 1n
    || !v2Decimal(value.bytesRead, BigInt(value.expectedBytes)) || !v2Decimal(value.maximumSyscallAttempts, 833n) || !v2Decimal(value.syscallAttempts, 833n)
    || BigInt(value.maximumSyscallAttempts) !== (BigInt(value.expectedBytes) + 65535n) / 65536n + 33n
    || BigInt(value.syscallAttempts) > BigInt(value.maximumSyscallAttempts)
    || [value.eofObserved, value.identitiesMatch, value.success].some(item => typeof item !== "boolean")
    || !["not_entered", "entered", "returned_failed", "returned_success", "unknown_exception"].includes(String(value.nativeOutcome))
    || (Object.hasOwn(value, "blockerCode") && !v2Text(value.blockerCode))) return directoryV2Failure();
  const trace = validateOfficeNativeCallsV2(value.calls), preads = trace.filter(call => call.syscall === "pread" || call.syscall === "pread_eof_probe");
  if (trace.some(call => call.resourceLifetimeId !== value.resourceLifetimeId || !["fstat", "pread", "pread_eof_probe"].includes(call.syscall))
    || BigInt(preads.length) !== BigInt(value.syscallAttempts) || trace.length > Number(value.maximumSyscallAttempts) + 2) return directoryV2Failure();
  if (Object.hasOwn(value, "identityBefore")) validateOfficeNativeIdentityV2(value.identityBefore);
  if (Object.hasOwn(value, "identityAfter")) validateOfficeNativeIdentityV2(value.identityAfter);
  let read = 0n, eof = false;
  for (const call of preads) {
    if (BigInt(call.offset!) !== read || eof) return directoryV2Failure();
    if (call.syscall === "pread_eof_probe") {
      if (read !== BigInt(value.expectedBytes) || call.requestedBytes !== "1") return directoryV2Failure();
      eof = call.nativeReturnState === "returned" && call.returned === 0;
    } else if (call.nativeReturnState === "returned" && call.success) read += BigInt(call.returned as number);
  }
  if (read !== BigInt(value.bytesRead) || eof !== value.eofObserved) return directoryV2Failure();
  if (value.success && (value.nativeOutcome !== "returned_success" || Object.hasOwn(value, "blockerCode") || read !== BigInt(value.expectedBytes)
    || !eof || !value.identitiesMatch || !value.identityBefore || !value.identityAfter || !v2Same(value.identityBefore, value.identityAfter)
    || !v2Object(value.identityBefore) || value.identityBefore.isFile !== true || value.identityBefore.isDirectory !== false
    || trace[0]?.syscall !== "fstat" || trace.at(-1)?.syscall !== "fstat"
    || !v2Same(trace[0]?.identity, value.identityBefore) || !v2Same(trace.at(-1)?.identity, value.identityAfter)
    || trace.some(call => call.nativeReturnState !== "returned" || call.calledAtMonotonicNs === "0"))) return directoryV2Failure();
  if (!value.success && value.nativeOutcome === "returned_success") return directoryV2Failure();
  return value as unknown as HostOfficeNativeReadbackV2;
}

export function validateOfficeNativeSnapshotV2(value: unknown): HostOfficeNativeSnapshotV2 {
  if (!v2Object(value) || !v2Exact(value, ["sessionNonce", "phase", "resources", "installationEntered", "residualCreation", "everFailed", "readbacks",
    "scopeBinding", "protectedStageVerified", "coreSafe", "packaged", "publicationObservationClaimed", "cancelRequested", ...v2OptionalKeys(value, ["installation", "publication"])]) || typeof value.sessionNonce !== "string" || !/^[a-f0-9]{32}$/.test(value.sessionNonce)
    || !["building", "blocked", "published_native_only", "cancelled", "closed"].includes(String(value.phase))
    || [value.installationEntered, value.residualCreation, value.everFailed, value.publicationObservationClaimed, value.cancelRequested].some(item => typeof item !== "boolean")
    || value.scopeBinding !== "unbound" || value.protectedStageVerified !== false || value.coreSafe !== false || value.packaged !== false
    || !Array.isArray(value.resources) || value.resources.length > 384 || !Array.isArray(value.readbacks) || value.readbacks.length > 1024) return directoryV2Failure();
  const ids = new Set<string>();
  for (const raw of value.resources) {
    const resource = validateOfficeNativeResourceV2(raw);
    if (ids.has(resource.lifetimeId) || !resource.lifetimeId.startsWith(value.sessionNonce + ":")
      || (resource.parentLifetimeId !== "" && !ids.has(resource.parentLifetimeId))) return directoryV2Failure();
    ids.add(resource.lifetimeId);
  }
  const reads = new Set<string>();
  for (const raw of value.readbacks) {
    const read = validateOfficeNativeReadbackV2(raw);
    const key = read.operationId + ":" + read.resourceLifetimeId;
    if (reads.has(key) || !ids.has(read.resourceLifetimeId)) return directoryV2Failure();
    reads.add(key);
  }
  const resources = new Map((value.resources as HostOfficeNativeResourceFactV2[]).map(item => [item.lifetimeId, item]));
  if (Object.hasOwn(value, "installation")) {
    const installation = validateOfficeNativeInstallationV2(value.installation, resources);
    if (value.installationEntered !== installation.entered) return directoryV2Failure();
  } else if (value.installationEntered) return directoryV2Failure();
  if (Object.hasOwn(value, "publication")) {
    if (!value.installation || !value.publicationObservationClaimed) return directoryV2Failure();
    validateOfficeNativePublicationV2(value.publication, resources, validateOfficeNativeInstallationV2(value.installation, resources));
  } else if (value.publicationObservationClaimed) return directoryV2Failure();
  return value as unknown as HostOfficeNativeSnapshotV2;
}

/** Exact history projection; caps, raw FD integers and Buffer payloads are forbidden here. */
export function validateOfficeNativeResultFactsV2(value: unknown): HostOfficeNativeResultFactsV2 {
  if (!v2Object(value) || !v2Exact(value, ["success", "nativeOutcome", "hostAcknowledgment", "operationId", "calls", "snapshot",
    ...v2OptionalKeys(value, ["resourceFact", "readback", "publication", "maximumSyscallAttempts", "syscallAttempts", "blockerCode"])])
    || typeof value.success !== "boolean" || value.nativeOutcome !== "returned" || value.hostAcknowledgment !== "not_provided"
    || typeof value.operationId !== "string" || (value.operationId !== "" && (!v2Text(value.operationId) || Buffer.byteLength(value.operationId) > 256))
    || (Object.hasOwn(value, "blockerCode") && !v2Text(value.blockerCode))) return directoryV2Failure();
  const trace = validateOfficeNativeCallsV2(value.calls), snapshot = validateOfficeNativeSnapshotV2(value.snapshot), resources = new Map(snapshot.resources.map(item => [item.lifetimeId, item]));
  if (trace.some(call => !resources.has(call.resourceLifetimeId) || resources.get(call.resourceLifetimeId)!.parentLifetimeId !== call.parentLifetimeId
    || call.entryName !== undefined && call.entryName !== resources.get(call.resourceLifetimeId)!.basename)) return directoryV2Failure();
  if (Object.hasOwn(value, "resourceFact")) {
    const resource = validateOfficeNativeResourceV2(value.resourceFact);
    if (!v2Same(resource, resources.get(resource.lifetimeId))) return directoryV2Failure();
  }
  if (Object.hasOwn(value, "readback")) {
    const read = validateOfficeNativeReadbackV2(value.readback);
    if (read.operationId !== value.operationId || read.success !== value.success || !v2Same(trace, read.calls)
      || !v2Same(read, snapshot.readbacks.find(item => item.operationId === read.operationId))) return directoryV2Failure();
  }
  if (Object.hasOwn(value, "publication")) {
    if (!snapshot.installation || Object.hasOwn(value, "readback")) return directoryV2Failure();
    const publication = validateOfficeNativePublicationV2(value.publication, resources, snapshot.installation);
    if (publication.operationId !== value.operationId || publication.success !== value.success || !v2Same(publication, snapshot.publication)
      || !v2Same(trace, publication.calls)) return directoryV2Failure();
  }
  if (Object.hasOwn(value, "maximumSyscallAttempts") || Object.hasOwn(value, "syscallAttempts")) {
    if (!v2Decimal(value.maximumSyscallAttempts, 832n) || !v2Decimal(value.syscallAttempts, 832n)
      || BigInt(value.syscallAttempts) > BigInt(value.maximumSyscallAttempts) || BigInt(value.syscallAttempts) !== BigInt(trace.length)
      || trace.some(call => call.syscall !== "write")) return directoryV2Failure();
  }
  return value as unknown as HostOfficeNativeResultFactsV2;
}
