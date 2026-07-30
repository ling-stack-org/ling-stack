import type { LingThemePackManifest } from "@ling-stack/ui-react/theme";
import {
  putStoredWebThemePackage,
  type StoredWebThemePackage,
  type ThemePackageRepositoryDescriptor,
} from "../package/index.js";
import { assertTokenOnlyManifest } from "./web-quick-theme-compiler.js";

export async function publishWebGeneratedThemeManifest(
  manifest: LingThemePackManifest,
): Promise<StoredWebThemePackage> {
  assertTokenOnlyManifest(manifest, 0);
  const packageChecksumSha256 = await sha256(
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  return putStoredWebThemePackage({ manifest, packageChecksumSha256 });
}

export function webGeneratedThemeDescriptor(
  stored: StoredWebThemePackage,
): ThemePackageRepositoryDescriptor {
  return Object.freeze({
    health: "ready",
    installedAt: stored.installedAt,
    manifest: stored.manifest,
    recordRevision: 1,
    themeId: stored.manifest.id,
    updatedAt: stored.updatedAt,
    ...(stored.packageChecksumSha256 !== undefined
      ? { packageChecksumSha256: stored.packageChecksumSha256 }
      : {}),
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
