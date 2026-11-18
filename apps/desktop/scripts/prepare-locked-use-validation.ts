import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LOCKED_USE_VALIDATION_FIXTURE, LOCKED_USE_VALIDATION_FIXTURE_BINARY, LOCKED_USE_VALIDATION_FIXTURE_ID,
  parseLockedUseValidationCandidate,
} from "../shared/locked-use-validation-contract.ts";
import { LOCKED_USE_COMPONENTS, record, sha256, validateLockedUseNativeManifest } from "./locked-use-release-evidence.ts";
import { bounded, hashFile, run, signature } from "./locked-use-release-files.ts";

async function main(): Promise<void> {
  const fields = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^(--components|--provider|--output)=(.+)$/u.exec(arg);
    if (!match || fields.has(match[1]!)) throw new Error("usage: --components=<dir> --provider=<signed-executable> --output=<fresh-dir>");
    fields.set(match[1]!, resolve(match[2]!));
  }
  if (fields.size !== 3 || process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("locked_use_validation_requires_macos_arm64_and_three_paths");
  }
  const components = fields.get("--components")!;
  const provider = fields.get("--provider")!;
  const output = fields.get("--output")!;
  const manifestBytes = await bounded(join(components, "build-manifest.json"));
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!record(manifest) || typeof manifest.team !== "string" || !/^[A-Z0-9]{10}$/u.test(manifest.team)) {
    throw new Error("locked_use_validation_manifest_invalid");
  }
  const artifactSha256: Record<string, string> = {};
  for (const [artifact, identifier] of Object.entries(LOCKED_USE_COMPONENTS)) {
    artifactSha256[artifact] = await hashFile(join(components, artifact));
    signature(join(components, artifact), identifier, manifest.team);
  }
  validateLockedUseNativeManifest({ manifest, observed: { team: manifest.team, artifactSha256 } });
  const fixture = join(components, LOCKED_USE_VALIDATION_FIXTURE);
  const fixtureExecutableSha256 = await hashFile(join(fixture, "Contents/MacOS", LOCKED_USE_VALIDATION_FIXTURE_BINARY));
  signature(fixture, LOCKED_USE_VALIDATION_FIXTURE_ID, manifest.team);
  const candidate = parseLockedUseValidationCandidate({
    schemaVersion: 1, kind: "attended_candidate", platform: "darwin", architecture: "arm64",
    osBuild: run("/usr/bin/sw_vers", ["-buildVersion"]).trim(), expectedTeamId: manifest.team,
    expectedBuildManifestSha256: sha256(manifestBytes),
    providerCodeHash: signature(provider, "com.lingstack.desktop.cua-driver", manifest.team), fixtureExecutableSha256,
  });
  await mkdir(output, { mode: 0o755 });
  await cp(fixture, join(output, LOCKED_USE_VALIDATION_FIXTURE), { recursive: true, errorOnExist: true, force: false });
  if (await hashFile(join(output, LOCKED_USE_VALIDATION_FIXTURE, "Contents/MacOS", LOCKED_USE_VALIDATION_FIXTURE_BINARY)) !== fixtureExecutableSha256) {
    throw new Error("locked_use_validation_fixture_changed");
  }
  signature(join(output, LOCKED_USE_VALIDATION_FIXTURE), LOCKED_USE_VALIDATION_FIXTURE_ID, manifest.team);
  await writeFile(join(output, "validation-candidate.json"), JSON.stringify(candidate, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  process.stdout.write(JSON.stringify({ prepared: true, candidateRoot: output, productCapability: "disabled_by_build", acceptance: "not_run" }) + "\n");
}
await main();
