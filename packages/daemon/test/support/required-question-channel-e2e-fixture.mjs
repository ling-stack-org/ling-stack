import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeterministicTerminalReportContent,
  createSqliteRunStore,
} from "../../../core/dist/index.js";
import { PiRunnerAdapter } from "../../../runner-pi/dist/index.js";
import { stream } from "../../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDaemonServer } from "../../dist/index.js";
import { listAllExecutionActionsForRun } from "../../dist/features/runs/execution-actions.js";
import { fileOperationCandidate } from "./channel-operation-candidate-fixture.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const QUESTION_PARTICIPANT_ID = "teammate_builtin_engineer";
const BARRIER_PARTICIPANT_ID = "teammate_builtin_qa";
const ENTRY_PARTICIPANT_ID = "ling_agent";
const QUESTION_PATH = "required-question-a.txt";
const BARRIER_PATH = "required-question-b.txt";
const ENTRY_PATH = "required-question-entry.txt";
const SOURCE_BODY = "@Engineer @QA 并行完成两个 required read：Engineer 回答必要问题后读取 required-question-a.txt；QA 读取 required-question-b.txt。两位都必须提供真实 read evidence 后才能完成。";

const REQUIRED_QUESTION = Object.freeze({
  schemaVersion: 1,
  waitMode: "required",
  questions: [{
    questionId: "scope",
    prompt: "Confirm the required continuation scope.",
    required: true,
    allowFreeText: true,
    options: [],
  }],
});

