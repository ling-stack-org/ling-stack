import { appendChannelItemFixture, updateChannelItemFixture } from "../../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Document, Packer, Paragraph } from "docx";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, projectConversationItemToChannelMessage } from "../../../core/dist/index.js";
import { createWorkflowParticipantAuthorityV1 } from "../../../contracts/dist/index.js";
import { PiRunnerAdapter } from "../../../runner-pi/dist/index.js";
import { createDaemonServer } from "../../dist/index.js";
import { prepareChannelCreateBody } from "../conversation-model-test-fixture.mjs";
import { ensureGitRepoForChannelPost } from "../git-test-helpers.mjs";
import { commandOperationCandidate } from "./channel-operation-candidate-fixture.mjs";
import { prepareFixtureTaskInput } from "./prepared-input-fixture.mjs";
import { ToolFreePiRunner } from "./tool-free-pi-runner.mjs";

const require = createRequire(import.meta.url);

const ASYNC_SETTLE_TIMEOUT_MS = 10_000;

const TEST_RESTRICTED_NODE_PATH = realpathSync(process.execPath);

const TEST_RESTRICTED_NODE_SHA256 = createHash("sha256")
  .update(readFileSync(TEST_RESTRICTED_NODE_PATH))
  .digest("hex");

function withRestrictedCommandReadiness(config) {
  return {
    ...config,
    testVerifiedPiRunner: true,
    sandbox: {
      ...config.sandbox,
      restrictedCommands: {
        // These orchestration tests never execute this helper. They need a
        // Host-owned runtime identity so the fail-closed readiness gate can
        // admit the typed plan before their synthetic Runner emits evidence.
        inputHelper: {
          path: TEST_RESTRICTED_NODE_PATH,
          sha256: TEST_RESTRICTED_NODE_SHA256,
          version: "channel-workspace-readiness-v1",
        },
        executables: {
          node: {
            path: TEST_RESTRICTED_NODE_PATH,
            sha256: TEST_RESTRICTED_NODE_SHA256,
          },
        },
      },
    },
  };
}

class VerifiedExecutionTestRunner extends PiRunnerAdapter {
  constructor(delegate) {
    super();
    this.delegate = delegate;
  }

  async prepareTaskInput(options) {
    return this.delegate.prepareTaskInput?.(options) ?? prepareFixtureTaskInput(options);
  }

  async runTask(options) {
    return this.delegate.runTask(options);
  }
}

function projectionFor(item, assignment) {
  return {
    projectionVersion: `projection:${item.id}:${assignment.revision}`,
    sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
    threadId: item.threadId,
    turnId: item.turnId,
    segmentId: assignment.segmentId,
    throughItemSequence: item.sequence,
    summaryIds: [],
    sourceRefs: [
      { type: "thread", id: item.threadId },
      { type: "turn", id: item.turnId },
      { type: "conversation_item", id: item.id },
    ],
    policyVersion: "test-projector-v1",
    visibilityFingerprint: "channel_shared",
  };
}

