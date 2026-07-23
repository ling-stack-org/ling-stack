import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "../scripts/cua-driver-signing/signing-contract.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const platform = process.platform;

if (!new Set(["darwin", "win32"]).has(platform)) {
  process.stdout.write(
    `${JSON.stringify({ kind: "ling-cua-driver-electron-builder-fixture", platform, skipped: true })}\n`,
  );
  process.exit(0);
}

const sourceRoot = parseSourceRoot(process.argv.slice(2), process.env);
const root = await mkdtemp(join(tmpdir(), `ling-cua-electron-builder-${platform}-`));
try {
  const outputRoot = join(root, "builder-output");
  const sourceProviderPath = platform === "win32"
    ? join(sourceRoot, "win32-x64", "payload", "cua-driver.exe")
    : join(sourceRoot, "darwin", "cua-driver");
  await access(join(sourceRoot, "source-build-attestation.json"));
  await access(sourceProviderPath);
  const expectedPreSignPayloadSha256 = await sha256File(sourceProviderPath);
  const command = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const packageScript = platform === "darwin" ? "package:mac" : "package:win";
  await run(command, [
    "pnpm",
    "--filter",
    "@ling-stack/desktop",
    packageScript,
  ], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      LING_CUA_SIGNING_FIXTURE: "1",
      LING_CUA_SIGNING_TIER: "test_signed_internal",
      LING_CUA_DISTRIBUTION_CHANNEL: "internal",
      LING_CUA_TEST_AUTHORITY_KIND: "ephemeral-ci",
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
      LING_CUA_DRIVER_SOURCE_BUILD_ROOT: sourceRoot,
      LING_CUA_PACKAGE_OUTPUT_ROOT: outputRoot,
      ...(platform === "darwin"
        ? { LING_CUA_DARWIN_EXPECTED_TEAM_ID: "ABCDEFGHIJ" }
        : {}),
    },
  });

  const expectedCopies = platform === "darwin" ? 2 : 1;
  const packagedCapabilities = await findNamedFiles(
    outputRoot,
    "packaged-provider-capabilities.json",
  );
  const packagedPolicies = await findNamedFiles(outputRoot, "runtime-trust-policy.json");
  const packagedProviders = await findNamedFiles(
    outputRoot,
    platform === "win32" ? "cua-driver.exe" : "cua-driver",
  );
  const packagedSeals = await findNamedFiles(outputRoot, "provider-seal.json");
  const packagedCatalogs = await findNamedFiles(outputRoot, "provider-integrity.cat");
  if (
    packagedCapabilities.length !== expectedCopies
    || packagedPolicies.length !== expectedCopies
    || packagedProviders.length !== expectedCopies
    || packagedSeals.length !== expectedCopies
    || packagedCatalogs.length !== (platform === "win32" ? expectedCopies : 0)
  ) {
    throw new Error(
      `electron_builder_fixture_private_resources_invalid:${packagedCapabilities.length}:${packagedPolicies.length}:${packagedProviders.length}:${packagedSeals.length}:${packagedCatalogs.length}`,
    );
  }
  for (const path of packagedCapabilities) {
    const capability = JSON.parse(await readFile(path, "utf8"));
    if (
      capability.darwin !== (platform === "darwin")
      || capability.win32 !== (platform === "win32")
    ) {
      throw new Error("electron_builder_fixture_capability_platform_mismatch");
    }
  }
  for (const path of packagedPolicies) {
    const policy = JSON.parse(await readFile(path, "utf8"));
    if (policy.platform !== platform) {
      throw new Error("electron_builder_fixture_policy_platform_mismatch");
    }
  }
  const capabilitiesSha256 = await sha256File(packagedCapabilities[0]);
  const runtimeTrustPolicySha256 = await sha256File(packagedPolicies[0]);

  const tracePaths = await findNamedFiles(outputRoot, "provider-signing-trace.json");
  if (tracePaths.length !== expectedCopies) {
    throw new Error(`electron_builder_fixture_trace_count_invalid:${tracePaths.length}`);
  }
  const summaries = [];
  for (const [index, tracePath] of tracePaths.entries()) {
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    const eventNames = trace.events.map((event) => `${event.hook}:${event.event}`);
    for (const required of [
      "afterPack:started",
      "afterPack:provider-pre-sign-digest",
      "afterPack:provider-signed",
      "afterPack:provider-sealed",
      ...(platform === "win32" ? ["afterPack:provider-catalog-signed"] : []),
      "afterPack:complete",
      "platformSign:outer-path-signed",
      "afterSign:started",
      "afterSign:verified",
    ]) {
      if (!eventNames.includes(required)) {
        throw new Error(`electron_builder_fixture_hook_missing:${required}:${tracePath}`);
      }
    }
    const outerRoles = trace.events
      .filter((event) => event.hook === "platformSign" && event.event === "outer-path-signed")
      .map((event) => event.role)
      .sort();
    const expectedOuterRoles = platform === "darwin"
      ? ["outer-app-bundle"]
      : ["outer-app", "outer-nsis", "outer-uninstaller"];
    if (JSON.stringify(outerRoles) !== JSON.stringify(expectedOuterRoles)) {
      throw new Error(`electron_builder_fixture_outer_roles_invalid:${outerRoles.join(",")}`);
    }
    const sealEvent = trace.events.find(
      (event) => event.hook === "afterPack" && event.event === "provider-sealed",
    );
    const preSignEvent = trace.events.find(
      (event) => event.hook === "afterPack" && event.event === "provider-pre-sign-digest",
    );
    const afterPackComplete = trace.events.find(
      (event) => event.hook === "afterPack" && event.event === "complete",
    );
    const afterSign = trace.events.find(
      (event) => event.hook === "afterSign" && event.event === "verified",
    );
    if (
      !sealEvent
      || !preSignEvent
      || !afterPackComplete
      || !afterSign
      || preSignEvent.providerSha256 !== expectedPreSignPayloadSha256
      || sealEvent.providerSha256 !== afterSign.providerSha256
      || afterPackComplete.providerSha256 !== sealEvent.providerSha256
    ) {
      throw new Error("electron_builder_fixture_provider_digest_changed_after_seal");
    }
    const finalEvents = trace.events.filter(
      (event) => event.hook === "artifactBuildCompleted" && event.event === "verified",
    );
    const expectedFinalRoles = platform === "darwin"
      ? ["outer-dmg", "outer-zip"]
      : ["outer-nsis"];
    const actualFinalRoles = finalEvents.map((event) => event.artifactRole).sort();
    if (JSON.stringify(actualFinalRoles) !== JSON.stringify(expectedFinalRoles)) {
      throw new Error(
        `electron_builder_fixture_final_roles_invalid:${actualFinalRoles.join(",")}`,
      );
    }
    for (const event of finalEvents) {
      if (
        event.artifactName?.toLowerCase().endsWith(".blockmap")
        || !/^[a-f0-9]{64}$/u.test(String(event.artifactSha256 ?? ""))
        || event.providerSha256 !== afterPackComplete.providerSha256
        || event.sealSha256 !== afterPackComplete.sealSha256
        || event.catalogSha256 !== afterPackComplete.catalogSha256
        || event.capabilitiesSha256 !== capabilitiesSha256
        || event.runtimeTrustPolicySha256 !== runtimeTrustPolicySha256
      ) {
        throw new Error(
          `electron_builder_fixture_final_digest_mismatch:${String(event.artifactRole)}`,
        );
      }
    }
    summaries.push({
      index,
      tracePath,
      trace,
      providerSha256: sealEvent.providerSha256,
      hooks: eventNames,
      outerRoles,
      finalArtifactRoles: actualFinalRoles,
    });
  }

  const retainedDirectory = join(desktopRoot, "test-results", "cua-driver-signing-feasibility");
  await mkdir(retainedDirectory, { recursive: true });
  const retainedTrace = join(retainedDirectory, `electron-builder-${platform}-traces.json`);
  await writeFile(retainedTrace, `${JSON.stringify({ platform, traces: summaries }, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      kind: "ling-cua-driver-electron-builder-fixture",
      platform,
      skipped: false,
      sourceRoot,
      expectedCopies,
      expectedPreSignPayloadSha256,
      retainedTrace,
      traces: summaries,
    })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function parseSourceRoot(values, environment) {
  const sourceRootValue = values[0] === "--source-root" && values.length === 2
    ? values[1]
    : environment.LING_CUA_DRIVER_SOURCE_BUILD_ROOT;
  if (
    typeof sourceRootValue !== "string"
    || !isAbsolute(sourceRootValue)
    || (values.length > 0 && !(values[0] === "--source-root" && values.length === 2))
  ) {
    throw new Error("usage: --source-root <absolute verified source-build output>");
  }
  return resolve(sourceRootValue);
}

async function run(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `electron_builder_fixture_failed:code=${String(code)}:signal=${String(signal)}`,
          ),
        );
      }
    });
  });
}

async function findNamedFiles(root, name) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name === name) {
        result.push(path);
      }
    }
  }
  await walk(root);
  return result.sort();
}
