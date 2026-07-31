#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupCuaDriverPublishedStage,
  cleanupCuaDriverStagingResidue,
  stageCuaDriverProvider,
} from "./cua-driver-package-staging.mjs";
import {
  packageAuthorityInputFromEnvironment,
  writeCuaDriverPackageAuthorityFiles,
} from "./cua-driver-package-runtime-policy.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(APP_ROOT, "scripts/cua-driver-electron-builder.config.mjs");

export async function prepareCuaDriverElectronPackage(input, dependencies = {}) {
  const platform = normalizePlatform(input?.platform);
  if (typeof input?.sourceRoot !== "string" || !isAbsolute(input.sourceRoot)) {
    throw new Error("cua_driver_source_build_root_invalid");
  }
  const createTemporaryRoot = dependencies.mkdtemp ?? mkdtemp;
  const stageProvider = dependencies.stageProvider ?? stageCuaDriverProvider;
  const writeAuthority = dependencies.writeAuthority ?? writeCuaDriverPackageAuthorityFiles;
  const cleanupPublishedStage = dependencies.cleanupPublishedStage
    ?? cleanupCuaDriverPublishedStage;
  const cleanupResidue = dependencies.cleanupResidue ?? cleanupCuaDriverStagingResidue;
  const removeEvidence = dependencies.rm ?? rm;
  const removeContainer = dependencies.rmdir ?? rmdir;
  const containerRoot = await createTemporaryRoot(join(tmpdir(), "ling-cua-driver-electron-package-"));
  const resourcesRoot = join(containerRoot, "resources");
  let staged;
  try {
    await mkdir(containerRoot, { recursive: true });
    staged = await stageProvider({
      sourceRoot: resolve(input.sourceRoot),
      outputRoot: resourcesRoot,
      platform,
    });
    const packageResourcesRoot = join(resourcesRoot, "providers", "cua-driver");
    const authorityInput = input.authorityInput
      ?? packageAuthorityInputFromEnvironment(platform, input.environment);
    const authority = await writeAuthority({
      outputRoot: packageResourcesRoot,
      ...authorityInput,
      platform,
    });
    let stageCleaned = false;
    let containerCleaned = false;
    let cleanupPromise;
    return Object.freeze({
      authority,
      containerRoot,
      evidenceRoot: join(containerRoot, "signing-evidence"),
      packageResourcesRoot,
      platform,
      staged,
      expectedPreSignPayloadSha256: staged.providerSha256,
      async cleanup() {
        if (stageCleaned && containerCleaned) return;
        cleanupPromise ??= cleanupPreparedPackageStage({
          cleanupPublishedStage,
          containerRoot,
          evidenceRoot: join(containerRoot, "signing-evidence"),
          get containerCleaned() { return containerCleaned; },
          get stageCleaned() { return stageCleaned; },
          markContainerCleaned() { containerCleaned = true; },
          markStageCleaned() { stageCleaned = true; },
          removeContainer,
          removeEvidence,
          resourcesRoot,
          staged,
        })
          .catch((error) => {
            cleanupPromise = undefined;
            throw error;
          });
        await cleanupPromise;
      },
    });
  } catch (error) {
    let cleanupError;
    try {
      if (staged) {
        await cleanupPublishedStage({
          outputRoot: resourcesRoot,
          expectedStageIdentity: staged.stageIdentity,
        });
      } else if (hasCleanupReceipt(error)) {
        await cleanupResidue({
          outputRoot: resourcesRoot,
          residuePath: error.cleanup.residuePath,
          expectedResidueIdentity: error.cleanup.residueIdentity,
        });
      }
      await removeContainer(containerRoot);
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `cua_driver_package_preparation_cleanup_failed:${containerRoot}`,
      );
    }
    throw error;
  }
}

async function cleanupPreparedPackageStage(input) {
  if (!input.stageCleaned) {
    if (typeof input.staged?.stageIdentity !== "string") {
      throw new Error("cua_driver_package_stage_cleanup_receipt_missing");
    }
    await input.cleanupPublishedStage({
      outputRoot: input.resourcesRoot,
      expectedStageIdentity: input.staged.stageIdentity,
    });
    input.markStageCleaned();
  }
  if (!input.containerCleaned) {
    await input.removeEvidence(input.evidenceRoot, { recursive: true, force: true });
    await input.removeContainer(input.containerRoot);
    input.markContainerCleaned();
  }
}

function hasCleanupReceipt(error) {
  return typeof error?.cleanup?.residuePath === "string"
    && typeof error?.cleanup?.residueIdentity === "string";
}

