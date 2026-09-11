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
import { buildTerminalReportPrompt } from "../dist/features/channels/terminal-report-prompt.js";
import { configureTerminalReportStore, processWorkflowTerminalReport } from "../dist/features/channels/terminal-report-coordinator.js";
import { createTerminalWorkflowFixture } from "./terminal-report-coordinator-fixture.mjs";

test("terminal report model input omits restricted section bodies and duplicate ref aliases", async () => {
  await withSynthesisFixture([], async ({ snapshot }) => {
    const ref = { kind: "artifact", id: "privacy-artifact", visibility: "developer_only", sensitivity: "secret_adjacent" };
    const publicAlias = { ...ref, visibility: "conversation", sensitivity: "normal" };
    const input = { ...snapshot, references: [...snapshot.references, ref, publicAlias] };
    for (const field of ["steps", "operations", "checks", "participants", "artifacts", "approvals", "risks"]) {
      input[field] = [...snapshot[field], {
        id: field === "artifacts" ? ref.id : `hidden-${field}`, agentId: "hidden-agent", kind: "artifact",
        title: `PRIVACY_SENTINEL_${field}`, summary: `PRIVACY_SENTINEL_${field}`,
        contributionSummaries: [`PRIVACY_SENTINEL_${field}`],
        sourceRefs: [publicAlias],
      }];
    }
    const before = structuredClone(input);
    const generated = buildTerminalReportPrompt(input);
    assert.doesNotMatch(generated.prompt, /PRIVACY_SENTINEL|privacy-artifact/u);
    assert.equal(generated.allowedSourceRefKeys.includes("artifact:privacy-artifact"), false);
    assert.match(generated.prompt, /Evidence snapshot:/u);
    assert.deepEqual(input, before, "model projection must not mutate Host evidence");
    assert.equal(buildTerminalReportPrompt({ ...input, references: [...input.references].reverse() })
      .allowedSourceRefKeys.includes("artifact:privacy-artifact"), false);
  });
});

test("terminal report synthesis repairs a model privacy downgrade before accepting content", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    const privateRef = { kind: "memory", id: "privacy-memory", visibility: "folded_evidence", sensitivity: "private" };
    const input = { ...snapshot, references: [...snapshot.references, privateRef] };
    const valid = buildDeterministicTerminalReportContent(input);
    runner.responses = [JSON.stringify({ ...valid, references: valid.references.map((ref) =>
      ref.id === privateRef.id ? { ...ref, sensitivity: "normal" } : ref) }), JSON.stringify(valid)];
    const result = await synthesizeTerminalReportContent({ store, snapshot: input, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(result.mode, "model");
    assert.equal(result.attemptCount, 2);
    assert.ok(result.validationCodes.includes("terminal_report_privacy_violation"));
    assert.equal(result.content.references.find((ref) => ref.id === privateRef.id)?.sensitivity, "private");
  });
});

test("withheld checks do not force a privacy-safe model report into repair and fallback", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    const checkRef = { kind: "check", id: "check-private-synthesis", visibility: "conversation" };
    const hiddenRef = { ...checkRef, visibility: "developer_only", sensitivity: "secret_adjacent" };
    const input = { ...snapshot,
      checks: [{ id: checkRef.id, title: "Private check", status: "passed", sourceRefs: [checkRef] }],
      references: [...snapshot.references, hiddenRef],
    };
    const valid = buildDeterministicTerminalReportContent(snapshot);
    runner.responses = [JSON.stringify({ ...valid, verification: [],
      references: valid.references.filter((ref) => ref.kind !== "check") })];
    const result = await synthesizeTerminalReportContent({ store, snapshot: input, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(result.mode, "model");
    assert.equal(result.attemptCount, 1);
    assert.deepEqual(result.content.verification, []);
    assert.equal(result.content.outcome.status, snapshot.terminalState);
    const modelSnapshot = JSON.parse(runner.runs[0].task.prompt.split("Evidence snapshot: ")[1]);
    assert.deepEqual(modelSnapshot.checks, []);
    assert.deepEqual(result.validationCodes, []);
  });
});

