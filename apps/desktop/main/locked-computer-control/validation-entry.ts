import { app, powerMonitor } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  LOCKED_USE_VALIDATION_ENTRY, LOCKED_USE_VALIDATION_METADATA_KEY, LOCKED_USE_VALIDATION_RESOURCE,
  LOCKED_USE_VALIDATION_FIXTURE, LOCKED_USE_VALIDATION_FIXTURE_BINARY, LOCKED_USE_VALIDATION_FIXTURE_ID,
  parseLockedUseValidationCandidate,
} from "../../shared/locked-use-validation-contract.js";
import { createDarwinExecFileCommandRunner } from "../cua-driver/adapters/darwin-identity.js";
import { readBoundedContainedResourceFile } from "../cua-driver/bounded-resource-file.js";
import { CuaDriverDesktopCoordinator } from "../cua-driver/coordinator.js";
import { resolveDesktopCuaDriverPackagedStartupAuthority } from "../cua-driver/packaged-startup.js";
import { createPackagedCuaDriverDesktopPlatformOwner } from "../cua-driver/platform-owner-composition.js";
import { resolveCuaDriverResourcePaths } from "../cua-driver/resource-path.js";
import { createInstalledDarwinLockedUseClientFactory } from "./installed-native-client.js";
import { runLockedUsePackagedValidation } from "./packaged-validation.js";
import { startLockedUseValidationFixture } from "./validation-fixture.js";
import { connectLockedUseValidationTransport } from "./validation-transport.js";

const execute = promisify(execFile);
const controller = new AbortController();
let exitReady = false;
app.on("before-quit", event => {
  if (!exitReady) { event.preventDefault(); controller.abort(new Error("locked_use_validation_cancelled")); }
});
process.on("SIGINT", () => controller.abort(new Error("locked_use_validation_cancelled")));
process.on("SIGTERM", () => controller.abort(new Error("locked_use_validation_cancelled")));
app.on("window-all-closed", () => undefined);

