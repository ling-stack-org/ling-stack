import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { on, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { REMOTE_PROTOCOL_VERSION, REMOTE_VISUALIZATION_FEATURE, type RemoteConversationVisualizationReadCommandV1 } from "@ling-stack/contracts";
import { readConversationVisualizationReferences } from "@ling-stack/conversation-ui-core";
import { createDirectWorkspaceSnapshot, createSqliteRunStore, projectConversationItemToChannelMessage, type RunStore } from "@ling-stack/core";
import { authProofSigningBytes, authProofSigningInput, fingerprintPublicJwkSync, parseRemoteServerFrameV1, sha256,
  validateRemoteAuthChallengeV1, validateRemoteP256PublicJwkV1 } from "@ling-stack/remote-protocol";
import { CONVERSATION_VISUALIZATION_TOOL, PiRunnerAdapter, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { WebSocket } from "ws";
import { resolveConfig } from "../dist/config.js";
import { createAiChannelReply } from "../dist/features/channels/ai-replies.js";
import { handleConversationStream } from "../dist/features/conversations/routes.js";
import { handleConversationVisualization, readConversationVisualization } from "../dist/features/conversations/visualization-read.js";
import { RemoteAccessController } from "../dist/features/remote-access/controller.js";
import { RemoteConversationFacade } from "../dist/features/remote-access/conversation-facade.js";
import { createRemoteGatewayIdentity } from "../dist/features/remote-access/pairing-auth-service.js";
import { RemoteAccessStateStore } from "../dist/features/remote-access/state-store.js";
import { executeRunRequest } from "../dist/features/runs/orchestrator.js";
import type { RunRequest } from "../dist/features/runs/schemas.js";
import type { RunExecutionSink } from "../dist/features/runs/run-execution-sink.js";
import { createAiTeammateDirectReply } from "../dist/features/teammates/direct-replies.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import type { McpBroker } from "../dist/context.js";

const document = {
  title: "Session mockup",
  summary: "Two views of the same workspace",
  html: "<details><summary>Changes</summary><p>Example branch</p></details>",
  layout: "wide",
};

async function createFixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-visualization-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  stores.trustWorkspaceRoot(cwd);
  const store = stores.getStore(cwd);
  const config = resolveConfig({ defaultWorkspaceCwd: cwd });
  const supervisor = new RuntimeSupervisor(config);
  const active = new ActiveRunRegistry();
  t.after(async () => { supervisor.releaseAll(); stores.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Visualization provider",
    providerId: "visualization-fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
    authHeader: false, reasoning: false, capabilities: ["chat"], enabled: true }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Fixture ready", checkedAt: now });
  class FixtureRunner extends PiRunnerAdapter {
    override async runTask(options: PiRunnerRunOptions) {
      const prepared = await super.prepareTaskInput(options);
      assert.equal(prepared.fingerprint, options.preparedInput?.fingerprint);
      assert.ok(prepared.tools.some(tool => tool.name === CONVERSATION_VISUALIZATION_TOOL));
      assert.ok(options.onConversationVisualization);
      assert.ok(options.runId);
      const runId = options.runId;
      const invoke = (input: unknown, toolCallId = "mockup-call") => options.onConversationVisualization!({
        input, toolCallId, signal: new AbortController().signal,
      });
      const result = await invoke(document);
      assert.equal(result.isError, undefined);
      const artifactId = Reflect.get(result.details as object, "artifactId") as string;
      assert.match(artifactId, /^viz_[a-f0-9]{32}$/);
      assert.deepEqual(await invoke(document), result);
      assert.equal(Reflect.get((await invoke({ ...document, title: "Changed" })).details as object, "code"), "visualization_conflict");
      assert.equal(Reflect.get((await invoke({ ...document, html: "<img src='https://fixture.invalid/image'>" }, "unsafe")).details as object, "code"), "visualization_invalid");
      const saved = store.getConversationVisualization(artifactId);
      assert.equal(saved?.runId, runId);
      assert.equal(readConversationVisualization(store, { artifactId, messageId: saved.messageId, messageRevision: 0 }, { threadId: saved.threadId }), undefined);
      const block = result.content[0];
      assert.equal(block?.type, "text");
      const text = "Before the mockup.\n\n" + block.text + "\n\nAfter the mockup.";
      options.onEvent?.({ type: "turn_start" });
      options.onEvent?.({ type: "assistant_text_delta", text });
      options.onEvent?.({ type: "message_end", role: "assistant", text });
      options.onEvent?.({ type: "turn_end" });
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: text }] };
    }
  }
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Pi fixture", status: "enabled", adapter: new FixtureRunner() }]);
  const secretResolver = {
    resolve: () => ({ configured: false as const }),
    status: (ref: string) => ({ ref, kind: "local" as const, configured: false }),
  };
  const startRun = (runRequest: RunRequest, sink: RunExecutionSink) =>
    executeRunRequest(runRequest, sink, runners, stores, active, supervisor, secretResolver, {} as McpBroker);
  return { cwd, config, now, store, stores, preset, runners, startRun, secretResolver };
}

