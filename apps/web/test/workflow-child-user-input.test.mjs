import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { projectWorkflowChildTimeline } = await import("../src/lib/workflow-child-timeline.ts");
const { mergeWorkflowNarration, liveNarrationWorkflowIds } = await import("../src/lib/workflow-narration-refresh.ts");
const { buildWorkflowProgressModel, workflowProgressToConversationWorkCell } = await import("../src/lib/workflow-progress.ts");
const { conversationTimelineItemsForModel } = await import("../src/lib/conversation-work-cell.ts");
const { projectTimelineResponsePresentation } = await import("../src/shared/conversation/timeline/timeline-response-presentation.ts");

function fixture({ boundary = 3, messages = true } = {}) {
  const source = { workspaceId: "workspace", threadId: "child-thread", turnId: "child-turn", runId: "run", attemptId: "attempt",
    participantId: "engineer", workflowStepId: "step", workUnitId: "unit", sourceItemId: "child-source" };
  const position = { runId: "run", attemptId: "attempt", afterEventSequence: boundary,
    ...(boundary ? { afterEventId: "event-" + boundary } : {}) };
  const question = { availability: "available", kind: "user_input_request", itemId: "question", requestId: "request", requestVersion: 1,
    source, runEventPosition: position, status: "answered", statusRevision: 2, waitMode: messages ? "optional" : "required", createdAt: "time", updatedAt: "time",
    questions: [{ questionId: "q", prompt: "Choose format", options: [], required: true, allowFreeText: true }] };
  const answer = { availability: "available", kind: "user_input_answer", itemId: "answer", requestId: "request", requestVersion: 1,
    source, runEventPosition: position, answerId: "accepted", acceptedAt: "time", delivery: { status: "pending", revision: 1, updatedAt: "time" },
    answers: [{ questionId: "q", prompt: "Choose format", kind: "text", text: "Keep Markdown" }] };
  const anchors = [question, answer].map((record, index) => ({ schemaVersion: 1, id: record.itemId, ...source, channelId: "channel",
    sequence: 100 + index, kind: record.kind, actorType: index ? "local_user" : "teammate", actorId: index ? "user" : "engineer",
    status: "committed", revision: 1, visibility: "channel", domainRefs: [], createdAt: "time", updatedAt: "time",
    payload: { requestId: record.requestId, requestVersion: 1, ...(index ? { answerId: record.answerId } : {}), runEventPosition: position } }));
  const history = { ...source, parentItemId: "parent", parentThreadId: "parent-thread", items: anchors, userInputs: [question, answer] };
  const step = { id: "step", workspaceId: "workspace", channelId: "channel", workflowId: "workflow", position: 0, runId: "run",
    toParticipantId: "engineer", toParticipantLabel: "Engineer", status: "running", title: "Implement", prompt: "Implement",
    createdAt: "time", updatedAt: "time", runUserInputHistory: history,
    runNarration: { runId: "run", attemptId: "attempt", participantId: "engineer", workflowStepId: "step",
      threadId: "parent-thread", turnId: "parent-turn", sourceItemId: "parent", sourceItemSequence: 1,
      segments: messages ? [1, 9].map(seq => ({ content: seq === 1 ? "Before" : "After", firstEventId: "event-" + seq,
        lastEventId: "event-" + seq, startEventSequence: seq, endEventSequence: seq, completed: true })) : [] } };
  return { step, history, input: { steps: [step], rows: [], actions: [], participantId: "engineer", parentItemId: "parent" } };
}

test("Host-settled child steps expose one final response footer while live steps remain commentary", () => {
  for (const status of ["succeeded", "failed", "cancelled", "blocked", "skipped"]) {
    const { input, step } = fixture(); step.status = status;
    const items = projectWorkflowChildTimeline(input);
    const messages = items.filter((item) => item.kind === "agentMessage");
    assert.equal(messages[0].phase, "commentary");
    assert.equal(messages.at(-1).phase, "final", status);
    const footers = projectTimelineResponsePresentation(items).footerByItemId;
    assert.equal(footers.size, 1, status);
    assert.equal([...footers.values()][0].copyText, "Before\n\nAfter");
  }
  for (const status of ["running", "waiting_for_input", "waiting_for_approval"]) {
    const { input, step } = fixture(); step.status = status;
    const items = projectWorkflowChildTimeline(input);
    assert(items.filter((item) => item.kind === "agentMessage").every((item) => item.phase === "commentary"));
    assert.equal(projectTimelineResponsePresentation(items).footerByItemId.size, 0, status);
  }
});