async function readPdfFixtureBytes() {
  const content = "BT\n/F1 24 Tf\n100 700 Td\n(Ling PDF fixture) Tj\nET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function readDocxFixtureBytes() {
  const document = new Document({
    sections: [{ children: [new Paragraph("Walking on imported air")] }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

class SummaryAwareRunner {
  constructor() {
    this.runs = [];
    this.summaryRuns = [];
    this.replyRuns = [];
    this.failSummary = false;
  }

  async runTask(options) {
    this.runs.push(options);
    const summary = /conversation summary coordinator/i.test(options.systemPrompt ?? "");
    if (summary && this.failSummary) {
      this.summaryRuns.push(options);
      throw new Error("synthetic summary provider failure");
    }
    const text = summary
      ? JSON.stringify({
          objective: "Preserve the durable historical objective.",
          decisions: ["Use proactive summaries before provider rejection."],
          constraints: ["Keep the recent raw tail."],
          openQuestions: [],
        })
      : "Reply after proactive summary.";
    (summary ? this.summaryRuns : this.replyRuns).push(options);
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [{ role: "assistant", content: text }],
      events: [],
    };
  }
}

class RecordingRunner extends ToolFreePiRunner {
  constructor() {
    super();
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    return super.runTask(options, () => "Designer reply");
  }
}

class WorkflowEvidenceRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    const toolCallId = `workflow_read_${this.runs.length}`;
    options.onEvent?.({
      type: "tool_start",
      toolCallId,
      toolName: "read",
      args: { path: "package.json" },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId,
      toolName: "read",
      result: { path: "package.json", content: [{ type: "text", text: "fixture" }] },
      isError: false,
    });
    options.onEvent?.({ type: "assistant_text_delta", text: "Designer reply" });
    return {
      taskId: options.task.id,
      messages: ["Designer reply"],
      events: [],
    };
  }
}

class DelayedCommandEvidenceRunner {
  constructor(command) {
    this.command = command;
    this.executionRuns = [];
    this.selectorRuns = [];
    this.reportRuns = [];
    this.pendingExecution = undefined;
  }

  async runTask(options) {
    if (/terminal report synthesizer/i.test(options.systemPrompt ?? "")) {
      this.reportRuns.push(options);
      options.onEvent?.({ type: "assistant_text_delta", text: "{}" });
      return { taskId: options.task.id, messages: ["{}"], events: [] };
    }
    if (/channel intent selector/i.test(options.systemPrompt ?? "")) {
      this.selectorRuns.push(options);
      const text = JSON.stringify({
        action: "execute",
        reason: "The user explicitly requested one bounded command execution.",
        execution: this.selectorExecution ?? { schemaVersion: 2,
          operations: [commandOperationCandidate({ sourceQuote: this.command, command: this.command })] },
      });
      options.onEvent?.({ type: "assistant_text_delta", text });
      return { taskId: options.task.id, messages: [text], events: [] };
    }
    this.executionRuns.push(options);
    await new Promise((resolveExecution) => {
      this.pendingExecution = resolveExecution;
    });
    const toolCallId = "single_participant_node";
    options.onEvent?.({
      type: "tool_start",
      toolCallId,
      toolName: "bash",
      args: { command: this.command },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId,
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "proof:7319" }],
        details: {
          unifiedExec: {
            status: "succeeded",
            cwd: options.cwd,
            command: { kind: "shell", command: this.command, shell: "bash" },
            startedAt: "2026-11-02T00:00:00.000Z",
            endedAt: "2026-11-02T00:00:00.000Z",
            durationMs: 0,
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            stdout: { byteCount: 10, preview: "proof:7319", truncated: false },
            stderr: { byteCount: 0, preview: "", truncated: false },
            artifacts: [],
          },
        },
      },
      isError: false,
    });
    const text = "Verified proof:7319.";
    options.onEvent?.({ type: "assistant_text_delta", text });
    return { taskId: options.task.id, messages: [text], events: [] };
  }

  releaseExecution() {
    this.pendingExecution?.();
    this.pendingExecution = undefined;
  }
}

class MismatchedExactCommandRunner {
  constructor() {
    this.decisions = [];
    this.executionRuns = [];
  }

  async runTask(options) {
    if (/terminal report synthesizer/i.test(options.systemPrompt ?? "")) {
      options.onEvent?.({ type: "assistant_text_delta", text: "{}" });
      return { taskId: options.task.id, messages: ["{}"], events: [] };
    }
    if (/channel intent selector/i.test(options.systemPrompt ?? "")) {
      const text = JSON.stringify({
        action: "execute",
        reason: "The user explicitly requested one bounded command execution.",
        execution: { schemaVersion: 2, operations: [commandOperationCandidate({
          sourceQuote: "@QA 执行 `node app.js` 验证，并且必须提供真实 evidence。", command: "node app.js",
          owner: { participantId: "teammate_builtin_qa", sourceQuote: "QA" } })] },
      });
      options.onEvent?.({ type: "assistant_text_delta", text });
      return { taskId: options.task.id, messages: [text], events: [] };
    }

    this.executionRuns.push(options);
    const toolCallId = "mismatched_exact_command";
    const input = { command: "node -e \"console.log('semantic substitute')\"" };
    options.onEvent?.({ type: "tool_start", toolCallId, toolName: "bash", args: input });
    const decision = await options.onApprovalRequired?.({
      toolCallId,
      toolName: "bash",
      input,
      task: options.task,
      cwd: options.cwd,
    });
    this.decisions.push(decision);
    options.onEvent?.({
      type: "tool_end",
      toolCallId,
      toolName: "bash",
      result: { approved: decision?.approved, reason: decision?.reason },
      isError: !decision?.approved,
    });
    const text = decision?.approved ? "Unexpectedly executed substitute command." : "Blocked: exact command binding did not match.";
    options.onEvent?.({ type: "assistant_text_delta", text });
    return { taskId: options.task.id, messages: [text], events: [] };
  }
}

class DelayedFileCommandRunner {
  constructor() {
    this.executionRuns = [];
    this.selectorRuns = [];
    this.pendingResolvers = [];
  }

