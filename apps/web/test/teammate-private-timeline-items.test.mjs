import assert from "node:assert/strict";
import { projectTimelineResponsePresentation } from "../src/shared/conversation/timeline/timeline-response-presentation.ts";
import test from "node:test";
import { projectTeammatePrivateTimelineItems } from "../src/features/teammates/teammate-private-timeline-items.ts";
import * as privateTimeline from "../src/features/teammates/teammate-private-timeline-items.ts";
import { batchCanonicalTranscriptItems, projectCanonicalConversationTimeline } from "@ling-stack/conversation-ui-core";
import { placeConversationTimelineDiagnostics } from "../src/domains/conversations/timeline-diagnostic-placement.ts";

function fixture() {
  const user = {
    id: "message:user:private-user", itemId: "private-user", kind: "userMessage", markdown: "Read then test.",
    threadSequence: 1, partIndex: 0, revision: 1, status: "succeeded", turnId: "turn-private",
    sourceRefs: [{ kind: "conversation_item", id: "private-user" }],
  };
  const facts = [41, 77, 84, 91].map((seq, index) => ({
    id: `action:read-${seq}`, actionId: `read-${seq}`, itemId: "private-user",
    kind: index === 3 ? "commandExecution" : "exploration", title: `action-${seq}`,
    runId: "run-private", attemptId: "attempt-private", participantId: "teammate-private", turnId: "turn-private",
    workflowStepId: null, revision: seq + 1, status: "succeeded", threadSequence: 1, partIndex: seq,
    sourceEventSequence: seq, sourceRefs: [{ kind: "conversation_item", id: "private-user" }, { kind: "execution_action", id: `read-${seq}` }],
    ...(index === 3 ? { command: "node --test", risk: "low", outputTail: [], exitCode: 0, outputTruncated: false }
      : { operation: "read", targets: [{ kind: "file", id: `/workspace/file-${index}.mjs`, path: `/workspace/file-${index}.mjs` }] }),
  }));
  const assistant = {
    id: "private-assistant", workspaceId: "workspace-private", teammateId: "teammate-private", threadId: "thread-private", authorType: "ai-teammate", authorId: "teammate-private",
    body: "Before first read. Before more reads. Verification complete.", status: "ready", revision: 1, linkedRunId: "run-private", fileRefs: [],
    narrationSegments: [
      { content: "Before first read.\n\nKeep `code` inline.", firstEventId: "evt-5", lastEventId: "evt-40", startEventSequence: 5, endEventSequence: 40, completed: true },
      { content: "Before more reads.", firstEventId: "evt-50", lastEventId: "evt-76", startEventSequence: 50, endEventSequence: 76, completed: true },
      { content: "Verification complete.", firstEventId: "evt-96", lastEventId: "evt-99", startEventSequence: 96, endEventSequence: 99, completed: true },
    ],
  };
  const messages = [{ message: { ...assistant, id: "private-user", authorType: "local-user", body: user.markdown, linkedRunId: undefined, narrationSegments: undefined }, body: user.markdown, facts: [] },
    { message: assistant, body: assistant.body, facts: [] }];
  return {
    user, facts, assistant,
    input: { messages, teammateId: "teammate-private", directThreadId: "thread-private", canonicalThreadId: "canonical-private",
      runs: [{ id: "run-private", teammateId: "teammate-private", threadId: "canonical-private" }],
      runLinks: [{ runId: "run-private", turnId: "turn-private", attemptNumber: 1, role: "primary" }],
      canonical: { items: [user, ...facts], contextSegmentIdByItemId: new Map([["private-user", "segment-private"]]) } },
  };
}

test("private canonical atomic facts interleave narration before shared batching", () => {
  const { input } = fixture();
  const atomic = projectTeammatePrivateTimelineItems(input);
  assert.deepEqual(atomic.map((item) => item.markdown ?? item.title), [
    "Read then test.", "Before first read.\n\nKeep `code` inline.", "action-41", "Before more reads.", "action-77", "action-84", "action-91", "Verification complete.",
  ]);
  assert.deepEqual(atomic.filter((item) => item.kind === "agentMessage").map((item) => item.sourceEventSequence), [5, 50, 96]);
  assert.equal(atomic.filter((item) => item.kind === "userMessage").length, 1);
  const batched = batchCanonicalTranscriptItems(atomic, { contextSegmentIdByItemId: input.canonical.contextSegmentIdByItemId });
  assert.equal(batched.some((item) => item.kind === "explorationBatch"), false, "Narration is a causal boundary, so the three reads must not be combined");
  assert.ok(atomic.filter((item) => item.kind === "agentMessage").every((item) => item.sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === "private-user")));
});