test("Host-bound participant text retains the privacy lineage omitted by the model", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    const restrictedRef = { kind: "memory", id: "host-private-contribution", visibility: "developer_only", sensitivity: "secret_adjacent" };
    const input = {
      ...snapshot,
      participants: snapshot.participants.map((participant, index) => index === 0 ? {
        ...participant,
        contributionSummaries: ["PRIVACY_SENTINEL Host contribution"],
        sourceRefs: [...participant.sourceRefs, restrictedRef],
      } : participant),
    };
    const original = structuredClone(input);
    const content = buildDeterministicTerminalReportContent(snapshot);
    runner.responses = [JSON.stringify(content)];
    const result = await synthesizeTerminalReportContent({ store, snapshot: input, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(result.mode, "model");
    const participant = result.content.participants.find((row) => row.agentId === input.participants[0].agentId);
    assert.match(participant.contribution, /PRIVACY_SENTINEL/u, "Host facts remain available in durable audit content");
    assert.ok(participant.sourceRefs.some((ref) => ref.id === restrictedRef.id && ref.visibility === "developer_only" && ref.sensitivity === "secret_adjacent"),
      "Host text must not be rebound without its original privacy policy");
    assert.doesNotMatch(runner.runs[0].task.prompt, /PRIVACY_SENTINEL|host-private-contribution/u);
    assert.deepEqual(input, original);
  });
});

test("Host-bound artifact refs retain restrictions and do not overwrite a model downgrade", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    const artifactRef = { kind: "artifact", id: "host-private-artifact", visibility: "developer_only", sensitivity: "secret_adjacent" };
    const fileRef = { kind: "file", id: "private-proof.txt", visibility: "conversation", sensitivity: "normal" };
    const input = { ...snapshot, artifacts: [...snapshot.artifacts, {
      id: artifactRef.id, kind: "file", title: "Host private artifact", path: "private-proof.txt",
      changedPaths: ["private-proof.txt"], status: "created", sourceRefs: [artifactRef, fileRef],
    }] };
    const original = structuredClone(input);
    const valid = buildDeterministicTerminalReportContent(snapshot);
    const artifact = { id: artifactRef.id, kind: "file", title: "Guessed artifact", sourceRefs: [] };
    runner.responses = [JSON.stringify({ ...valid, artifacts: [...valid.artifacts, artifact] })];
    const result = await synthesizeTerminalReportContent({ store, snapshot: input, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(result.mode, "model");
    const bound = result.content.artifacts.find((row) => row.id === artifactRef.id);
    assert.ok(bound.sourceRefs.some((ref) => ref.id === artifactRef.id && ref.visibility === "developer_only" && ref.sensitivity === "secret_adjacent"));
    assert.doesNotMatch(runner.runs[0].task.prompt, /host-private-artifact|private-proof/u);

    const downgraded = { ...artifact, sourceRefs: [{ ...artifactRef, visibility: "conversation", sensitivity: "normal" }] };
    runner.responses = [JSON.stringify({ ...valid, artifacts: [...valid.artifacts, downgraded] }), JSON.stringify(valid)];
    const repaired = await synthesizeTerminalReportContent({ store, snapshot: input, runnerRegistry, secretResolver, timeoutMs: 100 });
    assert.equal(repaired.mode, "model");
    assert.equal(repaired.attemptCount, 2, "Host enrichment must not overwrite a model downgrade before validation");
    assert.ok(repaired.validationCodes.includes("terminal_report_privacy_violation"));
    assert.deepEqual(input, original);
  });
});

