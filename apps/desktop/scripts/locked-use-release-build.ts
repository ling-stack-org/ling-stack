import { extractFile } from "@electron/asar";
import { isAbsolute, join } from "node:path";
import { bounded, signature } from "./locked-use-release-files.ts";
import { isHash, record, sha256 } from "./locked-use-release-evidence.ts";
import { resolveProviderLayout } from "./cua-driver-signing/provider-layout.mjs";

const authorityKey = "lingLockedUseReleaseAuthoritySha256";
const provenanceKey = "lingLockedUseAcceptanceSha256";

export function validatePreparedLockedUseRelease(authorityBytes: Buffer, provenanceBytes: Buffer): {
  team: string; providerCodeHash: string;
} {
  const authority: unknown = JSON.parse(authorityBytes.toString("utf8"));
  const provenance: unknown = JSON.parse(provenanceBytes.toString("utf8"));
  if (!record(authority) || !record(provenance) || authority.schemaVersion !== 1
    || authority.platform !== "darwin" || authority.nativeAcceptance !== "passed"
    || typeof authority.expectedTeamId !== "string" || !/^[A-Z0-9]{10}$/u.test(authority.expectedTeamId)
    || authority.expectedTeamId === "0000000000" || !isHash(authority.expectedBuildManifestSha256)
    || Object.keys(authority).length !== 5 || provenance.schemaVersion !== 1 || provenance.accepted !== true
    || provenance.architecture !== process.arch || typeof provenance.osBuild !== "string" || !provenance.osBuild
    || provenance.team !== authority.expectedTeamId || provenance.releaseAuthoritySha256 !== sha256(authorityBytes)
    || provenance.nativeBuildManifestSha256 !== authority.expectedBuildManifestSha256
    || !isHash(provenance.providerExecutableSha256) || !isHash(provenance.checklistSha256)
    || !isHash(provenance.nativeReportSha256) || typeof provenance.providerCodeHash !== "string"
    || !/^[a-f0-9]{40,64}$/u.test(provenance.providerCodeHash)
    || Object.keys(provenance).length !== 11) throw new Error("locked_use_release_preparation_invalid");
  return { team: authority.expectedTeamId, providerCodeHash: provenance.providerCodeHash };
}

/** Release resources augment the fixed signing pipeline and its existing fuses. */
export async function lockedUseReleaseBuilderConfig(input: {
  readonly releaseRoot?: string;
  readonly signingTier: string;
  readonly providerExpected: boolean;
}): Promise<{
  extraMetadata?: Record<string, string>;
  extraResources?: { from: string; to: string }[];
}> {
  if (input.releaseRoot === undefined) return {};
  if (!isAbsolute(input.releaseRoot) || input.releaseRoot.includes("${")
    || input.signingTier !== "production_signed" || !input.providerExpected) {
    throw new Error("locked_use_release_requires_production_provider_package");
  }
  const authorityPath = join(input.releaseRoot, "release-authority.json");
  const provenancePath = join(input.releaseRoot, "acceptance-provenance.json");
  const authority = await bounded(authorityPath);
  const provenance = await bounded(provenancePath);
  validatePreparedLockedUseRelease(authority, provenance);
  return {
    extraMetadata: { [authorityKey]: sha256(authority), [provenanceKey]: sha256(provenance) },
    extraResources: [
      { from: authorityPath, to: "locked-use/release-authority.json" },
      { from: provenancePath, to: "locked-use/acceptance-provenance.json" },
    ],
  };
}

/** Signing timestamps may change bytes; accepted executable code must match. */
export function verifyPackagedLockedUseAcceptance(input: {
  readonly metadata: unknown;
  readonly authorityBytes: Buffer;
  readonly provenanceBytes: Buffer;
  readonly observedProviderCodeHash: string;
}): void {
  const accepted = validatePreparedLockedUseRelease(input.authorityBytes, input.provenanceBytes);
  if (!record(input.metadata) || input.metadata[authorityKey] !== sha256(input.authorityBytes)
    || input.metadata[provenanceKey] !== sha256(input.provenanceBytes)
    || input.observedProviderCodeHash !== accepted.providerCodeHash) throw new Error("locked_use_packaged_acceptance_mismatch");
}

export async function verifyPackagedLockedUse(context: {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string }; readonly config: { readonly extraMetadata?: Record<string, unknown> } };
}): Promise<void> {
  const declared = context.packager?.config?.extraMetadata;
  if (!declared?.[authorityKey] && !declared?.[provenanceKey]) return;
  if (context.electronPlatformName !== "darwin") throw new Error("locked_use_release_platform_mismatch");
  const resources = join(context.appOutDir, context.packager.appInfo.productFilename + ".app", "Contents", "Resources");
  const authorityBytes = await bounded(join(resources, "locked-use", "release-authority.json"));
  const provenanceBytes = await bounded(join(resources, "locked-use", "acceptance-provenance.json"));
  const accepted = validatePreparedLockedUseRelease(authorityBytes, provenanceBytes);
  const metadata: unknown = JSON.parse(extractFile(join(resources, "app.asar"), "package.json").toString("utf8"));
  const layout = await resolveProviderLayout({ appOutDir: context.appOutDir, platform: "darwin" });
  if (!layout || !record(metadata) || metadata[authorityKey] !== declared[authorityKey]
    || metadata[provenanceKey] !== declared[provenanceKey]) throw new Error("locked_use_packaged_acceptance_mismatch");
  const observedProviderCodeHash = signature(layout.executablePath, "com.lingstack.desktop.cua-driver", accepted.team);
  verifyPackagedLockedUseAcceptance({ metadata, authorityBytes, provenanceBytes, observedProviderCodeHash });
}