export async function createRequiredQuestionChannelFixture(t, options = {}) {
  const cwd = options.cwd ?? await mkdtemp(join(tmpdir(), "ling-required-question-channel-"));
  const ownsCwd = options.cwd === undefined;
  await writeFile(join(cwd, QUESTION_PATH), "question-participant-proof\n", "utf8");
  await writeFile(join(cwd, BARRIER_PATH), "barrier-participant-proof\n", "utf8");
  await writeFile(join(cwd, ENTRY_PATH), "parallel-entry-proof\n", "utf8");

  const stores = new Map();
  const runContext = new AsyncLocalStorage();
  const barrier = deferred();
  const barrierEvidenceReached = deferred();
  const participantRunIds = new Map();
  const providerCalls = [];
  const state = {
    created: undefined,
    sourceItem: undefined,
    turn: undefined,
    workflow: undefined,
    steps: undefined,
    question: undefined,
  };

  class RequiredQuestionPiRunner extends PiRunnerAdapter {
    async runTask(runOptions) {
      const store = stores.get(cwd);
      const run = runOptions.runId && store ? store.getRun(runOptions.runId) : undefined;
      const participantId = run?.teammateId;
      let participantRunOrdinal;
      if (participantId && runOptions.runId) {
        const runIds = participantRunIds.get(participantId) ?? [];
        if (!runIds.includes(runOptions.runId)) runIds.push(runOptions.runId);
        participantRunIds.set(participantId, runIds);
        participantRunOrdinal = runIds.indexOf(runOptions.runId) + 1;
      }
      return await runContext.run({
        runId: runOptions.runId,
        participantId,
        participantRunOrdinal,
        requestIndex: 0,
        systemPrompt: runOptions.systemPrompt ?? "",
      }, () => super.runTask(runOptions));
    }

    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, {
        api: "openai-completions",
        streamSimple: (model, context, streamOptions) => stream(model, context, {
          ...streamOptions,
          fetch: async (_url, request) => {
            const execution = runContext.getStore();
            assert.ok(execution, "scripted Pi transport requires an active Run context");
            execution.requestIndex += 1;
            const body = JSON.parse(request.body);
            const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
            providerCalls.push({
              runId: execution.runId,
              participantId: execution.participantId,
              participantRunOrdinal: execution.participantRunOrdinal,
              requestIndex: execution.requestIndex,
              toolNames,
              body,
            });

            if (/context segmentation policy proposer/i.test(execution.systemPrompt)) {
              return textResponse(JSON.stringify({ action: "uncertain", candidateSegmentIds: [] }));
            }
            if (/channel intent selector/i.test(execution.systemPrompt)) {
              return textResponse(JSON.stringify({
                action: "execute",
                reason: "Both explicitly mentioned required participants must produce independent read evidence.",
                execution: {
                  schemaVersion: 2,
                  operations: [
                    fileOperationCandidate({
                      id: "question_read",
                      kind: "file_read",
                      path: QUESTION_PATH,
                      sourceQuote: SOURCE_BODY,
                      owner: { participantId: QUESTION_PARTICIPANT_ID, sourceQuote: "Engineer" },
                    }),
                    fileOperationCandidate({
                      id: "barrier_read",
                      kind: "file_read",
                      path: BARRIER_PATH,
                      sourceQuote: SOURCE_BODY,
                      owner: { participantId: BARRIER_PARTICIPANT_ID, sourceQuote: "QA" },
                    }),
                  ],
                },
              }));
            }
            if (/terminal report synthesizer/i.test(execution.systemPrompt)) {
              const snapshotText = body.messages.map(messageText).join("\n")
                .match(/Evidence snapshot: (\{[^\n]+\})/u)?.[1];
              assert.ok(snapshotText, "TerminalReport synthesis must receive durable Host evidence");
              return textResponse(JSON.stringify(buildDeterministicTerminalReportContent(JSON.parse(snapshotText))));
            }

            if (execution.participantId === ENTRY_PARTICIPANT_ID && execution.participantRunOrdinal === 1) {
              assert.equal(options.parallelWorkflow, true, "only the explicit parallel fixture owns an entry participant");
              if (execution.requestIndex === 1) {
                assert.ok(toolNames.includes("read"), "the graph entry must execute a real read");
                return toolResponse("read", { path: ENTRY_PATH }, "parallel-entry-read");
              }
              assert.equal(execution.requestIndex, 2, "the entry must finish after one real read");
              return textResponse("The entry read is complete; Engineer and QA may run independently.");
            }

            if (execution.participantId === QUESTION_PARTICIPANT_ID && execution.participantRunOrdinal === 1) {
              assert.ok(
                toolNames.includes("request_user_input"),
                "initial required participant Run must advertise request_user_input",
              );
              assert.equal(execution.requestIndex, 1, "the initial participant must pause before any second Provider request");
              return toolResponse("request_user_input", REQUIRED_QUESTION, "required-question");
            }

            if (execution.participantId === QUESTION_PARTICIPANT_ID && execution.participantRunOrdinal === 2) {
              if (execution.requestIndex === 1) {
                assert.ok(toolNames.includes("read"), "answer successor must retain its required read tool");
                return toolResponse("read", { path: QUESTION_PATH }, "question-read");
              }
              assert.equal(execution.requestIndex, 2, "answer successor must finish after one real read");
              return textResponse("Engineer resumed after the answer and read the required proof file.");
            }

            if (execution.participantId === BARRIER_PARTICIPANT_ID && execution.participantRunOrdinal === 1) {
              if (execution.requestIndex === 1) {
                assert.ok(toolNames.includes("read"), "barrier participant must retain its required read tool");
                return toolResponse("read", { path: BARRIER_PATH }, "barrier-read");
              }
              assert.equal(execution.requestIndex, 2, "barrier participant must pause after one real read");
              barrierEvidenceReached.resolve();
              await bounded(barrier.promise, "QA terminal barrier", options.timeoutMs);
              return textResponse("QA read the required proof file and may now finish.");
            }

            assert.fail(`Unexpected scripted Pi request: ${JSON.stringify({
              runId: execution.runId,
              participantId: execution.participantId,
              participantRunOrdinal: execution.participantRunOrdinal,
              requestIndex: execution.requestIndex,
            })}`);
          },
        }),
      });
    }
  }

  let daemon;
  let runner;
  let url;
  let store;
  const daemonInstances = [];
  async function startDaemonInstance() {
    runner = new RequiredQuestionPiRunner();
    daemon = createDaemonServer({
      host: "127.0.0.1",
      port: 0,
      defaultWorkspaceCwd: cwd,
      harness: { toolBroker: { mode: "enforce" } },
      channels: {
        autoRoute: false,
        intentSelector: true,
        terminalReports: true,
        teamObserverBus: false,
      },
    }, {
      runner,
      storeFactory(storeCwd) {
        const store = createSqliteRunStore(storeCwd);
        stores.set(storeCwd, store);
        return store;
      },
    });
    await bounded(daemon.start(), "Daemon start", options.timeoutMs);
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    url = `http://127.0.0.1:${address.port}`;
    // Opening the public snapshot initializes a fresh Store through the new
    // Daemon's own registry, rather than reusing the previous connection.
    await requestJson(`${url}/control-plane/snapshot?cwd=${encodeURIComponent(cwd)}&domains=runs`, {}, [200]);
    store = stores.get(cwd);
    assert.ok(store);
    daemonInstances.push({ daemon, runner, store });
  }
  await startDaemonInstance();

  t.after(async () => {
    barrier.resolve();
    await bounded(daemon.stop(), "Daemon cleanup stop", options.timeoutMs);
    if (ownsCwd) await rm(cwd, { recursive: true, force: true });
  });

  const provider = (await postJson(`${url}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Required question scripted transport",
    providerId: "required-question-scripted",
    model: "required-question-scripted-model",
    api: "openai-completions",
    baseUrl: "https://required-question.invalid/v1",
    capabilities: ["chat", "tool_call"],
    input: ["text"],
    authHeader: false,
    reasoning: true,
    enabled: true,
  })).provider;
  store.recordProviderCheckResult(provider.id, {
    ok: true,
    code: "ready",
    message: "Local scripted Pi transport only",
    checkedAt: new Date().toISOString(),
  });

  const participants = [
    { id: QUESTION_PARTICIPANT_ID, label: "Engineer", path: QUESTION_PATH },
    { id: BARRIER_PARTICIPANT_ID, label: "QA", path: BARRIER_PATH },
  ];
  for (const participant of participants) {
    await patchJson(`${url}/teammates/${encodeURIComponent(participant.id)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
      allowedTools: ["read"],
    });
  }
  const channel = (await postJson(`${url}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Required question fan-in",
    status: "active",
    boundPath: cwd,
    defaultProviderPresetId: provider.id,
    autoReplyMode: "mentions_only",
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 2,
      schedulingMode: "smart",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  })).channel;
  for (const participant of participants) {
    await putJson(`${url}/teammates/${encodeURIComponent(participant.id)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
  }

  const fixture = {
    cwd,
    get url() { return url; },
    get store() { return store; },
    get daemonGeneration() { return daemonInstances.length; },
    channel,
    participants,
    providerCalls,
    get turn() { return state.turn; },
    get workflow() { return state.workflow; },
    get steps() { return state.steps; },
    transport: {
      providerCalls,
      barrierEvidenceReached: barrierEvidenceReached.promise,
      get barrierReached() { return barrierEvidenceReached.settled; },
      releaseParticipant(participantId) {
        assert.equal(participantId, BARRIER_PARTICIPANT_ID, "only the controlled QA participant has a terminal barrier");
        barrier.resolve();
      },
    },
    async postChannelTurn() {
      assert.notEqual(options.parallelWorkflow, true, "explicit parallel coverage must use postParallelWorkflow");
      assert.equal(state.created, undefined, "the fixture owns exactly one source channel Turn");
      const created = await postJson(`${url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
        body: SOURCE_BODY,
        mentions: participants.map((participant) => ({
          id: participant.id,
          label: participant.label,
          kind: "ai-teammate",
        })),
        requestAiReply: true,
      });
      assert.ok(created.autoStartedWorkflow, "the public channel Turn must start the required workflow");
      state.created = created;
      state.sourceItem = store.getConversationItem((created.userItem ?? created.message).id);
      assert.ok(state.sourceItem?.turnId);
      state.turn = store.getLingTurn(state.sourceItem.turnId);
      state.workflow = store.getChannelWorkflow(created.autoStartedWorkflow.workflow.id);
      state.steps = created.autoStartedWorkflow.workflowSteps;
      return created;
    },
    async postParallelWorkflow() {
      assert.equal(options.parallelWorkflow, true, "parallel graph must be selected before starting the fixture");
      assert.equal(state.created, undefined, "the fixture owns exactly one accepted workflow");
      const created = await postJson(`${url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
        title: "Required question explicit parallel fan-in",
        objective: "After the entry read, Engineer asks its required scope question and reads its proof; QA independently reads its proof. Both required siblings must finish.",
        providerPresetId: provider.id,
        autoStart: true,
        workflowGraph: {
          schemaVersion: 1,
          id: "required-question-parallel-graph",
          name: "Required question explicit parallel fan-in",
          entryNodeId: "entry",
          maxParallelSteps: 2,
          nodes: [
            { id: "entry", kind: "step", name: "Read the shared entry", teammateId: ENTRY_PARTICIPANT_ID,
              prompt: `Read ${ENTRY_PATH}, then finish so Engineer and QA can run independently.`,
              requiredTools: ["read"], autoStart: true, providerPresetId: provider.id },
            { id: "engineer", kind: "step", name: "Required Engineer question and read", teammateId: QUESTION_PARTICIPANT_ID,
              prompt: `Ask the required scope question, then read ${QUESTION_PATH} after the answer.`,
              requiredTools: ["read"], autoStart: true, providerPresetId: provider.id },
            { id: "qa", kind: "step", name: "Independent QA read", teammateId: BARRIER_PARTICIPANT_ID,
              prompt: `Independently read ${BARRIER_PATH}, then finish. Do not wait for Engineer's answer.`,
              requiredTools: ["read"], autoStart: true, providerPresetId: provider.id },
          ],
          edges: [
            { id: "entry-engineer", fromNodeId: "entry", toNodeId: "engineer", condition: { kind: "all_succeeded" } },
            { id: "entry-qa", fromNodeId: "entry", toNodeId: "qa", condition: { kind: "all_succeeded" } },
          ],
          termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
        },
      });
      assert.ok(created.workflow && Array.isArray(created.workflowSteps));
      state.created = created;
      state.workflow = created.workflow;
      state.steps = created.workflowSteps;
      await postJson(`${url}/workflows/${encodeURIComponent(created.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
      return created;
    },
    async waitForQuestion() {
      assert.ok(state.workflow, "a public channel Turn or workflow graph must start before waitForQuestion");
      await waitForCondition(() => {
        const sourceStep = state.steps
          .map((step) => store.getChannelWorkflowStep(step.id))
          .find((step) => step.toParticipantId === QUESTION_PARTICIPANT_ID);
        const workflowRun = sourceStep?.runId ? store.getRun(sourceStep.runId) : undefined;
        const sourceTurn = workflowRun ? store.getLingTurnForRun(workflowRun.id) : undefined;
        const sourceThread = sourceTurn ? store.getLingThread(sourceTurn.threadId) : undefined;
        const sourceCanonicalItem = sourceTurn?.sourceItemId
          ? store.getConversationItem(sourceTurn.sourceItemId)
          : undefined;
        const initialCall = providerCalls.find((call) => call.participantId === QUESTION_PARTICIPANT_ID
          && call.participantRunOrdinal === 1 && call.requestIndex === 1);
        if (initialCall && !initialCall.toolNames.includes("request_user_input")) {
          assert.fail(`Initial required participant model request omitted request_user_input. ${JSON.stringify({
            tools: initialCall.toolNames,
            runId: workflowRun?.id,
            runStatus: workflowRun?.status,
            runError: workflowRun?.errorMessage,
          })}`);
        }
        const item = sourceTurn
          ? store.listConversationItemsForTurn({ turnId: sourceTurn.id })
            .find((candidate) => candidate.kind === "user_input_request")
          : undefined;
        if (!item) {
          if (workflowRun && ["failed", "cancelled"].includes(workflowRun.status)) {
            assert.fail(`Initial required participant terminated without a durable question. ${JSON.stringify({
              runId: workflowRun.id,
              runStatus: workflowRun.status,
              runError: workflowRun.errorMessage,
            })}`);
          }
          return false;
        }
        const transcript = store.readUserInputTranscript({ threadId: item.threadId, itemIds: [item.id] })[0];
        if (transcript?.availability !== "available" || transcript.kind !== "user_input_request") return false;
        const request = store.getUserInputRequest(item.threadId, transcript.requestId);
        const requestRun = request && store.getRun(request.source.runId);
        const requestStep = request?.source.workflowStepId
          ? store.getChannelWorkflowStep(request.source.workflowStepId)
          : undefined;
        if (!request || !transcript.answerAuthority || !sourceThread || !sourceTurn || !sourceCanonicalItem
          || !requestRun || !sourceStep || !requestStep
          || request.source.runId !== requestRun.id || requestStep.id !== sourceStep.id
          || requestRun.id !== workflowRun?.id || requestRun.status !== "yielded"
          || requestStep.status !== "waiting_for_input") return false;
        state.question = {
          item,
          transcript,
          request,
          sourceRun: requestRun,
          sourceStep: requestStep,
          sourceThread,
          sourceTurn,
          sourceCanonicalItem,
        };
        return true;
      }, "durable required question and yielded source Run", options.timeoutMs, () => describeFixtureState(fixture));
      return state.question;
    },
    async answerQuestion(text = "Proceed with the required read.") {
      const question = state.question ?? await fixture.waitForQuestion();
      const result = await requestJson(`${url}/user-input-answers?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          authority: question.transcript.answerAuthority,
          idempotencyKey: `required-question-answer:${question.request.requestId}`,
          answers: [{ questionId: "scope", kind: "text", text }],
        }),
      }, [202]);
      return result.body;
    },
    releaseParticipant(participantId) {
      fixture.transport.releaseParticipant(participantId);
    },
    waitForCondition(predicate, label, timeoutMs = options.timeoutMs) {
      return waitForCondition(predicate, label, timeoutMs, () => describeFixtureState(fixture));
    },
    actionsForRun(runId) {
      return listAllExecutionActionsForRun(store, runId);
    },
    async restartDaemon() {
      const previous = daemonInstances.at(-1);
      await bounded(daemon.stop(), "Daemon restart stop", options.timeoutMs);
      stores.delete(cwd);
      await startDaemonInstance();
      const current = daemonInstances.at(-1);
      assert.notEqual(current.daemon, previous.daemon, "restart must construct a new Daemon");
      assert.notEqual(current.runner, previous.runner, "restart must construct a new Pi Runner");
      assert.notEqual(current.store, previous.store, "restart must reopen SQLite through a new Store");
      return { generation: daemonInstances.length };
    },
    async readWorkflowSteps() {
      const result = await requestJson(`${url}/workflows/${encodeURIComponent(state.workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`, {}, [200]);
      return result.body.workflowSteps;
    },
  };
  return fixture;
}

