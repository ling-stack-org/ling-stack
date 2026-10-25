import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Build-host tooling only: the Windows builder's standalone 7za lacks NSIS.
// Source: https://github.com/ip7z/7zip/releases/tag/26.05 and its asset digest.
const archive = Object.freeze({ name: "7z2605-x64.exe", sizeBytes: 1663506,
  sha256: "fd99e86f57d8f429ef5ed045bf98315af962e2309b0f1ba87a147a44c71647d0" });
const files = Object.freeze({
  "7z.exe": "94205cfc054dd3bbeb978905bc619a65b3f04e9e73bb2717841110b6f46d962e",
  "7z.dll": "78bf6b668d75801e3aa180b4ccb16e6d8395fba80dec8a065055bb6f8dfabb82",
});
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Prepare a fixed, checked full extractor without installing it on the host. */
export async function prepareNsisExtractor() {
  if (process.env.ELECTRON_BUILDER_7ZIP_PATH) throw new Error("final_artifact_7zip_override_forbidden");
  const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  if (require("electron-builder/package.json").version !== "26.15.3"
    || builderRequire("app-builder-lib/package.json").version !== "26.15.3") throw new Error("final_artifact_builder_version_mismatch");
  const bootstrap = await builderRequire("app-builder-lib/out/toolsets/7zip.js").getPath7za();
  if (process.platform !== "win32") return { path: bootstrap, cleanup: async () => {} };
  if (process.arch !== "x64") throw new Error("Unsupported native NSIS verifier architecture");
  const root = await mkdtemp(join(tmpdir(), "ling-nsis-extractor-"));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const response = await fetch(`https://github.com/ip7z/7zip/releases/download/26.05/${archive.name}`,
      { signal: AbortSignal.timeout(90_000) });
    if (!response.ok || !response.body) throw new Error(`NSIS extractor download failed: ${response.status}`);
    const chunks = []; let sizeBytes = 0;
    for await (const chunk of response.body) {
      sizeBytes += chunk.length;
      if (sizeBytes > archive.sizeBytes) throw new Error("NSIS extractor download exceeds its pinned size");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== archive.sizeBytes || sha256(bytes) !== archive.sha256) throw new Error("NSIS extractor download digest mismatch");
    const installer = join(root, archive.name), extracted = join(root, "tool");
    await writeFile(installer, bytes, { flag: "wx" });
    // Read the SFX as a 7z archive; never execute the downloaded installer.
    execFileSync(bootstrap, ["x", "-t7z", "-bd", "-bb0", "-y", `-o${extracted}`, installer, ...Object.keys(files)],
      { timeout: 120_000, stdio: "pipe" });
    for (const [name, digest] of Object.entries(files)) {
      const path = join(extracted, name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256(await readFile(path)) !== digest) throw new Error(`NSIS extractor file digest mismatch: ${name}`);
    }
    const path = join(extracted, "7z.exe");
    const formats = execFileSync(path, ["i"], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (!/\bNsis\b/u.test(formats)) throw new Error("Pinned extractor does not support NSIS");
    return { path, cleanup };
  } catch (error) {
    await cleanup(); throw error;
  }
}