test("production child projection interleaves its own Q/A between narrative events, not canonical seq 100", () => {
  const { input } = fixture();
  const rows = projectWorkflowChildTimeline(input);
  assert.deepEqual(rows.map(row => row.kind), ["agentMessage", "userInputRequest", "userInputAnswer", "agentMessage"]);
  assert.deepEqual(rows.map(row => row.partIndex), [0, 1, 2, 3]);
  assert.deepEqual(rows.filter(row => row.kind.startsWith("userInput")).map(row => row.itemId), ["question", "answer"]);
});
test("zero-event child questions display before any tools without creating completion evidence", () => {
  const { input, step } = fixture({ boundary: 0, messages: false });
  assert.deepEqual(projectWorkflowChildTimeline(input).map(row => row.kind), ["userInputRequest", "userInputAnswer"]);
  const progress = buildWorkflowProgressModel({ workflow: { id: "workflow", workspaceId: "workspace", channelId: "channel",
    title: "Task", objective: "Task", status: "running", metadata: { sourceMessageId: "parent" }, createdAt: "time", updatedAt: "time" },
    steps: [step], runs: [], approvals: [], artifactsByRun: {}, t: key => key });
  const child = conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(progress)).find(row => row.kind === "subAgentActivity");
  assert.deepEqual(child.childItems.map(row => row.kind), ["userInputRequest", "userInputAnswer"]);
  assert.equal(progress.status, "running");
  assert(progress.agentSpans[0].rows.every(row => !row.operationExecution), "plan rows are not tool evidence");
  assert(child.childItems.every(row => !row.actionId && row.status !== "succeeded"));
});
for (const field of ["workspaceId", "runId", "attemptId", "participantId", "workflowStepId", "parentItemId", "parentThreadId"]) {
  test("child history rejects mismatched " + field, () => {
    const { input, step } = fixture();
    step.runUserInputHistory = { ...step.runUserInputHistory, [field]: "foreign" };
    assert.equal(projectWorkflowChildTimeline(input).filter(row => row.kind.startsWith("userInput")).length, 0);
  });
}
test("missing boundary produces a content-free placement diagnostic, never a guessed answer position", () => {
  const { input, step } = fixture();
  step.runUserInputHistory = { ...step.runUserInputHistory,
    items: step.runUserInputHistory.items.map(item => ({ ...item, payload: { ...item.payload, runEventPosition: undefined } })),
    userInputs: step.runUserInputHistory.userInputs.map(record => ({ ...record, runEventPosition: undefined })) };
  const rows = projectWorkflowChildTimeline(input);
  assert.equal(rows.filter(row => row.kind.startsWith("userInput")).length, 0);
  const diagnostic = rows.find(row => row.code === "user_input_order_unavailable");
  assert(diagnostic);
  assert.equal(diagnostic.actionId, undefined);
  assert.doesNotMatch(JSON.stringify(diagnostic), /Keep Markdown|Choose format/);
});
test("history refresh changes answer state even when narration did not advance; late reads cannot roll back", () => {
  const { step } = fixture();
  const updated = structuredClone(step);
  updated.runUserInputHistory.userInputs[1].delivery = { status: "failed", revision: 3, updatedAt: "later" };
  const merged = mergeWorkflowNarration([step], [updated]);
  assert.equal(merged[0].runUserInputHistory.userInputs[1].delivery.status, "failed");
  const replay = mergeWorkflowNarration(merged, [step]);
  assert.equal(replay[0].runUserInputHistory.userInputs[1].delivery.revision, 3);
  const oldRun = { ...step, runId: "old", runUserInputHistory: { ...step.runUserInputHistory, runId: "old" } };
  assert.equal(mergeWorkflowNarration(merged, [oldRun]), merged);
});
test("workflow mutation merge cannot overwrite newer Q/A with the same Run's older hydration", async () => {
  const { mergeWorkflowSteps } = await import("../src/app/app-shell-selectors.ts");
  const { step } = fixture(), newer = structuredClone(step);
  newer.runUserInputHistory.userInputs[1].delivery = { status: "failed", revision: 4, updatedAt: "later" };
  const merged = mergeWorkflowSteps([newer], [{ ...step, status: "waiting_for_input" }]);
  assert.equal(merged[0].status, "waiting_for_input", "Host lifecycle update is still accepted");
  assert.equal(merged[0].runUserInputHistory.userInputs[1].delivery.revision, 4);
});
test("a revoked child history cannot regain body from a late poll", () => {
  const { step } = fixture();
  const revoked = mergeWorkflowNarration([step], [{ ...step, runUserInputHistory: null }]);
  const replay = mergeWorkflowNarration(revoked, [step]);
  assert(!JSON.stringify(replay[0].runUserInputHistory).includes("Keep Markdown"));
  assert.equal(projectWorkflowChildTimeline({ ...fixture().input, steps: replay }).filter(row => row.kind.startsWith("userInput")).length, 0);
});
test("full protocol refresh preserves revocation, accepts first questions, and drops removed steps", async () => {
  const { mergeWorkflowStepReadModels } = await import("../src/lib/workflow-narration-refresh.ts");
  const { step } = fixture();
  const empty = [{ ...step, runUserInputHistory: null }];
  const first = mergeWorkflowStepReadModels(empty, [step]);
  assert.equal(first[0].runUserInputHistory.userInputs.length, 2);
  const revoked = mergeWorkflowStepReadModels(first, [{ ...step, runUserInputHistory: null }]);
  assert(!JSON.stringify(mergeWorkflowStepReadModels(revoked, [step])).includes("Keep Markdown"));
  assert.deepEqual(mergeWorkflowStepReadModels(first, []), []);
  const retried = { ...step, runId: "new-run", updatedAt: "2026-09-08T01:00:00Z", runNarration: null, runUserInputHistory: null };
  const older = { ...step, updatedAt: "2026-09-08T00:00:00Z" };
  assert.equal(mergeWorkflowStepReadModels([retried], [older])[0], retried);
});
test("full protocol and mutation controllers use the shared read-model merger", async () => {
  const { readFile } = await import("node:fs/promises");
  const domain = await readFile(new URL("../src/domains/workspace/use-workspace-domain.ts", import.meta.url), "utf8");
  assert.match(domain, /read\.publish\(setChannelWorkflowSteps, current => mergeWorkflowStepReadModels\(current, workflowSteps\)\)/);
  const controller = await readFile(new URL("../src/app/use-channel-workflow-controller.ts", import.meta.url), "utf8");
  assert.doesNotMatch(controller, /item\.id === response\.workflowStep\.id \? response\.workflowStep/);
});
test("initial empty history can receive its first question without new narration", () => {
  const { step } = fixture({ boundary: 0, messages: false });
  const before = [{ ...step, runUserInputHistory: null }];
  const merged = mergeWorkflowNarration(before, [step]);
  assert.equal(merged[0].runUserInputHistory.userInputs[0].itemId, "question");
  assert.equal(merged[0].runNarration, before[0].runNarration);
});
test("waiting-for-input runs continue refreshing their question history", () => {
  const { step } = fixture();
  assert.deepEqual(liveNarrationWorkflowIds([{ ...step, status: "waiting_for_input" }], [{ id: "run", channelId: "channel", status: "yielded" }], "channel"), ["workflow"]);
  assert.deepEqual(liveNarrationWorkflowIds([step], [{ id: "run", channelId: "channel", status: "yielded" }], "channel"), []);
});
test("workflow waiting is active, never shown as completed or finished", () => {
  const { step } = fixture({ boundary: 0, messages: false });
  const progress = buildWorkflowProgressModel({ workflow: { id: "workflow", title: "Task", objective: "Task",
    status: "waiting_for_input", metadata: { sourceMessageId: "parent" }, createdAt: "time", updatedAt: "time" },
    steps: [{ ...step, status: "waiting_for_input" }], runs: [], approvals: [], artifactsByRun: {}, t: key => key });
  assert.equal(progress.mode, "active");
  assert.equal(progress.attention, "waiting");
  assert.equal(progress.agentSpans[0].tone, "waiting");
  assert.equal(progress.agentSpans[0].stateLabel, "waiting for user input");
});
test("display selection accepts question-only children, not empty workflow plan rows", async () => {
  const { hasWorkflowTimelineContent } = await import("../src/lib/workflow-timeline-content.ts");
  const childItems = projectWorkflowChildTimeline(fixture({ boundary: 0, messages: false }).input);
  assert(hasWorkflowTimelineContent({ kind: "subAgentActivity", childItems }));
  assert(!hasWorkflowTimelineContent({ kind: "subAgentActivity", childItems: [] }));
  assert(!hasWorkflowTimelineContent({ kind: "plan" }));
});
test("atomic read stays between accepted answer and follow-up narrative, with updates retaining its position", () => {
  const { step } = fixture();
  const action = { id: "read", workspaceId: "workspace", runId: "run", attemptId: "attempt", participantId: "engineer",
    workflowStepId: "step", actionType: "read", risk: "low", status: "succeeded", title: "Read file", summary: "Read file",
    revision: 6, sourceEventSequence: 5, targetRefs: [{ type: "file", path: "sample.ts" }], previewArtifactIds: [], resultArtifactIds: [],
    sourceRefs: [{ kind: "conversation_item", id: "parent" }], createdAt: "time",
    toolEvidence: { toolName: "read", inputSummary: "sample.ts", outputText: "const value = 1;", outputTruncated: false, latestEventSeq: 6 } };
  let before;
  for (const revision of [6, 999]) {
    const model = buildWorkflowProgressModel({ workflow: { id: "workflow", title: "Task", objective: "Task", status: "running",
      metadata: { sourceMessageId: "parent" }, createdAt: "time", updatedAt: "time" }, steps: [step], runs: [], approvals: [],
      artifactsByRun: {}, executionActions: [{ ...action, revision }], t: key => key });
    const rows = model.agentSpans[0].typedTimelineItems;
    assert.deepEqual(rows.map(row => row.kind), ["agentMessage", "userInputRequest", "userInputAnswer", "exploration", "agentMessage"]);
    assert.equal(rows[3].sourceEventSequence, 5);
    assert(rows.filter(row => row.kind.startsWith("userInput")).every(row => !row.actionId));
    if (before) assert.deepEqual(rows.map(row => row.id), before);
    before = rows.map(row => row.id);
  }
});
test("atomic child evidence remains visible when the run has no narration or user-input history", () => {
  const { step } = fixture();
  const action = { id: "read-without-narration", workspaceId: "workspace", runId: "run", attemptId: "attempt",
    participantId: "engineer", workflowStepId: "step", actionType: "read", risk: "low", status: "succeeded",
    title: "Read file", summary: "Read file", revision: 1, sourceEventSequence: 2,
    targetRefs: [{ type: "file", path: "sample.ts" }], previewArtifactIds: [], resultArtifactIds: [],
    sourceRefs: [{ kind: "conversation_item", id: "parent" }], createdAt: "time",
    toolEvidence: { toolName: "read", inputSummary: "sample.ts", outputText: "const value = 1;",
      outputTruncated: false, latestEventSeq: 2 } };
  const rows = projectWorkflowChildTimeline({
    steps: [{ ...step, runNarration: undefined, runUserInputHistory: undefined }],
    rows: [{ id: "action-row", kind: "read", title: "Read sample.ts", tone: "success",
      operationExecution: { actionId: action.id, revision: action.revision, runId: action.runId,
        attemptId: action.attemptId, participantId: action.participantId, workflowStepId: action.workflowStepId,
        status: action.status, actionType: action.actionType, sourceRefs: action.sourceRefs } }],
    actions: [action], participantId: "engineer", parentItemId: "parent",
  });
  assert.deepEqual(rows.map(row => row.kind), ["exploration"]);
  assert.equal(rows[0].actionId, action.id);
});
test("atomic child evidence uses verified row lineage when the workflow step omits its redundant run id", () => {
  const { step } = fixture();
  const action = { id: "read-linked-by-run-session", workspaceId: "workspace", runId: "run", attemptId: "attempt",
    participantId: "engineer", workflowStepId: "step", actionType: "read", risk: "low", status: "succeeded",
    title: "Read file", summary: "Read file", revision: 1, sourceEventSequence: 2,
    targetRefs: [{ type: "file", path: "sample.ts" }], previewArtifactIds: [], resultArtifactIds: [],
    sourceRefs: [{ kind: "conversation_item", id: "parent" }], createdAt: "time",
    toolEvidence: { toolName: "read", inputSummary: "sample.ts", outputText: "const value = 1;",
      outputTruncated: false, latestEventSeq: 2 } };
  const rows = projectWorkflowChildTimeline({
    steps: [{ ...step, runId: undefined, runNarration: undefined, runUserInputHistory: undefined }],
    rows: [{ id: "action-row", kind: "read", title: "Read sample.ts", tone: "success",
      operationExecution: { actionId: action.id, revision: action.revision, runId: action.runId,
        attemptId: action.attemptId, participantId: action.participantId, workflowStepId: action.workflowStepId,
        status: action.status, actionType: action.actionType, sourceRefs: action.sourceRefs } }],
    actions: [action], participantId: "engineer", parentItemId: "parent",
  });
  assert.deepEqual(rows.map(row => row.kind), ["exploration"]);
  assert.equal(rows[0].actionId, action.id);
});