test("a Pi reply publishes a durable visualization with a readable committed message and scoped remote access", async t => {
  const { cwd, config, now, store, stores, preset, runners, startRun } = await createFixture(t);
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Visualization", objective: "Show a mockup" }, now);
  const foreign = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Other", objective: "Unrelated" }, now);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST") {
      void handleConversationStream(request, response, config, stores, runners, startRun).catch(() => response.end());
    } else {
      handleConversationVisualization(response, url, stores, url.pathname.split("/").at(-1)!);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  const response = await fetch(origin + "/conversations/stream?" + new URLSearchParams({ cwd }), {
    method: "POST",
    body: JSON.stringify({ threadId: thread.id, message: "Show a mockup", idempotencyKey: "mockup",
      executionBinding: { kind: "pi_provider", providerPresetId: preset.id } }),
  });
  assert.equal(response.status, 200);
  const transcript = await response.text();
  assert.match(transcript, /event: done/);
  assert.match(transcript, /After the mockup/);
  assert.ok(!transcript.includes(document.html));
  const run = store.listRuns({ threadId: thread.id })[0];
  assert.ok(run);
  const item = store.getConversationItem("narration:" + run.id);
  assert.ok(item?.kind === "assistant_message");
  assert.equal(item.payload.deliveryStatus, "ready");
  const [{ artifactId }] = readConversationVisualizationReferences(item.payload.body);
  const query = { cwd, threadId: thread.id, messageId: item.id, messageRevision: String(item.revision) };
  const read = async (overrides: Partial<typeof query> = {}): Promise<Response> =>
    await fetch(origin + "/conversation-visualizations/" + artifactId + "?" + new URLSearchParams({ ...query, ...overrides }));
  assert.equal((await read({ threadId: foreign.id })).status, 404);
  assert.equal((await read({ messageRevision: String(item.revision + 1) })).status, 404);
  const preview = await read();
  assert.equal(preview.status, 200, await preview.clone().text());
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal((await preview.json() as { html: string }).html, document.html);
  const facade = new RemoteConversationFacade({ store, workspaceId: thread.workspaceId, workspaceBindingId: "binding",
    workspaceDisplayName: "Workspace", conversationAccess: { mode: "selected", conversationIds: [thread.id] }, policyVersion: 1 });
  const phone = facade.openConversation(thread.workspaceId, thread.id).messages.find(message => message.role === "assistant");
  assert.ok(phone);
  assert.ok(phone.body.includes(artifactId));
  assert.ok(!phone.body.includes(document.html));
  const command = { commandId: "read", workspaceId: thread.workspaceId, conversationId: thread.id,
    messageId: phone.messageId, messageRevision: phone.revision, artifactId };
  assert.equal(Buffer.from(facade.readVisualization(command).htmlBase64Url, "base64url").toString(), document.html);
  assert.throws(() => facade.readVisualization({ ...command, conversationId: foreign.id }), /not available/);
  const reopened = createSqliteRunStore(cwd);
  try {
    assert.equal(readConversationVisualization(reopened, { artifactId, messageId: item.id, messageRevision: item.revision },
      { threadId: thread.id })?.html, document.html);
  } finally { reopened.close(); }
  await assertAuthenticatedVisualizationRead(cwd, store, command, foreign.id);
});