test("private segmented narration has explicit admitted speaker identity and one response footer", () => {
  const { input } = fixture();
  input.messages[1].message.narrationSegments = input.messages[1].message.narrationSegments.map((segment) => ({
    ...segment,
    source: {
      workspaceId: "workspace-private", threadId: "canonical-private", turnId: "turn-private",
      runId: "run-private", attemptId: "attempt-private", workUnitId: "unit-private", participantId: input.teammateId,
    },
  }));
  const items = projectTeammatePrivateTimelineItems(input);
  const messages = items.filter((item) => item.kind === "agentMessage");
  assert.ok(messages.every((item) => item.participantId === input.teammateId));
  const presentation = projectTimelineResponsePresentation(items);
  assert.deepEqual([...presentation.identityOwnerIds], [messages[0].id]);
  assert.equal(presentation.footerByItemId.size, 1);
  assert.equal([...presentation.footerByItemId.values()][0].logicalMessageCount, 1);
});

test("private narration without admitted source never inherits execution lineage from its author", () => {
  for (const patch of [undefined, { runId: "other-run" }, { turnId: "other-turn" },
    { participantId: "other-agent" }, { attemptId: "" }]) {
    const { input } = fixture();
    if (patch) input.messages[1].message.narrationSegments = input.messages[1].message.narrationSegments.map((segment) => ({
      ...segment,
      source: {
        workspaceId: "workspace-private", threadId: "canonical-private", turnId: "turn-private",
        runId: "run-private", attemptId: "attempt-private", workUnitId: "unit-private", participantId: input.teammateId,
        ...patch,
      },
    }));
    const items = projectTeammatePrivateTimelineItems(input);
    const messages = items.filter((item) => item.kind === "agentMessage");
    assert.equal(messages.length, 3);
    assert.ok(messages.every((item) => item.participantId === undefined && item.attemptId === undefined && item.workUnitId === undefined));
    assert.ok(messages.every((item) => item.sourceRefs.every((ref) => !["participant", "attempt", "work_unit"].includes(ref.kind))));
    const presentation = projectTimelineResponsePresentation(items);
    assert.deepEqual([...presentation.identityOwnerIds], [messages[0].id], "Only the same logical narration may continue its display identity");
    assert.equal(presentation.footerByItemId.size, 1);
  }
});

test("private canonical aggregate assistant is replaced by event segments, not duplicated", () => {
  const { input, assistant } = fixture();
  input.canonical.items.push({
    id: "message:agent:private-assistant", itemId: assistant.id, kind: "agentMessage", markdown: assistant.body,
    threadSequence: 2, partIndex: 0, revision: 1, status: "succeeded", turnId: "turn-private", runId: "run-private",
    sourceRefs: [{ kind: "conversation_item", id: assistant.id }],
  });
  const items = projectTeammatePrivateTimelineItems(input);
  const narration = items.filter((item) => item.kind === "agentMessage");
  assert.equal(narration.length, 3);
  assert.ok(narration.every((item) => item.markdown !== assistant.body));
});

test("private missing-anchor diagnostics survive and do not acquire fabricated conversation refs", () => {
  const { input } = fixture();
  const diagnostic = { id: "diagnostic:unanchored", kind: "diagnostic", title: "Activity unavailable", summary: "Missing conversation anchor.", status: "blocked", revision: 1, threadSequence: 0, partIndex: 0, runId: "run-private", sourceRefs: [{ kind: "run", id: "run-private" }] };
  input.canonical.items = [diagnostic];
  const items = projectTeammatePrivateTimelineItems(input);
  assert.equal(items.find((item) => item.id === diagnostic.id)?.summary, diagnostic.summary);
  assert.deepEqual(items.find((item) => item.id === diagnostic.id)?.sourceRefs, diagnostic.sourceRefs);
  assert.equal(items.filter((item) => item.kind === "agentMessage").length, 3);
  assert.ok(items.filter((item) => item.kind === "agentMessage").every((item) => item.sourceRefs.every((ref) => ref.kind !== "conversation_item")));
  assert.equal(items.some((item) => item.kind === "exploration" || item.kind === "explorationBatch"), false);
});

test("private displays real canonical missing-anchor diagnostics only for visible message runs", () => {
  const { input, facts } = fixture();
  input.canonical = projectCanonicalConversationTimeline({
    scope: { surface: "private", threadId: "thread-private", workspaceId: "workspace-private", depth: 0 },
    sourceSequence: 0, sourceRevision: "missing-private-anchors", items: [], turnRuns: input.runLinks,
    actions: [...facts.slice(0, 3), { ...facts[0], actionId: "hidden-action", runId: "run-hidden" }].map((fact) => ({
      id: fact.actionId, revision: fact.revision, workspaceId: "workspace-private", threadId: "thread-private",
      runId: fact.runId, attemptId: fact.attemptId, participantId: fact.participantId,
      actionType: "read", status: "succeeded", title: "Read file",
      sourceRefs: [{ kind: "run", id: fact.runId }, { kind: "execution_action", id: fact.actionId }],
    })),
  });
  assert.equal(input.canonical.items.length, 0);
  assert.equal(input.canonical.diagnostics.filter((diagnostic) => diagnostic.code === "missing_anchor").length, 4);
  const items = projectTeammatePrivateTimelineItems(input);
  const diagnostics = items.filter((item) => item.kind === "diagnostic");
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(diagnostics.map((item) => item.sourceRefs), input.canonical.diagnostics.slice(0, 3).map((diagnostic) => diagnostic.sourceRefs));
  assert.ok(diagnostics.every((item) => item.summary.includes("no conversation-item anchor") && item.runId === "run-private"));
  assert.ok(diagnostics.every((item) => item.status === "blocked"));
  assert.ok(diagnostics.every((item) => item.sourceRefs.every((ref) => ref.kind !== "conversation_item")));
  assert.ok(items.every((item) => item.kind !== "exploration" && item.kind !== "explorationBatch"));
  assert.deepEqual(projectTeammatePrivateTimelineItems(input).map((item) => item.id), items.map((item) => item.id));
});

