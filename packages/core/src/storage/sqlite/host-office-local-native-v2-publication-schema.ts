import type { HostOfficeNativeInstallationV2, HostOfficeNativePublicationV2, HostOfficeNativeResourceFactV2 } from "../../host-office-local-native-v2-types.js";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES } from "../../host-office-local-directory-v2-types.js";
import { validateOfficeNativeCallsV2, validateOfficeNativeReadbackV2 } from "./host-office-local-native-v2-schema.js";
import { directoryV2Failure, v2Component, v2Decimal, v2Exact, v2Object, v2OptionalKeys, v2Same, v2Size, v2Text } from "./host-office-local-directory-v2-validation.js";

export function validateOfficeNativeInstallationV2(value: unknown, resources: ReadonlyMap<string, HostOfficeNativeResourceFactV2>): HostOfficeNativeInstallationV2 {
  if (!v2Object(value) || !v2Exact(value, ["treeLifetimeId", "sourceParentLifetimeId", "destinationParentLifetimeId", "destinationName", "entries", "entered",
    "nativeReturnState", "calledAtMonotonicNs", "returnedAtMonotonicNs", ...(value.nativeReturnState === "returned" ? ["returned", "errno"] : [])])
    || !v2Component(value.destinationName) || typeof value.entered !== "boolean" || !v2Decimal(value.calledAtMonotonicNs) || !v2Decimal(value.returnedAtMonotonicNs)
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 128
    || resources.get(String(value.treeLifetimeId))?.kind !== "created_directory" || resources.get(String(value.sourceParentLifetimeId))?.kind !== "stage_parent"
    || resources.get(String(value.destinationParentLifetimeId))?.kind !== "destination_parent"
    || resources.get(String(value.treeLifetimeId))?.parentLifetimeId !== value.sourceParentLifetimeId) return directoryV2Failure();
  if (value.nativeReturnState === "returned") {
    if (!value.entered || (value.returned !== 0 && value.returned !== -1) || !v2Size(value.errno) || value.errno > 0x7fffffff
      || (value.returned === 0 ? value.errno !== 0 : value.errno === 0) || BigInt(value.returnedAtMonotonicNs) < BigInt(value.calledAtMonotonicNs)) return directoryV2Failure();
  } else if (value.nativeReturnState !== "not_returned" || value.returnedAtMonotonicNs !== "0") return directoryV2Failure();
  const ids = new Set<string>(); let size = 0n;
  for (const entry of value.entries) {
    if (!v2Object(entry) || !v2Exact(entry, ["resourceLifetimeId", "parentLifetimeId", "expectedBytes"])
      || !v2Text(entry.resourceLifetimeId) || ids.has(entry.resourceLifetimeId) || !v2Decimal(entry.expectedBytes, BigInt(HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES))) return directoryV2Failure();
    const resource = resources.get(entry.resourceLifetimeId);
    if (!resource || !["created_file", "created_directory"].includes(resource.kind) || resource.parentLifetimeId !== entry.parentLifetimeId
      || (ids.size === 0 ? entry.resourceLifetimeId !== value.treeLifetimeId : !ids.has(String(entry.parentLifetimeId)))
      || (resource.kind === "created_directory" ? entry.expectedBytes !== "0" : entry.expectedBytes !== resource.bytesWritten)) return directoryV2Failure();
    size += BigInt(entry.expectedBytes); ids.add(entry.resourceLifetimeId);
  }
  if (size > BigInt(HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES)) return directoryV2Failure();
  return value as unknown as HostOfficeNativeInstallationV2;
}

