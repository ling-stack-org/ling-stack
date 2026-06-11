import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(cliDir, "dist/index.js");

test("top-level local service commands are documented", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /ling restart/);
  assert.match(help.stdout, /ling status/);
  assert.match(help.stdout, /ling logs/);

  const restartHelp = await runCli(["restart", "--help"]);
  assert.equal(restartHelp.code, 0, restartHelp.stderr);
  assert.match(restartHelp.stdout, /Restarts the local Ling Stack daemon and Web UI/);
  assert.match(restartHelp.stdout, /--skip-build/);

  const logsHelp = await runCli(["logs", "--help"]);
  assert.equal(logsHelp.code, 0, logsHelp.stderr);
  assert.match(logsHelp.stdout, /--service daemon\|web\|all/);
});

test("local logs validates service before reading host state", async () => {
  const result = await runCli(["logs", "--service", "database"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /bad_service/);
});

test("package exposes the short ling binary alias", async () => {
  const pkg = JSON.parse(await readFile(resolve(cliDir, "package.json"), "utf8"));
  assert.equal(pkg.bin.ling, "./dist/index.js");
  assert.equal(pkg.bin["ling-stack"], "./dist/index.js");
});

function runCli(args) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliPath, ...args], (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}
