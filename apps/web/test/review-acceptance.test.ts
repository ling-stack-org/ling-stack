import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { ChannelMessageFileRef, ConversationSubmissionQuery } from "@ling-stack/contracts";
import type { useConversationDomain, ConversationStreamHandlers } from "../src/domains/conversations/use-conversation-domain.js";
import type { useChannelActionsController } from "../src/app/use-channel-actions-controller.js";
import type { submitNormalConversationGuidance } from "../src/features/workspace/normal-conversation-guidance-controller.js";
import { acknowledgeReviewDraft } from "../src/shared/conversation/review/review-draft.ts";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

const cwd = "/isolated/review-acceptance";
const timestamp = "2026-11-17T00:00:00Z";
const ref: ChannelMessageFileRef = { path: "src/main.ts", source: "composer", line: 3,
  annotation: { kind: "code", id: "accepted", side: "right", startLine: 2, text: "Check this" } };
const added: ChannelMessageFileRef = { ...ref, annotation: { ...ref.annotation!, id: "added", text: "More feedback" } };
const canonicalRef: ChannelMessageFileRef = { ...ref,
  annotation: { kind: "code", id: "accepted", text: "Check this", side: "right", startLine: 2 } };
const thread = { id: "review-thread", workspaceId: "review-workspace", kind: "conversation",
  title: "Review", objective: "Review", status: "running", createdAt: timestamp, updatedAt: timestamp };
const userMessage = { id: "review-user", role: "user", threadId: thread.id, turnId: "review-turn",
  content: "Review", status: "completed", createdAt: timestamp, updatedAt: timestamp, fileRefs: [canonicalRef] };
const assistantMessage = { ...userMessage, id: "review-assistant", role: "assistant", fileRefs: [] };
const detail = { cwd, thread, turns: [], conversationItems: [], userInputs: [],
  supersessionTombstones: { turnIds: [], runIds: [], responseMessageIds: [] }, runLinks: [], runs: [],
  reasoningSummaries: [], executionActions: [], approvals: [], approvalCheckpoints: [], interventions: [],
  terminalReports: [], artifacts: [], messages: [userMessage, assistantMessage], generatedMedia: [], defaults: {} };

function hookTransform(anchor: string) {
  return { anchor, replace: (key: string) =>
    `const ${anchor.slice(anchor.indexOf("{"), anchor.indexOf("}") + 1)} = globalThis[${JSON.stringify(key)}].ports.hooks;` };
}

