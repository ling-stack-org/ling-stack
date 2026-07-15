import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildDeterministicTerminalReportContent,
  computeTerminalReportEvidenceFingerprint,
  createSqliteRunStore,
} from "../../core/dist/index.js";
import { createRunnerRegistry } from "../dist/index.js";
import { collectWorkflowTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
import { synthesizeTerminalReportContent } from "../dist/features/channels/terminal-report-synthesis.js";
import { createTerminalWorkflowFixture } from "./terminal-report-coordinator-fixture.mjs";

test("terminal report synthesis accepts valid strict JSON on the first attempt", async () => {
  await withSynthesisFixture(["valid"], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    runner.responses = [JSON.stringify(buildDeterministicTerminalReportContent(snapshot))];
    const result = await synthesizeTerminalReportContent({ store, snapshot, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(result.mode, "model");
    assert.equal(result.attemptCount, 1);
    assert.equal(result.content?.participants.length, 2);
    assert.equal(runner.runs[0].tools.length, 0);
    assert.match(runner.runs[0].systemPrompt, /strict JSON/u);
  });
});

test("terminal report synthesis repairs invalid JSON once", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    runner.responses = ["not-json", JSON.stringify(buildDeterministicTerminalReportContent(snapshot))];
    const result = await synthesizeTerminalReportContent({ store, snapshot, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(result.mode, "model");
    assert.equal(result.attemptCount, 2);
    assert.deepEqual(result.validationCodes, ["terminal_report_schema_invalid"]);
    assert.match(runner.runs[1].task.prompt, /Repair the previous invalid output/u);
  });
});

test("terminal report synthesis repairs unsupported claims and rejects hallucinated refs", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    const valid = buildDeterministicTerminalReportContent(snapshot);
    const unsupported = {
      ...valid,
      verification: [{
        id: "invented-check",
        title: "Production deploy",
        status: "passed",
        sourceRefs: [{ kind: "check", id: "invented-check", visibility: "conversation", sensitivity: "normal" }],
      }],
    };
    runner.responses = [JSON.stringify(unsupported), JSON.stringify(valid)];
    const repaired = await synthesizeTerminalReportContent({ store, snapshot, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(repaired.mode, "model");
    assert.ok(repaired.validationCodes.includes("terminal_report_source_ref_missing"));
    assert.ok(repaired.validationCodes.includes("terminal_report_unverified_success_claim"));

    runner.responses = [JSON.stringify(unsupported), JSON.stringify(unsupported)];
    const fallback = await synthesizeTerminalReportContent({ store, snapshot, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(fallback.mode, "deterministic_fallback");
    assert.equal(fallback.attemptCount, 2);
    assert.equal(fallback.fallbackReason, "terminal_report_synthesis_invalid_after_repair");
  });
});

test("terminal report synthesis restores evidence-bound file refs omitted by the model", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    const artifactRef = terminalReportRef("artifact", "artifact_workspace_file", "workspace output");
    const fileRef = terminalReportRef("file", "src/workspace.ts", "src/workspace.ts");
    const snapshotBody = {
      ...snapshot,
      operations: [...snapshot.operations, {
        id: "operation_workspace_file",
        kind: "edit",
        title: "Edit workspace file",
        status: "succeeded",
        changedPaths: ["src/workspace.ts"],
        sourceRefs: [artifactRef, fileRef],
      }],
      artifacts: [...snapshot.artifacts, {
        id: "artifact_workspace_file",
        kind: "file",
        title: "workspace output",
        path: "run_1/workspace-output.txt",
        changedPaths: ["src/workspace.ts"],
        status: "created",
        sourceRefs: [artifactRef, fileRef],
      }],
      evidenceFingerprint: undefined,
    };
    const boundSnapshot = {
      ...snapshotBody,
      evidenceFingerprint: computeTerminalReportEvidenceFingerprint(snapshotBody),
    };
    const valid = buildDeterministicTerminalReportContent(boundSnapshot);
    runner.responses = [JSON.stringify({
      ...valid,
      artifacts: valid.artifacts.map((artifact) => ({
        ...artifact,
        sourceRefs: artifact.sourceRefs.filter((ref) => ref.kind !== "file"),
      })),
    })];

    const result = await synthesizeTerminalReportContent({
      store,
      snapshot: boundSnapshot,
      runnerRegistry,
      secretResolver,
      timeoutMs: 100,
    });
    assert.equal(result.mode, "model");
    assert.ok(result.content?.artifacts.find((artifact) => artifact.id === "artifact_workspace_file")?.sourceRefs.some((ref) =>
      ref.kind === "file" && ref.id === "src/workspace.ts"
    ));
  });
});