function commandAt(sourceEventSequence) {
  const id = `command-${sourceEventSequence}`;
  const commandText = `node -e "console.log(${sourceEventSequence})"`;
  const sourceRefs = [{ kind: "conversation_item", id: "parent" }];
  const lineage = {
    actionId: id, revision: 1, runId: "run", attemptId: "attempt", participantId: "engineer",
    workflowStepId: "step", actionType: "bash", status: "succeeded", latestEventSeq: sourceEventSequence,
    sourceRefs,
  };
  return {
    action: {
      id, revision: 1, sourceEventSequence, workspaceId: "workspace", runId: "run", attemptId: "attempt",
      participantId: "engineer", workflowStepId: "step", actionType: "bash", risk: "low", status: "succeeded",
      title: "Ran command", summary: "Ran command", targetRefs: [{ type: "command", label: commandText }],
      previewArtifactIds: [], resultArtifactIds: [], sourceRefs, createdAt: `time-${sourceEventSequence}`,
    },
    row: {
      id: `row-${id}`, kind: "run_command", title: "Ran command", commandText, tone: "success",
      operationExecution: lineage,
      commandExecution: {
        ...lineage, risk: "low", commandText, exitCode: 0, timedOut: false,
        outputTail: [], outputTruncated: false,
      },
    },
  };
}

