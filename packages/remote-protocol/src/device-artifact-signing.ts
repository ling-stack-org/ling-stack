import type { RemoteDeviceArtifactManifestV1, RemoteDeviceArtifactReceiptV1, RemotePhoneTaskProjectionV1 } from "@ling-stack/contracts";
import { canonicalJsonBytes, domainSeparatedCanonicalBytes } from "./canonical.js";
import { sha256 } from "./sha256.js";

export function deviceArtifactDigest(bytes: Uint8Array): string {
  return "sha256:" + Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function phoneTaskProjectionDigest(projection: RemotePhoneTaskProjectionV1): string {
  return deviceArtifactDigest(canonicalJsonBytes(projection));
}

export function deviceArtifactManifestBytes(manifest: RemoteDeviceArtifactManifestV1): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.remote.device-artifact.manifest.v1", manifest);
}

export function deviceArtifactChunkBytes(manifest: RemoteDeviceArtifactManifestV1, index: number, digest: string): Uint8Array {
  return domainSeparatedCanonicalBytes("ling.remote.device-artifact.chunk.v1", { manifest, index, digest });
}

export function deviceArtifactReceiptBytes(
  manifest: RemoteDeviceArtifactManifestV1,
  receipt: Omit<RemoteDeviceArtifactReceiptV1, "signature">,
): Uint8Array {
  const { digest, verifiedAt, apkVerification } = receipt;
  return domainSeparatedCanonicalBytes("ling.remote.device-artifact.receipt.v1", {
    manifest, digest, verifiedAt, ...(apkVerification ? { apkVerification } : {}),
  });
}