test("terminal report synthesis times out directly to fallback", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, secretResolver }) => {
    const runner = new BlockingRunner();
    const runnerRegistry = registryFor(runner);
    const result = await synthesizeTerminalReportContent({ store, snapshot, runnerRegistry, secretResolver, timeoutMs: 10 });
    assert.equal(result.mode, "deterministic_fallback");
    assert.equal(result.attemptCount, 1);
    assert.equal(result.fallbackReason, "terminal_report_synthesis_timeout");
  });
});

test("terminal report synthesis falls back when no provider is runnable", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-no-provider-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "no-provider");
    const snapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: "2026-07-11T06:00:00.000Z" });
    const result = await synthesizeTerminalReportContent({
      store,
      snapshot,
      runnerRegistry: registryFor(new ScriptedRunner([])),
      secretResolver: dummySecretResolver,
      timeoutMs: 100,
    });
    assert.equal(result.mode, "deterministic_fallback");
    assert.equal(result.fallbackReason, "terminal_report_provider_unavailable");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function withSynthesisFixture(_responses, fn) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-synthesis-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "synthesis");
    const provider = store.createProviderPreset({
      kind: "openai-compatible",
      displayName: "Terminal Report Model",
      providerId: "terminal-report-model",
      model: "terminal-report-model",
      api: "openai-responses",
      capabilities: ["chat"],
      input: ["text"],
      authHeader: false,
      enabled: true,
    }, "2026-07-11T06:00:00.000Z");
    store.recordProviderCheckResult(provider.id, {
      ok: true,
      code: "static_check",
      message: "Provider configuration is valid.",
      checkedAt: "2026-07-11T06:00:00.000Z",
    });
    store.updateChannel(fixture.channel.id, { defaultProviderPresetId: provider.id }, "2026-07-11T06:00:00.000Z");
    const snapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: "2026-07-11T06:00:00.000Z" });
    const runner = new ScriptedRunner([]);
    await fn({ store, snapshot, runnerRegistry: registryFor(runner), runner, secretResolver: dummySecretResolver });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

function registryFor(runner) {
  return createRunnerRegistry([{
    id: "pi",
    displayName: "Pi",
    status: "enabled",
    adapter: runner,
    supportedProviderApis: ["openai-responses"],
    supportedTools: [],
  }]);
}

class ScriptedRunner {
  constructor(responses) {
    this.responses = responses.slice();
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    const response = this.responses.shift() ?? "";
    options.onEvent?.({ type: "assistant_text_delta", text: response });
    return { taskId: options.task.id, messages: [response], events: [] };
  }
}

class BlockingRunner {
  async runTask(options) {
    return new Promise((resolvePromise, rejectPromise) => {
      options.signal?.addEventListener("abort", () => rejectPromise(new Error("aborted")), { once: true });
    });
  }
}

const dummySecretResolver = {
  status(ref) {
    return { ref, kind: "env", configured: false };
  },
  resolve(ref) {
    return { ref, configured: false };
  },
};

function terminalReportRef(kind, id, label) {
  return { kind, id, label, visibility: "conversation", sensitivity: "normal" };
}
