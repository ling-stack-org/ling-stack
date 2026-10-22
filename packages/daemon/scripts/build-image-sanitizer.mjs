import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { verifyImageCodecDependencies } from "./image-codec-dependencies.mjs";

if (!["darwin", "linux", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
  throw new Error("image_sanitizer_build_platform_unsupported");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const native = join(root, "native/image-sanitizer");
const manifest = parse(await readFile(join(native, "Cargo.toml"), "utf8"));
const minimumRust = manifest.package["rust-version"];
const toolchainHelp = `Rust ${minimumRust}+ and Cargo are required to build the image sanitizer. Install or update Rust with rustup (https://rustup.rs); CI uses Rust 1.97.1.`;
const rustc = spawnSync("rustc", ["-vV"], { cwd: native, shell: false, encoding: "utf8" });
if (rustc.status !== 0) throw new Error(`${toolchainHelp} ${rustc.error?.message ?? rustc.stderr}`);
const release = /^release: (\d+\.\d+\.\d+)/mu.exec(rustc.stdout)?.[1];
const required = minimumRust.split(".").map(Number);
const actual = release?.split(".").map(Number);
if (!actual || actual[0] < required[0] || (actual[0] === required[0] && actual[1] < required[1])) {
  throw new Error(`${toolchainHelp} Unsupported compiler: found ${release ?? "unknown"}.`);
}
const target = /^host: (\S+)$/mu.exec(rustc.stdout ?? "")?.[1];
if (!target || !target.startsWith(process.arch === "arm64" ? "aarch64-" : "x86_64-")
  || !(process.platform === "darwin" ? target.endsWith("apple-darwin")
    : process.platform === "win32" ? target.includes("windows-") : target.includes("linux-"))) {
  throw new Error("image_sanitizer_build_host_mismatch");
}
const cargo = spawnSync("cargo", ["--version"], { cwd: native, shell: false, encoding: "utf8" });
if (cargo.status !== 0) throw new Error(`${toolchainHelp} ${cargo.error?.message ?? cargo.stderr}`);
const graph = spawnSync("cargo", ["metadata", "--locked", "--format-version=1", "--filter-platform", target, "--manifest-path", join(native, "Cargo.toml")],
  { cwd: native, shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (graph.status !== 0) throw new Error("image_sanitizer_dependency_graph_failed");
// Cargo metadata retains weak optional dependency edges; tree reports the compiled normal/build graph.
const tree = spawnSync("cargo", ["tree", "--locked", "--target", target, "--edges", "normal,build", "--prefix", "none", "--format", "{p}", "--manifest-path", join(native, "Cargo.toml")],
  { cwd: native, shell: false, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (tree.status !== 0) throw new Error("image_sanitizer_dependency_graph_failed");
const activePackages = tree.stdout.trim().split("\n").map(line => {
  const match = /^([a-zA-Z0-9_-]+) v(\S+)/u.exec(line);
  if (!match) throw new Error("image_sanitizer_dependency_graph_invalid");
  return { name: match[1], version: match[2] };
});
const notices = await readFile(join(native, "THIRD_PARTY_LICENSES.txt"));
const dependencies = await verifyImageCodecDependencies({ metadata: JSON.parse(graph.stdout), activePackages,
  inventory: JSON.parse(await readFile(join(native, "dependency-inventory.json"), "utf8")),
  lock: parse(await readFile(join(native, "Cargo.lock"), "utf8")), notices: notices.toString("utf8"), nativeRoot: native });
const result = spawnSync("cargo", ["build", "--release", "--locked", "--target", target, "--target-dir", join(native, "target"), "--manifest-path", join(native, "Cargo.toml")],
  { cwd: native, shell: false, stdio: "inherit" });
if (result.status !== 0) throw new Error("image_sanitizer_build_failed");
const executable = process.platform === "win32" ? "ling-image-sanitizer.exe" : "ling-image-sanitizer";
const output = join(root, "dist/native/image-sanitizer");
await mkdir(output, { recursive: true });
await copyFile(join(native, "target", target, "release", executable), join(output, executable));
if (process.platform !== "win32") await chmod(join(output, executable), 0o755);
const sourceHash = createHash("sha256");
async function sources(directory, prefix = "") {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + item.name;
    if (item.isDirectory()) await sources(join(directory, item.name), relative + "/");
    else if (item.isFile()) sourceHash.update(relative + "\0").update(await readFile(join(directory, item.name)));
    else throw new Error("image_sanitizer_source_invalid");
  }
}
for (const name of ["Cargo.toml", "Cargo.lock", "dependency-inventory.json", "upstream-provenance.json"]) sourceHash.update(name + "\0").update(await readFile(join(native, name)));
await sources(join(native, "src"), "src/");
await sources(join(native, "vendor"), "vendor/");
await writeFile(join(output, "THIRD_PARTY_LICENSES.txt"), notices);
const metadata = { schema: "ling.image-sanitizer.build.v1", protocol: "ling.image-sanitizer.v1", version: "0.1.0",
  platform: `${process.platform}-${process.arch}`, target, executable,
  digestStage: "before-desktop-signing",
  dependencies,
  sha256: createHash("sha256").update(await readFile(join(output, executable))).digest("hex"),
  sourceSha256: sourceHash.digest("hex"), noticesSha256: createHash("sha256").update(notices).digest("hex") };
await writeFile(join(output, "build-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
process.stdout.write(JSON.stringify({ built: true, output, ...metadata }) + "\n");
