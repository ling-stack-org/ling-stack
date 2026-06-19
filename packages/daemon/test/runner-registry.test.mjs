import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultRunnerRegistry,
  createRunnerRegistry,
  DEFAULT_RUNNER_ID,
  LEGACY_PI_RUNNER_ID,
  UnsupportedRunnerError,
} from "../dist/index.js";

test("runner registry resolves default pi and legacy pi alias", () => {
  const runner = new RecordingRunner();
  const registry = createRunnerRegistry([{
    id: DEFAULT_RUNNER_ID,
    displayName: "Pi",
    status: "enabled",
    adapter: runner,
    aliases: [LEGACY_PI_RUNNER_ID],
    supportedProviderApis: ["openai-responses"],
    supportedTools: ["read"],
  }]);

  const defaultResolution = registry.resolve();
  assert.equal(defaultResolution.requestedRunnerId, DEFAULT_RUNNER_ID);
  assert.equal(defaultResolution.effectiveRunnerId, DEFAULT_RUNNER_ID);
  assert.equal(defaultResolution.requestSource, "product_default");
  assert.equal(defaultResolution.fallbackAllowed, false);
  assert.equal(defaultResolution.runner.adapter, runner);

  const legacyResolution = registry.resolve({ requestedRunnerId: LEGACY_PI_RUNNER_ID });
  assert.equal(legacyResolution.requestedRunnerId, DEFAULT_RUNNER_ID);
  assert.equal(legacyResolution.effectiveRunnerId, DEFAULT_RUNNER_ID);
  assert.equal(legacyResolution.runner.adapter, runner);
});

test("runner registry rejects duplicate ids and aliases", () => {
  const runner = new RecordingRunner();
  assert.throws(
    () => createRunnerRegistry([
      { id: "pi", displayName: "Pi", status: "enabled", adapter: runner },
      { id: "codex-app-server", displayName: "Codex", status: "enabled", adapter: runner, aliases: ["pi"] },
    ]),
    /Duplicate runner id or alias: pi/,
  );
});

test("runner registry fails explicit missing runner without fallback", () => {
  const registry = createRunnerRegistry([
    { id: "pi", displayName: "Pi", status: "enabled", adapter: new RecordingRunner() },
  ]);

  assert.throws(
    () => registry.resolve({ requestedRunnerId: "codex-app-server" }),
    (error) =>
      error instanceof UnsupportedRunnerError &&
      error.code === "unsupported_runner" &&
      error.fallbackReason.code === "missing_requested_runner",
  );
});

test("runner registry records fallback reason when policy allows fallback", () => {
  const piRunner = new RecordingRunner();
  const registry = createRunnerRegistry([
    { id: "pi", displayName: "Pi", status: "enabled", adapter: piRunner },
  ]);

  const resolution = registry.resolve({
    requestedRunnerId: "codex-app-server",
    allowFallback: true,
  });

  assert.equal(resolution.requestedRunnerId, "codex-app-server");
  assert.equal(resolution.effectiveRunnerId, "pi");
  assert.equal(resolution.requestSource, "run_request");
  assert.equal(resolution.fallbackAllowed, true);
  assert.equal(resolution.runner.adapter, piRunner);
  assert.equal(resolution.fallbackReason?.code, "missing_requested_runner");
});

test("runner registry applies explicit and implicit fallback policies", () => {
  const piRunner = new RecordingRunner();
  const registry = createRunnerRegistry([
    { id: "pi", displayName: "Pi", status: "enabled", adapter: piRunner },
  ]);

  assert.throws(
    () => registry.resolve({
      requestedRunnerId: "codex-app-server",
      requestSource: "run_request",
      explicitFallbackPolicy: "disabled",
      implicitFallbackPolicy: "allow_to_default",
    }),
    (error) => error instanceof UnsupportedRunnerError && error.fallbackReason.code === "missing_requested_runner",
  );

  const explicit = registry.resolve({
    requestedRunnerId: "codex-app-server",
    requestSource: "run_request",
    explicitFallbackPolicy: "allow_to_default",
  });
  assert.equal(explicit.effectiveRunnerId, "pi");
  assert.equal(explicit.requestSource, "run_request");
  assert.equal(explicit.fallbackAllowed, true);

  const implicit = registry.resolve({
    requestedRunnerId: "codex-app-server",
    requestSource: "workspace_default",
    implicitFallbackPolicy: "allow_to_default",
  });
  assert.equal(implicit.effectiveRunnerId, "pi");
  assert.equal(implicit.requestSource, "workspace_default");
  assert.equal(implicit.fallbackAllowed, true);
});

