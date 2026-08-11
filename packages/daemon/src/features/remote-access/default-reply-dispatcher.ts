import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  resolveEffectiveTeammateProviderPresetId,
  type AiTeammate,
  type Channel,
  type DirectWorkspaceBinding,
  type DirectWorkspaceSnapshot,
  type LingThread,
  type LingTurn,
  type RemoteDispatchIntent,
  type RunStore,
  type TeammateDirectThread,
} from "@ling-stack/core";
import type { McpBroker } from "../../context.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { StartupStateRegistry } from "../../startup/state.js";
import type { ComputerUseProjectionRegistry } from "../computer-use/registry.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { createAiChannelReply } from "../channels/ai-replies.js";
import { getChannelMessageView } from "../channels/conversation-item-messages.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../runs/orchestrator.js";
import type { RunRequest } from "../runs/schemas.js";
import { startDetachedRunAndResolveReady } from "../runs/detached.js";
import type { ProviderStartupRefreshService } from "../providers/startup-refresh.js";
import { createAiTeammateDirectReply } from "../teammates/direct-replies.js";
import type { DirectWorkspaceReady } from "../teammates/direct-workspace.js";
import type { RemoteReplyDispatcher } from "./dispatch-worker.js";

const REMOTE_REPLY_SYSTEM_PROMPT = [
  "This reply was requested through Ling Mobile Remote Access.",
  "Reply only with conversation text.",
  "Do not use tools, access files, browse the web, start workflows, create execution proposals, or perform side effects.",
  "If the request requires any of those capabilities, explain that it must be continued on the PC.",
].join("\n");

export interface DefaultRemoteReplyDispatcherOptions {
  readonly store: RunStore;
  readonly storeRegistry: RunStoreRegistry;
  readonly runnerRegistry: RunnerRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: import("@ling-stack/core").SecretResolver;
  readonly mcpBroker: McpBroker;
  readonly providerStartupRefresh: ProviderStartupRefreshService;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly startupState: StartupStateRegistry;
  readonly computerUsePreviews: ComputerUseProjectionRegistry;
}

/**
 * Default production dispatcher for Mobile replies. Every request is rebuilt
 * from server-owned conversation state and receives an immutable zero-tool,
 * read-only authority ceiling.
 */
export class DefaultRemoteReplyDispatcher implements RemoteReplyDispatcher {
  constructor(private readonly options: DefaultRemoteReplyDispatcherOptions) {}

  async dispatch(intent: RemoteDispatchIntent): Promise<void> {
    if (intent.workspaceId !== DEFAULT_WORKSPACE_ID) {
      throw new Error(`Remote reply workspace is not bound: ${intent.workspaceId}`);
    }
    if (intent.conversationKind === "channel") {
      await this.dispatchChannel(intent);
      return;
    }
    if (intent.conversationKind === "conversation") {
      await this.dispatchConversation(intent);
      return;
    }
    await this.dispatchTeammateDirect(intent);
  }