  async runTask(options) {
    if (/channel intent selector/i.test(options.systemPrompt ?? "")) {
      this.selectorRuns.push(options);
      const text = JSON.stringify({
        action: "execute",
        reason: "The user explicitly requested a file write followed by a Node verification.",
        execution: this.selectorExecution,
      });
      options.onEvent?.({ type: "assistant_text_delta", text });
      return { taskId: options.task.id, messages: [text], events: [] };
    }
    this.executionRuns.push(options);
    await new Promise((resolveExecution) => this.pendingResolvers.push(resolveExecution));
    const text = "Execution released for cleanup.";
    options.onEvent?.({ type: "assistant_text_delta", text });
    return { taskId: options.task.id, messages: [text], events: [] };
  }

  releaseAll() {
    this.pendingResolvers.splice(0).forEach((resolveExecution) => resolveExecution());
  }
}

class DirectToolRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    options.onEvent?.({
      type: "tool_start",
      toolCallId: "direct_read_package",
      toolName: "read",
      args: { path: "package.json" },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "direct_read_package",
      toolName: "read",
      result: { path: "package.json", content: [{ type: "text", text: "{\"name\":\"ling-stack\"}" }] },
      isError: false,
    });
    options.onEvent?.({ type: "assistant_text_delta", text: "Read package.json successfully." });
    return {
      taskId: options.task.id,
      messages: [{ role: "assistant", content: "Read package.json successfully." }],
      events: [],
    };
  }
}

class DirectApprovalRunner {
  constructor() {
    this.runs = [];
    this.decisions = [];
  }

  async runTask(options) {
    this.runs.push(options);
    options.onEvent?.({
      type: "tool_start",
      toolCallId: "direct_private_bash",
      toolName: "bash",
      args: { command: "printf private-approved" },
    });
    const decision = await options.onApprovalRequired?.({
      toolCallId: "direct_private_bash",
      toolName: "bash",
      input: { command: "printf private-approved" },
      task: options.task,
      cwd: options.cwd,
      defaultApproval: "ask",
    });
    assert.ok(decision);
    this.decisions.push(decision);
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "direct_private_bash",
      toolName: "bash",
      result: { approved: decision.approved },
      isError: !decision.approved,
    });
    if (!decision.approved) {
      throw new Error(decision.reason ?? "Private shell approval denied.");
    }
    const text = "Private shell check completed after approval.";
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [{ role: "assistant", content: text }],
      events: [],
    };
  }
}

class PromptEchoRunner extends ToolFreePiRunner {
  constructor() {
    super();
    this.runs = [];
  }

  async runTask(options) {
    return super.runTask(options, () => {
      this.runs.push(options);
      return options.task.prompt;
    });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class ScriptedRunner extends ToolFreePiRunner {
  constructor(responses) {
    super();
    this.responses = responses.slice();
    this.runs = [];
  }

  async runTask(options) {
    return super.runTask(options, () => {
      this.runs.push(options);
      const queuedResponse = this.responses.shift();
      const response = typeof queuedResponse === "function" ? queuedResponse(options) : queuedResponse;
      if (response instanceof Error) throw response;
      return response ?? "";
    });
  }
}

class SelectiveFailingRunner extends ToolFreePiRunner {
  constructor(failingTitles) {
    super();
    this.failingTitles = new Set(failingTitles);
    this.runs = [];
  }

  async runTask(options) {
    return super.runTask(options, () => {
      this.runs.push(options);
      if (this.failingTitles.has(options.task.title)) throw new Error(`${options.task.title} failed by test runner`);
      return `${options.task.title} complete`;
    });
  }
}

class DelayedRunner extends ToolFreePiRunner {
  constructor() {
    super();
    this.runs = [];
    this.completed = false;
    this.pending = undefined;
  }

  async runTask(options) {
    return super.runTask(options, async () => {
      this.runs.push(options);
      const text = await new Promise((resolve) => {
        this.pending = resolve;
      });
      this.completed = true;
      return text;
    });
  }

  resolve(text) {
    this.pending?.(text);
    this.pending = undefined;
  }
}

class AbortableDelayedRunner extends ToolFreePiRunner {
  constructor() {
    super();
    this.runs = [];
    this.abortCount = 0;
    this.pending = undefined;
  }

  async runTask(options) {
    return super.runTask(options, () => {
      this.runs.push(options);
      return new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        options.signal?.addEventListener("abort", () => {
          this.abortCount += 1;
          reject(new Error("aborted by test"));
        }, { once: true });
      });
    });
  }

  resolve(text) {
    this.pending?.resolve(text);
    this.pending = undefined;
  }
}

