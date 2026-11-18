import { extractFile } from "@electron/asar";
import { isAbsolute, join } from "node:path";
import { bounded, signature } from "./locked-use-release-files.ts";
import { isHash, record, sha256 } from "./locked-use-release-evidence.ts";
import { resolveProviderLayout } from "./cua-driver-signing/provider-layout.mjs";

const authorityKey = "lingLockedUseLocalAuthoritySha256";

export async function lockedUseLocalBuilderConfig(input: {
  readonly localRoot?: string;
  readonly releaseRoot?: string;
  readonly validationRoot?: string;
  readonly signingTier: string;
  readonly providerExpected: boolean;
}): Promise<{ extraMetadata?: Record<string, string>; extraResources?: { from: string; to: string }[] }> {
  if (input.localRoot === undefined) return {};
  if (!isAbsolute(input.localRoot) || input.localRoot.includes("${")
    || input.releaseRoot !== undefined || input.validationRoot !== undefined
    || input.signingTier !== "test_signed_internal" || !input.providerExpected) {
    throw new Error("locked_use_local_requires_internal_provider_package");
  }
  const authorityPath = join(input.localRoot, "local-authority.json");
  const authority = await bounded(authorityPath);
  validateLocalAuthority(authority);
  return {
    extraMetadata: { [authorityKey]: sha256(authority) },
    extraResources: [{ from: authorityPath, to: "locked-use/local-authority.json" }],
  };
}

export function validateLocalAuthority(bytes: Buffer): { readonly team: string; readonly manifestSha256: string } {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("locked_use_local_authority_invalid"); }
  if (!record(value) || Object.keys(value).length !== 6 || value.schemaVersion !== 1
    || value.platform !== "darwin" || value.profile !== "local_development"
    || value.nativeAcceptance !== "local_development"
    || typeof value.expectedTeamId !== "string" || !/^[A-Z0-9]{10}$/u.test(value.expectedTeamId)
    || value.expectedTeamId === "0000000000" || !isHash(value.expectedBuildManifestSha256)) {
    throw new Error("locked_use_local_authority_invalid");
  }
  return { team: value.expectedTeamId, manifestSha256: value.expectedBuildManifestSha256 };
}

export function verifyPackagedLockedUseLocalMetadata(input: {
  readonly metadata: unknown;
  readonly authorityBytes: Buffer;
}): void {
  validateLocalAuthority(input.authorityBytes);
  if (!record(input.metadata) || input.metadata[authorityKey] !== sha256(input.authorityBytes)
    || Object.hasOwn(input.metadata, "lingLockedUseReleaseAuthoritySha256")
    || Object.hasOwn(input.metadata, "lingLockedUseAcceptanceSha256")
    || Object.hasOwn(input.metadata, "lingLockedUseValidationCandidateSha256")) {
    throw new Error("locked_use_packaged_local_mismatch");
  }
}

export async function verifyPackagedLockedUseLocal(context: {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string }; readonly config: { readonly extraMetadata?: Record<string, unknown> } };
}): Promise<void> {
  const declared = context.packager?.config?.extraMetadata;
  if (!declared?.[authorityKey]) return;
  if (context.electronPlatformName !== "darwin") throw new Error("locked_use_local_platform_mismatch");
  const resources = join(context.appOutDir, context.packager.appInfo.productFilename + ".app", "Contents", "Resources");
  const authorityBytes = await bounded(join(resources, "locked-use/local-authority.json"));
  const metadata: unknown = JSON.parse(extractFile(join(resources, "app.asar"), "package.json").toString("utf8"));
  if (!record(metadata) || metadata[authorityKey] !== declared[authorityKey]) {
    throw new Error("locked_use_packaged_local_mismatch");
  }
  verifyPackagedLockedUseLocalMetadata({ metadata, authorityBytes });
  const authority = validateLocalAuthority(authorityBytes);
  const layout = await resolveProviderLayout({ appOutDir: context.appOutDir, platform: "darwin" });
  if (!layout) throw new Error("locked_use_local_provider_missing");
  // The provider package verifier binds the executable to this same Team ID;
  // this call keeps the local authority check from accepting a missing tree.
  signature(layout.executablePath, "com.lingstack.desktop.cua-driver", authority.team, "apple_development");
}