function projectCommands({ step, sequences, withContext = true }) {
  const commands = sequences.map(commandAt);
  return projectWorkflowChildTimeline({
    steps: [step], rows: commands.map((command) => command.row), actions: commands.map((command) => command.action),
    participantId: "engineer", parentItemId: "parent",
    ...(withContext ? { contextSegmentIdByItemId: new Map([["parent", "segment-1"]]) } : {}),
  });
}

test("three adjacent successful child commands batch only with committed context", () => {
  const { step } = fixture();
  const atomicStep = { ...step, runNarration: undefined, runUserInputHistory: undefined };
  const batched = projectCommands({ step: atomicStep, sequences: [1, 2, 3] });
  assert.deepEqual(batched.map((item) => item.kind), ["commandBatch"]);
  assert.deepEqual(batched[0].batch.commands.map((item) => item.actionId), ["command-1", "command-2", "command-3"]);
  assert.deepEqual(batched[0].batch.childItemIds, ["action:command-1", "action:command-2", "action:command-3"]);
  assert(batched[0].sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === "parent"));

  assert.deepEqual(
    projectCommands({ step: atomicStep, sequences: [1, 2, 3], withContext: false }).map((item) => item.kind),
    ["commandExecution", "commandExecution", "commandExecution"],
  );
});