test("private stale revision diagnostics retain audit text without blocking accepted canonical facts", () => {
  const { input } = fixture();
  input.messages[1].message.narrationSegments = undefined;
  const anchor = {
    id: "private-user", workspaceId: "workspace-private", threadId: "thread-private", turnId: "turn-private",
    sequence: 1, revision: 2, kind: "user_message", status: "committed", actorType: "local_user",
    payload: { body: "Read then test.", format: "markdown" },
  };
  const action = {
    id: "read-current", revision: 2, workspaceId: anchor.workspaceId, threadId: anchor.threadId,
    runId: "run-private", attemptId: "attempt-private", participantId: "teammate-private",
    actionType: "read", status: "succeeded", title: "Read current revision",
    sourceRefs: [{ kind: "conversation_item", id: anchor.id }, { kind: "run", id: "run-private" }, { kind: "file", id: "/workspace/current.mjs", path: "/workspace/current.mjs" }],
  };
  input.canonicalMessageIds = new Map([[anchor.id, "private-user"]]);
  input.canonical = projectCanonicalConversationTimeline({
    scope: { surface: "private", threadId: anchor.threadId, workspaceId: anchor.workspaceId, depth: 0 },
    sourceSequence: 1, sourceRevision: "accepted-private-revisions",
    items: [anchor, { ...anchor, revision: 1, payload: { body: "Stale user text." } }],
    actions: [action, { ...action, revision: 1, title: "Stale action title" }], turnRuns: input.runLinks,
  });
  assert.deepEqual(input.canonical.diagnostics.map((diagnostic) => diagnostic.code), ["stale_revision", "stale_revision"]);
  const items = projectTeammatePrivateTimelineItems(input);
  const diagnostics = items.filter((item) => item.kind === "diagnostic");
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((item) => item.status === undefined && item.title === "Activity"));
  assert.deepEqual(diagnostics.map((item) => item.sourceRefs), input.canonical.diagnostics.map((diagnostic) => diagnostic.sourceRefs));
  assert.deepEqual(diagnostics.map((item) => item.summary), input.canonical.diagnostics.map((diagnostic) => diagnostic.message));
  assert.deepEqual(items.filter((item) => item.kind === "exploration"), input.canonical.items.filter((item) => item.kind === "exploration"));
  assert.equal(items.find((item) => item.kind === "userMessage")?.markdown, "Read then test.");
});

test("private advisory diagnostics preserve exact ownership and never acquire terminal status", () => {
  const { input } = fixture();
  const diagnostics = ["stale_event", "late_event"].map((code) => ({
    code, sourceRefs: [{ kind: "run", id: "run-private" }, { kind: "run_event", id: `event-${code}` }],
    message: `Rejected lifecycle event: ${code}.`,
  }));
  input.canonical.diagnostics = [
    ...diagnostics,
    { ...diagnostics[0], sourceRefs: [{ kind: "run", id: "run-hidden" }, { kind: "message", id: "private-user" }] },
    { ...diagnostics[1], sourceRefs: [{ kind: "file", id: "private-user", path: "/workspace/current.mjs" }] },
  ];
  const displayed = projectTeammatePrivateTimelineItems(input).filter((item) => item.kind === "diagnostic");
  assert.equal(displayed.length, 2);
  assert.ok(displayed.every((item) => item.status === undefined && item.title === "Activity"));
  assert.deepEqual(displayed.map((item) => item.sourceRefs), diagnostics.map((diagnostic) => diagnostic.sourceRefs));
  assert.deepEqual(displayed.map((item) => item.summary), diagnostics.map((diagnostic) => diagnostic.message));
});

test("private live narration retains segment identities when the canonical snapshot arrives", () => {
  const { input } = fixture();
  const live = projectTeammatePrivateTimelineItems({ ...input, canonical: undefined });
  const refreshed = projectTeammatePrivateTimelineItems(input);
  assert.deepEqual(live.filter((item) => item.kind === "agentMessage").map((item) => item.id), refreshed.filter((item) => item.kind === "agentMessage").map((item) => item.id));
  assert.equal(live.filter((item) => item.kind === "agentMessage").length, 3);
  assert.ok(live.filter((item) => item.kind === "agentMessage").every((item) => item.sourceRefs.every((ref) => ref.kind !== "conversation_item")));
});

