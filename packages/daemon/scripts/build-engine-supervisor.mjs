import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("engine_supervisor_build_platform_unsupported");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const native = resolve(root, "native/engine-supervisor");
const result = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", resolve(native, "Cargo.toml")],
  { cwd: root, stdio: "inherit", shell: false });
if (result.status !== 0) throw new Error("engine_supervisor_build_failed");
const executable = "ling-engine-supervisor.exe";
const output = resolve(root, "dist/native/engine-supervisor");
await mkdir(output, { recursive: true });
await copyFile(resolve(native, "target/release", executable), resolve(output, executable));
const bytes = await readFile(resolve(output, executable));
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", shell: false });
const metadata = { schema: "ling.engine-supervisor.build.v1", version: "0.1.0", protocol: "ling.engine-supervisor.v1",
  platform: "win32-x64", executable, sha256: createHash("sha256").update(bytes).digest("hex"),
  sourceCommit: git.status === 0 ? git.stdout.trim() : "unknown" };
await writeFile(resolve(output, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ built: true, output, ...metadata })}\n`);
