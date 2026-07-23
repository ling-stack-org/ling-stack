import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { runText } from "./cua-driver-source-build-lib.mjs";

export async function verifyToolchain(platform, lock) {
  const rustc = await runText("rustc", [`+${lock.toolchain.rustcVersion}`, "--version"]);
  const cargo = await runText("cargo", [`+${lock.toolchain.rustcVersion}`, "--version"]);
  assert(
    rustc.startsWith(`rustc ${lock.toolchain.rustcVersion} `),
    `rustc version mismatch: ${rustc}`,
  );
  assert(
    cargo.startsWith(`cargo ${lock.toolchain.cargoVersion} `),
    `cargo version mismatch: ${cargo}`,
  );

  if (platform === "darwin") {
    assert(process.platform === "darwin", "darwin provider must be built on macOS");
    const pin = lock.toolchain.darwin;
    const developerDir = pin.developerDir;
    const env = { ...process.env, DEVELOPER_DIR: developerDir };
    const xcode = await runText("xcodebuild", ["-version"], { env });
    assert(
      xcode === `Xcode ${pin.xcodeVersion}\nBuild version ${pin.xcodeBuildVersion}`,
      `Xcode version mismatch: ${xcode}`,
    );
    const sdk = await runText("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { env });
    assert(sdk === pin.macOSSDKVersion, `macOS SDK version mismatch: ${sdk}`);
    const sdkPath = await runText("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { env });
    const clangPath = await runText("xcrun", ["--sdk", "macosx", "--find", "clang"], { env });
    const lipoPath = await runText("xcrun", ["--find", "lipo"], { env });
    const codesignPath = pin.postLinkIdentityNormalization.codesignPath;
    assert((await stat(codesignPath)).isFile(), `codesign tool not found: ${codesignPath}`);
    return {
      env: { DEVELOPER_DIR: developerDir },
      evidence: {
        xcodeVersion: pin.xcodeVersion,
        xcodeBuildVersion: pin.xcodeBuildVersion,
        macOSSDKVersion: sdk,
        developerDir,
        sdkPath,
        clangPath,
        codesignPath,
        lipoPath,
      },
    };
  }

  assert(platform === "win32-x64", `unsupported platform: ${platform}`);
  assert(process.platform === "win32", "win32-x64 provider must be built on Windows");
  const pin = lock.toolchain.win32X64;
  const environment = { ...process.env };
  const programFilesX86 = getEnvironmentValue(environment, "ProgramFiles(x86)");
  assert(programFilesX86, "ProgramFiles(x86) is not set");
  const { installationPath } = resolveConfiguredVisualStudioEnvironment(
    environment,
    pin.visualStudioVersion,
  );
  assert(
    (await stat(installationPath)).isDirectory(),
    `Visual Studio installation was not found: ${installationPath}`,
  );
  const toolsetFile = join(
    installationPath,
    "VC",
    "Auxiliary",
    "Build",
    "Microsoft.VCToolsVersion.default.txt",
  );
  const toolset = (await readFile(toolsetFile, "utf8")).trim();
  assert(toolset === pin.msvcToolsetVersion, `MSVC toolset version mismatch: ${toolset}`);
  const sdkLib = join(programFilesX86, "Windows Kits", "10", "Lib", pin.windowsSdkVersion);
  assert((await stat(sdkLib)).isDirectory(), `Windows SDK not found: ${sdkLib}`);
  const vsDevCmd = join(installationPath, "Common7", "Tools", "VsDevCmd.bat");
  assert((await stat(vsDevCmd)).isFile(), `Visual Studio developer shell not found: ${vsDevCmd}`);
  const toolsInstallDirectory = getEnvironmentValue(environment, "VCToolsInstallDir");
  const selectedToolsetVersion = getEnvironmentValue(environment, "VCToolsVersion")
    ?.replace(/[\\/]$/u, "");
  assert(
    selectedToolsetVersion === pin.msvcToolsetVersion,
    `developer shell selected the wrong MSVC toolset version: ${selectedToolsetVersion ?? "missing"}`,
  );
  const selectedSdkVersion = getEnvironmentValue(environment, "WindowsSDKVersion")
    ?.replace(/[\\/]$/u, "");
  assert(
    selectedSdkVersion === pin.windowsSdkVersion,
    `developer shell selected the wrong Windows SDK: ${selectedSdkVersion ?? "missing"}`,
  );
  const clPath = firstLine(await runText("where.exe", ["cl.exe"], { env: environment }));
  const linkPath = firstLine(await runText("where.exe", ["link.exe"], { env: environment }));
  const rcPath = firstLine(await runText("where.exe", ["rc.exe"], { env: environment }));
  const expectedToolsetRoot = join(
    installationPath,
    "VC",
    "Tools",
    "MSVC",
    pin.msvcToolsetVersion,
  );
  assertPathInside(toolsInstallDirectory, expectedToolsetRoot, "VCToolsInstallDir");
  const expectedSdkBin = join(
    programFilesX86,
    "Windows Kits",
    "10",
    "bin",
    pin.windowsSdkVersion,
    "x64",
  );
  assertPathInside(clPath, expectedToolsetRoot, "cl.exe");
  assertPathInside(linkPath, expectedToolsetRoot, "link.exe");
  assertPathInside(rcPath, expectedSdkBin, "rc.exe");
  return {
    env: environment,
    evidence: {
      visualStudioVersion: pin.visualStudioVersion,
      msvcToolsetVersion: pin.msvcToolsetVersion,
      windowsSdkVersion: pin.windowsSdkVersion,
      installationPath,
      clPath,
      linkPath,
      rcPath,
    },
  };
}

export function resolveConfiguredVisualStudioEnvironment(environment, expectedVersion) {
  assert(
    environment && typeof environment === "object" && !Array.isArray(environment),
    "Visual Studio environment is invalid",
  );
  const installationPath = getEnvironmentValue(environment, "VSINSTALLDIR")
    ?.replace(/[\\/]+$/u, "");
  assert(
    /^[A-Za-z]:[\\/]/u.test(installationPath ?? ""),
    `VSINSTALLDIR is missing or not absolute: ${installationPath ?? "missing"}`,
  );
  const commandVersion = getEnvironmentValue(environment, "VSCMD_VER")?.trim();
  assert(
    commandVersion === expectedVersion || commandVersion?.startsWith(`${expectedVersion}.`),
    `Visual Studio command version mismatch: ${commandVersion ?? "missing"}`,
  );
  return { commandVersion, installationPath };
}

export function parseWindowsEnvironment(value) {
  const environment = {};
  for (const line of String(value).split(/\r?\n/u)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    environment[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }
  return environment;
}

export function mergeEnvironment(base, overlay, caseInsensitive = process.platform === "win32") {
  const environment = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (caseInsensitive) {
      for (const existingKey of Object.keys(environment)) {
        if (existingKey !== key && existingKey.toLowerCase() === key.toLowerCase()) {
          delete environment[existingKey];
        }
      }
    }
    environment[key] = value;
  }
  return environment;
}

function getEnvironmentValue(environment, expectedKey) {
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === expectedKey.toLowerCase(),
  );
  return key ? environment[key] : undefined;
}

function normalizeWindowsPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

function assertPathInside(path, root, label) {
  const pathValue = normalizeWindowsPath(path);
  const rootValue = normalizeWindowsPath(root);
  assert(
    pathValue === rootValue || pathValue.startsWith(`${rootValue}/`),
    `${label} resolved outside the locked toolchain: ${path}`,
  );
}

function firstLine(value) {
  return String(value).split(/\r?\n/u).find(Boolean) ?? "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