test("private edited canonical user uses its exact durable message relation", () => {
  const { input } = fixture();
  input.canonical.items[0] = { ...input.canonical.items[0], id: "message:user:revision-item", itemId: "revision-item", sourceRefs: [{ kind: "conversation_item", id: "revision-item" }] };
  input.canonicalMessageIds = new Map([["revision-item", "private-user"]]);
  input.canonical.items = input.canonical.items.map((item) => item.kind === "userMessage" ? item : { ...item, itemId: "revision-item", sourceRefs: [{ kind: "conversation_item", id: "revision-item" }] });
  const items = projectTeammatePrivateTimelineItems(input);
  assert.deepEqual(items.filter((item) => item.kind === "userMessage").map((item) => item.itemId), ["revision-item"]);
  assert.ok(items.filter((item) => item.kind === "agentMessage").every((item) => item.sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === "revision-item")));
});

test("private canonical loading is not a failure and loaded missing evidence fails closed", () => {
  const { input, facts } = fixture();
  input.canonical = undefined;
  input.messages[1].facts = facts;
  const loading = projectTeammatePrivateTimelineItems({ ...input, canonicalState: "loading" });
  assert.equal(loading.some((item) => item.kind === "diagnostic"), false);
  assert.equal(loading.some((item) => item.kind === "exploration"), false);
  const missing = projectTeammatePrivateTimelineItems({ ...input, canonicalState: "loaded" });
  assert.equal(missing.filter((item) => item.kind === "diagnostic").length, 1);
  assert.equal(missing.some((item) => item.kind === "exploration"), false);
});

test("private message owner filtering precedes chrome and never relabels foreign authors", () => {
  const { input, assistant } = fixture();
  const foreign = [
    { ...assistant, id: "foreign-owner", teammateId: "other-agent" },
    { ...assistant, id: "foreign-thread", threadId: "other-thread" },
    { ...assistant, id: "foreign-author", authorId: "other-agent" },
    { ...assistant, id: "missing-author", authorId: undefined },
    { ...assistant, id: "system-author", authorType: "system" },
  ].map((message) => ({ message, body: `secret-${message.id}`, facts: [] }));
  input.messages.push(...foreign);
  const output = projectTeammatePrivateTimelineItems(input);
  assert.equal(JSON.stringify(output).includes("secret-"), false);
  assert.ok(output.every((item) => !foreign.some(({ message }) => item.itemId === message.id)));
  const selected = privateTimeline.selectTeammatePrivateMessages(input.messages.map(({ message }) => message), input);
  const invokedMessageIds = [];
  const copyCallbacks = selected.map((message) => () => invokedMessageIds.push(message.id));
  copyCallbacks.forEach((invoke) => invoke());
  assert.deepEqual(invokedMessageIds, ["private-user", "private-assistant"]);
  assert.deepEqual(privateTimeline.selectTeammatePrivateMessages(selected, { ...input, directThreadId: undefined }), []);
  assert.deepEqual(privateTimeline.selectTeammatePrivateMessages(selected, { ...input, teammateId: "other-agent", directThreadId: "other-thread" }), []);
});

test("private explicit foreign runs cannot enter by matching the current turn", () => {
  const { input, facts } = fixture();
  input.canonical.items.push(
    { ...facts[0], id: "foreign-run-fact", runId: "other-run", title: "foreign-secret" },
    { ...facts[0], id: "foreign-participant-fact", participantId: "other-agent", title: "foreign-secret" },
    { ...facts[0], id: "foreign-ref-fact", sourceRefs: [{ kind: "run", id: "other-run" }], title: "foreign-secret" },
  );
  const output = projectTeammatePrivateTimelineItems(input);
  assert.equal(JSON.stringify(output).includes("foreign-secret"), false);
  assert.equal(output.filter((item) => item.kind === "exploration").length, 3);
});

test("private unverified linked runs retain owned text but publish no execution association", () => {
  for (const mutate of [
    (input) => { input.runs = []; },
    (input) => { input.runs[0].teammateId = "other-agent"; },
    (input) => { input.runs[0].threadId = "other-thread"; },
    (input) => { input.runs[0].channelId = "other-channel"; },
    (input) => { input.runs[0].workflowStepId = "other-step"; },
    (input) => { input.runLinks = []; },
    (input) => { input.runLinks.push({ ...input.runLinks[0], turnId: "other-turn" }); },
  ]) {
    const { input, assistant, facts } = fixture();
    input.messages[1].facts = facts;
    mutate(input);
    const output = projectTeammatePrivateTimelineItems(input);
    assert.deepEqual(output.filter((item) => item.kind === "agentMessage").map((item) => item.markdown), [assistant.body]);
    assert.ok(output.every((item) => item.kind === "userMessage" || item.kind === "agentMessage"));
    assert.ok(output.every((item) => !item.runId && !item.actionId));
    assert.equal(privateTimeline.selectTeammatePrivateMessages(input.messages.map(({ message }) => message), input)[1].linkedRunId, undefined);
  }
});