async function assertAuthenticatedVisualizationRead(cwd: string, store: RunStore,
  command: RemoteConversationVisualizationReadCommandV1, foreignConversationId: string) {
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  const listenerPort = address.port;
  portProbe.close();
  await once(portProbe, "close");

  const stateDir = join(cwd, "gateway-state");
  const gatewayOrigin = "https://visualization-fixture.invalid";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyJwk = validateRemoteP256PublicJwkV1(publicKey.export({ format: "jwk" }));
  const home = new RemoteAccessStateStore({ stateDir, listenerPort, createIdentity: createRemoteGatewayIdentity });
  const deviceId = "visualization-device";
  home.updateState(state => ({ ...state, enabled: true, gatewayOrigin, deviceEpoch: 1,
    conversationAccess: { mode: "selected", conversationIds: [command.conversationId] },
    pairedDevice: { deviceId, platform: "android", displayName: "Fixture phone", deviceEpoch: 1, publicKeyJwk,
      publicKeyFingerprint: fingerprintPublicJwkSync(publicKeyJwk), pairedAt: new Date().toISOString() } }));
  const gateway = new RemoteAccessController({ store, stateDir, listenerPort, workspaceDisplayName: "Workspace",
    managementCapability: "visualization-test-capability", managementAllowedOrigins: ["http://localhost"] });
  await gateway.startIfEnabled();
  try {
    for (const negotiated of [false, true]) {
      const signal = AbortSignal.timeout(5_000);
      const response = await fetch("http://127.0.0.1:" + listenerPort + "/v1/auth/challenge" +
        (negotiated ? "?feature=" + REMOTE_VISUALIZATION_FEATURE : ""), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId }), signal,
      });
      assert.equal(response.status, 200);
      const { gatewaySignature: _signature, ...challenge } = validateRemoteAuthChallengeV1(await response.json());
      assert.deepEqual(challenge.negotiatedFeatures, negotiated ? [REMOTE_VISUALIZATION_FEATURE] : undefined);
      const proof = {
        version: REMOTE_PROTOCOL_VERSION, protocolVersion: REMOTE_PROTOCOL_VERSION, resume: [],
        gatewayId: challenge.gatewayId, challengeId: challenge.challengeId, candidateSessionId: challenge.candidateSessionId,
        deviceId, deviceEpoch: challenge.deviceEpoch, clientNonce: randomBytes(32).toString("base64url"),
      };
      const signingBytes = authProofSigningBytes(await authProofSigningInput(gatewayOrigin, challenge, proof, sha256));
      const signature = sign("sha256", signingBytes, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
      const socket = new WebSocket("ws://127.0.0.1:" + listenerPort + "/v1/session");
      const frames = on(socket, "message", { signal });
      const nextFrame = async () => {
        const result = await frames.next();
        assert.equal(result.done, false);
        return parseRemoteServerFrameV1(String(result.value[0]));
      };
      const send = (clientSeq: number, payload: RemoteConversationVisualizationReadCommandV1) => {
        const now = Date.now();
        socket.send(JSON.stringify({
          version: REMOTE_PROTOCOL_VERSION, type: "conversation.visualization.read", payload,
          gatewayId: challenge.gatewayId, sessionId: challenge.candidateSessionId, messageId: "request_" + clientSeq,
          clientSeq, sentAt: new Date(now).toISOString(), expiresAt: new Date(now + 10_000).toISOString(),
        }));
      };
      try {
        await once(socket, "open", { signal });
        socket.send(JSON.stringify({ ...proof, signature }));
        assert.equal((await nextFrame()).type, "session.ready");
        if (!negotiated) {
          const closed = once(socket, "close", { signal });
          send(1, command);
          assert.equal((await closed)[0], 1008);
          continue;
        }
        send(1, command);
        let frame = await nextFrame();
        while (frame.type !== "command.completed") frame = await nextFrame();
        assert.equal(frame.payload.commandId, command.commandId);
        assert.equal(frame.payload.commandType, "conversation.visualization.read");
        assert.equal(frame.payload.result.kind, "conversation_visualization");
        assert.equal(Buffer.from(frame.payload.result.document.htmlBase64Url, "base64url").toString(), document.html);
        send(2, { ...command, commandId: "foreign-read", conversationId: foreignConversationId });
        frame = await nextFrame();
        while (frame.type !== "command.failed") frame = await nextFrame();
        assert.equal(frame.payload.commandId, "foreign-read");
        assert.equal(frame.payload.error.code, "conversation_not_allowed");
      } finally {
        await frames.return?.();
        socket.terminate();
      }
    }
  } finally {
    await gateway.stop();
  }
}

