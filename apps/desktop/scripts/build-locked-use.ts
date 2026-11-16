import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, copyFileSync, writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This standalone build precedes Desktop's compiled JavaScript output.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../native/locked-use");
const identity = process.argv.find((arg) => arg.startsWith("--identity="))?.slice(11) ?? "-";
if (process.platform !== "darwin") throw new Error("locked_use_build_requires_macos");
if (process.argv.slice(2).some((arg) => !arg.startsWith("--identity="))) throw new Error("locked_use_build_argument_invalid");

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.status !== 0) throw new Error(`locked_use_build_failed:${command}:${result.stderr ?? result.status}`);
  return result.stdout ?? "";
}

run("swift", ["build", "--package-path", root, "-c", "release", "--jobs", "4"]);
const bin = run("swift", ["build", "--package-path", root, "-c", "release", "--show-bin-path"], true).trim();
run(resolve(bin, "LingLockedUsePolicyChecks"), []);
mkdirSync(resolve(root, "dist"), { recursive: true });
// Fresh inodes avoid reusing the kernel's cached signature for a replaced image.
const output = mkdtempSync(resolve(root, "dist/components-"));
function sign(path: string, identifier?: string): void {
  run("/usr/bin/codesign", ["--force", "--options", "runtime,library", "--timestamp=none",
    ...(identifier ? ["--identifier", identifier] : []), "--sign", identity, path]);
  run("/usr/bin/codesign", ["--verify", "--strict", path]);
}
for (const [name, identifier] of [["LingLockBroker", "broker"], ["LingLockInstaller", "installer"]]) {
  const path = resolve(output, name!);
  copyFileSync(resolve(bin, name!), path);
  sign(path, `com.lingstack.locked-use.${identifier}`);
}
const broker = resolve(output, "LingLockBroker");
const metadata = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", broker], { encoding: "utf8" });
if (metadata.status !== 0) throw new Error("locked_use_signature_unreadable");
const team = metadata.stderr.match(/^TeamIdentifier=([A-Z0-9]{10})$/mu)?.[1] ?? "0000000000";
if (identity !== "-" && team === "0000000000") throw new Error("locked_use_signing_team_missing");

function bundle(name: string, executable: string, identifier: string, kind = "APPL"): string {
  const path = resolve(output, name);
  mkdirSync(resolve(path, "Contents/MacOS"), { recursive: true });
  const info = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleName</key><string>${name.replace(/\.app$/u, "")}</string>
<key>CFBundlePackageType</key><string>${kind}</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSUIElement</key><true/>
<key>NSInputMonitoringUsageDescription</key><string>Detect local keyboard and pointer takeover during protected Computer Use.</string>
</dict></plist>\n`;
  writeFileSync(resolve(path, "Contents/Info.plist"), info);
  return path;
}
const guardian = bundle("Ling Guardian.app", "LingGuardian", "com.lingstack.locked-use.guardian.dev");
copyFileSync(resolve(bin, "LingGuardian"), resolve(guardian, "Contents/MacOS/LingGuardian"));
sign(guardian);
const client = bundle("Client.app", "LingLockedUseClient", "com.lingstack.locked-use.client");
copyFileSync(resolve(bin, "LingLockedUseClient"), resolve(client, "Contents/MacOS/LingLockedUseClient"));
sign(client);
const plugin = bundle("LingLockAuth.bundle", "LingLockAuth", "com.lingstack.locked-use.authorization", "BNDL");
const objects = resolve(output, "plugin-objects");
mkdirSync(objects);
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
const include = resolve(root, "Sources/LockedUseNative/include");
run("xcrun", ["swiftc", "-parse-as-library", "-emit-object", "-target", target,
  "-module-name", "LingTaskVerifier", resolve(root, "AuthorizationPlugin/TaskVerifier.swift"), "-o", resolve(objects, "verifier.o")]);
run("xcrun", ["clang", "-target", target, "-fobjc-arc", "-std=gnu11", "-Wall", "-Wextra", "-Werror", "-fvisibility=hidden",
  `-DLING_SIGNING_TEAM="${team}"`, "-I", include, "-c", resolve(root, "AuthorizationPlugin/RemotePlugin.m"), "-o", resolve(objects, "plugin.o")]);
run("xcrun", ["clang", "-target", target, "-std=gnu11", "-Wall", "-Wextra", "-Werror", "-I", include,
  "-c", resolve(root, "Sources/LockedUseNative/PeerIdentity.c"), "-o", resolve(objects, "peer.o")]);
const pluginBinary = resolve(plugin, "Contents/MacOS/LingLockAuth");
run("xcrun", ["swiftc", "-emit-library", "-Xlinker", "-bundle", "-target", target, "-framework", "Security", "-framework", "Foundation", "-lbsm",
  resolve(objects, "plugin.o"), resolve(objects, "peer.o"), resolve(objects, "verifier.o"), "-o", pluginBinary]);
sign(plugin);
const abi = resolve(output, "plugin-abi-tests");
run("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-framework", "Security",
  resolve(root, "AuthorizationPlugin/RemotePluginTests.c"), "-o", abi]);
run(abi, [pluginBinary]);
run("xcrun", ["swiftc", "-parse-as-library", "-emit-object", "-target", target,
  "-module-name", "LingTaskVerifierDiagnostics", resolve(root, "AuthorizationPlugin/TaskVerifierDiagnostics.swift"), "-o", resolve(objects, "diagnostics.o")]);
run("xcrun", ["clang", "-target", target, "-std=c11", "-Wall", "-Wextra", "-Werror",
  `-DLING_SIGNING_TEAM="${team}"`, "-c", resolve(root, "AuthorizationPlugin/TaskVerifierTests.c"), "-o", resolve(objects, "task-tests.o")]);
const taskTests = resolve(output, "task-verifier-tests");
run("xcrun", ["swiftc", "-target", target, "-framework", "Security", "-framework", "Foundation",
  resolve(objects, "task-tests.o"), resolve(objects, "verifier.o"), resolve(objects, "diagnostics.o"), "-o", taskTests]);
sign(taskTests, "com.lingstack.locked-use.broker");
const developerID = /^Authority=Developer ID Application:/mu.test(metadata.stderr);
run(taskTests, [developerID ? "match" : "deny"]);
cpSync(resolve(root, "LICENSE"), resolve(output, "LICENSE"));
const manifest = {
  schemaVersion: 1, platform: "darwin", architecture: process.arch, team,
  signing: identity === "-" ? "adhoc" : "local_identity",
  productCapability: "disabled_by_build", nativeAcceptance: "not_run",
  checks: { policy: "passed", authorizationPluginABI: "passed", kernelTaskVerifier: developerID ? "identity_passed" : "denial_passed", xctest: "separate" },
  upstreamCommit: "e25be21caa0ea489316f6be6635d2a4766c4cd0b",
  artifacts: Object.fromEntries(["LingLockBroker", "LingLockInstaller", "Ling Guardian.app/Contents/MacOS/LingGuardian",
    "Client.app/Contents/MacOS/LingLockedUseClient", "LingLockAuth.bundle/Contents/MacOS/LingLockAuth"]
    .map((name) => [name, createHash("sha256").update(readFileSync(resolve(output, name))).digest("hex")])),
};
writeFileSync(resolve(output, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(resolve(root, "dist/latest.json"), `${JSON.stringify({ output })}\n`);
process.stdout.write(`${JSON.stringify({ built: true, output, productCapability: manifest.productCapability })}\n`);