test("loaded canonical snapshot does not erase a sanitized unverified-link diagnostic", () => {
  const { input } = fixture();
  input.runs = [];
  input.messages[1].facts = [{ id: "untrusted-diagnostic", kind: "diagnostic", revision: 1,
    threadSequence: 0, partIndex: 0, status: "blocked", title: "untrusted-target-secret",
    summary: "Command batch lineage is incomplete.", actionId: "untrusted-action",
    runId: "untrusted-run", sourceRefs: [{ kind: "path", id: "untrusted-path-secret" }] }];
  const output = projectTeammatePrivateTimelineItems({ ...input, canonicalState: "loaded" });
  const diagnostics = output.filter(item => item.kind === "diagnostic");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].status, "blocked");
  assert.equal(diagnostics[0].summary, "Command batch lineage is incomplete.");
  assert.deepEqual(diagnostics[0].sourceRefs, []);
  assert.equal(diagnostics[0].runId, undefined);
  assert.equal(diagnostics[0].actionId, undefined);
  assert.equal(JSON.stringify(output).includes("untrusted-"), false);
  assert.equal(projectTeammatePrivateTimelineItems({ ...input, canonicalState: "loading" }).some(item => item.kind === "diagnostic"), false);
});

test("admitted private Run retains its sanitized missing-action notice beside canonical narration", () => {
  const { input } = fixture();
  input.messages[1].facts = [{ id: "legacy-incomplete", kind: "diagnostic", revision: 1,
    threadSequence: 0, partIndex: 0, status: "blocked", sourceRefs: [],
    summary: "Command batch lineage is incomplete." }];
  const output = projectTeammatePrivateTimelineItems({ ...input, canonicalState: "loaded" });
  assert.equal(output.filter(item => item.kind === "diagnostic").length, 1);
  assert.ok(output.some(item => item.kind === "agentMessage"));
  const notice = output.find(item => item.kind === "diagnostic");
  assert.equal(notice.runId, undefined);
  assert.deepEqual(notice.sourceRefs, []);
  input.canonical.items.push({ ...notice, id: "canonical-notice", runId: "run-private" });
  assert.equal(projectTeammatePrivateTimelineItems({ ...input, canonicalState: "loaded" }).filter(item => item.kind === "diagnostic").length, 1);
});

test("loaded legacy link without admitted Run evidence remains visibly blocked without fetching foreign facts", () => {
  const { input } = fixture();
  input.runs = [];
  input.messages[1].facts = [];
  const output = projectTeammatePrivateTimelineItems({ ...input, canonicalState: "loaded" });
  const diagnostics = output.filter(item => item.kind === "diagnostic");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].summary, "Execution evidence is missing required lineage.");
  assert.equal(diagnostics[0].description, diagnostics[0].summary);
  assert.equal(diagnostics[0].status, "blocked");
  assert.equal(diagnostics[0].runId, undefined);
  assert.deepEqual(diagnostics[0].sourceRefs, []);
  assert.equal(output.some(item => item.kind === "commandExecution"), false);
});

test("private owner collaboration is blocked without external targets while ordinary tools survive", () => {
  const { input } = fixture();
  const anchor = { id: "private-user", workspaceId: "workspace-private", threadId: "canonical-private", turnId: "turn-private", sequence: 1, revision: 1, kind: "user_message", status: "committed", actorType: "local_user", payload: { body: "Read then test." } };
  const action = { revision: 1, workspaceId: anchor.workspaceId, threadId: anchor.threadId, runId: "run-private", attemptId: "attempt-private", participantId: "teammate-private", status: "succeeded", sourceRefs: [{ kind: "conversation_item", id: anchor.id }, { kind: "run", id: "run-private" }] };
  input.canonical = projectCanonicalConversationTimeline({
    scope: { surface: "private", threadId: anchor.threadId, workspaceId: anchor.workspaceId, participantId: input.teammateId, depth: 0 },
    sourceSequence: 1, sourceRevision: "private-single-owner", items: [anchor], turnRuns: input.runLinks,
    actions: [
      { ...action, id: "read", actionType: "read", title: "Read file" },
      { ...action, id: "bash", actionType: "bash", title: "Test code", commandEvidence: { command: "node --test", latestEventSeq: 1, outputTail: [], outputTruncated: false, exitCode: 0 } },
      { ...action, id: "mcp", actionType: "mcp", title: "MCP data" },
      { ...action, id: "delegate-secret", actionType: "spawn_agent", title: "Delegate to other-agent", summary: "external-secret" },
    ],
  });
  const ownFact = input.canonical.items.find((item) => item.actionId === "read");
  input.canonical.items.push(
    { ...ownFact, id: "subagent-secret", kind: "subAgentActivity", label: "external-secret", lifecycle: "completed", childItems: [{ ...ownFact, title: "external-secret", participantId: "other-agent" }] },
    { ...ownFact, id: "protocol-secret", kind: "protocolEvent", protocolKind: "handoff", title: "external-secret", availableActions: [{ kind: "open-task", taskId: "external-secret" }] },
  );
  const output = projectTeammatePrivateTimelineItems(input);
  assert.ok(["exploration", "commandExecution", "mcpToolCall"].every((kind) => output.some((item) => item.kind === kind)));
  assert.equal(output.some((item) => ["subAgentActivity", "collabAgentToolCall", "protocolEvent"].includes(item.kind)), false);
  assert.equal(JSON.stringify(output).includes("external-secret"), false);
  const blocked = output.filter((item) => item.kind === "diagnostic" && item.code === "scope_mismatch");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].status, "blocked");
  assert.deepEqual(blocked[0].sourceRefs, []);
  assert.equal(blocked[0].actionId, undefined);
  assert.equal(blocked[0].availableActions, undefined);
});