function readCurrentChannelUserMessage(prompt) {
  const matches = [...prompt.matchAll(/User message:\nTurn envelope:\nText:\n([^\n]+)/g)];
  return matches.at(-1)?.[1];
}

class ParallelDelayedRunner extends ToolFreePiRunner {
  constructor() {
    super();
    this.runs = [];
    this.pendingResolvers = [];
    this.startedResolvers = [];
    this.autoResolveText = undefined;
  }

  async runTask(options) {
    this.runs.push(options);
    this.startedResolvers.splice(0).forEach((resolveStarted) => resolveStarted());
    return super.runTask(options, async () => {
      return this.autoResolveText ?? new Promise((resolve) => this.pendingResolvers.push(resolve));
    });
  }

  async waitUntilStarted(count) {
    const deadline = Date.now() + ASYNC_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.runs.length >= count) {
        return;
      }
      await new Promise((resolve) => {
        this.startedResolvers.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    assert.fail(`Timed out waiting for ${count} parallel runs. Started: ${this.runs.length}`);
  }

  resolveAll(text) {
    this.autoResolveText = text;
    this.pendingResolvers.splice(0).forEach((resolvePending) => resolvePending(text));
  }
}

function testDaemonConfig(cwd) {
  return {
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd,
    runners: {},
    runtimeTools: {},
    channels: { autoRoute: false, intentSelector: false, terminalReports: false },
  };
}

function unusedRunnerRegistry() {
  return {
    get() {
      return undefined;
    },
    list() {
      return [];
    },
    resolve() {
      throw new Error("runner registry should not be used by deterministic route test");
    },
  };
}

async function assertInvalidModelPlan(baseUrl, cwd, channelId, sourceItemId, field) {
  const decisions = await getJson(`${baseUrl}/channels/${encodeURIComponent(channelId)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(sourceItemId)}`);
  assert.equal(decisions.decisions.length, 1);
  const decision = decisions.decisions[0];
  assert.equal(decision.action, "reply", "failed Host diagnostic only, not an accepted ordinary reply");
  assert.equal(decision.status, "failed");
  assert.equal(decision.errorCode, "channel_operation_plan_invalid");
  assert.equal(decision.createdBy, "model_policy");
  assert.equal(decision.execution, undefined);
  const observations = await getJson(`${baseUrl}/control-plane/events?cwd=${encodeURIComponent(cwd)}&domains=runners&limit=1000`);
  const rejected = observations.events.filter(event => event.entityType === "channel_intent_selection"
    && event.entityId === sourceItemId && event.data.outcome === "binding_rejected");
  assert.deepEqual(rejected.map(event => event.data.fields), [[field]]);
  const owned = observations.events.filter(event => event.entityType === "channel_intent_selection" && event.entityId === sourceItemId);
  assert.deepEqual(owned.filter(event => event.action === "channel_intent.request_started").map(event =>
    [event.data.requestOrdinal, event.data.purpose]), [[1, "initial"], [2, "binding_repair"]]);
  // ScriptedRunner has one response: its repair deliberately returns empty
  // text. Keep that parse failure distinct from a second binding rejection.
  assert.deepEqual(owned.filter(event => event.data.outcome === "intent_schema_rejected").map(event => event.data.requestOrdinal), [2]);
}

async function startDaemonForTest(runner, dependencies = {}, config = {}) {
  const { channels, testVerifiedPiRunner, ...restConfig } = config;
  const executionRunner = testVerifiedPiRunner && runner
    ? new VerifiedExecutionTestRunner(runner)
    : runner;
  const routedRunner = wrapTestRunnerContextSegmentation(executionRunner);
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    ...restConfig,
    channels: { intentSelector: false, terminalReports: false, ...channels },
  }, {
    ...dependencies,
    ...(routedRunner ? { runner: routedRunner } : {}),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    server: daemon.server,
    close: () => daemon.stop(),
  };
}

async function publishHostOpenAvailability(baseUrl, bridgeToken) {
  const response = await fetch(new URL("/desktop/capabilities/host/availability", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ling-desktop-bridge-token": bridgeToken,
    },
    body: JSON.stringify({
      protocol: "ling-host-capability-bridge/v1",
      desktopInstanceId: "desktop-channel-test",
      generation: 1,
      capabilities: ["host.open_local_target"],
      checkedAt: new Date().toISOString(),
    }),
  });
  assert.equal(response.status, 200, await response.text());
}