async function domainFixture(t: TestContext, options: { pending?: boolean; lostStream?: boolean; failDetail?: boolean } = {}) {
  const port = catalogHookPort();
  const calls: string[] = [];
  let pendingKey = options.pending ? "pending-review" : undefined;
  const apiNames = ["archiveLingThread", "getConversation", "getConversationSubmission", "listLingThreads", "streamConversation"];
  const harness = await catalogConsumerHarness(t, {
    exports: { "domains/conversations/use-conversation-domain.ts": ["useConversationDomain"] },
    ports: {
      hooks: port.hooks,
      journal: { read: () => pendingKey, remember() {}, forget() { pendingKey = undefined; } },
      api: {
        async archiveLingThread() { throw new Error("Unexpected archive"); },
        async getConversation() { calls.push("detail"); if (options.failDetail) throw new Error("Offline"); return detail; },
        async getConversationSubmission(_cwd: string, query: ConversationSubmissionQuery) {
          calls.push("receipt");
          return { status: "accepted", cwd, idempotencyKey: query.idempotencyKey, threadId: thread.id,
            turnId: userMessage.turnId, sourceItemId: userMessage.id,
            sourceItem: { kind: "user_message", id: userMessage.id, threadId: thread.id,
              turnId: userMessage.turnId, payload: { fileRefs: [canonicalRef] } } };
        },
        async listLingThreads() { return { threads: [thread] }; },
        async streamConversation() { calls.push("post"); return { ok: true, body: {} }; },
      },
      async readSseResponse(_response: unknown, receive: (event: { event: string; data: string }) => void) {
        if (options.lostStream) throw new TypeError("Stream disconnected");
        receive({ event: "ready", data: JSON.stringify({ thread, turn: { id: userMessage.turnId }, userMessage, assistantMessage }) });
      },
    },
    transforms: {
      "domains/conversations/use-conversation-domain.ts": [
        hookTransform('import { useCallback, useEffect, useRef, useState } from "react";'),
        { anchor: `import { ${apiNames.join(", ")} } from "../../api.js";`, replace: (key: string) =>
          `const { ${apiNames.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` },
        { anchor: 'import { readSseResponse } from "../../sse.js";', replace: (key: string) =>
          `const { readSseResponse } = globalThis[${JSON.stringify(key)}].ports;` },
        { anchor: 'import { submissionLookupJournal } from "../../shared/conversation/conversation-submission-journal.js";', replace: (key: string) =>
          `const submissionLookupJournal = globalThis[${JSON.stringify(key)}].ports.journal;` },
      ],
      "domains/conversations/conversation-error-owner.ts": [hookTransform('import { useCallback, useMemo, useRef, useState } from "react";')],
      "domains/conversations/use-conversation-stream-busy-owner.ts": [hookTransform('import { useCallback, useEffect, useMemo, useRef, useState } from "react";')],
    },
  });
  const module = harness.module as { useConversationDomain: typeof useConversationDomain };
  const render = (): ReturnType<typeof useConversationDomain> => port.render(module.useConversationDomain, { cwd, translate: (value: string) => value });
  render(); await port.flush();
  t.after(() => port.unmount());
  return { render, calls, send: (handlers: ConversationStreamHandlers) => render().actions.sendConversationMessage({ message: "Review", fileRefs: [ref, added] }, handlers) };
}

for (const scenario of [
  { name: "ready stream", options: {} },
  { name: "recovered POST receipt", options: { lostStream: true } },
  { name: "pending receipt", options: { pending: true } },
  { name: "pending receipt with an offline detail", options: { pending: true, failDetail: true } },
]) test(`${scenario.name} acknowledges exact feedback after leaving the originating surface`, async t => {
  const f = await domainFixture(t, scenario.options);
  const accepted: (readonly ChannelMessageFileRef[])[] = [];
  let presentations = 0;
  await f.send({ shouldCommit: () => false, onInputAccepted: refs => accepted.push(refs),
    onMessageAccepted: () => { presentations += 1; }, onSubmissionRecovered: () => { presentations += 1; } });
  assert.deepEqual(accepted, [[canonicalRef]]);
  assert.deepEqual(acknowledgeReviewDraft([ref, added], accepted[0]!), [added]);
  assert.equal(presentations, 0);
  assert.equal(f.render().state.selectedConversationDetail, undefined);
  assert.equal(f.calls.filter(call => call === "post").length, "pending" in scenario.options ? 0 : 1);
});