test("private diagnostics do not disclose foreign owner references or scope error text", () => {
  const { input } = fixture();
  input.canonical.diagnostics = [
    { code: "missing_anchor", message: "foreign-secret", sourceRefs: [{ kind: "run", id: "run-private" }, { kind: "participant", id: "other-agent" }] },
    { code: "missing_anchor", message: "foreign-secret", sourceRefs: [{ kind: "run", id: "other-run" }, { kind: "message", id: "private-user" }] },
    { code: "scope_mismatch", message: "foreign-secret", sourceRefs: [{ kind: "run", id: "run-private" }] },
  ];
  const output = projectTeammatePrivateTimelineItems(input);
  assert.equal(JSON.stringify(output).includes("foreign-secret"), false);
  assert.equal(JSON.stringify(output).includes("other-agent"), false);
});

test("private DTO scope validation rejects foreign lanes and inconsistent TurnRun links", () => {
  const { input } = fixture();
  const response = {
    teammateId: input.teammateId,
    thread: { id: input.directThreadId, teammateId: input.teammateId, workspaceId: "workspace-private" },
    messages: input.messages.map(({ message }) => message),
    timeline: {
      thread: { id: input.canonicalThreadId, kind: "teammate_direct", teammateId: input.teammateId, workspaceId: "workspace-private" },
      runs: input.runs, runLinks: input.runLinks,
      turns: [{ id: "turn-private", threadId: input.canonicalThreadId, workspaceId: "workspace-private", teammateId: input.teammateId }],
    },
  };
  assert.equal(privateTimeline.privateTimelineResponseIsOwned(response, input), true);
  const systemHistory = structuredClone(response);
  systemHistory.messages.push({ ...systemHistory.messages[0], id: "system-continuation", authorType: "system", authorId: "system", body: "Continue the private run." });
  assert.equal(privateTimeline.privateTimelineResponseIsOwned(systemHistory, input), true);
  assert.equal(privateTimeline.selectTeammatePrivateMessages(systemHistory.messages, input).some((message) => message.id === "system-continuation"), false);
  systemHistory.messages.at(-1).systemPurpose = "governance_notification";
  assert.equal(privateTimeline.selectTeammatePrivateMessages(systemHistory.messages, input).some((message) => message.id === "system-continuation"), true);
  systemHistory.messages.at(-1).teammateId = "other-agent";
  assert.equal(privateTimeline.privateTimelineResponseIsOwned(systemHistory, input), false);
  assert.equal(privateTimeline.privateTimelineResponseIsOwned(response, { ...input, teammateId: "other-agent", directThreadId: "other-thread" }), false);
  for (const mutate of [
    (value) => { value.thread.teammateId = "other-agent"; },
    (value) => { value.messages[1].authorId = "other-agent"; },
    (value) => { value.messages[1].workspaceId = "other-workspace"; },
    (value) => { value.timeline.thread.kind = "channel"; },
    (value) => { value.timeline.thread.workflowId = "other-workflow"; },
    (value) => { value.timeline.thread.workspaceId = "other-workspace"; },
    (value) => { value.timeline.runs[0].channelId = "other-channel"; },
    (value) => { value.timeline.runs[0].workflowStepId = "other-step"; },
    (value) => { value.timeline.runs[0].teammateId = "other-agent"; },
    (value) => { value.timeline.turns[0].threadId = "other-thread"; },
    (value) => { value.timeline.runLinks[0].turnId = "other-turn"; },
  ]) {
    const invalid = structuredClone(response);
    mutate(invalid);
    assert.equal(privateTimeline.privateTimelineResponseIsOwned(invalid, input), false);
  }
});

test("private owner collaboration with external source refs emits only a generic blocked notice", () => {
  const { input, facts } = fixture();
  input.canonical.items = [{ ...facts[0], id: "secret-delegation", kind: "collabAgentToolCall", title: "other-agent", sourceRefs: [{ kind: "participant", id: "other-agent" }, { kind: "run", id: "other-run" }] }];
  const output = projectTeammatePrivateTimelineItems(input);
  const blocked = output.filter((item) => item.kind === "diagnostic");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].status, "blocked");
  assert.deepEqual(blocked[0].sourceRefs, []);
  assert.equal(JSON.stringify(output).includes("other-agent"), false);
  assert.equal(JSON.stringify(output).includes("other-run"), false);
});

test("private message-bound media cannot override an unproved or foreign run association", () => {
  const { input, assistant } = fixture();
  const media = [
    { mediaJobId: "own", runId: "run-private", messageId: assistant.id },
    { mediaJobId: "foreign", runId: "other-run", messageId: assistant.id },
    { mediaJobId: "other-message", runId: "run-private", messageId: "other-message" },
  ];
  assert.deepEqual(privateTimeline.privateGeneratedMediaForMessage(media, assistant).map((item) => item.mediaJobId), ["own"]);
  const unproved = privateTimeline.selectTeammatePrivateMessages([assistant], { ...input, runs: [] })[0];
  assert.deepEqual(privateTimeline.privateGeneratedMediaForMessage(media, unproved), []);
});