export async function runCuaDriverElectronPackageCli(
  values = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
) {
  const { platform, builderArgs } = parseArgs(values);
  if (builderArgs.some(isBuilderConfigOverride)) {
    throw new Error("cua_driver_electron_builder_config_override_forbidden");
  }
  assertGovernedBuilderArgs(platform, builderArgs);
  const packageProvider = environment.LING_CUA_DRIVER_PACKAGE_PROVIDER === "1";
  const sourceRoot = environment.LING_CUA_DRIVER_SOURCE_BUILD_ROOT;
  if (packageProvider !== Boolean(sourceRoot)) {
    throw new Error(
      packageProvider
        ? "cua_driver_source_build_root_missing"
        : "cua_driver_source_build_root_without_package_authority",
    );
  }
  if (packageProvider && environment.ELECTRON_BUILDER_7ZIP_PATH) {
    throw new Error("cua_driver_electron_builder_7zip_override_forbidden");
  }
  const prepared = packageProvider
    ? await prepareCuaDriverElectronPackage({ platform, sourceRoot, environment }, dependencies)
    : undefined;
  let builderError;
  try {
    const childEnvironment = {
      ...environment,
      LING_CUA_DRIVER_PACKAGE_PROVIDER: packageProvider ? "1" : "0",
      ...(prepared
        ? {
            LING_CUA_PACKAGE_RESOURCES_ROOT: prepared.packageResourcesRoot,
            LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(
              prepared.authority.hostAuthority,
            ),
            LING_CUA_EXPECTED_PRE_SIGN_PAYLOAD_SHA256: prepared.expectedPreSignPayloadSha256,
            // A signing state seals one concrete package output and must never be
            // reused by a later Builder invocation. Keep it in this invocation's
            // verified temporary container so repeat local/CI packages start clean
            // without weakening the hooks' double-sign rejection.
            LING_CUA_SIGNING_EVIDENCE_DIR: prepared.evidenceRoot,
          }
        : {}),
    };
    const runBuilder = dependencies.runBuilder ?? spawnElectronBuilder;
    const exitCode = await runBuilder({
      appRoot: APP_ROOT,
      args: ["--config", CONFIG_PATH, ...builderArgs],
      environment: childEnvironment,
    });
    if (exitCode !== 0) {
      throw new Error(`electron_builder_failed:${exitCode}`);
    }
  } catch (error) {
    builderError = error;
  }
  let cleanupError;
  try {
    await prepared?.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (builderError && cleanupError) {
    throw new AggregateError(
      [builderError, cleanupError],
      "electron_builder_and_package_cleanup_failed",
    );
  }
  if (builderError) throw builderError;
  if (cleanupError) throw cleanupError;
}

async function spawnElectronBuilder({ appRoot, args, environment }) {
  const executable = process.platform === "win32" ? "corepack.cmd" : "corepack";
  return new Promise((settle, reject) => {
    const child = spawn(executable, ["pnpm", "exec", "electron-builder", ...args], {
      cwd: appRoot,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`electron_builder_signal:${signal}`));
        return;
      }
      settle(code ?? 1);
    });
  });
}

function parseArgs(values) {
  if (values[0] !== "--platform" || !values[1]) {
    throw new Error("usage: --platform <darwin|win32-x64> -- <electron-builder args>");
  }
  const separator = values.indexOf("--", 2);
  if (separator !== 2 || values.length === 3) {
    throw new Error("usage: --platform <darwin|win32-x64> -- <electron-builder args>");
  }
  return {
    platform: normalizePlatform(values[1]),
    builderArgs: values.slice(separator + 1),
  };
}

function normalizePlatform(value) {
  if (value !== "darwin" && value !== "win32-x64") {
    throw new Error(`cua_driver_package_platform_invalid:${String(value)}`);
  }
  return value;
}

function isBuilderConfigOverride(value) {
  return value === "--config"
    || value === "-c"
    || value.startsWith("--config=")
    || value.startsWith("--config.")
    || value.startsWith("-c=")
    || value.startsWith("-c.");
}

function assertGovernedBuilderArgs(platform, values) {
  const platformFlag = platform === "darwin" ? "--mac" : "--win";
  const allowedTargets = new Set(platform === "darwin" ? ["dir", "dmg", "zip"] : ["dir", "nsis"]);
  const allowedArchitectures = new Set(platform === "darwin" ? ["--arm64"] : ["--x64"]);
  let platformCount = 0;
  let targetCount = 0;
  let architectureCount = 0;
  const seen = new Set();
  for (const value of values) {
    if (value === platformFlag) {
      platformCount += 1;
    } else if (allowedTargets.has(value)) {
      targetCount += 1;
    } else if (allowedArchitectures.has(value)) {
      architectureCount += 1;
    } else {
      throw new Error(`cua_driver_electron_builder_argument_forbidden:${String(value)}`);
    }
    if (seen.has(value)) {
      throw new Error(`cua_driver_electron_builder_argument_duplicate:${String(value)}`);
    }
    seen.add(value);
  }
  if (platformCount !== 1 || targetCount === 0 || architectureCount === 0) {
    throw new Error("cua_driver_electron_builder_arguments_incomplete");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCuaDriverElectronPackageCli().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