function wrapTestRunnerContextSegmentation(runner) {
  if (!runner) {
    return undefined;
  }
  runner.segmentationRuns ??= [];
  const routed = Object.create(runner);
  routed.prepareTaskInput = runner.prepareTaskInput?.bind(runner) ?? prepareFixtureTaskInput;
  routed.runTask = async (options) => {
    if (!/context segmentation policy proposer/i.test(options.systemPrompt ?? "")) {
      return runner.runTask(options);
    }
    runner.segmentationRuns.push(options);
    const configuredResponse = runner.segmentationResponses?.shift();
    const text = typeof configuredResponse === "function"
      ? configuredResponse(options)
      : configuredResponse ?? JSON.stringify({ action: "uncertain", candidateSegmentIds: [] });
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  };
  return routed;
}

function createParallelWorkflowStep(store, workflowId, title, metadata = {}) {
  return store.createChannelWorkflowStep(
    {
      workflowId,
      position: metadata.position ?? 1,
      title,
      prompt: `Complete ${title}.`,
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      participantAuthority: createWorkflowParticipantAuthorityV1({
        kind: "workflow_definition",
        origin: "workflow_graph",
        participantId: "teammate_builtin_engineer",
        sourceId: workflowId,
      }),
      status: metadata.status,
      metadata: {
        templateStepId: title.toLowerCase().replaceAll(" ", "-"),
        branchGroupId: metadata.branchGroupId,
        joinGroupId: metadata.joinGroupId,
        dependsOnStepIds: metadata.dependsOnStepIds,
        dependencyMode: metadata.dependencyMode,
        fanInPolicy: metadata.fanInPolicy,
        autoStart: metadata.autoStart,
        maxParallelSiblings: metadata.maxParallelSiblings,
        providerPresetId: metadata.providerPresetId,
        requiredTools: metadata.omitRequiredTools ? undefined : metadata.requiredTools ?? ["read"],
        approvalGate: metadata.approvalGate,
      },
    },
    new Date().toISOString(),
  );
}

function createStoreChannelAndMessage(store, cwd, body) {
  const now = "2026-06-11T00:00:00.000Z";
  const channel = store.createChannel({
    name: "Ling Agent Session",
    status: "active",
    boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  }, now);
  const message = appendChannelItemFixture(store, {
    channelId: channel.id,
    authorType: "local-user",
    body,
  }, now);
  return { channel, message };
}

function createActiveChannelReplyRunFixture(store, input) {
  const teammateId = input.teammateId ?? "ling_agent";
  const sourceMessage = appendChannelItemFixture(store, {
    channelId: input.channelId,
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    body: "Source message for the active channel reply.",
    status: "ready",
  }, "2026-06-11T00:00:55.000Z");
  const replyMessage = appendChannelItemFixture(store, {
    channelId: input.channelId,
    replyToItemId: sourceMessage.id,
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: teammateId,
    body: "",
    status: "pending",
  }, "2026-06-11T00:00:56.000Z");
  const workUnit = store.createWorkUnit({
    id: `wu_${input.runId}`,
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: sourceMessage.id,
    channelId: input.channelId,
    teammateId,
    idempotencyKey: `channel-reply-fixture:${input.runId}`,
    createdByActor: "system",
    request: { sourceMessageId: sourceMessage.id },
    linkedMessageId: replyMessage.id,
    now: "2026-06-11T00:00:57.000Z",
  });
  const run = store.createRun({
    id: input.runId,
    cwd: input.cwd,
    taskId: input.taskId,
    channelId: input.channelId,
    threadId: sourceMessage.threadId,
    teammateId,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: input.taskId, title: "Active work" },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: {
      cwd: input.cwd,
      sourceMessageId: sourceMessage.id,
      linkedMessageId: replyMessage.id,
    },
    workUnitId: workUnit.id,
    createdAt: "2026-06-11T00:01:00.000Z",
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, "2026-06-11T00:01:30.000Z");
  updateChannelItemFixture(store, replyMessage.id, { linkedRunId: run.id }, "2026-06-11T00:01:31.000Z");
  store.markRunStarted(run.id, "2026-06-11T00:02:00.000Z");
  return store.getRun(run.id);
}

function customTemplate(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "custom-template",
    name: "Custom Template",
    steps: [],
    ...overrides,
  };
}

async function createChannel(baseUrl, cwd) {
  return (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Engineering",
    status: "active",
    boundPath: cwd,
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      schedulingMode: "smart",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  })).channel;
}

