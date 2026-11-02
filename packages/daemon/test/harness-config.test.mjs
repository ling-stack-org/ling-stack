import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer, createHarnessFeatureSnapshot } from "../dist/index.js";

const harnessEnvNames = [
  "LING_STACK_HARNESS_CONTINUATIONS_MODE",
  "LING_STACK_HARNESS_TOOL_BROKER_MODE",
  "LING_STACK_HARNESS_EVALUATIONS_MODE",
  "LING_STACK_HARNESS_EVALUATION_MODEL_GATE",
  "LING_STACK_HARNESS_DELEGATIONS_MODE",
  "LING_STACK_HARNESS_DELEGATION_MAX_DEPTH",
];

test("harness features default off and produce an immutable run policy snapshot", (t) => {
  withHarnessEnvironment({}, () => {
    const daemon = createTestDaemon(t);
    assert.deepEqual(daemon.config.harness, {
      continuations: { mode: "off" },
      toolBroker: { mode: "off" },
      evaluations: { mode: "off", modelGate: "shadow" },
      delegations: { mode: "off", maxDepth: 4, selectedWorkflowIds: [] },
    });
    assert.deepEqual(createHarnessFeatureSnapshot(daemon.config), {
      schemaVersion: 1,
      continuations: "off",
      toolBroker: "off",
      evaluations: "off",
      evaluationModelGate: "shadow",
      delegations: "off",
      delegationMaxDepth: 4,
      delegationSelectedWorkflowIds: [],
    });
  });
});

test("harness environment modes are validated and delegation depth is bounded", (t) => {
  withHarnessEnvironment({
    LING_STACK_HARNESS_CONTINUATIONS_MODE: "shadow",
    LING_STACK_HARNESS_TOOL_BROKER_MODE: "enforce",
    LING_STACK_HARNESS_EVALUATIONS_MODE: "invalid",
    LING_STACK_HARNESS_EVALUATION_MODEL_GATE: "enforce",
    LING_STACK_HARNESS_DELEGATIONS_MODE: "shadow",
    LING_STACK_HARNESS_DELEGATION_MAX_DEPTH: "99",
  }, () => {
    const daemon = createTestDaemon(t);
    assert.deepEqual(daemon.config.harness, {
      continuations: { mode: "shadow" },
      toolBroker: { mode: "enforce" },
      evaluations: { mode: "off", modelGate: "enforce" },
      delegations: { mode: "shadow", maxDepth: 16, selectedWorkflowIds: [] },
    });
  });
});

test("explicit harness config wins over environment and invalid depth falls back safely", (t) => {
  withHarnessEnvironment({
    LING_STACK_HARNESS_CONTINUATIONS_MODE: "enforce",
    LING_STACK_HARNESS_TOOL_BROKER_MODE: "enforce",
    LING_STACK_HARNESS_EVALUATIONS_MODE: "enforce",
    LING_STACK_HARNESS_EVALUATION_MODEL_GATE: "enforce",
    LING_STACK_HARNESS_DELEGATIONS_MODE: "enforce",
    LING_STACK_HARNESS_DELEGATION_MAX_DEPTH: "12",
  }, () => {
    const daemon = createTestDaemon(t, {
      harness: {
        continuations: { mode: "off" },
        toolBroker: { mode: "shadow" },
        evaluations: { mode: "shadow", modelGate: "shadow" },
        delegations: { mode: "off", maxDepth: -1 },
      },
    });
    assert.deepEqual(daemon.config.harness, {
      continuations: { mode: "off" },
      toolBroker: { mode: "shadow" },
      evaluations: { mode: "shadow", modelGate: "shadow" },
      delegations: { mode: "off", maxDepth: 4, selectedWorkflowIds: [] },
    });
  });
});

test("malformed JavaScript config cannot escape the closed harness modes", (t) => {
  withHarnessEnvironment({
    LING_STACK_HARNESS_CONTINUATIONS_MODE: "enforce",
    LING_STACK_HARNESS_EVALUATION_MODEL_GATE: "enforce",
    LING_STACK_HARNESS_DELEGATION_MAX_DEPTH: "8junk",
  }, () => {
    const daemon = createTestDaemon(t, {
      harness: {
        continuations: { mode: "invalid" },
        evaluations: { modelGate: "invalid" },
      },
    });
    assert.equal(daemon.config.harness.continuations.mode, "off");
    assert.equal(daemon.config.harness.evaluations.modelGate, "shadow");
    assert.equal(daemon.config.harness.delegations.maxDepth, 4);
  });
});

/** Construction opens plugin Stores even before start(), so every case owns an isolated workspace. */
function createTestDaemon(t, config = {}) {
  const cwd = mkdtempSync(resolve(tmpdir(), "ling-harness-config-"));
  let daemon;
  t.after(async () => {
    try {
      await daemon?.stop();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, ...config, defaultWorkspaceCwd: cwd });
  return daemon;
}

function withHarnessEnvironment(values, callback) {
  const previous = Object.fromEntries(harnessEnvNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of harnessEnvNames) {
      const value = values[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    callback();
  } finally {
    for (const name of harnessEnvNames) {
      const value = previous[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