/** Publication observation is read-only provenance, not a creator cap, cleanup authority or Core receipt. */
export function validateOfficeNativePublicationV2(value: unknown, resources: ReadonlyMap<string, HostOfficeNativeResourceFactV2>, installation: HostOfficeNativeInstallationV2): HostOfficeNativePublicationV2 {
  if (!v2Object(value) || !v2Exact(value, ["operationId", "observationBasis", "expectedBytes", "budgetBytes", "maximumCalls", "success", "nativeOutcome", "entries", "calls", ...v2OptionalKeys(value, ["blockerCode"])])
    || !v2Text(value.operationId) || value.observationBasis !== "original_destination_parent_relative" || typeof value.success !== "boolean"
    || !["not_entered", "entered", "returned_failed", "returned_success", "unknown_exception"].includes(String(value.nativeOutcome))
    || !v2Decimal(value.expectedBytes, BigInt(HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES)) || !v2Decimal(value.budgetBytes, BigInt(HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES + 128))
    || !v2Decimal(value.maximumCalls, 8192n) || !Array.isArray(value.entries) || value.entries.length > installation.entries.length
    || installation.nativeReturnState !== "returned" || installation.returned !== 0 || Object.hasOwn(value, "blockerCode") && !v2Text(value.blockerCode)) return directoryV2Failure();
  const installedFiles = installation.entries.filter(item => resources.get(item.resourceLifetimeId)?.kind === "created_file");
  const expected = installedFiles.reduce((sum, entry) => sum + BigInt(entry.expectedBytes), 0n);
  const maximum = 2n + 5n * BigInt(installation.entries.length) + installedFiles.reduce((sum, entry) => sum + (BigInt(entry.expectedBytes) + 65535n) / 65536n + 35n, 0n);
  const trace = validateOfficeNativeCallsV2(value.calls);
  if (BigInt(value.expectedBytes) !== expected || BigInt(value.budgetBytes) !== expected + BigInt(installedFiles.length)
    || BigInt(value.maximumCalls) !== maximum || BigInt(trace.length) > maximum) return directoryV2Failure();
  const observed = new Set<string>();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index], original = installation.entries[index]!;
    if (!v2Object(entry) || !v2Exact(entry, ["originalLifetimeId", ...v2OptionalKeys(entry, ["observedLifetimeId", "readback"])])
      || entry.originalLifetimeId !== original.resourceLifetimeId) return directoryV2Failure();
    if (Object.hasOwn(entry, "observedLifetimeId")) {
      if (!v2Text(entry.observedLifetimeId) || observed.has(entry.observedLifetimeId)) return directoryV2Failure();
      const resource = resources.get(entry.observedLifetimeId), originalResource = resources.get(original.resourceLifetimeId)!;
      if (!resource || resource.kind !== (originalResource.kind === "created_file" ? "publication_file" : "publication_directory")
        || resource.basename !== (index === 0 ? installation.destinationName : originalResource.basename)
        || resource.parentLifetimeId !== (index === 0 ? installation.destinationParentLifetimeId : (value.entries.find((item: unknown) => v2Object(item) && item.originalLifetimeId === original.parentLifetimeId) as { observedLifetimeId?: string } | undefined)?.observedLifetimeId)) return directoryV2Failure();
      observed.add(entry.observedLifetimeId);
      if (entry.readback) {
        const read = validateOfficeNativeReadbackV2(entry.readback);
        if (resource.kind !== "publication_file" || read.resourceLifetimeId !== resource.lifetimeId || read.operationId !== value.operationId
          || read.expectedBytes !== original.expectedBytes || read.calls.some(call => !trace.some(actual => v2Same(actual, call)))) return directoryV2Failure();
      }
      if (value.success && (resource.state !== "closed" || !resource.identityObserved || originalResource.kind === "created_file" && (!entry.readback || !v2Object(entry.readback) || entry.readback.success !== true))) return directoryV2Failure();
      if (value.success && (!resource.initialIdentity || !originalResource.initialIdentity
        || resource.initialIdentity.isFile !== (originalResource.kind === "created_file") || resource.initialIdentity.isDirectory !== (originalResource.kind === "created_directory")
        || resource.initialIdentity.device !== originalResource.initialIdentity.device || resource.initialIdentity.inode !== originalResource.initialIdentity.inode
        || resource.initialIdentity.mode !== originalResource.initialIdentity.mode)) return directoryV2Failure();
    } else if (entry.readback || value.success) return directoryV2Failure();
  }
  if (value.success && (value.nativeOutcome !== "returned_success" || Object.hasOwn(value, "blockerCode") || value.entries.length !== installation.entries.length
    || trace.some(call => call.nativeReturnState !== "returned" || call.calledAtMonotonicNs === "0" || !call.success && call.errno !== 4))) return directoryV2Failure();
  if (!value.success && value.nativeOutcome === "returned_success") return directoryV2Failure();
  return value as unknown as HostOfficeNativePublicationV2;
}
