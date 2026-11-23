import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DesktopDaemonLifecycle } from "../dist/main/daemon-lifecycle.js";

test("packaged Windows cold startup preserves authority and sends a private shutdown request", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "ling-windows-daemon-lifecycle-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const authority = new PassThrough();
  const resources = new PassThrough();
  const command = new PassThrough();
  t.after(() => { authority.destroy(); resources.destroy(); command.destroy(); });
  const pid = 42;
  const child = Object.assign(new ChildProcess(), {
    pid, stdio: [null, null, null, authority, resources, null, command],
  });
  const kill = t.mock.method(child, "kill", () => false);
  let commandText = "";
  command.on("data", chunk => { commandText += String(chunk); });
  const commandEnded = once(command, "end");
  const baseUrl = "http://127.0.0.1:17991";
  const readyAt = Date.now() + 140_000;
  let onSpawn: (env: NodeJS.ProcessEnv) => void = () => undefined;
  const spawned = new Promise<NodeJS.ProcessEnv>(resolve => { onSpawn = resolve; });
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl,
    daemonEntryPath: fileURLToPath(import.meta.url),
    defaultWorkspaceCwd: workspace,
    packaged: true,
    platform: "win32",
    fetch: async () => {
      if (Date.now() < readyAt) throw new TypeError("packaged resources are still loading");
      return Response.json({ service: "ling-stack-daemon", defaultWorkspaceCwd: workspace });
    },
    probePort: async () => "free",
    spawnDaemon: input => { onSpawn(input.env); return child; },
  });
  const startup = lifecycle.ensureStarted();
  void startup.catch(() => undefined);
  const env = await spawned;
  assert.equal(env.LING_STACK_SHUTDOWN_REQUEST_FD, "6");
  await setImmediate();
  t.mock.timers.tick(140_000);
  await setImmediate();
  assert.equal(lifecycle.status.state, "starting");
  assert.equal(authority.destroyed, false);
  await assert.rejects(lifecycle.getExecutionEngineAuthority(), /engine_host_authority_unavailable/);

  const engineAuthority = { schemaVersion: 1, instanceId: "11111111-1111-1111-1111-111111111111", baseUrl, pid,
    credentials: { capability: "fixture".repeat(7), csrfToken: "csrf".repeat(11) } };
  resources.end(JSON.stringify({ schemaVersion: 1, phase: "resources_ready", pid }));
  authority.end(JSON.stringify(engineAuthority));
  assert.equal((await startup).ownedByDesktop, true);
  assert.deepEqual(await lifecycle.getExecutionEngineAuthority(), engineAuthority);

  const stop = lifecycle.stopOwnedDaemon();
  await commandEnded;
  assert.equal(commandText, "shutdown\n");
  assert.equal(lifecycle.status.state, "draining");
  Object.assign(child, { exitCode: 0 });
  child.emit("exit", 0, null);
  assert.deepEqual(await stop, { kind: "owned_stopped", pid, code: 0, signal: null });
  assert.equal(kill.mock.callCount(), 0);
});
