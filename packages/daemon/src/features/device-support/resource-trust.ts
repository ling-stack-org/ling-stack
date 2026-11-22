import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { DeviceResourceManifestV1 } from "@ling-stack/contracts";
import { canonicalJsonBytes, decodeBase64Url } from "@ling-stack/remote-protocol";

export interface DeviceResourceTrustPolicy {
  readonly allowedLicenses: readonly string[];
  verifyManifest(manifest: DeviceResourceManifestV1): boolean;
}

export function readDeviceResourceTrustPolicy(path: string | undefined): DeviceResourceTrustPolicy | undefined {
  if (path === undefined) return undefined;
  let document: unknown;
  try {
    if (!isAbsolute(path)) throw new Error();
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error();
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Device resource trust configuration requires an absolute path to a readable JSON file");
  }
  if (!isRecord(document) || Object.keys(document).length !== 3 || document.version !== 1
    || !Array.isArray(document.signingKeys) || document.signingKeys.length < 1 || document.signingKeys.length > 32
    || !Array.isArray(document.allowedLicenses) || document.allowedLicenses.length < 1 || document.allowedLicenses.length > 64
    || !document.allowedLicenses.every(isLicenseIdentifier) || new Set(document.allowedLicenses).size !== document.allowedLicenses.length) {
    throw new Error("Device resource trust configuration requires version 1, signing keys and allowed licenses");
  }

  const keys = new Map<string, KeyObject>();
  for (const entry of document.signingKeys) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || typeof entry.keyId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(entry.keyId) || keys.has(entry.keyId)
      || typeof entry.publicKeyPem !== "string" || !entry.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")) {
      throw new Error("Device resource signing key entry is invalid");
    }
    let key: KeyObject;
    try {
      key = createPublicKey(entry.publicKeyPem);
    } catch {
      throw new Error("Device resource signing key is not a valid public key");
    }
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Device resource signing key must use Ed25519");
    keys.set(entry.keyId, key);
  }

  return {
    allowedLicenses: document.allowedLicenses.slice(),
    verifyManifest(manifest) {
      const match = /^ed25519:([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):([A-Za-z0-9_-]{86})$/u.exec(manifest.signature);
      const keyId = match?.[1];
      const key = keyId === undefined ? undefined : keys.get(keyId);
      if (!match || keyId === undefined || !key) return false;
      try {
        const signature = decodeBase64Url(match[2]!);
        const { signature: _signature, ...unsigned } = manifest;
        return signature.byteLength === 64 && verify(null, canonicalJsonBytes({
          purpose: "ling.device-resource-manifest.v1", keyId, manifest: unsigned,
        }), key, signature);
      } catch {
        return false;
      }
    },
  };
}

function isLicenseIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