for (const scenario of [
  { name: "first request timeout", invalidAttempts: 0, timeout: true, attempts: 1 },
  { name: "repair request timeout", invalidAttempts: 1, timeout: true, attempts: 2 },
  { name: "invalid output after repair", invalidAttempts: 2, timeout: false, attempts: 2 },
]) {
  test(`terminal report coordinator persists synthesis provenance after ${scenario.name}`, async () => {
    await withSynthesisFixture([], async ({ store, snapshot, runner, secretResolver }) => {
      runner.responses = Array(scenario.invalidAttempts).fill("not-json");
      const adapter = {
        async runTask(options) {
          return runner.responses.length > 0
            ? runner.runTask(options)
            : new BlockingRunner().runTask(options);
        },
      };
      configureTerminalReportStore(store, {
        enabled: true,
        runnerRegistry: registryFor(adapter),
        secretResolver,
        synthesisTimeoutMs: 20,
      });
      const result = await processWorkflowTerminalReport(store, snapshot.source.id);
      const persisted = store.getTerminalReport(result.record.id);
      const diagnostic = store.listRuntimeEvents(result.workUnit.id).find((event) =>
        event.type === "work_unit_progress" && event.data.synthesisMode
      ).data;
      assert.equal(persisted.status, "fallback");
      assert.equal(diagnostic.attemptCount, scenario.attempts);
      assert.equal(persisted.attemptCount, diagnostic.attemptCount);
      assert.equal(persisted.report.synthesis.attemptCount, diagnostic.attemptCount);
      assert.equal(persisted.report.synthesis.providerPresetId, diagnostic.providerPresetId);
      assert.equal(persisted.report.synthesis.model, diagnostic.model);
      assert.deepEqual(persisted.report.synthesis.validationCodes, diagnostic.validationCodes);
      assert.equal(diagnostic.fallbackReason, scenario.timeout
        ? "terminal_report_synthesis_timeout"
        : "terminal_report_synthesis_invalid_after_repair");
      assert.equal(store.getConversationItem(persisted.resultItemId).status, "committed");
      assert.equal(persisted.report.outcome.status, snapshot.terminalState);
      const repeated = await processWorkflowTerminalReport(store, snapshot.source.id);
      assert.equal(repeated.record.id, persisted.id);
      assert.deepEqual(repeated.record.report.synthesis, persisted.report.synthesis);
    });
  });
}

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

test("terminal report synthesis binds participant contributions to semantic Host evidence", async () => {
  await withSynthesisFixture([], async ({ store, snapshot, runnerRegistry, runner, secretResolver }) => {
    const qaRunId = snapshot.participants.find((participant) => participant.agentId === "qa")?.runIds[0];
    assert.ok(qaRunId);
    const rawCommand = "node -e \"const p=Buffer.from('c2Vuc2l0aXZlLXBhdGg=','base64').toString('utf8');if (!p) process.exit(1)\"";
    store.appendEvent(qaRunId, "tool_start", {
      toolCallId: "qa_raw_command",
      toolName: "bash",
      args: { command: rawCommand },
    });
    store.appendEvent(qaRunId, "tool_end", {
      toolCallId: "qa_raw_command",
      toolName: "bash",
      isError: false,
    });
    const evidenceSnapshot = collectWorkflowTerminalReportEvidence(store, snapshot.source.id, {
      generatedAt: "2026-07-11T06:00:00.000Z",
    });
    const valid = buildDeterministicTerminalReportContent(evidenceSnapshot);
    runner.responses = [JSON.stringify({
      ...valid,
      participants: valid.participants.map((participant) => participant.agentId === "qa"
        ? { ...participant, contribution: rawCommand }
        : participant),
    })];

    const result = await synthesizeTerminalReportContent({
      store,
      snapshot: evidenceSnapshot,
      runnerRegistry,
      secretResolver,
      timeoutMs: 100,
    });
    assert.equal(result.mode, "model");
    const qaContribution = result.content?.participants.find((participant) => participant.agentId === "qa")?.contribution ?? "";
    assert.equal(qaContribution, "Verified: verification (completed)");
    assert.doesNotMatch(qaContribution, /Buffer\.from|sensitive-path/u);
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
