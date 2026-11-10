import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Compare the final installer plug-ins with their paired source records. */
export async function verifyNsisPlugins({ installer, sevenZipPath, sources }) {
  sources ??= JSON.parse(await readFile(new URL("../../apps/desktop/scripts/distribution/vendor-notices/nsis-plugins/sources.json", import.meta.url), "utf8"));
  const plugins = sources.entries.filter(entry => entry.binarySha256);
  if (plugins.length !== 2 || plugins[0].name !== "StdUtils" || plugins[1].name !== "nsis7z") throw new Error("Expected the two reviewed NSIS plug-in records");
  const records = [];
  for (const plugin of plugins) {
    if (!/^[a-f0-9]{64}$/u.test(plugin.binarySha256)) throw new Error("Invalid reviewed NSIS plug-in digest");
    const name = `${plugin.name}.dll`;
    const bytes = execFileSync(sevenZipPath, ["e", "-so", "-bd", "-bb0", installer, join("$PLUGINSDIR", name)],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!bytes.length || sha256 !== plugin.binarySha256) throw new Error(`Final NSIS plug-in does not match its reviewed source record: ${name}`);
    records.push({ name, sizeBytes: bytes.length, sha256, sourceArchiveSha256: plugin.sha256 });
  }
  return records;
}