  private async dispatchChannel(intent: RemoteDispatchIntent): Promise<void> {
    const channel = this.options.store.getChannel(intent.conversationId);
    const sourceMessage = getChannelMessageView(this.options.store, intent.messageId);
    if (!channel || channel.workspaceId !== intent.workspaceId || !sourceMessage || sourceMessage.channelId !== channel.id) {
      throw new Error(`Remote channel reply source is unavailable: ${intent.id}`);
    }
    const teammateId = sourceMessage.mentions.find((mention) => mention.kind === "ai-teammate")?.id
      ?? channel.defaultTeammateId;
    const teammate = teammateId ? this.options.store.getAiTeammate(teammateId) : undefined;
    const providerPresetId = resolveRemoteReplyProviderPresetId({
      teammate,
      surface: "channel",
      workspaceDefaultProviderPresetId: this.options.store.getWorkspaceSettings().defaultProviderPresetId,
      channelDefaultProviderPresetId: channel.defaultProviderPresetId,
    });
    if (providerPresetId) {
      await this.options.providerStartupRefresh.refreshBeforeRun({
        cwd: this.options.store.paths.cwd,
        store: this.options.store,
        providerPresetId,
      });
    }
    await createAiChannelReply({
      startRun: async (request, sink) => await executeRunRequest(
        request,
        sink,
        this.options.runnerRegistry,
        this.options.storeRegistry,
        this.options.activeRuns,
        this.options.runtimeSupervisor,
        this.options.secretResolver,
        this.options.mcpBroker,
        {
          controlPlaneEvents: this.options.controlPlaneEvents,
          startupState: this.options.startupState,
          computerUsePreviews: this.options.computerUsePreviews,
        },
      ),
      store: this.options.store,
      channel,
      sourceMessage,
      ...(providerPresetId ? { providerPresetId } : {}),
      ...(teammateId ? { teammateId } : {}),
      proposalMode: "disabled",
      secretResolver: this.options.secretResolver,
      teamObserverBusEnabled: false,
      completionMode: "background",
      trackCompletion: (completion) => this.options.activeRuns.trackCompletion(completion),
      replyMessageId: remoteReplyMessageId(intent),
      disableWebEvidence: true,
    });
  }

  private async dispatchConversation(intent: RemoteDispatchIntent): Promise<void> {
    const thread = this.options.store.getLingThread(intent.conversationId);
    const turn = this.options.store.getLingTurn(intent.messageId);
    if (!thread || thread.kind !== "conversation" || thread.workspaceId !== intent.workspaceId || !turn || turn.threadId !== thread.id) {
      throw new Error(`Remote conversation reply source is unavailable: ${intent.id}`);
    }
    const previousRun = thread.lastRunId ? this.options.store.getRun(thread.lastRunId) : undefined;
    const providerPresetId = previousRun?.providerPresetId ?? this.options.store.getWorkspaceSettings().defaultProviderPresetId;
    if (!providerPresetId) {
      throw new Error(`Remote conversation has no server-owned provider selection: ${thread.id}`);
    }
    await this.options.providerStartupRefresh.refreshBeforeRun({
      cwd: this.options.store.paths.cwd,
      store: this.options.store,
      providerPresetId,
    });
    const runId = await startDetachedRunAndResolveReady((onRunReady) => executeRunRequest(
      buildRemoteConversationRunRequest({
        workspaceCwd: this.options.store.paths.cwd,
        intent,
        thread,
        turn,
        providerPresetId,
      }),
      createDetachedRunExecutionSink(),
      this.options.runnerRegistry,
      this.options.storeRegistry,
      this.options.activeRuns,
      this.options.runtimeSupervisor,
      this.options.secretResolver,
      this.options.mcpBroker,
      {
        onRunReady,
        controlPlaneEvents: this.options.controlPlaneEvents,
        startupState: this.options.startupState,
        computerUsePreviews: this.options.computerUsePreviews,
      },
    ));
    if (!runId) {
      throw new Error(`Remote conversation reply failed to start: ${intent.id}`);
    }
  }

