import type { HostOfficeNativeResultFactsV2 } from "../../host-office-local-native-v2-types.js";
import { directoryV2Failure, v2Same } from "./host-office-local-directory-v2-validation.js";

/**
 * Validate the original closeSession trace, including publication's guarded
 * close after failed forward work. This is a historical grammar, not a closure
 * capability: prior acquisition/retention belongs to history and full replay.
 * Unknown descriptor integers are never retried or adopted here.
 */
export function validateOfficeDirectoryCloseSessionV2(result: HostOfficeNativeResultFactsV2): void {
  const resources = result.snapshot.resources;
  if (result.snapshot.phase !== "closed" || result.resourceFact) return directoryV2Failure();
  const indices = new Map(resources.map((resource, index) => [resource.lifetimeId, index]));
  const failedGuards = new Set<string>();
  let previous = resources.length, ordinal = 0, failed = false;
  while (ordinal < result.calls.length) {
    const first = result.calls[ordinal++]!, index = indices.get(first.resourceLifetimeId);
    if (index === undefined || index >= previous) return directoryV2Failure();
    previous = index;
    const resource = resources[index]!;
    let close = first;
    if (resource.kind === "publication_directory" || resource.kind === "publication_file") {
      if (first.syscall !== "fstat" || first.nativeReturnState !== "returned") return directoryV2Failure();
      const original = resource.initialIdentity, identity = first.identity;
      const sameNode = first.success && identity && original && identity.device === original.device
        && identity.inode === original.inode && identity.isFile === original.isFile && identity.isDirectory === original.isDirectory;
      if (first.success && (!v2Same(identity, resource.identity) || first.returnedAtMonotonicNs !== resource.observedAtMonotonicNs)) return directoryV2Failure();
      if (!sameNode) {
        const expected = first.success || first.errno === 9 ? "unknown" : "retained";
        if (resource.state !== expected) return directoryV2Failure();
        failedGuards.add(resource.lifetimeId); failed = true;
        continue;
      }
      const guarded = result.calls[ordinal++];
      if (!guarded || guarded.resourceLifetimeId !== first.resourceLifetimeId) return directoryV2Failure();
      close = guarded;
    }
    if (close.syscall !== "close" || close.nativeReturnState !== "returned"
      || resource.state !== (close.success ? "closed" : "unknown")) return directoryV2Failure();
    failed ||= !close.success;
  }
  // A retained resource is possible only when its actual observer guard failed
  // without EBADF. Other retained resources cannot be skipped by closeSession.
  if (resources.some(resource => resource.state === "retained" && !failedGuards.has(resource.lifetimeId))) return directoryV2Failure();
  failed ||= resources.some(resource => resource.state === "unknown");
  if (result.success === failed) return directoryV2Failure();
}
