import {
  resolveEffectiveTeammateProviderPresetId,
  type SecretResolver,
  type TeammateDirectMessage,
} from "@ling-stack/core";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { ProviderStartupRefreshService } from "../providers/startup-refresh.js";
import type { LingImageVisionSummarizer } from "../channels/materialization/registry.js";
import {
  DirectReplyControlService,
} from "../teammates/direct-controls.js";
import type { ActiveDirectReplyRegistry } from "../teammates/direct-reply-active-registry.js";
import { createAiTeammateDirectReply, type StartTeammateDirectRun } from "../teammates/direct-replies.js";
import { ensureDirectWorkspaceReady } from "../teammates/direct-workspace.js";
import { RunControlService } from "../../run-control.js";
import type { CreateCompanionReply, CreateCompanionReplyInput } from "./dialogue.js";

export interface CompanionReplyServiceDependencies {
  readonly startRun: StartTeammateDirectRun;
  readonly activeRuns: ActiveRunRegistry;
  readonly secretResolver: SecretResolver;
  readonly activeDirectReplies: ActiveDirectReplyRegistry;
  readonly providerStartupRefresh: ProviderStartupRefreshService;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export class CompanionReplyService {
  private readonly directReplyControl: DirectReplyControlService;

  constructor(private readonly dependencies: CompanionReplyServiceDependencies) {
    this.directReplyControl = new DirectReplyControlService({
      startRun: dependencies.startRun,
      activeRuns: dependencies.activeRuns,
      secretResolver: dependencies.secretResolver,
      activeDirectReplies: dependencies.activeDirectReplies,
      runControl: new RunControlService(),
      providerStartupRefresh: dependencies.providerStartupRefresh,
      imageVisionSummarizer: dependencies.imageVisionSummarizer,
    });
  }

  readonly createReply: CreateCompanionReply = async (input: CreateCompanionReplyInput): Promise<TeammateDirectMessage> => {
    const workspace = await ensureDirectWorkspaceReady({
      store: input.store,
      thread: input.thread,
      workspaceCwd: input.store.paths.cwd,
    });
    if (!workspace.ok) {
      const blocked = input.store.createTeammateDirectMessage(
        {
          ...(input.replyMessageId ? { id: input.replyMessageId } : {}),
          threadId: input.thread.id,
          teammateId: input.teammate.id,
          authorType: "ai-teammate",
          authorId: input.teammate.id,
          body: `私聊工作区不可用：${workspace.message}`,
          status: "blocked",
          errorMessage: workspace.message,
        },
        new Date().toISOString(),
      );
      input.stream?.onBlocked(blocked);
      return blocked;
    }

    const providerPresetId = resolveEffectiveTeammateProviderPresetId({
      teammate: input.teammate,
      surface: "private",
      workspaceDefaultProviderPresetId: input.store.getWorkspaceSettings().defaultProviderPresetId,
    });
    await this.dependencies.providerStartupRefresh.refreshBeforeRun({
      cwd: input.store.paths.cwd,
      store: input.store,
      providerPresetId,
    });
    let sourceWorkUnitId: string | undefined;
    const reply = await createAiTeammateDirectReply({
      startRun: this.dependencies.startRun,
      store: input.store,
      teammate: input.teammate,
      thread: input.thread,
      sourceMessage: input.sourceMessage,
      workspace: workspace.workspace,
      secretResolver: this.dependencies.secretResolver,
      imageVisionSummarizer: this.dependencies.imageVisionSummarizer,
      webFetch: this.dependencies.webFetch,
      webResolveHostAddresses: this.dependencies.webResolveHostAddresses,
      signal: input.signal,
      ...(input.replyMessageId ? { replyMessageId: input.replyMessageId } : {}),
      disableWebEvidence: input.disableWebEvidence,
      systemPromptAppend: input.systemPromptAppend,
      onWorkUnitStarted: (handle) => {
        sourceWorkUnitId = handle.workUnitId;
        input.onWorkUnitStarted?.(handle);
      },
      stream: input.stream,
    });
    await this.directReplyControl.maybeStartNextQueuedContinuation({
      store: input.store,
      teammateId: input.teammate.id,
      threadId: input.thread.id,
      sourceWorkUnitId,
    });
    return reply;
  };
}
