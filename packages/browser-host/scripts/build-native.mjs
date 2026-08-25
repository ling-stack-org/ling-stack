import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.platform;
if ((platform !== "darwin" || process.arch !== "arm64") && (platform !== "win32" || process.arch !== "x64")) {
  throw new Error("browser_host_build_platform_unsupported");
}
const executable = platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host";
const build = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", resolve(packageRoot, "native/Cargo.toml")], {
  cwd: packageRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (build.status !== 0) throw new Error(`browser_host_build_failed:${build.stderr.trim()}`);
const source = resolve(packageRoot, "native/target/release", executable);
const output = resolve(packageRoot, "dist/native", executable);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await copyFile(source, output);
let signing = "unsigned";
if (platform === "darwin") {
  await chmod(output, 0o755);
  const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", output], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (signed.status !== 0) throw new Error(`browser_host_codesign_failed:${signed.stderr.trim()}`);
  const verified = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", output], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (verified.status !== 0) throw new Error(`browser_host_codesign_verify_failed:${verified.stderr.trim()}`);
  const displayed = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", output], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const details = `${displayed.stdout}\n${displayed.stderr}`;
  if (displayed.status !== 0 || !/\badhoc\b/u.test(details) || /linker-signed/u.test(details)) {
    throw new Error("browser_host_codesign_identity_invalid");
  }
  signing = "adhoc";
}
const bytes = await readFile(output);
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" });
const metadata = {
  schema: "ling.browser-host.build.v1",
  version: "0.1.1",
  protocol: "ling.chrome.native.v1",
  platform: platform === "darwin" ? "darwin-arm64" : "win32-x64",
  executable,
  signing,
  hostSha256: createHash("sha256").update(bytes).digest("hex"),
  sourceCommit: git.status === 0 ? git.stdout.trim() : "unknown",
};
await writeFile(resolve(packageRoot, "dist/native/build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ built: true, output, ...metadata })}\n`);
