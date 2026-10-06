import { basename } from "node:path";
import type { HostOfficeLocalDirectoryPreparedV2, HostOfficeLocalDirectoryExecutionRecordV2, PrepareHostOfficeLocalDirectoryEffectV2,
  HostOfficeDirectoryResourceBindingV2 } from "../../host-office-local-directory-v2-types.js";
import type { HostOfficeNativeIdentityV2, HostOfficeNativeResourceFactV2 } from "../../host-office-local-native-v2-types.js";
import { directoryV2Failure, v2Exact, v2Object, v2OptionalKeys, v2Size, v2Text, v2Timestamp } from "./host-office-local-directory-v2-validation.js";

export interface OfficeDirectorySlotV2 {
  readonly resourceSlotId: string;
  readonly kind: HostOfficeNativeResourceFactV2["kind"];
  readonly basename: string;
  readonly parentResourceSlotId?: string;
  readonly initialIdentity?: HostOfficeNativeIdentityV2;
}
/** Both original ancestor chains remain separate even when they legitimately alias an existing inode. */
export function officeDirectorySlotsV2(execution: HostOfficeLocalDirectoryPreparedV2): OfficeDirectorySlotV2[] {
  return [...(["stage", "destination"] as const).flatMap(role => execution[role].ancestors.map((item, index, chain) => ({
    resourceSlotId: item.resourceSlotId, kind: index === chain.length - 1 ? role === "stage" ? "stage_parent" as const : "destination_parent" as const : "ancestor" as const,
    basename: item.path === "/" ? "/" : basename(item.path), ...(index === 0 ? {} : { parentResourceSlotId: chain[index - 1]!.resourceSlotId }),
    initialIdentity: item.identity,
  }))), ...execution.members.map(item => ({ resourceSlotId: item.resourceSlotId, kind: item.kind,
    basename: item.basename, parentResourceSlotId: item.parentResourceSlotId })), ...execution.members.map((item, index) => ({
      resourceSlotId: item.publicationResourceSlotId, kind: item.kind === "created_file" ? "publication_file" as const : "publication_directory" as const,
      basename: index === 0 ? execution.destination.firstMissingComponent : item.basename,
      parentResourceSlotId: index === 0 ? execution.destination.parentResourceSlotId : execution.members[index - 1]!.publicationResourceSlotId,
    }))];
}

export function validateOfficeDirectoryBindingV2(value: unknown): HostOfficeDirectoryResourceBindingV2 {
  if (!v2Object(value) || !v2Exact(value, ["resourceSlotId", "nativeLifetimeId", ...v2OptionalKeys(value, ["acquisitionCallRef", "firstFstatCallRef"])])
    || !v2Text(value.resourceSlotId) || !v2Text(value.nativeLifetimeId)) return directoryV2Failure();
  for (const key of ["acquisitionCallRef", "firstFstatCallRef"] as const) if (Object.hasOwn(value, key)) {
    const ref = value[key];
    if (!v2Object(ref) || !v2Exact(ref, ["effectId", "ordinal"]) || !v2Text(ref.effectId) || !v2Size(ref.ordinal) || ref.ordinal >= 8192) return directoryV2Failure();
  }
  return value as unknown as HostOfficeDirectoryResourceBindingV2;
}

