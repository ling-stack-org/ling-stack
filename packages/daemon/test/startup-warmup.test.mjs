import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";

test("daemon start warms default workspace effective config snapshot", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-warmup-workspace-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-warmup-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    secretResolver: readySecretResolver,
  });
  try {
    await writeFile(resolve(userRoot, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      theme: "dark",
      locale: "zh-CN",
    }), "utf8");
    await writeFile(resolve(userRoot, "config.json"), JSON.stringify({
      schemaVersion: 1,
      runtimeDefaults: {
        defaultRunnerId: "pi",
        implicitRunnerFallback: "disabled",
      },
    }), "utf8");

    await daemon.start();
    const status = daemon.startupState.snapshot(cwd);
    assert.equal(status.state, "ready");
    assert.equal(status.phases.process_config, "ready");
    assert.equal(status.phases.user_config, "ready");
    assert.equal(status.phases.workspace_store, "ready");
    assert.equal(status.phases.effective_config, "ready");
    assert.equal(status.phases.runtime_policy, "ready");
    assert.equal(status.phases.secret_resolver, "ready");
    assert.ok(status.effectiveConfigLoadedAt);

    const snapshot = daemon.startupState.getEffectiveConfigSnapshot(cwd);
    assert.equal(snapshot.response.values.theme.value, "dark");
    assert.equal(snapshot.response.values.theme.source, "user");
    assert.equal(snapshot.response.values.runtime.implicitRunnerFallback.value, "disabled");
    assert.equal(snapshot.response.values.runtime.implicitRunnerFallback.source, "user");
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("startup status api returns readiness and refresh rereads user config", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-status-api-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-status-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    secretResolver: readySecretResolver,
  });
  try {
    await writeFile(resolve(userRoot, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      theme: "dark",
    }), "utf8");

    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.readiness, "ready");

    const initial = await getJson(`${baseUrl}/startup/status`);
    assert.equal(initial.cwd, cwd);
    assert.equal(initial.state, "ready");
    assert.equal(initial.phases.effective_config, "ready");
    assert.equal(initial.diagnostics.length, 0);

    await writeFile(resolve(userRoot, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      theme: "sepia",
    }), "utf8");
    const refreshed = await postJson(`${baseUrl}/startup/refresh`);
    assert.equal(refreshed.cwd, cwd);
    assert.equal(refreshed.state, "degraded");
    assert.equal(refreshed.phases.user_config, "degraded");
    assert.equal(refreshed.phases.effective_config, "ready");
    assert.ok(refreshed.diagnostics.some((diagnostic) => diagnostic.code === "user_settings_invalid_theme"));

    const refreshedHealth = await getJson(`${baseUrl}/health`);
    assert.equal(refreshedHealth.readiness, "degraded");
    assert.equal(daemon.startupState.getEffectiveConfigSnapshot(cwd).response.values.theme.value, "system");
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("startup status warms an existing starting workspace record", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-existing-record-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-existing-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    secretResolver: readySecretResolver,
  });
  try {
    await daemon.start();
    const otherCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-other-"));
    daemon.startupState.ensureWorkspace(otherCwd);
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const warmed = await getJson(`${baseUrl}/startup/status?cwd=${encodeURIComponent(otherCwd)}`);
    assert.equal(warmed.state, "ready");
    assert.equal(warmed.phases.process_config, "ready");
    assert.equal(warmed.phases.runtime_policy, "ready");

    await rm(otherCwd, { recursive: true, force: true });
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("startup optional warmups mark provider automation external-work and plugin phases", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-optional-warmups-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-optional-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    secretResolver: readySecretResolver,
  });
  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const status = await waitForStartupPhase(baseUrl, "plugin_warmup", "ready");

    assert.equal(status.phases.provider_warmup, "ready");
    assert.equal(status.phases.automation_scheduler, "ready");
    assert.equal(status.phases.external_work_scheduler, "ready");
    assert.equal(status.phases.plugin_warmup, "ready");
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("startup refresh reruns provider warmup and degrades on failed checks", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-provider-warmup-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-provider-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    secretResolver: readySecretResolver,
  });
  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Broken Startup Relay",
      providerId: "broken-startup-relay",
      model: "broken-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      authHeader: false,
      enabled: true,
      capabilities: ["chat"],
      input: ["text"],
    });

    await postJson(`${baseUrl}/startup/refresh?cwd=${encodeURIComponent(cwd)}`);
    const status = await waitForStartupPhase(baseUrl, "provider_warmup", "degraded");
    assert.equal(status.state, "degraded");
    assert.ok(status.diagnostics.some((diagnostic) => diagnostic.code === "provider_startup_check_failed"));
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("daemon startup marks invalid workspace runtime policy as failed", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-runtime-failed-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-runtime-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    secretResolver: readySecretResolver,
  });
  try {
    await mkdir(resolve(cwd, ".ling-stack"), { recursive: true });
    await writeFile(resolve(cwd, ".ling-stack", "runtime-settings.json"), JSON.stringify({
      workspaceId: "workspace_default",
      defaultRunnerId: "missing-runner",
      allowedRunnerIds: ["missing-runner"],
    }), "utf8");

    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const status = daemon.startupState.snapshot(cwd);
    assert.equal(status.state, "failed");
    assert.equal(status.phases.workspace_store, "ready");
    assert.equal(status.phases.effective_config, "failed");
    assert.equal(status.phases.runtime_policy, "failed");
    assert.ok(status.diagnostics.some((diagnostic) => diagnostic.code === "effective_config_load_failed"));

    const body = await getJson(`${baseUrl}/startup/status?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(body.state, "failed");
    assert.equal(body.phases.runtime_policy, "failed");
    assert.ok(body.diagnostics.some((diagnostic) => diagnostic.code === "effective_config_load_failed"));
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("run creation gate rejects failed startup runtime policy before durable claim", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-run-gate-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-startup-run-gate-user-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  let runnerStarted = false;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    secretResolver: readySecretResolver,
    runner: {
      async runTask() {
        runnerStarted = true;
        return { taskId: "unexpected", events: [], messages: [] };
      },
    },
  });
  try {
    await mkdir(resolve(cwd, ".ling-stack"), { recursive: true });
    await writeFile(resolve(cwd, ".ling-stack", "runtime-settings.json"), JSON.stringify({
      workspaceId: "workspace_default",
      defaultRunnerId: "missing-runner",
      allowedRunnerIds: ["missing-runner"],
    }), "utf8");

    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const blocked = await postRunExpectError(`${baseUrl}/runs`, runBody(cwd, "task_runtime_policy_failed"));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "runtime_policy_invalid");
    assert.match(blocked.body.message, /missing-runner|runtime-settings/);
    assert.equal(runnerStarted, false);

    const runs = await getJson(`${baseUrl}/runs?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(runs.runs, []);
    const workUnits = await getJson(`${baseUrl}/work-units?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(workUnits.workUnits, []);
  } finally {
    if (previousLingStackHome === undefined) {
      delete process.env.LING_STACK_HOME;
    } else {
      process.env.LING_STACK_HOME = previousLingStackHome;
    }
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

const readySecretResolver = {
  status(ref) {
    return { ref, kind: ref.startsWith("keychain:") ? "keychain" : "env", configured: false, errorCode: "secret_missing" };
  },
  resolve(ref) {
    return { ref, configured: false, status: this.status(ref) };
  },
};

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function postJson(url, requestBody) {
  const response = await fetch(url, {
    method: "POST",
    ...(requestBody === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        }),
  });
  const responseBody = await response.json();
  assert.equal(response.ok, true, JSON.stringify(responseBody));
  return responseBody;
}

async function postRunExpectError(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.notEqual(response.status, 200, JSON.stringify(result));
  return { status: response.status, body: result };
}

function runBody(cwd, taskId) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "This run must be blocked by startup runtime policy.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["read"],
    thinkingLevel: "off",
  };
}

async function waitForStartupPhase(baseUrl, phase, expectedStatus) {
  const deadline = Date.now() + 2_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/startup/status`);
    if (latest.phases[phase] === expectedStatus) {
      return latest;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(`Timed out waiting for ${phase}=${expectedStatus}; latest=${JSON.stringify(latest)}`);
}