test("default runner registry exposes disabled future adapters and fails closed", () => {
  const piRunner = new RecordingRunner();
  const registry = createDefaultRunnerRegistry(piRunner);
  const runners = registry.list();
  assert.equal(runners.some((runner) => runner.id === "pi" && runner.status === "enabled"), true);
  assert.equal(runners.some((runner) => runner.id === "codex-app-server" && runner.status === "disabled"), true);
  assert.equal(runners.some((runner) => runner.id === "openclaw-acp" && runner.status === "disabled"), true);
  const pi = runners.find((runner) => runner.id === "pi");
  assert.equal(pi.toolHydration.mode, "unsupported");
  assert.equal(pi.toolHydration.supportsToolHydration, false);
  assert.equal(pi.toolHydration.conformance, "unverified");
  const codex = runners.find((runner) => runner.id === "codex-app-server");
  assert.equal(codex.featureFlag, "runners.codexAppServer.enabled");
  assert.equal(codex.disabledReason, "Feature flag is disabled.");

  assert.throws(
    () => registry.resolve({
      requestedRunnerId: "codex-app-server",
      explicitFallbackPolicy: "disabled",
    }),
    (error) =>
      error instanceof UnsupportedRunnerError &&
      error.fallbackReason.code === "disabled_requested_runner",
  );

  const fallback = registry.resolve({
    requestedRunnerId: "openclaw-acp",
    explicitFallbackPolicy: "allow_to_default",
  });
  assert.equal(fallback.requestedRunnerId, "openclaw-acp");
  assert.equal(fallback.effectiveRunnerId, "pi");
  assert.equal(fallback.fallbackAllowed, true);
  assert.equal(fallback.fallbackReason?.code, "disabled_requested_runner");
  assert.equal(fallback.runner.adapter, piRunner);
});

test("default runner registry exposes unified exec capability when configured", () => {
  const registry = createDefaultRunnerRegistry(new RecordingRunner(), {
    runtimeTools: {
      unifiedExec: true,
    },
  });
  const pi = registry.list().find((runner) => runner.id === "pi");
  assert.equal(pi.capabilities.includes("runtime:unified-exec"), true);
});

test("pi runner exposes daemon-hydrated tools only after the feature and conformance gates pass", () => {
  const halfEnabled = createDefaultRunnerRegistry(new RecordingRunner(), {
    runners: {
      pi: {
        toolHydration: {
          enabled: true,
        },
      },
    },
  }).list().find((runner) => runner.id === "pi");

  assert.equal(halfEnabled.toolHydration.mode, "unsupported");
  assert.equal(halfEnabled.toolHydration.conformance, "unverified");
  assert.equal(halfEnabled.capabilities.includes("runtime:tool-hydration"), false);

  const verified = createDefaultRunnerRegistry(new RecordingRunner(), {
    runners: {
      pi: {
        toolHydration: {
          enabled: true,
          conformancePassed: true,
          maxHydratedToolsPerRun: 12,
        },
      },
    },
  }).list().find((runner) => runner.id === "pi");

  assert.equal(verified.toolHydration.mode, "daemon_hydrated");
  assert.equal(verified.toolHydration.supportsNamespaceSearch, true);
  assert.equal(verified.toolHydration.supportsToolHydration, true);
  assert.equal(verified.toolHydration.conformance, "verified");
  assert.equal(verified.toolHydration.maxHydratedToolsPerRun, 12);
  assert.equal(verified.capabilities.includes("runtime:tool-hydration"), true);
});

test("pi runner exposes platform-native sandbox binding only behind an explicit feature gate", () => {
  const defaultPi = createDefaultRunnerRegistry(new RecordingRunner()).list().find((runner) => runner.id === "pi");
  assert.equal(defaultPi.capabilities.includes("runtime:platform-native-sandbox"), false);

  const sandboxedPi = createDefaultRunnerRegistry(new RecordingRunner(), {
    runners: {
      pi: {
        sandboxBinding: {
          enabled: true,
        },
      },
    },
  }).list().find((runner) => runner.id === "pi");
  assert.equal(sandboxedPi.capabilities.includes("runtime:platform-native-sandbox"), true);
});

