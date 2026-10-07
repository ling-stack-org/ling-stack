import { basename, dirname, join } from "node:path";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH, HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES, HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL,
  type HostOfficeLocalDirectoryPreparedV2, type HostOfficeDirectoryAncestorV2 } from "../../host-office-local-directory-v2-types.js";
import { validateOfficeNativeIdentityV2 } from "./host-office-local-native-v2-schema.js";
import { directoryV2Failure, v2Canonical, v2Component, v2Digest, v2Exact, v2Inside, v2Object, v2Same, v2Size,
  v2Source, v2Text, v2Timestamp } from "./host-office-local-directory-v2-validation.js";

function chain(value: unknown, parent: unknown, parentSlot: unknown, slots: Set<string>): readonly HostOfficeDirectoryAncestorV2[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 128 || !v2Canonical(parent) || parent === "/" || !v2Text(parentSlot)) return directoryV2Failure();
  let previous: string | undefined;
  for (const item of value) {
    if (!v2Object(item) || !v2Exact(item, ["resourceSlotId", "path", "identity"]) || !v2Text(item.resourceSlotId)
      || slots.has(item.resourceSlotId) || !v2Canonical(item.path)
      || (previous === undefined ? item.path !== "/" : dirname(item.path) !== previous || item.path === previous)) return directoryV2Failure();
    const identity = validateOfficeNativeIdentityV2(item.identity);
    if (!identity.isDirectory || identity.isFile) return directoryV2Failure();
    slots.add(item.resourceSlotId); previous = item.path;
  }
  if (previous !== parent || value.at(-1).resourceSlotId !== parentSlot) return directoryV2Failure();
  return value as readonly HostOfficeDirectoryAncestorV2[];
}

/** Exact fixed missing-subtree graph; independent of v1 leaf/overwrite/member semantics. */
export function validateOfficeLocalDirectoryPreparedV2(value: unknown): HostOfficeLocalDirectoryPreparedV2 {
  if (!v2Object(value) || !v2Exact(value, ["schemaVersion", "protocol", "graph", "executionId", "source", "parentOperationId",
    "producerOperationId", "toolCallId", "toolName", "format", "workspacePath", "workspaceIdentity", "targetPath",
    "requestDigest", "policyDigest", "output", "stage", "destination", "members", "scopeRef", "preparedAt"])
    || value.schemaVersion !== 2 || value.protocol !== HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL || value.graph !== HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH
    || ![value.executionId, value.parentOperationId, value.producerOperationId, value.toolCallId].every(v2Text)
    || value.parentOperationId === value.producerOperationId || !v2Source(value.source)
    || !v2Canonical(value.workspacePath) || !v2Canonical(value.targetPath) || !v2Inside(value.workspacePath, value.targetPath)
    || !v2Digest(value.requestDigest) || !v2Digest(value.policyDigest) || !v2Object(value.output)
    || !v2Exact(value.output, ["bytesSha256", "sizeBytes"]) || !v2Digest(value.output.bytesSha256) || !v2Size(value.output.sizeBytes)
    || value.output.sizeBytes < 1 || value.output.sizeBytes > HOST_OFFICE_LOCAL_DIRECTORY_V2_MAX_BYTES
    || !v2Object(value.stage) || !v2Exact(value.stage, ["parentPath", "parentResourceSlotId", "topBasename", "ancestors"])
    || !v2Object(value.destination) || !v2Exact(value.destination, ["parentPath", "parentResourceSlotId", "firstMissingComponent", "ancestors"])
    || !v2Component(value.stage.topBasename) || !v2Component(value.destination.firstMissingComponent)
    || !v2Object(value.scopeRef) || !v2Exact(value.scopeRef, ["scopeId", "issuerId", "evidenceDigest"])
    || !v2Text(value.scopeRef.scopeId) || !v2Text(value.scopeRef.issuerId) || !v2Digest(value.scopeRef.evidenceDigest)
    || !Array.isArray(value.members) || value.members.length < 2 || value.members.length > 128) return directoryV2Failure();
  const format = ({ office_create_workbook: "xlsx", office_create_document: "docx", office_create_presentation: "pptx" } as Record<string, string>)[String(value.toolName)];
  if (!format || format !== value.format || !value.targetPath.toLowerCase().endsWith("." + format)) return directoryV2Failure();
  const workspaceIdentity = validateOfficeNativeIdentityV2(value.workspaceIdentity);
  if (!workspaceIdentity.isDirectory || workspaceIdentity.isFile) return directoryV2Failure();
  const slots = new Set<string>();
  chain(value.stage.ancestors, value.stage.parentPath, value.stage.parentResourceSlotId, slots);
  const destination = chain(value.destination.ancestors, value.destination.parentPath, value.destination.parentResourceSlotId, slots);
  const workspace = destination.find(item => item.path === value.workspacePath);
  if (!workspace || !v2Same(workspace.identity, workspaceIdentity)) return directoryV2Failure();
  const ids = new Set<string>();
  let parentSlot = value.stage.parentResourceSlotId, canonicalParent = value.destination.parentPath as string,
    stageParent = value.stage.parentPath as string;
  for (let index = 0; index < value.members.length; index++) {
    const member = value.members[index], file = index === value.members.length - 1;
    if (!v2Object(member) || !v2Exact(member, ["memberId", "kind", "resourceSlotId", "publicationResourceSlotId", "parentResourceSlotId", "basename", "canonicalPath", "stagePath", "initial"])
      || !v2Text(member.memberId) || ids.has(member.memberId) || !v2Text(member.resourceSlotId) || slots.has(member.resourceSlotId)
      || member.parentResourceSlotId !== parentSlot || member.kind !== (file ? "created_file" : "created_directory") || member.initial !== "absent"
      || !v2Component(member.basename) || !v2Canonical(member.canonicalPath) || !v2Canonical(member.stagePath)
      || member.stagePath !== join(stageParent, member.basename)
      || member.canonicalPath !== join(canonicalParent, index === 0 ? value.destination.firstMissingComponent : member.basename)
      || (index === 0 && member.basename !== value.stage.topBasename)) return directoryV2Failure();
    if (file && (member.canonicalPath !== value.targetPath || basename(member.canonicalPath) !== member.basename)) return directoryV2Failure();
    if (!v2Text(member.publicationResourceSlotId) || slots.has(member.publicationResourceSlotId) || member.publicationResourceSlotId === member.resourceSlotId) return directoryV2Failure();
    ids.add(member.memberId); slots.add(member.resourceSlotId); slots.add(member.publicationResourceSlotId);
    parentSlot = member.resourceSlotId; canonicalParent = member.canonicalPath; stageParent = member.stagePath;
  }
  // Reserve every additional readonly publication lifetime before the first native entry.
  if (slots.size > 384 || v2Inside(value.stage.parentPath as string, value.destination.parentPath as string)
    || value.stage.parentPath === value.destination.parentPath) return directoryV2Failure();
  v2Timestamp(value.preparedAt);
  return value as unknown as HostOfficeLocalDirectoryPreparedV2;
}