function mixedPrivateHistoryFixture() {
  const { input, assistant } = fixture();
  const phases = ["p01", "p02", "p03"];
  input.runs = phases.map((phase) => ({ id: `run-${phase}`, teammateId: input.teammateId, threadId: input.canonicalThreadId }));
  input.runLinks = phases.map((phase) => ({ runId: `run-${phase}`, turnId: `turn-${phase}`, attemptNumber: 1, role: "primary" }));
  input.turns = phases.map((phase) => ({
    id: `turn-${phase}`, workspaceId: assistant.workspaceId, threadId: input.canonicalThreadId,
    teammateId: input.teammateId, sourceItemId: phase === "p03" ? "canonical-p03-user" : `${phase}-user`,
  }));
  input.messages = phases.flatMap((phase) => [
    { message: { ...assistant, id: `${phase}-user`, authorType: "local-user", authorId: "local-user", linkedRunId: undefined, narrationSegments: undefined, body: `${phase} request` }, body: `${phase} request`, facts: [] },
    { message: { ...assistant, id: `${phase}-reply`, linkedRunId: `run-${phase}`, narrationSegments: undefined, body: `${phase} answer` }, body: `${phase} answer`, facts: [] },
  ]);
  input.canonicalMessageIds = new Map([["canonical-p03-user", "p03-user"]]);
  const sourceRefs = (phase, id) => [{ kind: "run", id: `run-${phase}` }, { kind: "execution_action", id }, { kind: "participant", id: input.teammateId }];
  const actions = phases.flatMap((phase) => Array.from({ length: phase === "p02" ? 4 : 1 }, (_, index) => {
    const id = `${phase}-action-${index}`;
    return {
      id, revision: index + 1, workspaceId: assistant.workspaceId, threadId: input.canonicalThreadId,
      runId: `run-${phase}`, attemptId: `attempt-${phase}`, participantId: input.teammateId,
      actionType: "read", status: "succeeded", title: `Read ${phase}-${index}`, sourceEventSequence: 40 + index,
      sourceRefs: [...sourceRefs(phase, id), ...(phase === "p03" ? [{ kind: "conversation_item", id: "canonical-p03-user" }] : [])],
    };
  }));
  input.canonical = projectCanonicalConversationTimeline({
    scope: { surface: "private", threadId: input.canonicalThreadId, workspaceId: assistant.workspaceId, participantId: input.teammateId, depth: 0 },
    sourceSequence: 1, sourceRevision: "mixed-private-history", turnRuns: input.runLinks,
    items: [{ id: "canonical-p03-user", workspaceId: assistant.workspaceId, threadId: input.canonicalThreadId, turnId: "turn-p03", sequence: 1, revision: 1,
      kind: "user_message", status: "committed", actorType: "local_user", payload: { body: "p03 request" }, domainRefs: [{ type: "message", id: "p03-user" }] }],
    actions,
  });
  return input;
}

test("private mixed legacy diagnostics use source-message view positions without changing canonical facts", () => {
  const input = mixedPrivateHistoryFixture();
  const atomic = projectTeammatePrivateTimelineItems(input);
  const placements = privateTimeline.resolveTeammatePrivateDiagnosticPlacements({
    items: atomic, scope: input, messages: input.messages.map(({ message }) => message),
    canonical: input.canonical, canonicalMessageIds: input.canonicalMessageIds,
  });
  const output = placeConversationTimelineDiagnostics(atomic, placements);
  assert.equal(placements.length, 5);
  assert.ok(placements.every((placement) => Object.keys(placement).sort().join() === "afterItemId,diagnosticId"));
  assert.deepEqual(atomic, projectTeammatePrivateTimelineItems({ ...input, turns: undefined }), "Adapter facts never change order based on placement relations");
  assert.ok(atomic.findIndex((item) => item.kind === "diagnostic") > atomic.findIndex((item) => item.kind === "exploration"));
  for (const [phase, nextPhase, count] of [["p01", "p02", 1], ["p02", "p03", 4]]) {
    const sourceIndex = output.findIndex((item) => item.itemId === `${phase}-user`);
    const nextIndex = output.findIndex((item) => item.kind === "userMessage" && (item.itemId === `${nextPhase}-user` || item.itemId === `canonical-${nextPhase}-user`));
    const diagnostics = output.filter((item) => item.kind === "diagnostic" && item.runId === `run-${phase}`);
    assert.equal(diagnostics.length, count);
    assert.ok(diagnostics.every((item) => output.indexOf(item) > sourceIndex && output.indexOf(item) < nextIndex), `${phase} diagnostics must stay with their durable source message, before ${nextPhase}`);
    assert.ok(diagnostics.every((item) => item.status === "blocked" && item.threadSequence === 1 && item.turnId === `turn-${phase}`));
    const original = input.canonical.diagnostics.filter((item) => item.sourceRefs.some((ref) => ref.kind === "run" && ref.id === `run-${phase}`));
    assert.deepEqual(diagnostics.map((item) => item.sourceRefs), original.map((item) => item.sourceRefs));
    assert.ok(diagnostics.every((item) => !item.itemId && item.sourceRefs.every((ref) => ref.kind !== "conversation_item")));
  }
  assert.deepEqual(output.filter((item) => item.kind === "exploration"), input.canonical.items.filter((item) => item.kind === "exploration"));
  assert.deepEqual(batchCanonicalTranscriptItems(output, { contextSegmentIdByItemId: new Map() }).map((item) => item.id), output.map((item) => item.id));
  assert.deepEqual(placeConversationTimelineDiagnostics(projectTeammatePrivateTimelineItems(input), placements), output);
});