async function setWorkspaceDefaultProvider(baseUrl, cwd, providerPresetId) {
  assert.ok(providerPresetId, "workspace default test setup requires a channel model");
  await patchJson(`${baseUrl}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
    defaultProviderPresetId: providerPresetId,
  });
}

async function createWorkflowTestChannel(baseUrl, cwd, name) {
  return (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name,
    status: "active",
    boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      schedulingMode: "smart",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  })).channel;
}

async function createAutoRouteTestChannel(baseUrl, cwd) {
  const provider = (await createStaticChatProvider(baseUrl, cwd)).provider;
  await postJson(`${baseUrl}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
  const channel = (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultProviderPresetId: provider.id,
    autoReplyMode: "auto_route",
    allowedTools: ["read"],
  })).channel;
  const teammateId = "teammate_builtin_designer";
  await patchJson(`${baseUrl}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
    providerPresetId: provider.id,
  });
  await putJson(`${baseUrl}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
    memberships: [{ channelId: channel.id }],
  });
  return channel;
}

async function createStaticChatProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

function simulateLegacyChannelWithoutModel(cwd, channelId) {
  const store = createSqliteRunStore(cwd);
  try {
    store.updateChannel(channelId, { defaultProviderPresetId: null }, new Date().toISOString());
  } finally {
    store.close();
  }
}

async function postTaskRunAndReadReadyRunId(baseUrl, cwd, taskId, body) {
  const response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/run?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const text = await response.text();
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:") && line.includes("runId"));
  assert.ok(dataLine, text);
  return JSON.parse(dataLine.slice("data:".length).trim()).runId;
}

function parseAcceptedPrivateSseEvents(text) {
  const [accepted, ...events] = parseSseEvents(text);
  assert.equal(accepted?.event, "accepted");
  const message = accepted.data.message;
  assert.ok(message.id);
  assert.ok(message.threadId);
  assert.equal(message.authorType, "local-user");
  assert.equal(message.status, "ready");
  assert.deepEqual(events[0]?.data.message, message);
  assert.equal(events[0]?.event, "ready");
  assert.equal(events.some(event => event.event === "accepted"), false);
  return events;
}

function privateReplyTextEvents(text) {
  const events = parseAcceptedPrivateSseEvents(text);
  for (const event of events.filter(event => event.event === "delta")) {
    assert.equal(typeof event.data.delta, "string");
    assert.equal(typeof event.data.body, "string");
    assert.equal(event.data.messageId, events[0].data.aiReply.id);
  }
  // A real SDK message_end also publishes narration metadata with no new text.
  return events.filter(event => event.event !== "delta" || event.data.delta !== "");
}

function parseSseEvents(text) {
  return text
    .split(/\n\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) {
        return undefined;
      }
      return {
        event: eventLine.slice("event:".length).trim(),
        data: projectCanonicalChannelConversationForTest(JSON.parse(dataLine.slice("data:".length).trim())),
      };
    })
    .filter(Boolean);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return projectCanonicalChannelConversationForTest(await response.json());
}

