import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("locked_control_darwin_probe_requires_apple_silicon");
}

const source = resolve(desktopRoot, "scripts/native/locked-control-probe-window.swift");
const infoPlist = resolve(desktopRoot, "scripts/native/LockedControlProbeWindow-Info.plist");
const appRoot = resolve(desktopRoot, "build/native/darwin-arm64/LingLockedControlProbe.app");
const contentsRoot = resolve(appRoot, "Contents");
const executable = resolve(contentsRoot, "MacOS/LingLockedControlProbe");

mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
mkdirSync(resolve(contentsRoot, "Resources"), { recursive: true, mode: 0o700 });

const build = spawnSync("xcrun", [
  "swiftc",
  "-O",
  "-target", "arm64-apple-macos13.0",
  "-framework", "AppKit",
  source,
  "-o", executable,
], {
  cwd: desktopRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (build.status !== 0) {
  throw new Error(`locked_control_darwin_probe_build_failed:${build.stderr.trim()}`);
}

copyFileSync(infoPlist, resolve(contentsRoot, "Info.plist"));

const validate = spawnSync("plutil", ["-lint", resolve(contentsRoot, "Info.plist")], {
  cwd: desktopRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (validate.status !== 0) {
  throw new Error(`locked_control_darwin_probe_plist_invalid:${validate.stderr.trim()}`);
}

process.stdout.write(`${JSON.stringify({
  built: true,
  platform: "darwin",
  architecture: "arm64",
  appRoot,
  executable,
  bundleId: "com.lingstack.locked-control-probe",
})}\n`);
