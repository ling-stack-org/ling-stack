import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedPlatform = process.argv.find((value) => value.startsWith("--platform="))
  ?.slice("--platform=".length) ?? process.platform;

if (requestedPlatform !== "darwin") {
  throw new Error("locked_control_native_helper_cross_compile_not_supported");
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("locked_control_native_helper_requires_apple_silicon");
}

const source = resolve(desktopRoot, "scripts/native/locked-control-darwin.swift");
const output = resolve(desktopRoot, "build/native/darwin-arm64/ling-locked-control-helper");
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });

const build = spawnSync("xcrun", [
  "swiftc",
  "-O",
  "-target", "arm64-apple-macos13.0",
  source,
  "-o", output,
], {
  cwd: desktopRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (build.status !== 0) {
  throw new Error(`locked_control_native_helper_build_failed:${build.stderr.trim()}`);
}

const probe = spawnSync(output, [], {
  input: `${JSON.stringify({ command: "session", platform: "darwin" })}\n`,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"],
});
if (probe.status !== 0) {
  throw new Error("locked_control_native_helper_session_probe_failed");
}
const value = JSON.parse(probe.stdout);
if (value.platform !== "darwin"
  || !/^[a-f0-9]{64}$/u.test(value.sessionBindingDigest)
  || typeof value.sessionActive !== "boolean"
  || typeof value.sessionLocked !== "boolean") {
  throw new Error("locked_control_native_helper_session_probe_invalid");
}

process.stdout.write(`${JSON.stringify({
  built: true,
  platform: "darwin",
  architecture: "arm64",
  output,
  contentFreeSessionProbe: true,
})}\n`);