async function getArtifactJson(baseUrl, cwd, artifactId) {
  const response = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/content?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

function assertCoordinatorWorkflowStartReply(result) {
  assert.equal(result.aiReply.kind, "ai_reply");
  assert.equal(result.aiReply.threadId, result.message.threadId);
  assert.equal(result.aiReply.authorId, "ling_agent");
  assert.doesNotMatch(result.aiReply.body, /Starting now|现在开始处理|workflow_start\./u);
  const orchestration = result.autoStartedWorkflow?.orchestration;
  assert.ok(orchestration, `coordinator startup must have a dispatch result; reply=${result.aiReply.status}: ${result.aiReply.body}`);
  switch (orchestration.status) {
    case "started":
      assert.equal(result.aiReply.status, "ready");
      assert.match(result.aiReply.body, /^(?:Run started|Queued|运行已开始|已排队): .+/u);
      assert.ok((orchestration.startedSteps ?? [orchestration]).some((step) => step.runId));
      break;
    case "blocked":
    case "failed":
      assert.equal(result.aiReply.status, orchestration.status);
      assert.ok(result.aiReply.body.includes(orchestration.blocker));
      break;
    case "waiting_for_approval":
      assert.equal(result.aiReply.status, "blocked");
      assert.match(result.aiReply.body, /^(?:Waiting for approval to continue\.|等待审批后继续。)$/u);
      break;
    case "idle":
      assert.equal(result.aiReply.status, "ready");
      assert.ok(result.aiReply.body.includes(orchestration.reason));
      assert.match(result.aiReply.body, /^(?:Waiting:|等待：)/u);
      break;
    case "completed":
      assert.equal(result.aiReply.status, "ready");
      assert.match(result.aiReply.body, /^(?:Workflow: Completed|工作流: 已完成)$/u);
      break;
    default:
      assert.fail(`unasserted coordinator state: ${orchestration.status}`);
  }
  assert.doesNotMatch(result.aiReply.body, /主会话/);
  assert.doesNotMatch(result.aiReply.body, /工作证据|折叠证据摘要/);
}

function assertIntentDecisionInspectPayloadIsSafe(decision) {
  const allowedKeys = new Set([
    "schemaVersion",
    "id",
    "workspaceId",
    "channelId",
    "sourceTurnId",
    "sourceItemId",
    "contextSegmentId",
    "contextProjectionVersion",
    "action",
    "selectedTeammateIds",
    "participantManifest",
    "proposalId",
    "resultItemIds",
    "workflowId",
    "reason",
    "clarification",
    "execution",
    "status",
    "createdBy",
    "errorCode",
    "createdAt",
    "updatedAt",
  ]);
  const forbiddenKeys = [
    "prompt",
    "body",
    "messages",
    "contextPack",
    "systemPrompt",
    "taskPrompt",
    "proposal",
    "rawPrompt",
    "hiddenPrompt",
    "privateMessages",
    "artifactBody",
    "providerSecret",
    "providerSecrets",
    "apiKey",
    "apiKeyRef",
    "secretRef",
    "providerApiKey",
    "confidence",
    "score",
  ];
  for (const key of Object.keys(decision)) {
    assert.equal(allowedKeys.has(key), true, `unexpected intent inspect field: ${key}`);
  }
  for (const key of forbiddenKeys) {
    assert.equal(Object.hasOwn(decision, key), false, `unsafe intent inspect field exposed: ${key}`);
  }
}

function assertSingleReplyIntentDecision(decisions, sourceItemId) {
  assert.equal(decisions.length, 1);
  assertIntentDecisionInspectPayloadIsSafe(decisions[0]);
  assert.equal(decisions[0].schemaVersion, 2);
  assert.equal(decisions[0].sourceItemId, sourceItemId);
  assert.equal(decisions[0].action, "reply");
  assert.equal(decisions[0].status, "accepted");
}

async function waitForChannelMessageStatus(baseUrl, cwd, channelId, messageId, status, threadId) {
  const deadline = Date.now() + ASYNC_SETTLE_TIMEOUT_MS;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/channels/${encodeURIComponent(channelId)}/items?cwd=${encodeURIComponent(cwd)}${threadId ? `&threadId=${encodeURIComponent(threadId)}` : ""}`);
    const message = latest.messages.find((item) => item.id === messageId);
    if (message?.status === status) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for channel message ${messageId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function waitForCondition(predicate, label) {
  const deadline = Date.now() + ASYNC_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function waitForWorkflowStepStatus(baseUrl, cwd, workflowId, workflowStepId, status) {
  const deadline = Date.now() + ASYNC_SETTLE_TIMEOUT_MS;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const step = latest.workflowSteps.find((candidate) => candidate.id === workflowStepId);
    if (step?.status === status) {
      return step;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for workflow step ${workflowStepId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function settleParallelDelayedWorkflow(baseUrl, cwd, workflowId, runner, text, options = {}) {
  const deadline = Date.now() + ASYNC_SETTLE_TIMEOUT_MS;
  let latest;
  while (Date.now() < deadline) {
    runner.resolveAll(text);
    latest = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const runningSteps = latest.workflowSteps.filter((step) => step.status === "running");
    const queuedSteps = options.drainQueued ? latest.workflowSteps.filter((step) => step.status === "queued") : [];
    if (runningSteps.length === 0) {
      if (queuedSteps.length > 0) {
        await postJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
      const hasRunning = settled.workflowSteps.some((step) => step.status === "running");
      const hasQueued = options.drainQueued && settled.workflowSteps.some((step) => step.status === "queued");
      if (!hasRunning && !hasQueued) {
        return settled.workflowSteps;
      }
      continue;
    }
    await Promise.all(runningSteps.map((step) => waitForWorkflowStepStatus(baseUrl, cwd, workflowId, step.id, "succeeded")));
  }
  assert.fail(`Timed out waiting for parallel delayed workflow ${workflowId} to settle. Latest: ${JSON.stringify(latest)}`);
}

async function waitForWorkflowTemplateStepStatus(baseUrl, cwd, workflowId, templateStepId, status) {
  const deadline = Date.now() + ASYNC_SETTLE_TIMEOUT_MS;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const step = latest.workflowSteps.find((candidate) => candidate.metadata?.templateStepId === templateStepId);
    if (step?.status === status) {
      return step;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for workflow template step ${templateStepId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function approveWorkflowStepGate(baseUrl, cwd, workflowId, templateStepId) {
  const deadline = Date.now() + ASYNC_SETTLE_TIMEOUT_MS;
  let approval;
  let step;
  while (Date.now() < deadline) {
    const steps = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    step = steps.workflowSteps.find((candidate) => candidate.metadata?.templateStepId === templateStepId);
    assert.ok(step, `Expected workflow step for template step ${templateStepId}`);
    const approvals = await getJson(`${baseUrl}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(step.id)}`);
    approval = approvals.approvals[0];
    if (approval) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(approval, `Expected pending approval for workflow step ${templateStepId}`);
  assert.equal(approval.workflowStepId, step.id);
  assert.equal(approval.actionType, "workflow_step");
  assert.equal(approval.payload.type, "workflow_step");
  assert.equal(approval.payload.workflowStepId, step.id);
  const actions = await getJson(`${baseUrl}/execution-actions?cwd=${encodeURIComponent(cwd)}&status=waiting_for_approval`);
  assert.equal(actions.actions.some((action) => action.approvalId === approval.id && action.targetRefs.some((ref) => ref.type === "workflow_step" && ref.id === step.id)), true);
  await postJson(`${baseUrl}/approvals/${encodeURIComponent(approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
    reason: `approve ${templateStepId}`,
  });
  return await postJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
}

