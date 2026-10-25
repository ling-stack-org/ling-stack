// Validate failed candidate-location cases at the ordinary product module URLs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
assert.equal(root, "/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack");
assert.equal(realpathSync(process.cwd()), root);
assert.equal(process.env.LING_IMAGE_SANITIZER_PATH, undefined);
const sha = value => createHash("sha256").update(value).digest("hex");
function files(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink());
    return entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`];
  });
}
const pairs = ["contracts", "core", "daemon"].flatMap(pkg => {
  const prefix = `output/e6-20260928/project-inputs-final-build/${pkg}/`;
  return files(prefix).filter(path => path.endsWith(".js")).map(path => {
    const ordinary = `packages/${pkg}/dist/${path.slice(prefix.length)}`;
    assert.ok(existsSync(join(root, ordinary)));
    assert.equal(sha(readFileSync(join(root, path))), sha(readFileSync(join(root, ordinary))), ordinary);
    return [path, ordinary];
  });
});
assert.equal(pairs.length, 1541);
const inputs = [...new Set([...["packages/contracts/src", "packages/core/src", "packages/daemon/src", "packages/daemon/test"].flatMap(files),
  ...pairs.flat(), ...files("packages/daemon/dist/native")])].sort();
const snapshot = () => ({ inputCount: inputs.length,
  sha256: sha(JSON.stringify(inputs.map(path => [path, sha(readFileSync(join(root, path)))]))) });
const before = snapshot(), qaRoot = mkdtempSync(join(tmpdir(), "ling-e6-standard-dist-"));
const logPath = join(root, "output/e6-20260928/p3-standard-dist-revalidated-20261025.log");
const log = openSync(logPath, "wx", 0o600);
writeSync(log, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, qaRoot, before,
  comparedCandidateOrdinaryJavaScript: pairs.length, mismatches: 0,
  kind: "same-bytecode-real-resource-and-original-module-identity-revalidation" }) + "\n");
const tests = ["native-artifact-import", "packaged-codesign-host-invocation", "packaged-codesign-host-source",
  "packaged-codesign-original-issuer", "run-request-permission-axes"].map(name => `packages/daemon/test/${name}.test.mjs`);
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  cwd: root, env: { ...process.env, NODE_OPTIONS: "", LING_STACK_HOME: join(qaRoot, "ling-home"),
    LING_STACK_DEFAULT_WORKSPACE_CWD: join(qaRoot, "workspace"), LING_WORKSPACE_CWD: join(qaRoot, "workspace") },
  stdio: ["ignore", log, log], timeout: 240000,
});
const after = snapshot();
const summary = { finishedAt: new Date().toISOString(), exitCode: result.status,
  signal: result.signal, error: result.error?.message, after, inputsUnchanged: before.sha256 === after.sha256 };
writeSync(log, JSON.stringify(summary) + "\n"); closeSync(log);
console.log(JSON.stringify({ logPath, ...summary }));
process.exit(result.status === 0 && summary.inputsUnchanged ? 0 : 1);
