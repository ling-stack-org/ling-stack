import { cp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.find((value) => value.startsWith("--platform="))?.slice("--platform=".length);
const platform = requested ?? (process.platform === "darwin" ? "darwin-arm64" : process.platform === "win32" ? "win32-x64" : "unsupported");
const outputRoot = resolve(desktopRoot, "dist", "office-driver");

if (platform === "unsupported") {
  process.stdout.write("Office driver is not built on this platform.\n");
  process.exit(0);
}

if (platform === "darwin-arm64") {
  const sourceRoot = resolve(desktopRoot, "scripts", "native", "office-driver", "macos");
  const bundle = resolve(outputRoot, "darwin-arm64", "OfficeDriver.app");
  const executable = resolve(bundle, "Contents", "MacOS", "ling-office-driver");
  await rm(bundle, { recursive: true, force: true });
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(resolve(bundle, "Contents", "Resources"), { recursive: true });
  await run("xcrun", [
    "swiftc", "-O", "-parse-as-library",
    resolve(sourceRoot, "main.swift"),
    "-framework", "AppKit",
    "-framework", "CoreServices",
    "-o", executable,
  ]);
  await cp(resolve(sourceRoot, "Info.plist"), resolve(bundle, "Contents", "Info.plist"));
  await run("codesign", [
    "--force", "--sign", "-", "--options", "runtime",
    "--entitlements", resolve(sourceRoot, "entitlements.plist"),
    bundle,
  ]);
  process.stdout.write(`Built ${executable}\n`);
  process.exit(0);
}

if (platform === "win32-x64") {
  const project = resolve(desktopRoot, "scripts", "native", "office-driver", "windows", "Ling.Office.Driver.csproj");
  const output = resolve(outputRoot, "win32-x64");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await run("dotnet", [
    "publish", project,
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--self-contained", "true",
    "/p:PublishSingleFile=true",
    "/p:IncludeNativeLibrariesForSelfExtract=true",
    "--output", output,
  ]);
  process.stdout.write(`Built ${resolve(output, "ling-office-driver.exe")}\n`);
  process.exit(0);
}

throw new Error(`Unsupported Office driver platform: ${platform}`);

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: desktopRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)));
  });
}