async function main(): Promise<void> {
  if (!app.isPackaged || process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() === 0
    || process.argv.length !== 2 || process.argv[1] !== "--validate-locked-use-attended") {
    throw new Error("usage: signed-validation-candidate --validate-locked-use-attended");
  }
  const bytes = readFileSync(join(app.getAppPath(), "package.json"));
  if (bytes.length > 1024 * 1024) throw new Error("locked_use_validation_package_metadata_invalid");
  const metadata: unknown = JSON.parse(bytes.toString("utf8"));
  if (!record(metadata) || metadata.main !== LOCKED_USE_VALIDATION_ENTRY
    || typeof metadata[LOCKED_USE_VALIDATION_METADATA_KEY] !== "string"
    || Object.hasOwn(metadata, "lingLockedUseReleaseAuthoritySha256") || Object.hasOwn(metadata, "lingLockedUseAcceptanceSha256")) {
    throw new Error("locked_use_validation_candidate_package_required");
  }
  const runRoot = join(app.getPath("userData"), "locked-use-validation", randomUUID());
  const hostData = join(runRoot, "host");
  const workspace = join(runRoot, "workspace");
  mkdirSync(hostData, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  app.setPath("userData", hostData);
  const candidateFile = await readBoundedContainedResourceFile({
    resourcesPath: process.resourcesPath, segments: LOCKED_USE_VALIDATION_RESOURCE.split("/"), maxBytes: 16 * 1024,
  });
  if (!candidateFile || digest(candidateFile.bytes) !== metadata[LOCKED_USE_VALIDATION_METADATA_KEY]) {
    throw new Error("locked_use_validation_candidate_digest_mismatch");
  }
  const candidate = parseLockedUseValidationCandidate(JSON.parse(candidateFile.bytes.toString("utf8")));
  if (candidate.osBuild !== await osBuild()) throw new Error("locked_use_validation_os_build_mismatch");
  const packagePath = join(process.resourcesPath, "..", "..");
  const packageCodeHash = await signedCodeHash(packagePath, "com.lingstack.desktop", candidate.expectedTeamId);
  const fixtureFile = await readBoundedContainedResourceFile({
    resourcesPath: process.resourcesPath,
    segments: ["locked-use", LOCKED_USE_VALIDATION_FIXTURE, "Contents", "MacOS", LOCKED_USE_VALIDATION_FIXTURE_BINARY],
    maxBytes: 32 * 1024 * 1024,
  });
  if (!fixtureFile || digest(fixtureFile.bytes) !== candidate.fixtureExecutableSha256) throw new Error("locked_use_validation_fixture_digest_mismatch");
  const fixtureBundle = join(process.resourcesPath, "locked-use", LOCKED_USE_VALIDATION_FIXTURE);
  await signedCodeHash(fixtureBundle, LOCKED_USE_VALIDATION_FIXTURE_ID, candidate.expectedTeamId);
  const authority = await resolveDesktopCuaDriverPackagedStartupAuthority({
    packaged: true, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, platform: "darwin",
  });
  if (!authority.runtimeEligible || authority.policy?.platform !== "darwin"
    || authority.policy.expectedTeamId !== candidate.expectedTeamId) throw new Error("locked_use_validation_packaged_provider_unavailable");
  const providerPaths = resolveCuaDriverResourcePaths({ resourcesPath: process.resourcesPath, platform: "darwin", architecture: "arm64" });
  if (await signedCodeHash(providerPaths.executablePath, "com.lingstack.desktop.cua-driver", candidate.expectedTeamId) !== candidate.providerCodeHash) {
    throw new Error("locked_use_validation_provider_code_mismatch");
  }
  await app.whenReady();
  const abort = () => controller.abort(new Error("locked_use_validation_system_transition"));
  powerMonitor.on("suspend", abort);
  const timeout = setTimeout(() => controller.abort(new Error("locked_use_validation_timeout")), 600_000);
  timeout.unref();
  const owner = await createPackagedCuaDriverDesktopPlatformOwner({
    platform: "darwin", policy: authority.policy, onDarwinPermissionChanged: abort,
  });
  let fixture: Awaited<ReturnType<typeof startLockedUseValidationFixture>> | undefined;
  try {
    await owner.start();
    fixture = await startLockedUseValidationFixture(fixtureFile.path, controller.signal);
    const factory = createInstalledDarwinLockedUseClientFactory({
      expectedTeamId: candidate.expectedTeamId, expectedBuildManifestSha256: candidate.expectedBuildManifestSha256,
    });
    const bridgeContext = {
      bridgeToken: randomBytes(32).toString("base64url"), daemonAuthorityEpoch: randomUUID(), bridgeConnectionId: randomUUID(),
      desktopInstanceEpoch: 1, workspaceCwd: workspace,
    };
    let endpoint: string | undefined;
    let providerGeneration: number | undefined;
    const result = await runLockedUsePackagedValidation({
      candidate, candidateSha256: digest(candidateFile.bytes), packageCodeHash, workspaceCwd: workspace,
      fixture, signal: controller.signal, createNative: onRevoked => factory.createClient(onRevoked),
      onPhase: phase => process.stdout.write(JSON.stringify({ event: "lockedUsePackagedValidation", phase }) + "\n"),
      createCoordinator: input => new CuaDriverDesktopCoordinator({
        ...input, platform: "darwin", architecture: "arm64", resourcesPath: process.resourcesPath,
        userDataPath: hostData, workspaceCwd: workspace, bridgeContext, daemonBaseUrl: "http://127.0.0.1:1",
        featureFlags: authority.featureFlags, packaged: true, readinessDetailsV1: true, platformBinding: owner.binding,
        // The harness consumes this private lease; nothing is published to a daemon.
        leaseClient: {
          async publish(lease) { endpoint = lease.endpoint; providerGeneration = lease.generation; },
          async revoke() { endpoint = undefined; },
        },
      }),
      async connect(generation, signal) {
        if (!endpoint || providerGeneration !== generation) throw new Error("locked_use_validation_lease_missing");
        return connectLockedUseValidationTransport({ endpoint, context: { ...bridgeContext, generation }, signal });
      },
    });
    if (await osBuild() !== candidate.osBuild
      || await signedCodeHash(packagePath, "com.lingstack.desktop", candidate.expectedTeamId) !== packageCodeHash
      || await signedCodeHash(providerPaths.executablePath, "com.lingstack.desktop.cua-driver", candidate.expectedTeamId) !== candidate.providerCodeHash) {
      throw new Error("locked_use_validation_build_changed");
    }
    await writeFile(join(runRoot, "before.png"), result.beforeImage, { flag: "wx", mode: 0o600 });
    await writeFile(join(runRoot, "after.png"), result.afterImage, { flag: "wx", mode: 0o600 });
    const reportPath = join(runRoot, "packaged-gui-validation.json");
    await writeFile(reportPath, JSON.stringify(result.report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({ event: "lockedUsePackagedValidation", result: "passed", reportPath,
      productCapability: "disabled_by_build", physicalAndFaultAcceptance: "separate" }) + "\n");
  } finally {
    clearTimeout(timeout);
    powerMonitor.removeListener("suspend", abort);
    await fixture?.close();
    await owner.dispose();
  }
}

async function signedCodeHash(path: string, identifier: string, team: string): Promise<string> {
  const runner = createDarwinExecFileCommandRunner({ timeoutMs: 10_000, baseEnvironment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  await runner.run({ executable: "/usr/bin/codesign", args: ["--verify", "--strict", "--all-architectures", "--test-requirement",
    `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`
      + " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", path] });
  const info = await runner.run({ executable: "/usr/bin/codesign", args: ["--display", "--verbose=4", path] });
  const text = info.stdout + "\n" + info.stderr;
  const hashes = [...text.matchAll(/^CDHash=([a-f0-9]{40,64})$/gmu)];
  const flags = [...text.matchAll(/\bflags=0x([a-f0-9]+)\b/giu)];
  if (hashes.length !== 1 || flags.length !== 1 || (Number.parseInt(flags[0]![1]!, 16) & 0x10000) === 0) {
    throw new Error("locked_use_validation_signed_code_invalid");
  }
  return hashes[0]![1]!;
}
async function osBuild(): Promise<string> {
  const value = await execute("/usr/bin/sw_vers", ["-buildVersion"], { timeout: 3000, maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  return value.stdout.trim();
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

let exitCode = 0;
try { await main(); }
catch (error) {
  exitCode = 1;
  process.stderr.write(JSON.stringify({ event: "lockedUsePackagedValidation", result: "failed",
    reason: error instanceof Error ? error.message : "validation_failed" }) + "\n");
} finally { exitReady = true; app.exit(exitCode); }
