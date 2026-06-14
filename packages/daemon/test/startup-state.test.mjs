import assert from "node:assert/strict";
import { test } from "node:test";
import { StartupStateRegistry } from "../dist/startup/state.js";

test("startup state derives required, degraded, and failed workspace states", () => {
  const registry = new StartupStateRegistry({
    startupAttemptId: "startup_test",
    now: () => new Date("2026-06-14T00:00:00.000Z"),
  });
  const cwd = "/tmp/ling-startup-state";

  assert.equal(registry.ensureWorkspace(cwd).state, "starting");
  for (const phase of ["process_config", "user_config", "workspace_store", "effective_config", "runtime_policy", "secret_resolver"]) {
    registry.setPhase(cwd, phase, "ready");
  }
  assert.equal(registry.snapshot(cwd).state, "ready");

  registry.setPhase(cwd, "provider_warmup", "degraded");
  assert.equal(registry.snapshot(cwd).state, "degraded");

  registry.setPhase(cwd, "runtime_policy", "failed");
  assert.equal(registry.snapshot(cwd).state, "failed");
});

test("startup diagnostics are bounded and repeated diagnostics are collapsed", () => {
  const registry = new StartupStateRegistry({
    startupAttemptId: "startup_test",
    maxDiagnosticsPerWorkspace: 3,
    now: () => new Date("2026-06-14T00:00:00.000Z"),
  });
  const cwd = "/tmp/ling-startup-diagnostics";

  for (let index = 0; index < 5; index += 1) {
    registry.addDiagnostic(cwd, {
      level: "warning",
      code: `diagnostic_${index}`,
      phase: "user_config",
      message: `Diagnostic ${index}`,
    });
  }
  assert.deepEqual(registry.snapshot(cwd).diagnostics.map((diagnostic) => diagnostic.code), [
    "diagnostic_2",
    "diagnostic_3",
    "diagnostic_4",
  ]);

  registry.addDiagnostic(cwd, {
    level: "error",
    code: "diagnostic_4",
    phase: "user_config",
    message: "Diagnostic 4 again",
  });
  const repeated = registry.snapshot(cwd).diagnostics.at(-1);
  assert.equal(repeated.code, "diagnostic_4");
  assert.equal(repeated.level, "error");
  assert.equal(repeated.count, 2);
  assert.equal(repeated.message, "Diagnostic 4 again");
});