async function postJson(url, body) {
  const preparedBody = await prepareChannelCreateBody(url, body);
  await ensureGitRepoForChannelPost(url, preparedBody);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preparedBody),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return projectCanonicalChannelConversationForTest(await response.json());
}

function projectCanonicalChannelConversationForTest(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const decorations = Array.isArray(payload.decorations) ? payload.decorations : [];
  const decorationByItemId = new Map(decorations.map((decoration) => [decoration.itemId, decoration]));
  const projectItem = (item) => {
    const decoration = decorationByItemId.get(item.id);
    return {
      ...projectConversationItemToChannelMessage(item, {
        ...(decoration?.linkedRunId ? { linkedRunId: decoration.linkedRunId } : {}),
      }),
      ...(decoration?.editedAt ? { editedAt: decoration.editedAt } : {}),
      ...(decoration?.pendingReplacement ? { pendingReplacement: decoration.pendingReplacement } : {}),
      ...(decoration?.webEvidence ? { webEvidence: decoration.webEvidence } : {}),
    };
  };
  if (payload.userItem) {
    const message = projectItem(payload.userItem);
    const aiReplies = (payload.assistantItems ?? []).map(projectItem);
    return {
      ...payload,
      message,
      aiReplies,
      ...(aiReplies[0] ? { aiReply: aiReplies[0] } : {}),
    };
  }
  if (Array.isArray(payload.items)) {
    return {
      ...payload,
      messages: payload.items
        .filter((item) => item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "system_event")
        .map(projectItem),
    };
  }
  return payload;
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function deleteJson(url) {
  const response = await fetch(url, {
    method: "DELETE",
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response;
}

export {
  ASYNC_SETTLE_TIMEOUT_MS,
  AbortableDelayedRunner,
  DelayedCommandEvidenceRunner,
  DelayedFileCommandRunner,
  DelayedRunner,
  DirectApprovalRunner,
  DirectToolRunner,
  MismatchedExactCommandRunner,
  ParallelDelayedRunner,
  PromptEchoRunner,
  RecordingRunner,
  ScriptedRunner,
  SelectiveFailingRunner,
  SummaryAwareRunner,
  WorkflowEvidenceRunner,
  approveWorkflowStepGate,
  assertCoordinatorWorkflowStartReply,
  assertIntentDecisionInspectPayloadIsSafe,
  assertInvalidModelPlan,
  assertSingleReplyIntentDecision,
  createActiveChannelReplyRunFixture,
  createAutoRouteTestChannel,
  createChannel,
  createParallelWorkflowStep,
  createStaticChatProvider,
  createStoreChannelAndMessage,
  createWorkflowTestChannel,
  customTemplate,
  deleteJson,
  escapeRegExp,
  getArtifactJson,
  getJson,
  parseAcceptedPrivateSseEvents,
  parseSseEvents,
  patchJson,
  postJson,
  postTaskRunAndReadReadyRunId,
  privateReplyTextEvents,
  projectionFor,
  publishHostOpenAvailability,
  putJson,
  readCurrentChannelUserMessage,
  readDocxFixtureBytes,
  readPdfFixtureBytes,
  setWorkspaceDefaultProvider,
  settleParallelDelayedWorkflow,
  simulateLegacyChannelWithoutModel,
  startDaemonForTest,
  testDaemonConfig,
  unusedRunnerRegistry,
  waitForChannelMessageStatus,
  waitForCondition,
  waitForWorkflowStepStatus,
  waitForWorkflowTemplateStepStatus,
  withRestrictedCommandReadiness,
};