test("channel and private Pi replies publish separate visualizations through their conversation owners", async t => {
  const { cwd, now, store, preset, startRun, secretResolver } = await createFixture(t);
  const channel = store.createChannel({ name: "Design", boundPath: cwd, defaultProviderPresetId: preset.id }, now);
  const channelThread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root", channelId: channel.id, title: "Design", objective: "Show an interface",
  }, now).thread;
  const body = "Show a mockup.";
  const user = store.appendConversationUserTurn({
    channelId: channel.id, threadId: channelThread.id, turnKind: "initial_request", title: body,
    userInstruction: body, idempotencyKey: "channel-mockup",
    payload: { body, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, now);
  const channelReply = await createAiChannelReply({
    store, channel, sourceMessage: projectConversationItemToChannelMessage(user.item), startRun, secretResolver,
    providerPresetId: preset.id, disableWebEvidence: true, completionMode: "inline",
  });
  assert.equal(channelReply.status, "ready", channelReply.errorMessage ?? channelReply.body);
  const channelItem = store.getEffectiveConversationItem(channelReply.id);
  assert.ok(channelItem?.kind === "assistant_message");
  const [channelRef] = readConversationVisualizationReferences(channelReply.body);
  assert.ok(channelRef);

  const teammate = store.createAiTeammate({
    roleKey: "engineer", displayName: "Designer", description: "Designs interfaces",
    providerPresetId: preset.id, approvalProfile: { mode: "standard", requiredForTools: [] },
  }, now);
  const direct = store.getOrCreateTeammateDirectThread(teammate.id, now);
  const binding = { mode: "external_path", status: "ready", executionPath: cwd, updatedAt: now } as const;
  const thread = store.updateTeammateDirectThreadWorkspace(direct.id, binding, now);
  assert.ok(thread);
  const sourceMessage = store.createTeammateDirectMessage({
    threadId: thread.id, teammateId: teammate.id, authorType: "local-user", body, status: "ready",
  }, now);
  const directReply = await createAiTeammateDirectReply({
    store, teammate, thread, sourceMessage, startRun, secretResolver, providerPresetId: preset.id,
    workspace: { thread, binding, snapshot: createDirectWorkspaceSnapshot(thread, cwd), executionCwd: cwd },
    disableWebEvidence: true,
  });
  assert.equal(directReply.status, "ready", directReply.errorMessage ?? directReply.body);
  const [directRef] = readConversationVisualizationReferences(directReply.body);
  assert.ok(directRef);
  assert.notEqual(directRef.artifactId, channelRef.artifactId);
  const directRun = store.getRun(directReply.linkedRunId!);
  assert.ok(directRun?.threadId);

  const channelQuery = { artifactId: channelRef.artifactId, messageId: channelReply.id, messageRevision: channelItem.revision };
  const directQuery = { artifactId: directRef.artifactId, messageId: directReply.id, messageRevision: directReply.revision ?? 1 };
  assert.equal(readConversationVisualization(store, channelQuery, { threadId: channelThread.id })?.html, document.html);
  assert.equal(readConversationVisualization(store, directQuery, { threadId: directRun.threadId })?.html, document.html);
  assert.equal(readConversationVisualization(store, channelQuery, { threadId: directRun.threadId }), undefined);
  assert.equal(readConversationVisualization(store, directQuery, { threadId: channelThread.id }), undefined);

  const facade = new RemoteConversationFacade({ store, workspaceId: channelThread.workspaceId,
    workspaceBindingId: "binding", workspaceDisplayName: "Workspace", policyVersion: 1,
    conversationAccess: { mode: "selected", conversationIds: [channel.id, direct.id] } });
  for (const [conversationId, query] of [[channel.id, channelQuery], [direct.id, directQuery]] as const) {
    const message = facade.openConversation(channelThread.workspaceId, conversationId).messages.find(item => item.messageId === query.messageId);
    assert.ok(message);
    const { htmlBase64Url } = facade.readVisualization({ ...query, commandId: "read", conversationId,
      workspaceId: channelThread.workspaceId, messageRevision: message.revision });
    assert.equal(Buffer.from(htmlBase64Url, "base64url").toString(), document.html);
  }
});
