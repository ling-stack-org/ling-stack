import assert from "node:assert/strict";
import test from "node:test";
import {
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