for (const recovered of [false, true]) test(`queued guidance acknowledges feedback outside its presentation guard, recovered=${recovered}`, async t => {
  let pending = recovered ? { key: "pending-guidance", sourceId: "review-run", threadId: thread.id, mode: "queue_followup" } : undefined;
  let posts = 0;
  const intervention = { id: "review-guidance", sourceRunId: "review-run", mode: "queue_followup", instruction: "Review",
    messagePayload: { body: "Review", attachmentIds: [], fileRefs: [canonicalRef] } };
  const harness = await catalogConsumerHarness(t, {
    exports: { "features/workspace/normal-conversation-guidance-controller.ts": ["submitNormalConversationGuidance"] },
    ports: {
      journal: { read: () => pending, remember() {}, forget() { pending = undefined; } },
      api: {
        async createRunIntervention(_cwd: string, _source: string, request: { idempotencyKey: string }) {
          posts += 1; return { cwd, intervention: { ...intervention, idempotencyKey: request.idempotencyKey } };
        },
        async listRunInterventions(_cwd: string, _source: string, _limit: number, key: string) {
          return { cwd, idempotencyKey: key, interventions: [{ ...intervention, idempotencyKey: key }] };
        },
      },
    },
    transforms: { "features/workspace/normal-conversation-guidance.ts": [
      { anchor: 'import { createRunIntervention, listRunInterventions } from "../../api.js";', replace: (key: string) =>
        `const { createRunIntervention, listRunInterventions } = globalThis[${JSON.stringify(key)}].ports.api;` },
      { anchor: 'import { guidanceLookupJournal } from "../../shared/conversation/conversation-submission-journal.js";', replace: (key: string) =>
        `const guidanceLookupJournal = globalThis[${JSON.stringify(key)}].ports.journal;` },
    ] },
  });
  const module = harness.module as { submitNormalConversationGuidance: typeof submitNormalConversationGuidance };
  const identity = { surface: "normal_conversation", workspaceCwd: cwd, threadId: thread.id, identity: thread.id } as const;
  let remaining: readonly ChannelMessageFileRef[] = [ref, added];
  let finished = false;
  let abandoned = false;
  const attachmentController: Parameters<typeof submitNormalConversationGuidance>[0]["attachmentController"] = {
    pendingAttachments: [], readyAttachmentIds: [], cleanupFailures: [],
    attachFiles: async () => {}, removeAttachment: async () => {}, retryAttachment: async () => {}, retryCleanup: async () => {},
    consumeForSend: () => [], protectForSubmission: items => items.map(item => ({ ...item, deleteOnRemove: false })), markSendBound() {}, restoreForIdentity: () => true,
    abandonSend() { abandoned = true; }, releasePreviews() {},
  };
  await module.submitNormalConversationGuidance({
    activeReply: { runId: "review-run", sourceRunId: "review-run", threadId: thread.id, status: "running", createdAt: timestamp, updatedAt: timestamp },
    threadId: thread.id, workspaceCwd: cwd, body: "Review", fileRefs: remaining, notReadyMessage: "Not ready",
    attachmentController,
    identityController: { identity: thread.id, ownerKey: "owner", ready: true, capture: () => identity, isCurrent: () => false, createCommitGuard: () => () => false },
    operationOwner: { busy: false, begin: value => ({ requestId: 1, ownerKey: "owner", value }), finish() { finished = true; } },
    actionFeedback: { message: "", messageFor: () => "", clear() {}, report(_scope, message) { assert.fail(message); } },
    onInputAccepted: refs => { remaining = acknowledgeReviewDraft(remaining, refs); },
    onAccepted: () => assert.fail("Departed surface cannot publish a message"),
    onRecovered: () => assert.fail("Departed surface cannot publish recovery"),
    refresh: async () => assert.fail("Departed surface cannot refresh"),
  });
  assert.deepEqual(remaining, [added]);
  assert.equal(posts, recovered ? 0 : 1);
  assert.equal(finished, true);
  assert.equal(abandoned, true);
});

