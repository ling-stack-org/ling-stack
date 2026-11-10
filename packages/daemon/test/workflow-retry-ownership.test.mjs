import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixturePath = fileURLToPath(new URL("./support/a12-workflow-retry-fixture.mjs", import.meta.url));
const cases = [
  "preparing-reconcile",
  "normal-retry",
  "duplicate-retry",
  "preparation-failure",
  "late-orchestrated-ready-after-cancel",
  "late-direct-ready-after-cancel",
  "old-terminal-after-ready",
  "reject-non-blocked",
  "reject-terminal-workflow",
  "reject-incomplete-dependency",
  "reject-nonretryable-loop",
];

// The outer process never imports Daemon/Core or opens a store. Every case gets
// its own process, home, workspace, SQLite store, ephemeral HTTP port and gate.
for (const lane of ["existing", "manifest"]) {
  for (const scenario of cases) {
    test(`A12 ${lane}: ${scenario}`, { timeout: 45_000 }, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `ling-a12-${lane}-${scenario}-`));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const temp = join(root, "tmp");
      await Promise.all([home, workspace, temp].map((path) => mkdir(path)));
      const env = {
        PATH: dirname(process.execPath),
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: home,
        TMPDIR: temp,
        TEMP: temp,
        TMP: temp,
        LANG: "C.UTF-8",
        NODE_NO_WARNINGS: "1",
        LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: workspace,
        A12_OWNED_ROOT: root,
      };
      const result = await runChild([fixturePath, lane, scenario], { env, cwd: workspace });
      await Promise.all([
        writeFile(join(root, "stdout.log"), result.stdout),
        writeFile(join(root, "stderr.log"), result.stderr),
      ]);
      t.diagnostic(`A12 retained evidence root: ${root}`);
      const marker = result.stdout.split(/\r?\n/u).find((line) => line.startsWith("A12_RESULT "));
      assert.ok(marker, JSON.stringify({ root, ...result }));
      const report = JSON.parse(marker.slice("A12_RESULT ".length));
      await writeFile(join(root, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
      assert.equal(result.signal, null, JSON.stringify({ root, report, ...result }));
      assert.equal(result.code, 0, JSON.stringify({ root, report, stderr: result.stderr }, null, 2));
      assert.equal(report.verdict, "passed", JSON.stringify(report));
      assert.equal(report.observations.modelRequests, 0);
      assert.equal(report.observations.blockedExternalFetches, 0);
      assert.equal(report.observations.keychainAccesses, 0);
      // Preserve this case's self-owned state and output on success or failure.
      // Cleanup is an explicit owner decision, not a broad test teardown.
    });
  }
}

async function runChild(args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 35_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
