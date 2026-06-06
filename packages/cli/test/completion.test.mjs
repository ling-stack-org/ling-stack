import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("completion bash prints static script from command metadata", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-completion-"));
  try {
    const result = await runCli(cwd, ["completion", "bash"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /complete -F _ling_stack_completion ling-stack/);
    assert.match(result.stdout, /--output-last-message/);
    assert.match(result.stdout, /daemon start/);
    assert.match(result.stdout, /daemon stop/);
    assert.match(result.stdout, /runs events/);
    assert.match(result.stdout, /external-work github ci triage/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("completion zsh and fish print shell-specific scripts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-completion-"));
  try {
    const zsh = await runCli(cwd, ["completion", "zsh"]);
    assert.equal(zsh.code, 0, zsh.stderr);
    assert.match(zsh.stdout, /#compdef ling-stack/);
    assert.match(zsh.stdout, /--output-last-message/);

    const fish = await runCli(cwd, ["completion", "fish"]);
    assert.equal(fish.code, 0, fish.stderr);
    assert.match(fish.stdout, /complete -c ling-stack/);
    assert.match(fish.stdout, /output-last-message/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("completion rejects unsupported shells", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-completion-"));
  try {
    const result = await runCli(cwd, ["completion", "powershell"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /bad_completion_shell/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function runCli(cwd, args) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliPath, "--cwd", cwd, ...args], (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}
