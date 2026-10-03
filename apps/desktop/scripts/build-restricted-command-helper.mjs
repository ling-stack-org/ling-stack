import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildNativeEvidence } from "../../../native/sandbox/scripts/build.mjs";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--platform" || args[1] !== "darwin"
    || process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("restricted_command_package_platform_invalid");
}
const parent = mkdtempSync(join(tmpdir(), "ling-restricted-package-"));
const build = join(parent, "build"), staged = join(desktopRoot, "dist", ".restricted-command-next");
const destination = join(desktopRoot, "dist", "restricted-command");
try {
  ensureGeneratedDistDirectory();
  const manifest = buildNativeEvidence({ target: "aarch64-apple-darwin", output: build });
  requireBuild(manifest.target === "aarch64-apple-darwin" && manifest.verification.releaseBuild === "passed"
    && manifest.verification.inputCapture === "passed");
  rmGenerated(staged); mkdirSync(staged, { recursive: false, mode: 0o700 });
  cpSync(join(build, "ling-sandbox-runner"), join(staged, "ling-sandbox-runner"), { errorOnExist: true });
  chmodSync(join(staged, "ling-sandbox-runner"), 0o755);
  cpSync(join(build, "licenses"), join(staged, "licenses"), { recursive: true, errorOnExist: true });
  const packagedBinary = join(staged, "ling-sandbox-runner");
  normalizeDarwinCodeSignature(packagedBinary);
  const packagedManifest = {
    ...manifest,
    binary: {
      ...manifest.binary,
      sha256: createHash("sha256").update(readFileSync(packagedBinary)).digest("hex"),
      sizeBytes: lstatSync(packagedBinary).size,
    },
  };
  writeFileSync(join(staged, "manifest.json"), `${JSON.stringify(packagedManifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  requireBuild(packagedManifest.binary.sizeBytes > 0
    && packagedManifest.binary.sizeBytes <= manifest.binary.sizeBytes
    && packagedManifest.binary.sha256 !== manifest.binary.sha256);
  rmGenerated(destination);
  renameSync(staged, destination);
  process.stdout.write(JSON.stringify({ target: manifest.target, helperVersion: manifest.helperVersion,
    binarySha256: manifest.binary.sha256, destination }) + "\n");
} finally {
  rmSync(parent, { recursive: true, force: true });
}
function requireBuild(value) {
  if (!value) throw new Error("restricted_command_package_build_invalid");
}
function ensureGeneratedDistDirectory() {
  const dist = join(desktopRoot, "dist");
  try {
    const stat = lstatSync(dist);
    requireBuild(stat.isDirectory() && !stat.isSymbolicLink());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(dist, { mode: 0o700 });
  }
}
function normalizeDarwinCodeSignature(path) {
  const result = spawnSync("/usr/bin/codesign", ["--remove-signature", path], {
    encoding: "utf8",
    windowsHide: true,
  });
  requireBuild(!result.error && !result.signal && result.status === 0);
}
function rmGenerated(path) {
  if (!path.startsWith(resolve(desktopRoot, "dist") + "/")) throw new Error("restricted_command_package_path_invalid");
  try {
    const stat = lstatSync(path);
    requireBuild(stat.isDirectory() && !stat.isSymbolicLink());
    rmSync(path, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
