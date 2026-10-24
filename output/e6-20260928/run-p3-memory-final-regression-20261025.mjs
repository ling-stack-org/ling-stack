import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
assert.equal(root, "/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack");
assert.equal(realpathSync(process.cwd()), root);
const roots = ["packages/contracts/src", "packages/core/src", "packages/daemon/src", "packages/daemon/test",
  "output/e6-20260928/project-inputs-final-build/contracts", "output/e6-20260928/project-inputs-final-build/core",
  "output/e6-20260928/project-inputs-final-build/daemon"];
function collect(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), `unexpected input symlink: ${directory}/${entry.name}`);
    return entry.isDirectory() ? collect(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`];
  });
}
const sha = value => createHash("sha256").update(value).digest("hex");
function snapshot() {
  const rows = roots.flatMap(collect).sort().map(path => [path, sha(readFileSync(join(root, path)))]);
  return { inputCount: rows.length, sha256: sha(JSON.stringify(rows)) };
}
const before = snapshot();
const tests = readdirSync(join(root, "packages/daemon/test")).filter(name => name.endsWith(".test.mjs"))
  .sort().map(name => `packages/daemon/test/${name}`);
const qaRoot = mkdtempSync(join(tmpdir(), "ling-e6-memory-final-full-"));
const logPath = join(root, "output/e6-20260928/p3-memory-daemon-final-full-20261025.log");
const log = openSync(logPath, "wx", 0o600);
const header = { kind: "isolated-candidate-daemon-full", startedAt: new Date().toISOString(),
  pid: process.pid, qaRoot, testFiles: tests.length, before, modelCalls: "not an authorized live-model pilot" };
writeSync(log, `${JSON.stringify(header)}\n`);
console.log(JSON.stringify({ ...header, logPath }));
const result = spawnSync(process.execPath, ["--loader", "./output/e6-20260928/public-projection-test-loader.mjs",
  "--test", "--test-concurrency=1", ...tests], {
  cwd: root, env: { ...process.env, NODE_OPTIONS: "", LING_STACK_HOME: join(qaRoot, "ling-home"),
    LING_STACK_DEFAULT_WORKSPACE_CWD: join(qaRoot, "workspace"), LING_WORKSPACE_CWD: join(qaRoot, "workspace") },
  stdio: ["ignore", log, log],
});
const after = snapshot();
const summary = { finishedAt: new Date().toISOString(), exitCode: result.status,
  signal: result.signal, error: result.error?.message, after, sourceAndCandidateUnchanged: before.sha256 === after.sha256 };
writeSync(log, `${JSON.stringify(summary)}\n`);
closeSync(log);
console.log(JSON.stringify(summary));
process.exit(result.status === 0 && summary.sourceAndCandidateUnchanged ? 0 : 1);
