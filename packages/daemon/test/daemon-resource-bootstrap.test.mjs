import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDaemonResourceBootstrap } from "../../core/dist/daemon-resource-bootstrap.js";
import { readExecutionEngineHostAuthority } from "../../core/dist/execution-engine-host-authority.js";

async function launchCli(t, extraEnv = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cli-resource-bootstrap-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = new URL("../src/cli.ts", import.meta.url).href;
  const shutdownSource = new URL("../src/runtime/signal-shutdown.ts", import.meta.url).href;
  const hook = join(cwd, "hook.mjs");
  const boundary = `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    export function readPackagedQaHarnessSelection() {}
    export function readPackagedRestrictedCommandConfig() {}
    export function readPackagedOfficeLocalNativeArtifact() {}
    export async function preparePackagedGstackStartup() {
      assert.equal(process.env.LING_STACK_RESOURCE_BOOTSTRAP_FD, undefined);
      assert.equal(process.env.LING_STACK_ENGINE_AUTHORITY_FD, undefined);
      process.send('preparing');
      const [action] = await once(process, 'message');
      if (action === 'fail') throw new Error('fixture_resource_authentication_failed');
      return () => {};
    }
    export async function startDaemon(config, hooks) {
      assert.equal(typeof hooks.initializeBundledSkills, 'function');
      process.send('starting-service');
      const [action] = await once(process, 'message');
      assert.equal(action, 'service-ready');
      return { config, server: { address: () => ({port: 17991}) }, stop: async () => {},
        engineManagement: {capability: 'x'.repeat(43), csrfToken: 'y'.repeat(43)} };
    }`;
  // Execute the actual CLI, replacing only native/resource/service side effects.
  // Both pipe writers and readers are production code over real child-process pipes.
  await writeFile(hook, `import { registerHooks } from 'node:module';
    const boundaries = new Set(${JSON.stringify(["./index.js", "./runtime/packaged-qa-harness-bootstrap.js",
      "./runtime/sandbox/packaged-restricted-command-bootstrap.js", "./runtime/sandbox/packaged-office-native-bootstrap.js",
      "./features/skills/packaged-startup.js"])});
    registerHooks({resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(source)} && specifier === './runtime/signal-shutdown.js') {
        return { shortCircuit: true, url: ${JSON.stringify(shutdownSource)} };
      }
      if (context.parentURL === ${JSON.stringify(source)} && boundaries.has(specifier)) {
        return { shortCircuit: true, url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(boundary)}`)} };
      }
      return next(specifier, context);
    }});`);
  const child = spawn(process.execPath, ["--import", hook, new URL(source).pathname], {
    cwd, env: { PATH: process.env.PATH, LING_STACK_HOST: "127.0.0.1", LING_STACK_PORT: "17991",
      LING_STACK_PACKAGED_DESKTOP: "1", LING_STACK_ENGINE_AUTHORITY_FD: "3", LING_STACK_RESOURCE_BOOTSTRAP_FD: "4", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  let output = "";
  const messages = [];
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  child.on("message", value => messages.push(value));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  });
  return { child, exited, messages, output: () => output };
}

test("actual CLI authenticates resources before FD4 and service startup, with FD3 only after service readiness", { timeout: 5000 }, async t => {
  const input = await launchCli(t);
  assert.equal((await once(input.child, "message"))[0], "preparing");
  let resourcesReady = false, authorityReady = false;
  const resource = readDaemonResourceBootstrap({ channel: input.child.stdio[4], pid: input.child.pid })
    .then(() => { resourcesReady = true; });
  const authority = readExecutionEngineHostAuthority({ channel: input.child.stdio[3], pid: input.child.pid,
    baseUrl: "http://127.0.0.1:17991" }).then(value => { authorityReady = true; return value; });
  assert.equal(resourcesReady, false);
  assert.deepEqual(input.messages, ["preparing"]);
  const starting = once(input.child, "message");
  input.child.send("admit");
  assert.equal((await starting)[0], "starting-service");
  await resource;
  assert.equal(authorityReady, false, "FD4 must not masquerade as completed service/engine readiness");
  input.child.send("service-ready");
  assert.equal((await authority).pid, input.child.pid);
  input.child.disconnect();
  assert.deepEqual(await input.exited, [0, null]);
  assert.equal(input.output().includes("x".repeat(43)), false);
});

test("actual CLI resource failure exits without a resource receipt, service or authority", { timeout: 5000 }, async t => {
  const input = await launchCli(t);
  assert.equal((await once(input.child, "message"))[0], "preparing");
  const resource = assert.rejects(readDaemonResourceBootstrap({ channel: input.child.stdio[4], pid: input.child.pid }), /invalid|unavailable/);
  input.child.send("fail");
  assert.deepEqual(await input.exited, [1, null]);
  await resource;
  assert.deepEqual(input.messages, ["preparing"]);
  assert.match(input.output(), /fixture_resource_authentication_failed/);
});

test("actual CLI refuses invalid bootstrap descriptors or nonpackaged use before side effects", { timeout: 5000 }, async t => {
  for (const extraEnv of [{ LING_STACK_RESOURCE_BOOTSTRAP_FD: "3" }, { LING_STACK_PACKAGED_DESKTOP: "0" }]) {
    const input = await launchCli(t, extraEnv);
    assert.deepEqual(await input.exited, [1, null]);
    assert.deepEqual(input.messages, []);
    assert.match(input.output(), /daemon_resource_bootstrap_invalid/);
  }
});