/** Exact invocation parameters, not an arbitrary syscall sequence or caller-created lifetime. */
export function validateOfficeLocalDirectoryEffectV2(execution: HostOfficeLocalDirectoryExecutionRecordV2, value: unknown): PrepareHostOfficeLocalDirectoryEffectV2 {
  if (!v2Object(value) || !v2Text(value.effectId) || Buffer.byteLength(value.effectId) > 256 || !v2Size(value.ordinal) || value.ordinal >= 1024
    || !v2Text(value.kind) || (value.mode !== "forward" && !(value.mode === "cleanup" && value.kind === "close_session"))) return directoryV2Failure();
  const extra = ({ capture_parents: [], create_directory: ["resourceSlotId", "parentResourceSlotId", "parentNativeLifetimeId", "basename"],
    create_file: ["resourceSlotId", "parentResourceSlotId", "parentNativeLifetimeId", "basename"],
    write_file: ["resourceSlotId", "nativeLifetimeId", "offset", "sizeBytes"], read_file: ["resourceSlotId", "nativeLifetimeId", "expectedBytes", "budgetBytes"],
    observe_publication: ["resourceSlotId", "nativeLifetimeId", "budgetBytes"],
    fsync_resource: ["resourceSlotId", "nativeLifetimeId"], observe_resource: ["resourceSlotId", "nativeLifetimeId"], close_resource: ["resourceSlotId", "nativeLifetimeId"],
    install_tree: ["resourceSlotId", "nativeLifetimeId", "sourceParentResourceSlotId", "sourceParentNativeLifetimeId", "sourceBasename",
      "destinationParentResourceSlotId", "destinationParentNativeLifetimeId", "destinationBasename", "flags"], close_session: [] } as Record<string, string[]>)[value.kind];
  if (!extra || !v2Exact(value, ["effectId", "ordinal", "kind", "mode", "preparedAt", ...extra])) return directoryV2Failure();
  if (v2Timestamp(value.preparedAt) < v2Timestamp(execution.preparedAt)) return directoryV2Failure();
  if (value.kind === "capture_parents") {
    if (value.ordinal !== 0) return directoryV2Failure();
  } else if (value.ordinal === 0) return directoryV2Failure();
  if (value.kind === "capture_parents" || value.kind === "close_session") return value as unknown as PrepareHostOfficeLocalDirectoryEffectV2;
  const slot = officeDirectorySlotsV2(execution).find(item => item.resourceSlotId === value.resourceSlotId);
  if (!slot) return directoryV2Failure();
  if (value.kind === "create_directory" || value.kind === "create_file") {
    const member = execution.members.find(item => item.resourceSlotId === slot.resourceSlotId);
    if (!member || member.kind !== (value.kind === "create_file" ? "created_file" : "created_directory")
      || value.parentResourceSlotId !== member.parentResourceSlotId || value.basename !== member.basename || !v2Text(value.parentNativeLifetimeId)) return directoryV2Failure();
  } else {
    if (!v2Text(value.nativeLifetimeId)) return directoryV2Failure();
    if (["write_file", "read_file", "close_resource"].includes(value.kind) && slot.kind !== "created_file") return directoryV2Failure();
    if (value.kind === "write_file" && (!v2Size(value.offset) || !v2Size(value.sizeBytes) || value.sizeBytes < 1 || value.offset + value.sizeBytes > execution.output.sizeBytes)) return directoryV2Failure();
    if (value.kind === "read_file" && (value.expectedBytes !== execution.output.sizeBytes || value.budgetBytes !== execution.output.sizeBytes + 1)) return directoryV2Failure();
    if (value.kind === "observe_publication" && (value.resourceSlotId !== execution.members[0]!.resourceSlotId || value.budgetBytes !== execution.output.sizeBytes + 1)) return directoryV2Failure();
    if (slot.kind === "publication_file" || slot.kind === "publication_directory") return directoryV2Failure();
    if (value.kind === "install_tree" && (value.resourceSlotId !== execution.members[0]!.resourceSlotId
      || value.sourceParentResourceSlotId !== execution.stage.parentResourceSlotId || value.sourceBasename !== execution.stage.topBasename
      || value.destinationParentResourceSlotId !== execution.destination.parentResourceSlotId || value.destinationBasename !== execution.destination.firstMissingComponent
      || value.flags !== "RENAME_EXCL" || !v2Text(value.sourceParentNativeLifetimeId) || !v2Text(value.destinationParentNativeLifetimeId))) return directoryV2Failure();
  }
  return value as unknown as PrepareHostOfficeLocalDirectoryEffectV2;
}