  private async dispatchTeammateDirect(intent: RemoteDispatchIntent): Promise<void> {
    const sourceMessage = this.options.store.getTeammateDirectMessage(intent.messageId);
    const thread = this.options.store.listTeammateDirectThreads({ limit: 500 })
      .find((candidate) => candidate.id === intent.conversationId);
    const teammate = thread ? this.options.store.getAiTeammate(thread.teammateId) : undefined;
    if (!sourceMessage || !thread || !teammate || sourceMessage.threadId !== thread.id || thread.workspaceId !== intent.workspaceId) {
      throw new Error(`Remote teammate reply source is unavailable: ${intent.id}`);
    }
    const providerPresetId = resolveRemoteReplyProviderPresetId({
      teammate,
      surface: "private",
      workspaceDefaultProviderPresetId: this.options.store.getWorkspaceSettings().defaultProviderPresetId,
    });
    if (!providerPresetId) {
      throw new Error(`Remote teammate conversation has no server-owned provider selection: ${thread.id}`);
    }
    await this.options.providerStartupRefresh.refreshBeforeRun({
      cwd: this.options.store.paths.cwd,
      store: this.options.store,
      providerPresetId,
    });
    await createAiTeammateDirectReply({
      startRun: async (request, sink) => await executeRunRequest(
        request,
        sink,
        this.options.runnerRegistry,
        this.options.storeRegistry,
        this.options.activeRuns,
        this.options.runtimeSupervisor,
        this.options.secretResolver,
        this.options.mcpBroker,
        {
          controlPlaneEvents: this.options.controlPlaneEvents,
          startupState: this.options.startupState,
          computerUsePreviews: this.options.computerUsePreviews,
        },
      ),
      store: this.options.store,
      teammate,
      thread,
      sourceMessage,
      providerPresetId,
      authorizationMode: "ask",
      workspaceAccessMode: "read_only",
      permissionPreset: "read_only",
      workspace: createRemoteDirectWorkspace(this.options.store, thread),
      secretResolver: this.options.secretResolver,
      replyMessageId: remoteReplyMessageId(intent),
      toolsOverride: [],
      disableWebEvidence: true,
      systemPromptAppend: REMOTE_REPLY_SYSTEM_PROMPT,
      idempotencyKeyOverride: intent.id,
    });
  }
}

export function resolveRemoteReplyProviderPresetId(input: {
  readonly teammate?: Pick<AiTeammate, "id" | "modelBindingMode" | "providerPresetId">;
  readonly surface: "private" | "channel";
  readonly workspaceDefaultProviderPresetId?: string;
  readonly channelDefaultProviderPresetId?: Channel["defaultProviderPresetId"];
}): string | undefined {
  if (!input.teammate) {
    return input.surface === "channel"
      ? input.channelDefaultProviderPresetId
      : input.workspaceDefaultProviderPresetId;
  }
  return resolveEffectiveTeammateProviderPresetId({
    teammate: input.teammate,
    surface: input.surface,
    workspaceDefaultProviderPresetId: input.workspaceDefaultProviderPresetId,
    channelDefaultProviderPresetId: input.channelDefaultProviderPresetId,
  });
}

export function buildRemoteConversationRunRequest(input: {
  readonly workspaceCwd: string;
  readonly intent: RemoteDispatchIntent;
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly providerPresetId: string;
}): RunRequest {
  return {
    workspaceCwd: input.workspaceCwd,
    cwd: input.workspaceCwd,
    task: {
      id: `remote_conversation_${input.turn.id}`,
      title: input.turn.title,
      prompt: input.turn.userInstruction,
    },
    threadId: input.thread.id,
    turnId: input.turn.id,
    teammateId: LING_AGENT_ID,
    providerPresetId: input.providerPresetId,
    tools: [],
    authorizationMode: "ask",
    workspaceAccessMode: "read_only",
    permissionPreset: "read_only",
    thinkingLevel: "medium",
    systemPrompt: REMOTE_REPLY_SYSTEM_PROMPT,
    sourceMessageId: input.intent.messageId,
    createdByActor: "local-user",
    idempotencyKey: input.intent.id,
  };
}

function remoteReplyMessageId(intent: RemoteDispatchIntent): string {
  return `remote_reply_${intent.id.replace(/^remote_dispatch_/u, "")}`;
}

function createRemoteDirectWorkspace(store: RunStore, thread: TeammateDirectThread): DirectWorkspaceReady {
  const binding: DirectWorkspaceBinding = {
    mode: "local",
    status: "ready",
    executionPath: store.paths.cwd,
    updatedAt: thread.updatedAt,
  };
  const snapshot: DirectWorkspaceSnapshot = {
    mode: "local",
    status: "ready",
    workspaceCwd: store.paths.cwd,
    executionCwd: store.paths.cwd,
  };
  return {
    thread,
    binding,
    snapshot,
    executionCwd: store.paths.cwd,
  };
}
