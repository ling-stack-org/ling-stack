import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const limit = 12 * 1024 ** 2, totalLimit = 64 * 1024 ** 2;
const stageRoots = ["artifacts/source/desktop-source", "artifacts/native/desktop-native",
  "artifacts/resource/desktop-resources", "artifacts/browser/desktop-archives",
  "artifacts/browser/desktop-inspection", "artifacts/native/desktop-executable"];

/** Bounded diagnostics, never runtime payloads, credentials or an approval receipt. */
export async function collectGstackEvidence(workspace, output) {
  workspace = resolve(workspace); output = resolve(output);
  const records = [], omitted = [];
  let total = 0;
  const copy = async name => {
    const source = join(workspace, name);
    const stat = await lstat(source).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || total + stat.size > totalLimit) {
      omitted.push({ name, reason: "non_regular_or_size_bound" }); return;
    }
    const bytes = await readFile(source);
    if (bytes.length !== stat.size || bytes.length > limit || total + bytes.length > totalLimit) throw new Error("gstack_evidence_input_changed");
    JSON.parse(bytes.toString("utf8"));
    const destination = join(output, name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    total += bytes.length;
    records.push({ name, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  };
  for (const name of ["desktop-candidate.json", "desktop-candidate-progress.json", "desktop-candidate-failure.json",
    ".gstack-resource-workspace.json", "last-run.json"]) await copy(name);
  for (const stage of stageRoots) {
    const entries = await readdir(join(workspace, stage), { withFileTypes: true }).catch(error => {
      if (error.code !== "ENOENT") throw error; return [];
    });
    if (entries.length > 512) throw new Error("gstack_evidence_stage_entry_bound");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.endsWith(".json")) await copy(`${stage}/${entry.name}`);
    }
  }
  const reports = await readdir(join(workspace, "artifacts/report")).catch(error => {
    if (error.code !== "ENOENT") throw error; return [];
  });
  for (const name of reports.filter(name => /^shell-parser(?:\.exe)?\.provenance\.json$/u.test(name))) await copy(`artifacts/report/${name}`);
  for (const name of ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    "@anthropic-ai/claude-agent-sdk-win32-x64", "@anthropic-ai/sdk"]) {
    await copy(`artifacts/resource/desktop-resources/runtime/node_modules/${name}/package.json`);
  }
  const report = { schemaVersion: 1, scope: "diagnostics_only", acceptance: "not_granted", files: records, omitted, totalBytes: total };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "collection.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required for gstack evidence collection");
  console.log(JSON.stringify(await collectGstackEvidence(join(process.env.RUNNER_TEMP, "gstack-candidate"),
    resolve(".codex-artifacts/desktop-release/gstack")), null, 2));
}
