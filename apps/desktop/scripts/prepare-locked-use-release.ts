import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  LOCKED_USE_ACCEPTANCE_CASES, LOCKED_USE_COMPONENTS, isHash, record, sha256,
  validateLockedUseReleaseEvidence,
} from "./locked-use-release-evidence.ts";
import { bounded, hashFile, run, signature } from "./locked-use-release-files.ts";
import { validateLockedUsePackagedCase } from "./locked-use-release-evidence.ts";

const installedRoot = "/Library/Application Support/LingStack/LockedUse";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--template") {
    const output = resolve(args[1]!);
    await writeFile(output, JSON.stringify({
      schemaVersion: 1, platform: "darwin", osBuild: "", team: "",
      nativeBuildManifestSha256: "", providerExecutableSha256: "", reviewer: "", reviewedAt: "",
      cases: Object.fromEntries(LOCKED_USE_ACCEPTANCE_CASES.map((name) =>
        [name, { result: "not_run", evidencePath: "", evidenceSha256: "" }])),
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write("Created an unaccepted checklist template: " + output + "\n");
    return;
  }
  const fields = new Map<string, string>();
  for (const arg of args) {
    const match = /^(--components|--provider|--checklist|--output)=(.+)$/u.exec(arg);
    if (!match || fields.has(match[1]!)) throw new Error("usage: --template <file> | --components=<dir> --provider=<signed-executable> --checklist=<file> --output=<fresh-dir>");
    fields.set(match[1]!, resolve(match[2]!));
  }
  if (fields.size !== 4 || process.platform !== "darwin") throw new Error("locked_use_release_requires_macos_and_four_paths");
  if (process.getuid?.() !== 0) throw new Error("locked_use_release_requires_administrator_to_read_native_evidence");
  const components = fields.get("--components")!;
  const provider = fields.get("--provider")!;
  const checklistPath = fields.get("--checklist")!;
  const output = fields.get("--output")!;
  const manifestBytes = await bounded(join(components, "build-manifest.json"));
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!record(manifest) || typeof manifest.team !== "string" || !/^[A-Z0-9]{10}$/u.test(manifest.team)) {
    throw new Error("locked_use_release_manifest_invalid");
  }
  const artifactSha256: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  for (const [artifact, identifier] of Object.entries(LOCKED_USE_COMPONENTS)) {
    artifactSha256[artifact] = await hashFile(join(components, artifact));
    hashes[identifier] = signature(join(components, artifact), identifier, manifest.team);
  }
  const providerCodeHash = signature(provider, "com.lingstack.desktop.cua-driver", manifest.team);
  // The signed installer reads the private report through its secure-store checks.
  // This read-only command neither installs nor promotes the native service.
  signature(join(installedRoot, "LingLockInstaller"), "com.lingstack.locked-use.installer", manifest.team);
  const reportText = run(join(installedRoot, "LingLockInstaller"), ["validation-report"]).trim();
  const report: unknown = JSON.parse(reportText);
  if (sha256(await bounded(join(installedRoot, "build-manifest.json"))) !== sha256(manifestBytes)) {
    throw new Error("locked_use_release_installed_manifest_mismatch");
  }
  const checklistBytes = await bounded(checklistPath);
  const checklist: unknown = JSON.parse(checklistBytes.toString("utf8"));
  const observed = {
    osBuild: run("/usr/bin/sw_vers", ["-buildVersion"]).trim(), team: manifest.team,
    providerSha256: await hashFile(provider), artifactSha256,
    componentCodeHashes: {
      brokerHash: hashes["com.lingstack.locked-use.broker"]!, guardianHash: hashes["com.lingstack.locked-use.guardian.dev"]!,
      pluginHash: hashes["com.lingstack.locked-use.authorization"]!, clientHash: hashes["com.lingstack.locked-use.client"]!,
    },
  };
  const authority = validateLockedUseReleaseEvidence({ manifestBytes, manifest, report, checklist, observed });
  if (!record(checklist) || !record(checklist.cases)) throw new Error("locked_use_release_checklist_invalid");
  const evidenceRoot = await realpath(dirname(checklistPath));
  for (const name of LOCKED_USE_ACCEPTANCE_CASES) {
    const item = checklist.cases[name];
    if (!record(item) || typeof item.evidencePath !== "string" || isAbsolute(item.evidencePath) || !isHash(item.evidenceSha256)) {
      throw new Error("locked_use_release_evidence_path_invalid");
    }
    const evidencePath = await realpath(resolve(evidenceRoot, item.evidencePath));
    const within = relative(evidenceRoot, evidencePath);
    if (within.startsWith("..") || isAbsolute(within) || await hashFile(evidencePath) !== item.evidenceSha256) {
      throw new Error("locked_use_release_evidence_mismatch:" + name);
    }
    if (name === "packaged_gui_capture_input") {
      validateLockedUsePackagedCase(JSON.parse((await bounded(evidencePath)).toString("utf8")), {
        osBuild: observed.osBuild, nativeBuildManifestSha256: sha256(manifestBytes), providerCodeHash,
      });
    }
  }
  const pin = sha256(authority);
  const authorityPath = join(output, "release-authority.json");
  await mkdir(output, { mode: 0o755 });
  await writeFile(authorityPath, authority, { flag: "wx", mode: 0o644 });
  await writeFile(join(output, "acceptance-provenance.json"), JSON.stringify({
    schemaVersion: 1, architecture: process.arch, osBuild: observed.osBuild, team: observed.team, providerCodeHash,
    nativeBuildManifestSha256: sha256(manifestBytes), providerExecutableSha256: observed.providerSha256,
    checklistSha256: sha256(checklistBytes), nativeReportSha256: sha256(Buffer.from(reportText)),
    releaseAuthoritySha256: pin, accepted: true,
  }, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  process.stdout.write(JSON.stringify({ prepared: true, releaseRoot: output, signedPackageAcceptance: "separate" }) + "\n");
}
await main();