test("private history positioning never borrows a foreign or ambiguous source-message relation", () => {
  for (const mutate of [
    (input) => { input.turns[1].teammateId = "foreign-agent"; },
    (input) => { input.turns[1].threadId = "foreign-thread"; },
    (input) => { input.turns[1].workspaceId = "foreign-workspace"; },
    (input) => { input.turns[1].channelId = "foreign-channel"; },
    (input) => { input.turns[1].sourceItemId = "missing-message"; },
    (input) => { input.turns[1].sourceItemId = "p02-reply"; },
    (input) => { input.messages.push({ ...input.messages[2] }); },
    (input) => { input.turns.push({ ...input.turns[1], sourceItemId: "p01-user" }); },
    (input) => { input.canonicalMessageIds.set("p02-user", "p01-user"); },
  ]) {
    const input = mixedPrivateHistoryFixture();
    mutate(input);
    input.canonical.diagnostics.push({ code: "missing_anchor", message: "FOREIGN_DIAGNOSTIC", sourceRefs: [{ kind: "run", id: "foreign-run" }, { kind: "message", id: "p02-user" }] });
    const atomic = projectTeammatePrivateTimelineItems(input);
    const placements = privateTimeline.resolveTeammatePrivateDiagnosticPlacements({
      items: atomic, scope: input, messages: input.messages.map(({ message }) => message),
      canonical: input.canonical, canonicalMessageIds: input.canonicalMessageIds,
    });
    const output = placeConversationTimelineDiagnostics(atomic, placements);
    const legacy = output.filter((item) => item.kind === "diagnostic" && item.runId === "run-p02");
    const baseline = projectTeammatePrivateTimelineItems({ ...input, turns: undefined });
    assert.equal(legacy.length, 4, "Unresolved display position must never suppress the blocked evidence");
    assert.deepEqual(legacy, baseline.filter((item) => item.kind === "diagnostic" && item.runId === "run-p02"));
    assert.ok(output.findIndex((item) => item.runId === "run-p02" && item.kind === "diagnostic") > output.findIndex((item) => item.kind === "exploration"));
    assert.equal(JSON.stringify(output).includes("FOREIGN_DIAGNOSTIC"), false);
  }
});

test("private diagnostic placement resolves exact canonical-to-native source relations without altering native rows", () => {
  const input = mixedPrivateHistoryFixture();
  input.turns[1].sourceItemId = "canonical-historical-p02";
  input.canonicalMessageIds.set("canonical-historical-p02", "p02-user");
  const items = projectTeammatePrivateTimelineItems(input);
  const placements = privateTimeline.resolveTeammatePrivateDiagnosticPlacements({
    items, scope: input, messages: input.messages.map(({ message }) => message),
    canonical: input.canonical, canonicalMessageIds: input.canonicalMessageIds,
  });
  const p02DiagnosticIds = new Set(items.filter((item) => item.kind === "diagnostic" && item.runId === "run-p02").map((item) => item.id));
  const source = items.find((item) => item.itemId === "p02-user");
  assert.equal(placements.filter((placement) => p02DiagnosticIds.has(placement.diagnosticId)).length, 4);
  assert.ok(placements.filter((placement) => p02DiagnosticIds.has(placement.diagnosticId)).every((placement) => placement.afterItemId === source.id));
  assert.deepEqual(source.sourceRefs, [{ kind: "message", id: "p02-user" }]);
  assert.ok(placeConversationTimelineDiagnostics(items, placements).includes(source));
});

test("private placement rejects stale rows when their Run owner link becomes ambiguous", () => {
  const input = mixedPrivateHistoryFixture();
  const items = projectTeammatePrivateTimelineItems(input);
  const original = structuredClone(items);
  input.runLinks.push({ ...input.runLinks[1] });
  const placements = privateTimeline.resolveTeammatePrivateDiagnosticPlacements({
    items, scope: input, messages: input.messages.map(({ message }) => message),
    canonical: input.canonical, canonicalMessageIds: input.canonicalMessageIds,
  });
  const p02Ids = new Set(items.filter((item) => item.runId === "run-p02").map((item) => item.id));
  assert.ok(placements.every((placement) => !p02Ids.has(placement.diagnosticId)));
  assert.deepEqual(items, original, "Resolving metadata never changes source facts");
});
