// Full Daemon regression at ordinary product URLs, with frozen inputs and private Ling directories.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    assert.ok(!entry.isSymbolicLink(), `unexpected input symlink: ${directory}/${entry.name}`);
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
const packages = ["contracts", "core", "daemon", "runner-pi", "providers", "browser-host", "plugin-sdk", "remote-protocol", "localization"];
const inputs = [...new Set([
  ...packages.flatMap(pkg => ["src", "dist"].flatMap(part => {
    const directory = `packages/${pkg}/${part}`;
    return existsSync(join(root, directory)) ? files(directory) : [];
  })),
  ...files("packages/daemon/test"), ...pairs.flat(),
  ...packages.map(pkg => `packages/${pkg}/package.json`), "package.json", "pnpm-lock.yaml",
])].sort();
const snapshot = () => ({ inputCount: inputs.length,
  sha256: sha(JSON.stringify(inputs.map(path => [path, sha(readFileSync(join(root, path)))]))) });
const tests = readdirSync(join(root, "packages/daemon/test"))
  .filter(name => name.endsWith(".test.mjs")).sort().map(name => `packages/daemon/test/${name}`);
assert.equal(tests.length, 523);
const before = snapshot(), qaRoot = mkdtempSync(join(tmpdir(), "ling-e6-standard-full-"));
const logPath = join(root, "output/e6-20260928/p3-standard-dist-full-20261025.log");
const log = openSync(logPath, "wx", 0o600);
const command = ["--test", "--test-concurrency=1", ...tests];
writeSync(log, JSON.stringify({ kind: "standard-complete-dist-daemon-full", startedAt: new Date().toISOString(),
  pid: process.pid, qaRoot, testFiles: tests.length, before, comparedCandidateOrdinaryJavaScript: pairs.length,
  mismatches: 0, modelCalls: "not an authorized live-model pilot" }) + "\n");
const child = spawn(process.execPath, command, {
  cwd: root, env: { ...process.env, NODE_OPTIONS: "", LING_STACK_HOME: join(qaRoot, "ling-home"),
    LING_STACK_DEFAULT_WORKSPACE_CWD: join(qaRoot, "workspace"), LING_WORKSPACE_CWD: join(qaRoot, "workspace") },
  stdio: ["ignore", log, log],
});
console.log(JSON.stringify({ logPath, pid: process.pid, childPid: child.pid, testFiles: tests.length, before }));
child.once("error", error => {
  writeSync(log, JSON.stringify({ launchError: error.message }) + "\n");
});
child.once("close", (exitCode, signal) => {
  let after, snapshotError;
  try { after = snapshot(); } catch (error) { snapshotError = error.message; }
  const summary = { finishedAt: new Date().toISOString(), exitCode, signal, after, snapshotError,
    inputsUnchanged: before.sha256 === after?.sha256 };
  writeSync(log, JSON.stringify(summary) + "\n");
  closeSync(log);
  console.log(JSON.stringify({ logPath, ...summary }));
  process.exitCode = exitCode === 0 && summary.inputsUnchanged ? 0 : 1;
});
