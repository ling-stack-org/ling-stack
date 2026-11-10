import type { BundledSkillManifest } from "@ling-stack/core/bundled-skill-source";

const embeddedBundledGstackJson: string = "NO_PACKAGED_GSTACK_IDENTITY";

export interface PackagedGstackIdentity {
  readonly manifestChecksum: string;
  readonly upstreamRevision: string;
  readonly adaptationRevision: string;
  readonly target: NonNullable<BundledSkillManifest["target"]>;
  readonly skillIds: readonly string[];
}

/** Build-owned selection data, not a path or receipt supplied by a request. */
export function readPackagedGstackIdentity(): PackagedGstackIdentity | undefined {
  if (embeddedBundledGstackJson === "NO_PACKAGED_GSTACK_IDENTITY") return undefined;
  const value = JSON.parse(embeddedBundledGstackJson) as PackagedGstackIdentity;
  if (!/^sha256:[a-f0-9]{64}$/.test(value.manifestChecksum) || !/^[a-f0-9]{40}$/.test(value.upstreamRevision) ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(value.adaptationRevision) ||
    !["darwin", "win32"].includes(value.target?.platform) || !["arm64", "x64"].includes(value.target?.arch) ||
    !Array.isArray(value.skillIds) || value.skillIds.length !== 57 || new Set(value.skillIds).size !== 57 ||
    !value.skillIds.every(id => typeof id === "string" && /^[a-z][a-z0-9-]*$/.test(id))) {
    throw new Error("packaged_gstack_identity_invalid");
  }
  return Object.freeze({ ...value, target: Object.freeze({ ...value.target }), skillIds: Object.freeze([...value.skillIds]) });
}