test("future runner feature flags do not enable adapters without conformance", () => {
  const registry = createDefaultRunnerRegistry(new RecordingRunner(), {
    runners: {
      codexAppServer: {
        enabled: true,
        baseUrl: "http://127.0.0.1:12345",
      },
      openclawAcp: {
        enabled: true,
        endpoint: "http://127.0.0.1:23456",
      },
    },
  });
  const runners = registry.list();
  const codex = runners.find((runner) => runner.id === "codex-app-server");
  const openclaw = runners.find((runner) => runner.id === "openclaw-acp");
  assert.equal(codex.status, "disabled");
  assert.match(codex.disabledReason, /conformance has not passed/);
  assert.deepEqual(codex.capabilities.includes("native_resume"), true);
  assert.equal(openclaw.status, "disabled");
  assert.match(openclaw.disabledReason, /conformance has not passed/);
  assert.deepEqual(openclaw.capabilities.includes("mcp_tools"), true);

  assert.throws(
    () => registry.resolve({ requestedRunnerId: "codex-app-server", explicitFallbackPolicy: "disabled" }),
    (error) =>
      error instanceof UnsupportedRunnerError &&
      error.fallbackReason.code === "disabled_requested_runner",
  );
});

test("future runner conformance flag still fails closed until readiness is confirmed", () => {
  const registry = createDefaultRunnerRegistry(new RecordingRunner(), {
    runners: {
      codexAppServer: {
        enabled: true,
        baseUrl: "http://127.0.0.1:12345",
        conformancePassed: true,
      },
      openclawAcp: {
        enabled: true,
        endpoint: "http://127.0.0.1:23456",
        conformancePassed: true,
      },
    },
  });

  for (const runnerId of ["codex-app-server", "openclaw-acp"]) {
    const runner = registry.list().find((item) => item.id === runnerId);
    assert.equal(runner.status, "disabled");
    assert.match(runner.disabledReason, /readiness has not been confirmed/i);
    assert.throws(
      () => registry.resolve({ requestedRunnerId: runnerId, explicitFallbackPolicy: "disabled" }),
      (error) =>
        error instanceof UnsupportedRunnerError &&
        error.fallbackReason.code === "disabled_requested_runner",
    );
  }
});

test("future runner adapters become selectable only after all static gates pass", () => {
  const registry = createDefaultRunnerRegistry(new RecordingRunner(), {
    runners: {
      codexAppServer: {
        enabled: true,
        baseUrl: "http://127.0.0.1:12345",
        readinessPassed: true,
        conformancePassed: true,
      },
      openclawAcp: {
        enabled: true,
        endpoint: "http://127.0.0.1:23456",
        readinessPassed: true,
        conformancePassed: true,
      },
    },
  });

  for (const runnerId of ["codex-app-server", "openclaw-acp"]) {
    const runner = registry.list().find((item) => item.id === runnerId);
    assert.equal(runner.status, "enabled");
    const resolution = registry.resolve({ requestedRunnerId: runnerId, explicitFallbackPolicy: "disabled" });
    assert.equal(resolution.effectiveRunnerId, runnerId);
    assert.equal(resolution.runner.adapter, runner.adapter);
  }
});

test("runner registry enforces workspace allowed runners before fallback", () => {
  const registry = createRunnerRegistry([
    { id: "pi", displayName: "Pi", status: "enabled", adapter: new RecordingRunner() },
    { id: "codex-app-server", displayName: "Codex", status: "enabled", adapter: new RecordingRunner() },
  ]);

  assert.throws(
    () => registry.resolve({
      requestedRunnerId: "codex-app-server",
      allowedRunnerIds: ["pi"],
      requestSource: "run_request",
      explicitFallbackPolicy: "allow_to_default",
    }),
    (error) =>
      error instanceof UnsupportedRunnerError &&
      error.fallbackReason.code === "disabled_requested_runner" &&
      /not allowed/.test(error.message),
  );
});

test("runner registry enforces declared tool and provider conformance", () => {
  const registry = createRunnerRegistry([
    {
      id: "pi",
      displayName: "Pi",
      status: "enabled",
      adapter: new RecordingRunner(),
      supportedProviderApis: ["openai-responses"],
      supportedTools: ["read"],
    },
  ]);

  assert.throws(
    () => registry.resolve({ requestedRunnerId: "pi", providerApi: "anthropic-messages" }),
    (error) => error instanceof UnsupportedRunnerError && error.fallbackReason.code === "unsupported_provider_api",
  );
  assert.throws(
    () => registry.resolve({ requestedRunnerId: "pi", tools: ["write"] }),
    (error) => error instanceof UnsupportedRunnerError && error.fallbackReason.code === "unsupported_tool",
  );
});

class RecordingRunner {
  async runTask() {
    return { taskId: "task", events: [], messages: [] };
  }
}