export async function waitForCondition(predicate, label, timeoutMs = DEFAULT_TIMEOUT_MS, describe) {
  const deadline = Date.now() + (timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await bounded(Promise.resolve().then(predicate), label, Math.max(1, deadline - Date.now()))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const detail = describe ? ` Latest: ${JSON.stringify(describe())}` : "";
  assert.fail(`Timed out waiting for ${label}.${detail}`);
}

async function bounded(promise, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs ?? DEFAULT_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function describeFixtureState(fixture) {
  const workflow = fixture.workflow && fixture.store.getChannelWorkflow(fixture.workflow.id);
  const steps = fixture.steps?.map((step) => {
    const current = fixture.store.getChannelWorkflowStep(step.id);
    const run = current?.runId ? fixture.store.getRun(current.runId) : undefined;
    return {
      id: current?.id,
      participantId: current?.toParticipantId,
      status: current?.status,
      runId: run?.id,
      runStatus: run?.status,
      errorMessage: run?.errorMessage,
      blocker: current?.blocker,
      delegatedOutcome: current?.metadata?.delegatedOutcome,
      actions: run ? fixture.actionsForRun(run.id).map((action) => ({
        id: action.id, actionType: action.actionType, status: action.status,
      })) : [],
    };
  });
  return {
    workflow: workflow && { id: workflow.id, status: workflow.status, completionGate: workflow.metadata?.completionGate?.status },
    turn: fixture.turn && fixture.store.getLingTurn(fixture.turn.id)?.status,
    steps,
    providerCalls: fixture.providerCalls.map((call) => ({
      runId: call.runId,
      participantId: call.participantId,
      participantRunOrdinal: call.participantRunOrdinal,
      requestIndex: call.requestIndex,
      toolNames: call.toolNames,
    })),
  };
}

function toolResponse(name, input, suffix) {
  return sseResponse({
    tool_calls: [{
      index: 0,
      id: `fixture-${suffix}`,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    }],
  }, "tool_calls");
}

function textResponse(content) {
  return sseResponse({ content }, "stop");
}

function sseResponse(delta, finishReason) {
  const chunk = { id: "required-question-fixture", object: "chat.completion.chunk", created: 1,
    model: "required-question-scripted-model" };
  return new Response(
    `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`
      + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function messageText(message) {
  return typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => typeof part.text === "string" ? part.text : "").join("\n")
      : "";
}

function deferred() {
  let settled = false;
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return {
    promise,
    get settled() { return settled; },
    resolve() {
      if (settled) return;
      settled = true;
      settle();
    },
  };
}

async function postJson(url, body) {
  const result = await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, [200, 201]);
  return result.body;
}

async function patchJson(url, body) {
  const result = await requestJson(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, [200]);
  return result.body;
}

async function putJson(url, body) {
  const result = await requestJson(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, [200]);
  return result.body;
}

async function requestJson(url, init, expectedStatuses) {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  const text = await response.text();
  assert.ok(expectedStatuses.includes(response.status), `${response.status} ${response.statusText}: ${text}`);
  return { response, body: text ? JSON.parse(text) : undefined };
}
