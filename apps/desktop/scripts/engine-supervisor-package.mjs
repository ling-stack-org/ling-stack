import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Authenticode changes PE bytes. Bind the packaged manifest after signing, before NSIS. */
export async function sealEngineSupervisorPackage(context) {
  if (context.electronPlatformName !== "win32") return;
  const root = join(context.appOutDir, "resources", "engine-supervisor");
  const file = join(root, "ling-engine-supervisor.exe");
  const manifest = join(root, "build-metadata.json");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error("engine_supervisor_package_invalid");
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  if (metadata.schema !== "ling.engine-supervisor.build.v1" || metadata.version !== "0.1.0"
    || metadata.protocol !== "ling.engine-supervisor.v1" || metadata.platform !== "win32-x64"
    || metadata.executable !== "ling-engine-supervisor.exe" || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    throw new Error("engine_supervisor_package_invalid");
  }
  const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
  await writeFile(manifest, `${JSON.stringify({ ...metadata, unsignedSha256: metadata.unsignedSha256 ?? metadata.sha256, sha256 }, null, 2)}\n`);
}
