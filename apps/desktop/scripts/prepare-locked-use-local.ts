import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bounded, hashFile, signature } from "./locked-use-release-files.ts";
import { isHash, LOCKED_USE_COMPONENTS, record, sha256 } from "./locked-use-release-evidence.ts";

/**
 * Create an explicitly local authority for an Apple Development package.
 * This lane is intentionally not a release evidence format: it binds the
 * exact local native component set and never claims notarization or acceptance
 * for another machine.
 */
export async function prepareLockedUseLocalAuthority(input: {
  readonly components: string;
  readonly output: string;
}): Promise<{ readonly authorityPath: string; readonly team: string; readonly manifestSha256: string }> {
  const components = resolve(input.components);
  const output = resolve(input.output);
  const manifestBytes = await bounded(join(components, "build-manifest.json"));
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw new Error("locked_use_local_manifest_invalid"); }
  if (!record(manifest)
    || Object.keys(manifest).length !== 10
    || manifest.schemaVersion !== 1 || manifest.platform !== "darwin"
    || manifest.architecture !== process.arch || manifest.signing !== "local_development"
    || manifest.productCapability !== "disabled_by_build" || manifest.nativeAcceptance !== "not_run"
    || typeof manifest.team !== "string" || !/^[A-Z0-9]{10}$/u.test(manifest.team)
    || manifest.team === "0000000000" || typeof manifest.upstreamCommit !== "string"
    || !/^[a-f0-9]{40}$/u.test(manifest.upstreamCommit) || !record(manifest.checks)
    || Object.keys(manifest.checks).length !== 4 || manifest.checks.policy !== "passed"
    || manifest.checks.authorizationPluginABI !== "passed"
    || manifest.checks.kernelTaskVerifier !== "local_development_identity_passed"
    || manifest.checks.xctest !== "separate" || !record(manifest.artifacts)
    || Object.keys(manifest.artifacts).length !== Object.keys(LOCKED_USE_COMPONENTS).length
    || Object.keys(LOCKED_USE_COMPONENTS).some((artifact) => !Object.hasOwn(manifest.artifacts!, artifact))) {
    throw new Error("locked_use_local_manifest_invalid");
  }
  const artifactHashes: Record<string, string> = {};
  for (const [artifact, identifier] of Object.entries(LOCKED_USE_COMPONENTS)) {
    const path = join(components, artifact);
    artifactHashes[artifact] = await hashFile(path);
    signature(path, identifier, manifest.team, "apple_development");
  }
  for (const artifact of Object.keys(LOCKED_USE_COMPONENTS)) {
    if (!isHash(manifest.artifacts[artifact]) || manifest.artifacts[artifact] !== artifactHashes[artifact]) {
      throw new Error("locked_use_local_artifact_mismatch");
    }
  }
  const authority = {
    schemaVersion: 1,
    platform: "darwin",
    profile: "local_development",
    nativeAcceptance: "local_development",
    expectedTeamId: manifest.team,
    expectedBuildManifestSha256: sha256(manifestBytes),
  } as const;
  await mkdir(output, { recursive: false, mode: 0o755 });
  const authorityPath = join(output, "local-authority.json");
  await writeFile(authorityPath, JSON.stringify(authority, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  return { authorityPath, team: manifest.team, manifestSha256: sha256(manifestBytes) };
}

async function main(): Promise<void> {
  const fields = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^(--components|--output)=(.+)$/u.exec(arg);
    if (!match || fields.has(match[1]!)) throw new Error("usage: --components=<dir> --output=<fresh-dir>");
    fields.set(match[1]!, resolve(match[2]!));
  }
  if (fields.size !== 2 || process.platform !== "darwin") throw new Error("locked_use_local_requires_macos_and_two_paths");
  const result = await prepareLockedUseLocalAuthority({ components: fields.get("--components")!, output: fields.get("--output")! });
  process.stdout.write(JSON.stringify({ prepared: true, ...result, profile: "local_development", productCapability: "disabled_by_build" }) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