for (const scenario of ["ready", "lost", "pending"] as const) test(`channel ${scenario} acceptance retires the receipt's comments independently of presentation`, async t => {
  const path = "app/use-channel-actions-controller.ts";
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
  const apiStart = source.indexOf("import {\n");
  const apiEnd = source.indexOf('} from "../api.js";', apiStart);
  assert.ok(apiStart >= 0 && apiEnd > apiStart);
  const apiAnchor = source.slice(apiStart, source.indexOf(";", apiEnd) + 1);
  const apiNames = apiAnchor.slice(apiAnchor.indexOf("{") + 1, apiAnchor.indexOf("}")).split(",").map(name => name.trim()).filter(Boolean);
  const port = catalogHookPort();
  let pendingKey = scenario === "pending" ? "pending-channel-review" : undefined;
  let posts = 0;
  const item = { schemaVersion: 1, id: userMessage.id, workspaceId: "review-workspace", channelId: "review-channel", threadId: thread.id,
    turnId: userMessage.turnId, sequence: 1, kind: "user_message", actorType: "local_user", actorId: "local-user", status: "committed",
    visibility: "channel", revision: 1, domainRefs: [], createdAt: timestamp, updatedAt: timestamp,
    payload: { body: "Review", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [canonicalRef] } };
  const envelope = { channelId: item.channelId, thread: { ...thread, channelId: item.channelId, surfaceKind: "channel_root", relationKind: "root" },
    turn: { id: item.turnId }, userItem: item, items: [item], assistantItems: [], decorations: [], turnContextAssignments: [], generatedMedia: [] };
  const harness = await catalogConsumerHarness(t, {
    exports: { [path]: ["useChannelActionsController"] },
    ports: { hooks: port.hooks,
      journal: { read: () => pendingKey, begin() {}, finish() {}, forget() { pendingKey = undefined; } },
      api: Object.fromEntries(apiNames.map(name => [name, async (...args: unknown[]) => {
        if (name === "streamChannelTurn") { posts += 1; return {}; }
        if (name === "getConversationSubmission") {
          const query = args[1] as ConversationSubmissionQuery;
          return { status: "accepted", cwd, idempotencyKey: query.idempotencyKey, threadId: item.threadId,
            turnId: item.turnId, sourceItemId: item.id, sourceItem: item };
        }
        throw new Error(`Unexpected IO: ${name}`);
      }])),
      async readSseResponse(_response: unknown, receive: (event: { event: string; data: string }) => void) {
        if (scenario === "lost") throw new TypeError("Stream disconnected");
        receive({ event: "ready", data: JSON.stringify(envelope) });
      },
    },
    transforms: { [path]: [
      { anchor: source.slice(0, source.indexOf(";") + 1), replace: (key: string) =>
        `const { useRef } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
      { anchor: apiAnchor, replace: (key: string) => `const { ${apiNames.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` },
      { anchor: 'import { readSseResponse } from "../sse.js";', replace: (key: string) =>
        `const { readSseResponse } = globalThis[${JSON.stringify(key)}].ports;` },
      { anchor: 'import { submissionLookupJournal } from "../shared/conversation/conversation-submission-journal.js";', replace: (key: string) =>
        `const submissionLookupJournal = globalThis[${JSON.stringify(key)}].ports.journal;` },
    ] },
  });
  const module = harness.module as { useChannelActionsController: typeof useChannelActionsController };
  const actions: ReturnType<typeof useChannelActionsController> = port.render(module.useChannelActionsController, {
    form: { cwd }, selectedChannelId: item.channelId, channels: [], providers: [], providerTemplates: [], channelDecisions: [],
    isSelectedChannelConversation: () => false, clearFeedback() {}, reportFeedback() {},
    setChannelMessages: () => assert.fail("Departed channel cannot publish messages"),
    setChannelConversationItems: () => assert.fail("Departed channel cannot publish items"),
    refreshChannelMessages: async () => {}, refreshChannelExecutionProposals: async () => {}, refreshChannelIntentDecisions: async () => {},
    refreshUsedMemoryAudit: async () => {}, refreshChannelMessageRouteDecisions: async () => {}, refreshChannelFiles: async () => {},
  });
  t.after(() => port.unmount());
  let remaining: readonly ChannelMessageFileRef[] = [ref, added];
  let accepts = 0;
  const sending = actions.sendChannelMessage({ body: "Review", fileRefs: remaining, mentions: [], attachmentIds: [], linkPreviewIds: [], requestAiReply: false,
    onInputAccepted: refs => { accepts += 1; remaining = acknowledgeReviewDraft(remaining, refs); } });
  if (scenario === "ready") await sending;
  else await assert.rejects(sending, scenario === "pending" ? { name: "RecoveredConversationSubmissionError" } : /Stream disconnected/);
  assert.equal(accepts, 1);
  assert.deepEqual(remaining, [added]);
  assert.equal(posts, scenario === "pending" ? 0 : 1);
});
