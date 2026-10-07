import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { startFakeAcpServer } from "../dist/runtime/acp/fake-server.js";
import { startFakeCodexAppServer } from "../dist/runtime/adapters/fake-codex-app-server.js";

test("runner readiness routes expose external runners after gates pass", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runner-readiness-"));
  const acp = await startFakeAcpServer({ capabilities: { approvalBridge: false } });
  const codex = await startFakeCodexAppServer({ capabilities: { approvalBridge: false, nativeResume: false } });
  const daemon = await startDaemonForTest({
    runners: {
      codexAppServer: {
        enabled: true,
        baseUrl: codex.baseUrl,
        readinessPassed: true,
      },
      openclawAcp: {
        enabled: true,
        endpoint: acp.endpoint,
        readinessPassed: true,
      },
    },
  });
  try {
    const runners = await getJson(`${daemon.url}/runners?cwd=${encodeURIComponent(cwd)}`);
    const pi = runners.runners.find((runner) => runner.id === "pi");
    const openclaw = runners.runners.find((runner) => runner.id === "openclaw-acp");
    const codexRunner = runners.runners.find((runner) => runner.id === "codex-app-server");
    assert.equal(pi.status, "enabled");
    assert.equal(pi.readiness.status, "ready");
    assert.equal(openclaw.status, "enabled");
    assert.equal(openclaw.readiness.status, "ready");
    assert.equal(codexRunner.status, "enabled");
    assert.equal(codexRunner.readiness.status, "ready");

    const readiness = await getJson(`${daemon.url}/runners/openclaw-acp/readiness?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(readiness.cwd, cwd);
    assert.equal(readiness.readiness.runnerId, "openclaw-acp");
    assert.equal(readiness.readiness.status, "ready");
    assert.equal(readiness.readiness.featureFlagEnabled, true);
    assert.equal(readiness.readiness.toolExecutionConformance.status, "verified");
    assert.equal(readiness.readiness.toolExecutionConformance.nativeSideEffectMode, "disabled");
    assert.equal(readiness.readiness.toolExecutionConformance.approvalBridgeVerified, false);
    assert.deepEqual(readiness.readiness.toolExecutionConformance.curatedTools, ["read", "grep", "find", "ls"]);
    assert.equal(readiness.readiness.endpointReachable, true);
    assert.equal(readiness.readiness.capabilityNegotiated, true);
    assert.deepEqual(blockerCodes(readiness), []);

    const snapshot = await getJson(`${daemon.url}/control-plane/snapshot?cwd=${encodeURIComponent(cwd)}&domains=runners`);
    assert.equal(snapshot.domains.runners.ok, true);
    assert.equal(snapshot.domains.runners.data.runners.find((runner) => runner.id === "openclaw-acp").readiness.status, "ready");

    const missing = await requestJson(`${daemon.url}/runners/missing/readiness?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "runner_not_found");

    const missingCwd = await requestJson(`${daemon.url}/runners/openclaw-acp/readiness`);
    assert.equal(missingCwd.status, 400);
    assert.equal(missingCwd.json.error, "bad_request");
  } finally {
    await daemon.close();
    await acp.close();
    await codex.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runner readiness keeps ACP capability failures blocked", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runner-readiness-acp-"));
  const acp = await startFakeAcpServer({ capabilities: { artifacts: false } });
  const daemon = await startDaemonForTest({
    runners: {
      openclawAcp: {
        enabled: true,
        endpoint: acp.endpoint,
        readinessPassed: true,
      },
    },
  });
  try {
    const readiness = await getJson(`${daemon.url}/runners/openclaw-acp/readiness?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(readiness.readiness.endpointReachable, true);
    assert.equal(readiness.readiness.capabilityNegotiated, false);
    assert.equal(blockerCodes(readiness).includes("missing_capability_negotiation"), true);
    assert.equal(blockerCodes(readiness).includes("adapter_not_implemented"), false);
  } finally {
    await daemon.close();
    await acp.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runner readiness reports feature flag and endpoint blockers by default", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runner-readiness-default-"));
  const daemon = await startDaemonForTest();
  try {
    const readiness = await getJson(`${daemon.url}/runners/codex-app-server/readiness?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(readiness.readiness.status, "blocked");
    assert.equal(readiness.readiness.featureFlagEnabled, false);
    assert.equal(readiness.readiness.toolExecutionConformance.status, "verified");
    assert.equal(blockerCodes(readiness).includes("feature_flag_disabled"), true);
    assert.equal(blockerCodes(readiness).includes("missing_endpoint"), true);
    assert.equal(blockerCodes(readiness).includes("adapter_not_implemented"), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function blockerCodes(response) {
  return response.readiness.blockingReasons.map((blocker) => blocker.code);
}

async function startDaemonForTest(config = {}) {
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    ...config,
  }, {
    runner: new NoopRunner(),
    storeFactory: (cwd) => createSqliteRunStore(cwd),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (response.status !== 200) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    json: await response.json(),
  };
}

class NoopRunner {
  async runTask(options) {
    return { taskId: options.task.id, events: [], messages: [] };
  }
}