test("child narration splits command batches before the display projection", () => {
  const { step } = fixture();
  const narratedStep = {
    ...step,
    runUserInputHistory: undefined,
    runNarration: {
      ...step.runNarration,
      segments: [1, 5, 9].map((sequence) => ({
        content: `Narration ${sequence}`, firstEventId: `event-${sequence}`, lastEventId: `event-${sequence}`,
        startEventSequence: sequence, endEventSequence: sequence, completed: true,
      })),
    },
  };
  const items = projectCommands({ step: narratedStep, sequences: [2, 3, 4, 6, 7, 8] });
  assert.deepEqual(items.map((item) => item.kind), ["agentMessage", "commandBatch", "agentMessage", "commandBatch", "agentMessage"]);
  assert.deepEqual(items.filter((item) => item.kind === "commandBatch").map((item) => item.batch.commandCount), [3, 3]);
});

test("child structured question and answer split adjacent command batches", () => {
  const { step } = fixture({ boundary: 4 });
  const items = projectCommands({ step, sequences: [2, 3, 4, 5, 6, 7] });
  assert.deepEqual(items.map((item) => item.kind), [
    "agentMessage", "commandBatch", "userInputRequest", "userInputAnswer", "commandBatch", "agentMessage",
  ]);
  assert.deepEqual(items.filter((item) => item.kind === "commandBatch").map((item) => item.batch.commandCount), [3, 3]);
});
