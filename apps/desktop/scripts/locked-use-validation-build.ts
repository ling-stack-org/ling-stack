import { extractFile } from "@electron/asar";
import { isAbsolute, join, resolve } from "node:path";
import {
  LOCKED_USE_VALIDATION_ENTRY, LOCKED_USE_VALIDATION_METADATA_KEY, LOCKED_USE_VALIDATION_FIXTURE,
  LOCKED_USE_VALIDATION_FIXTURE_BINARY, LOCKED_USE_VALIDATION_FIXTURE_ID, LOCKED_USE_VALIDATION_RESOURCE,
  parseLockedUseValidationCandidate,
} from "../shared/locked-use-validation-contract.ts";
import { bounded, hashFile, signature } from "./locked-use-release-files.ts";
import { record, sha256 } from "./locked-use-release-evidence.ts";
import { resolveProviderLayout } from "./cua-driver-signing/provider-layout.mjs";

/** Keep the already signed fixture bytes pinned while signing the outer app. */
export async function lockedUseValidationSigningIgnore(input: {
  readonly appPath: string;
  readonly metadata: unknown;
}): Promise<((path: string) => boolean) | undefined> {
  if (!record(input.metadata) || !Object.hasOwn(input.metadata, LOCKED_USE_VALIDATION_METADATA_KEY)) return undefined;
  const resources = join(input.appPath, "Contents", "Resources");
  const candidateBytes = await bounded(join(resources, LOCKED_USE_VALIDATION_RESOURCE));
  const candidate = parseLockedUseValidationCandidate(JSON.parse(candidateBytes.toString("utf8")));
  const fixture = join(resources, "locked-use", LOCKED_USE_VALIDATION_FIXTURE);
  const observedFixtureSha256 = await hashFile(join(fixture, "Contents/MacOS", LOCKED_USE_VALIDATION_FIXTURE_BINARY));
  verifyPackagedLockedUseValidation({ metadata: input.metadata, candidateBytes,
    observedProviderCodeHash: candidate.providerCodeHash, observedFixtureSha256 });
  signature(fixture, LOCKED_USE_VALIDATION_FIXTURE_ID, candidate.expectedTeamId);
  return path => isLockedUseValidationFixturePath(path, input.appPath);
}

export function isLockedUseValidationFixturePath(path: string, appPath: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some(segment => segment === "." || segment === "..")) return false;
  const paths = [resolve(appPath, "Contents/Resources/locked-use", LOCKED_USE_VALIDATION_FIXTURE).replaceAll("\\", "/"),
    "Contents/Resources/locked-use/" + LOCKED_USE_VALIDATION_FIXTURE,
    "Resources/locked-use/" + LOCKED_USE_VALIDATION_FIXTURE];
  return paths.some(root => normalized === root || normalized.startsWith(root + "/"));
}

export async function lockedUseValidationBuilderConfig(input: {
  readonly candidateRoot?: string;
  readonly releaseRoot?: string;
  readonly signingTier: string;
  readonly providerExpected: boolean;
}): Promise<{ extraMetadata?: Record<string, string>; extraResources?: { from: string; to: string }[] }> {
  if (input.candidateRoot === undefined) return {};
  if (input.releaseRoot !== undefined || !isAbsolute(input.candidateRoot) || input.candidateRoot.includes("${")
    || input.signingTier !== "production_signed" || !input.providerExpected) {
    throw new Error("locked_use_validation_requires_separate_production_provider_candidate");
  }
  const manifest = join(input.candidateRoot, "validation-candidate.json");
  const bytes = await bounded(manifest);
  const candidate = parseLockedUseValidationCandidate(JSON.parse(bytes.toString("utf8")));
  if (candidate.architecture !== process.arch) throw new Error("locked_use_validation_architecture_mismatch");
  const fixture = join(input.candidateRoot, LOCKED_USE_VALIDATION_FIXTURE);
  if (await hashFile(join(fixture, "Contents/MacOS", LOCKED_USE_VALIDATION_FIXTURE_BINARY)) !== candidate.fixtureExecutableSha256) {
    throw new Error("locked_use_validation_fixture_mismatch");
  }
  return {
    extraMetadata: { main: LOCKED_USE_VALIDATION_ENTRY, [LOCKED_USE_VALIDATION_METADATA_KEY]: sha256(bytes) },
    extraResources: [{ from: manifest, to: LOCKED_USE_VALIDATION_RESOURCE },
      { from: fixture, to: "locked-use/" + LOCKED_USE_VALIDATION_FIXTURE }],
  };
}

export function verifyPackagedLockedUseValidation(input: {
  readonly metadata: unknown;
  readonly candidateBytes: Buffer;
  readonly observedProviderCodeHash: string;
  readonly observedFixtureSha256: string;
}): void {
  const candidate = parseLockedUseValidationCandidate(JSON.parse(input.candidateBytes.toString("utf8")));
  if (!record(input.metadata) || input.metadata.main !== LOCKED_USE_VALIDATION_ENTRY
    || input.metadata[LOCKED_USE_VALIDATION_METADATA_KEY] !== sha256(input.candidateBytes)
    || Object.hasOwn(input.metadata, "lingLockedUseReleaseAuthoritySha256")
    || Object.hasOwn(input.metadata, "lingLockedUseAcceptanceSha256")
    || candidate.providerCodeHash !== input.observedProviderCodeHash
    || candidate.fixtureExecutableSha256 !== input.observedFixtureSha256) throw new Error("locked_use_packaged_validation_mismatch");
}

export async function verifyPackagedLockedUseValidationCandidate(context: {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string }; readonly config: { readonly extraMetadata?: Record<string, unknown> } };
}): Promise<void> {
  const declared = context.packager?.config?.extraMetadata;
  if (!declared?.[LOCKED_USE_VALIDATION_METADATA_KEY]) return;
  if (context.electronPlatformName !== "darwin") throw new Error("locked_use_validation_platform_mismatch");
  const resources = join(context.appOutDir, context.packager.appInfo.productFilename + ".app", "Contents", "Resources");
  const candidateBytes = await bounded(join(resources, LOCKED_USE_VALIDATION_RESOURCE));
  const candidate = parseLockedUseValidationCandidate(JSON.parse(candidateBytes.toString("utf8")));
  const metadata: unknown = JSON.parse(extractFile(join(resources, "app.asar"), "package.json").toString("utf8"));
  if (!record(metadata) || metadata[LOCKED_USE_VALIDATION_METADATA_KEY] !== declared[LOCKED_USE_VALIDATION_METADATA_KEY]) {
    throw new Error("locked_use_packaged_validation_mismatch");
  }
  const layout = await resolveProviderLayout({ appOutDir: context.appOutDir, platform: "darwin" });
  if (!layout) throw new Error("locked_use_validation_provider_missing");
  const fixture = join(resources, "locked-use", LOCKED_USE_VALIDATION_FIXTURE);
  signature(fixture, LOCKED_USE_VALIDATION_FIXTURE_ID, candidate.expectedTeamId);
  verifyPackagedLockedUseValidation({ metadata, candidateBytes,
    observedProviderCodeHash: signature(layout.executablePath, "com.lingstack.desktop.cua-driver", candidate.expectedTeamId),
    observedFixtureSha256: await hashFile(join(fixture, "Contents/MacOS", LOCKED_USE_VALIDATION_FIXTURE_BINARY)) });
}
