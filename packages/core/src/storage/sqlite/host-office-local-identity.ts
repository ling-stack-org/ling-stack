import type { HostOfficeFileIdentity } from "../../host-office-local-types.js";

const identityKeys = ["device", "inode", "sizeBytes", "modifiedNs", "changedNs"] as const;

/** Pure allowlist for captured identity facts; never rereads a path or grants filesystem authority. */
export function isHostOfficeFileIdentity(value: unknown): value is HostOfficeFileIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Object.keys(identity).length === identityKeys.length && identityKeys.every(key => Object.hasOwn(identity, key))
    && [identity.device, identity.inode, identity.modifiedNs, identity.changedNs]
      .every(part => typeof part === "string" && /^\d{1,40}$/.test(part))
    && Number.isSafeInteger(identity.sizeBytes) && Number(identity.sizeBytes) >= 0;
}
