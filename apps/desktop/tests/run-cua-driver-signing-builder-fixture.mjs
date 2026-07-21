import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCuaDriverPackageAuthorityFiles } from "../scripts/cua-driver-package-runtime-policy.mjs";
import {
  sha256Bytes,
  sha256File,
} from "../scripts/cua-driver-signing/signing-contract.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.platform;

if (!new Set(["darwin", "win32"]).has(platform)) {
  process.stdout.write(
    `${JSON.stringify({ kind: "ling-cua-driver-electron-builder-fixture", platform, skipped: true })}\n`,
  );
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), `ling-cua-electron-builder-${platform}-`));
try {
  const packageResourcesRoot = join(root, "package-resources");
  const providerRoot = join(packageResourcesRoot, "0.8.3-ling.1");
  const outputRoot = join(root, "builder-output");
  const providerPath =
    platform === "win32"
      ? join(providerRoot, "win32-x64", "payload", "cua-driver.exe")
      : join(providerRoot, "darwin", "cua-driver");
  await mkdir(dirname(providerPath), { recursive: true });
  await writeFile(join(providerRoot, "provider-lock.json"), `${platform}-builder-fixture-lock\n`);
  await writeFile(providerPath, Buffer.from(`electron-builder-provider-fixture:${platform}`));
  const fixtureCertificateSha256 = sha256Bytes(
    "fixture-certificate:CN=Ling Disposable CI Fixture",
  );
  const packageAuthority = await writeCuaDriverPackageAuthorityFiles({
    outputRoot: packageResourcesRoot,
    platform: platform === "darwin" ? "darwin" : "win32-x64",
    signingProfile: { signingTier: "test_signed_internal" },
    ...(platform === "darwin"
      ? { expectedTeamId: "ABCDEFGHIJ" }
      : {
          providerSigner: {
            subject: "CN=Ling Disposable CI Fixture",
            certificateSha256: fixtureCertificateSha256,
          },
          catalogSigner: {
            subject: "CN=Ling Disposable CI Fixture",
            certificateSha256: fixtureCertificateSha256,
          },
        }),
  });

  const executable = join(desktopRoot, "node_modules", ".bin", "electron-builder");
  const args = [
    "--config",
    "./scripts/cua-driver-electron-builder.config.mjs",
    platform === "darwin" ? "--mac" : "--win",
    ...(platform === "darwin" ? ["dmg", "zip"] : ["nsis"]),
    process.arch === "arm64" && platform === "darwin" ? "--arm64" : "--x64",
  ];
  await run(executable, args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      LING_CUA_SIGNING_FIXTURE: "1",
      LING_CUA_SIGNING_TIER: "test_signed_internal",
      LING_CUA_DISTRIBUTION_CHANNEL: "internal",
      LING_CUA_TEST_AUTHORITY_KIND: "ephemeral-ci",
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
      LING_CUA_PACKAGE_RESOURCES_ROOT: packageResourcesRoot,
      LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(packageAuthority.hostAuthority),
      LING_CUA_PACKAGE_OUTPUT_ROOT: outputRoot,
      LING_CUA_EXPECTED_PRE_SIGN_PAYLOAD_SHA256: await sha256File(providerPath),
      ...(platform === "darwin"
        ? { LING_CUA_DARWIN_EXPECTED_TEAM_ID: "ABCDEFGHIJ" }
        : {}),
    },
  });

  const packagedCapabilities = await findNamedFiles(
    outputRoot,
    "packaged-provider-capabilities.json",
  );
  const packagedPolicies = await findNamedFiles(outputRoot, "runtime-trust-policy.json");
  const packagedProviders = await findNamedFiles(
    outputRoot,
    platform === "win32" ? "cua-driver.exe" : "cua-driver",
  );
  const packagedUiAccessProviders = platform === "win32"
    ? await findNamedFiles(outputRoot, "cua-driver-uia.exe")
    : [];
  const packagedSeals = await findNamedFiles(outputRoot, "provider-seal.json");
  const packagedCatalogs = await findNamedFiles(outputRoot, "provider-integrity.cat");
  if (
    packagedCapabilities.length !== 1
    || packagedPolicies.length !== 1
    || packagedProviders.length !== 1
    || packagedUiAccessProviders.length !== 0
    || packagedSeals.length !== 1
    || packagedCatalogs.length !== (platform === "win32" ? 1 : 0)
  ) {
    throw new Error(
      `electron_builder_fixture_private_resources_invalid:${packagedCapabilities.length}:${packagedPolicies.length}:${packagedProviders.length}:${packagedUiAccessProviders.length}:${packagedSeals.length}:${packagedCatalogs.length}`,
    );
  }
  const packagedCapability = JSON.parse(await readFile(packagedCapabilities[0], "utf8"));
  const packagedPolicy = JSON.parse(await readFile(packagedPolicies[0], "utf8"));
  if (
    packagedCapability.darwin !== (platform === "darwin")
    || packagedCapability.win32 !== (platform === "win32")
    || packagedPolicy.platform !== platform
  ) {
    throw new Error("electron_builder_fixture_capability_platform_mismatch");
  }

  const traces = await findNamedFiles(outputRoot, "provider-signing-trace.json");
  if (traces.length !== 1) {
    throw new Error(`electron_builder_fixture_trace_count_invalid:${traces.length}`);
  }
  const trace = JSON.parse(await readFile(traces[0], "utf8"));
  const eventNames = trace.events.map((event) => `${event.hook}:${event.event}`);
  for (const required of [
    "afterPack:started",
    "afterPack:provider-pre-sign-digest",
    "afterPack:provider-signed",
    "afterPack:provider-sealed",
    ...(platform === "win32" ? ["afterPack:provider-catalog-signed"] : []),
    "platformSign:outer-path-signed",
    "afterSign:started",
    "afterSign:verified",
  ]) {
    if (!eventNames.includes(required)) {
      throw new Error(`electron_builder_fixture_hook_missing:${required}`);
    }
  }
  const sealEvent = trace.events.find(
    (event) => event.hook === "afterPack" && event.event === "provider-sealed",
  );
  const afterPackComplete = trace.events.find(
    (event) => event.hook === "afterPack" && event.event === "complete",
  );
  const afterSign = trace.events.find(
    (event) => event.hook === "afterSign" && event.event === "verified",
  );
  if (
    !sealEvent
    || !afterPackComplete
    || !afterSign
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
      || event.capabilitiesSha256 !== packageAuthority.hostAuthority.capabilitiesSha256
      || event.runtimeTrustPolicySha256
        !== packageAuthority.hostAuthority.runtimeTrustPolicySha256
    ) {
      throw new Error(
        `electron_builder_fixture_final_digest_mismatch:${String(event.artifactRole)}`,
      );
    }
  }

  const retainedDirectory = join(desktopRoot, "test-results", "cua-driver-signing-feasibility");
  await mkdir(retainedDirectory, { recursive: true });
  const retainedTrace = join(retainedDirectory, `electron-builder-${platform}-trace.json`);
  await writeFile(retainedTrace, `${JSON.stringify(trace, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      kind: "ling-cua-driver-electron-builder-fixture",
      electronBuilderVersion: trace.electronBuilderVersion,
      platform,
      skipped: false,
      providerSha256: sealEvent.providerSha256,
      retainedTrace,
      hooks: eventNames,
      finalArtifactRoles: actualFinalRoles,
    })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function run(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
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
