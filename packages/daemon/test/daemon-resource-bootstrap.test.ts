import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, Readable } from "node:stream";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { readDaemonResourceBootstrap } from "../../core/dist/daemon-resource-bootstrap.js";
import { DAEMON_SHUTDOWN_REQUEST_FD, observeDaemonShutdown } from "../../core/dist/daemon-shutdown-observer.js";
import { readExecutionEngineHostAuthority } from "../../core/dist/execution-engine-host-authority.js";

async function launchCli(t: TestContext, extraEnv: NodeJS.ProcessEnv = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cli-resource-bootstrap-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = new URL("../src/cli.ts", import.meta.url).href;
  const shutdownSource = new URL("../src/runtime/signal-shutdown.ts", import.meta.url).href;
  const hook = join(cwd, "hook.mjs");
  const invalidNative = extraEnv.LING_TEST_NATIVE_RESOURCE_INVALID === "1";
  const boundary = `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    export function readPackagedQaHarnessSelection() {}
    export function readPackagedRestrictedCommandConfig() {}
    export function readPackagedOfficeLocalNativeArtifact() {
      assert.equal(process.env.LING_STACK_RESOURCE_BOOTSTRAP_FD, undefined);
      assert.equal(process.env.LING_STACK_ENGINE_AUTHORITY_FD, undefined);
      assert.equal(process.env.LING_STACK_SHUTDOWN_REQUEST_FD, undefined);
      if (${invalidNative}) throw new Error('fixture_resource_authentication_failed');
    }
    export async function startDaemon(config, hooks) {
      assert.deepEqual(hooks, {});
      process.send('starting-service');
      const [action] = await once(process, 'message');
      assert.equal(action, 'service-ready');
      // The service owns a live handle until the parent closes the fixture IPC.
      process.channel.ref();
      return { config, server: { address: () => ({port: 17991}) }, stop: async (options) => {
          assert.equal(options.waitForOwnedDrain, true);
          process.send('draining-service');
          const [action] = await once(process, 'message');
          assert.equal(action, 'finish-drain');
        },
        engineManagement: {capability: 'x'.repeat(43), csrfToken: 'y'.repeat(43)} };
    }`;
  // Execute the actual CLI, replacing only native/resource/service side effects.
  // Both pipe writers and readers are production code over real child-process pipes.
  await writeFile(hook, `import { registerHooks } from 'node:module';
    const boundaries = new Set(${JSON.stringify(["./index.js", "./runtime/packaged-qa-harness-bootstrap.js",
      "./runtime/sandbox/packaged-restricted-command-bootstrap.js", "./runtime/sandbox/packaged-office-native-bootstrap.js"])});
    registerHooks({resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(source)} && specifier === './runtime/signal-shutdown.js') {
        return { shortCircuit: true, url: ${JSON.stringify(shutdownSource)} };
      }
      if (context.parentURL === ${JSON.stringify(source)} && boundaries.has(specifier)) {
        return { shortCircuit: true, url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(boundary)}`)} };
      }
      return next(specifier, context);
    }});`);
  const child = spawn(process.execPath, ["--import", hook, fileURLToPath(source)], {
    cwd, env: { PATH: process.env.PATH, LING_STACK_HOST: "127.0.0.1", LING_STACK_PORT: "17991",
      LING_STACK_PACKAGED_DESKTOP: "1", LING_STACK_ENGINE_AUTHORITY_FD: "3", LING_STACK_RESOURCE_BOOTSTRAP_FD: "4", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe",
      extraEnv.LING_STACK_SHUTDOWN_OBSERVER_FD ? "pipe" : "ignore",
      extraEnv.LING_STACK_SHUTDOWN_REQUEST_FD ? "pipe" : "ignore", "ipc"],
  });
  const exited = once(child, "exit");
  const pid = child.pid;
  const authorityChannel = child.stdio[3];
  const resourceChannel = child.stdio[4];
  assert.ok(pid);
  assert.ok(child.stdout && child.stderr);
  assert.ok(authorityChannel instanceof Readable);
  assert.ok(resourceChannel instanceof Readable);
  let output = "";
  const messages: unknown[] = [];
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  child.on("message", value => messages.push(value));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  });
  return { child, pid, exited, authorityChannel, resourceChannel, messages, output: () => output };
}

test("actual CLI starts without gstack and publishes FD3 only after service readiness", { timeout: 5000 }, async t => {
  const input = await launchCli(t);
  const starting = once(input.child, "message");
  let authorityReady = false;
  const resource = readDaemonResourceBootstrap({ channel: input.resourceChannel, pid: input.pid });
  const authority = readExecutionEngineHostAuthority({ channel: input.authorityChannel, pid: input.pid,
    baseUrl: "http://127.0.0.1:17991" }).then(value => { authorityReady = true; return value; });
  assert.equal((await starting)[0], "starting-service");
  await resource;
  assert.equal(authorityReady, false, "FD4 must not masquerade as completed service/engine readiness");
  input.child.send("service-ready");
  assert.equal((await authority).pid, input.pid);
  assert.equal(input.child.connected, true, "the fixture service stays alive after publishing authority");
  input.child.disconnect();
  assert.deepEqual(await input.exited, [0, null]);
  assert.equal(input.output().includes("x".repeat(43)), false);
});

test("actual CLI resource failure exits without a resource receipt, service or authority", { timeout: 5000 }, async t => {
  const input = await launchCli(t, { LING_TEST_NATIVE_RESOURCE_INVALID: "1" });
  const resource = assert.rejects(readDaemonResourceBootstrap({ channel: input.resourceChannel, pid: input.pid }), /invalid|unavailable/);
  assert.deepEqual(await input.exited, [1, null]);
  await resource;
  assert.deepEqual(input.messages, []);
  assert.match(input.output(), /fixture_resource_authentication_failed/);
});

test("actual CLI drains and exits cleanly after a request on its inherited command pipe", { timeout: 5000 }, async t => {
  const input = await launchCli(t, { LING_STACK_SHUTDOWN_OBSERVER_FD: "5", LING_STACK_SHUTDOWN_REQUEST_FD: "6" });
  const starting = once(input.child, "message");
  const resourcesReady = readDaemonResourceBootstrap({ channel: input.resourceChannel, pid: input.pid });
  const authorityReady = readExecutionEngineHostAuthority({ channel: input.authorityChannel, pid: input.pid,
    baseUrl: "http://127.0.0.1:17991" });
  assert.equal((await starting)[0], "starting-service");
  await resourcesReady;
  input.child.send("service-ready");
  await authorityReady;
  const channels: readonly unknown[] = input.child.stdio;
  const observer = channels[5];
  assert.ok(observer instanceof Readable);
  const phase = new Promise<string>((resolve, reject) => {
    const dispose = observeDaemonShutdown({ channel: observer, pid: input.pid, onPhase: resolve, onUnavailable: reject });
    t.after(dispose);
  });
  const draining = once(input.child, "message");
  const command = channels[DAEMON_SHUTDOWN_REQUEST_FD];
  assert.ok(command instanceof Duplex);
  command.end("shutdown\n");
  assert.equal(await phase, "draining");
  assert.equal((await draining)[0], "draining-service");
  assert.equal(input.child.exitCode, null);
  input.child.send("finish-drain");
  assert.deepEqual(await input.exited, [0, null]);
});

test("actual CLI refuses invalid bootstrap descriptors or nonpackaged use before side effects", { timeout: 5000 }, async t => {
  for (const extraEnv of [{ LING_STACK_RESOURCE_BOOTSTRAP_FD: "3" }, { LING_STACK_PACKAGED_DESKTOP: "0" }]) {
    const input = await launchCli(t, extraEnv);
    assert.deepEqual(await input.exited, [1, null]);
    assert.deepEqual(input.messages, []);
    assert.match(input.output(), /daemon_resource_bootstrap_invalid/);
  }
  const input = await launchCli(t, { LING_STACK_SHUTDOWN_REQUEST_FD: "6" });
  assert.deepEqual(await input.exited, [1, null]);
  assert.deepEqual(input.messages, []);
  assert.match(input.output(), /daemon_shutdown_request_invalid/);
});
