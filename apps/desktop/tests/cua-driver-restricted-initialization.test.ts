import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test, { type TestContext } from "node:test";
import type { DesktopCuaDriverLeaseV1 } from "@ling-stack/contracts";
import { CuaDriverDesktopCoordinator } from "../dist/main/cua-driver/coordinator.js";
import { deriveCuaDriverProxyToken, deriveCuaDriverWorkspaceBinding } from "../dist/main/cua-driver/mcp-proxy.js";
import { RestrictedCuaDriverGeneration } from "../dist/main/cua-driver/restricted-generation.js";
import { createA34CoordinatorArtifactFixture } from "./support/a34-coordinator-artifact-fixture.mjs";
import { allowedTools, deferred, taskGrant } from "./locked-use-fixtures.ts";

async function fixture(t: TestContext, pauseReadiness = false) {
  const artifacts = await createA34CoordinatorArtifactFixture(t);
  const children: ChildProcess[] = [];
  const leases: DesktopCuaDriverLeaseV1[] = [];
  const events: string[] = [];
  const readinessEntered = deferred();
  const releaseReadiness = deferred();
  if (!pauseReadiness) releaseReadiness.resolve();
  const bridge = {
    bridgeToken: "restricted-fixture-bridge", daemonAuthorityEpoch: "authority-1",
    bridgeConnectionId: "bridge-1", desktopInstanceEpoch: 1, workspaceCwd: artifacts.workspaceCwd,
  };
  let generation = 3;
  let readinessChecks = 0;
  let registeredPID: number | undefined;
  let coordinator!: CuaDriverDesktopCoordinator;
  const owner = new RestrictedCuaDriverGeneration({
    currentGeneration: () => generation,
    advanceNormalGenerationFloor(value) { generation = value; },
    allowedToolIds: allowedTools,
    isAuthorityCurrent: () => true,
    native: {
      providerHostProcessID: process.pid,
      async attachProvider(pid) { assert.equal(children[0]?.pid, pid); registeredPID = pid; },
      async check() {},
      async beginAction() { events.push("action-begin"); },
      async finishAction() { events.push("action-finish"); },
      async end() { events.push("native-end"); },
    },
    createCoordinator(restricted) {
      coordinator = new CuaDriverDesktopCoordinator({
        ...restricted, platform: "darwin", architecture: "arm64",
        resourcesPath: artifacts.resourcesPath, userDataPath: artifacts.userDataPath,
        workspaceCwd: artifacts.workspaceCwd, bridgeContext: bridge,
        daemonBaseUrl: "http://127.0.0.1:1", readinessDetailsV1: true,
        featureFlags: {
          bundledEmbedded: { darwin: true, win32: false },
          packagedProvider: { darwin: true, win32: false },
        },
        processLifecycle: {
          lifetimeBoundary: "test-fixture",
          spawn(input) {
            // The verified artifact is inert fixture data. Only this owned
            // Node child exercises the real host's stdio and process lifetime.
            const child = spawn(process.execPath, ["-e", providerScript], {
              cwd: input.cwd, env: input.environment, stdio: ["pipe", "pipe", "pipe"],
            });
            children.push(child);
            return child;
          },
          async terminate(child) { child.kill("SIGKILL"); },
          async terminateImmediately(child) { child.kill("SIGKILL"); },
          async assertNoResidue() {
            assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
            events.push("provider-exited");
          },
        },
        readinessController: {
          async check(context) {
            readinessChecks += 1;
            assert.ok(context.providerProcessId);
            assert.equal(registeredPID, context.providerProcessId);
            assert.equal(context.hostProcessId, process.pid);
            const result = await context.requestCheckPermissions!();
            assert.ok("result" in result);
            assert.deepEqual(result.result, { checked: true });
            readinessEntered.resolve();
            await releaseReadiness.promise;
            return {
              generation: context.generation, childInstanceNonce: context.childInstanceNonce,
              ready: true, providerState: "ready",
              permissions: { accessibility: "granted", screenRecording: "granted", capturable: true },
            };
          },
          invalidate() {},
        },
        leaseClient: {
          async publish(lease) { leases.push(lease); },
          async revoke() {},
        },
      });
      return coordinator;
    },
  });
  const post = (message: unknown, sessionId?: string) => {
    const lease = leases.at(-1)!;
    return fetch(lease.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deriveCuaDriverProxyToken({ ...bridge, generation: lease.generation })}`,
        "x-ling-cua-driver-generation": String(lease.generation),
        "x-ling-cua-driver-authority-epoch": bridge.daemonAuthorityEpoch,
        "x-ling-cua-driver-workspace-sha256": deriveCuaDriverWorkspaceBinding(bridge.workspaceCwd),
        "x-ling-cua-driver-instance-epoch": String(bridge.desktopInstanceEpoch),
        "x-ling-cua-driver-bridge-connection": bridge.bridgeConnectionId,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
  };
  t.after(async () => {
    releaseReadiness.resolve();
    await owner.stop("test_complete");
  });
  return {
    owner, events, children, post, readinessEntered, releaseReadiness,
    coordinator: () => coordinator, readinessChecks: () => readinessChecks,
  };
}

const initialize = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-daemon", version: "1" } },
};
const capture = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_window_state", arguments: { pid: 321, window_id: 1 } } };

test("restricted startup primes the real lazy host before attestation and daemon attachment", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fx = await fixture(t);
  await fx.owner.start({ generation: fx.owner.reserve(), grant: taskGrant(), holdActionAdmission: true });
  const snapshot = await fx.owner.waitUntilReady(AbortSignal.timeout(1_000));
  assert.equal(snapshot.providerState, "ready");
  assert.equal(snapshot.generation, 4);
  assert.equal(snapshot.pid, fx.children[0]?.pid);
  assert.equal(fx.children.length, 1);
  const attached = await fx.post(initialize);
  assert.equal(attached.status, 200, await attached.text());
  const session = attached.headers.get("mcp-session-id")!;
  assert.ok(session);
  assert.equal(fx.readinessChecks(), 1);
  assert.equal(fx.children.length, 1);
  const gated = await fx.post(capture, session);
  assert.equal(gated.status, 400);
  assert.match(await gated.text(), /locked_control_attestation_pending/u);
  assert.equal(fx.events.length, 0);
  fx.owner.openActionAdmission();
  const accepted = await fx.post(capture, session);
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).result, { accepted: true });
  assert.deepEqual(fx.events, ["action-begin", "action-finish"]);
  await fx.owner.stop("revoked");
  assert.ok(fx.events.indexOf("provider-exited") < fx.events.indexOf("native-end"));
});

test("revocation while priming fences the real host's late readiness and attachment", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fx = await fixture(t, true);
  const starting = fx.owner.start({ generation: fx.owner.reserve(), grant: taskGrant(), holdActionAdmission: true });
  await fx.readinessEntered.promise;
  const attaching = fx.post(initialize);
  fx.owner.closeCallGate("native_revoked");
  fx.releaseReadiness.resolve();
  await assert.rejects(starting, /mcp_call_gate_closed|authority_rotated/u);
  const response = await attaching;
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.throws(() => fx.owner.openActionAdmission(), /authority_rotated/u);
  assert.equal(fx.events.includes("action-begin"), false);
  assert.equal(fx.children.length, 1);
  await fx.owner.stop("revoked");
  assert.ok(fx.events.indexOf("provider-exited") < fx.events.indexOf("native-end"));
});

const providerScript = String.raw`
const input = require("node:readline").createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "0.8.3" } }
    : message.params?.name === "check_permissions" ? { checked: true } : { accepted: true };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
`;
