import { resolveEffectiveTeammateProviderPresetId, type Channel, type ChannelExecutionProposal, type ChannelMessage, type RunStore, type RunTool } from "@ling-stack/core";
import { isLingAgentExecutorId } from "./ling-agent-executor.js";
import { resolveChannelConversationSurface } from "./conversation-surface.js";

export type LingAutoStartRisk = "low" | "medium" | "high";

export type LingAutoStartBlockReason =
  | "missing_target"
  | "missing_content"
  | "ambiguous_acceptance"
  | "missing_executor"
  | "tool_denied"
  | "policy_requires_confirmation";

type LingAutoStartRiskReason =
  | "external_side_effect"
  | "credential_or_provider_change"
  | "approval_policy_change"
  | "deploy_release_publish"
  | "git_push_or_merge"
  | "broad_delete_or_move";

export interface LingAutoStartDecision {
  readonly allowed: boolean;
  readonly risk: LingAutoStartRisk;
  readonly reason: string;
  readonly blockReason?: LingAutoStartBlockReason;
}

export function decideLingAgentAutoStart(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly proposal: ChannelExecutionProposal;
}): LingAutoStartDecision {
  const { channel, sourceMessage, proposal, store } = input;
  if (sourceMessage.authorType !== "local-user" || sourceMessage.kind !== "message" || sourceMessage.intent !== "discuss") {
    return blocked("policy_requires_confirmation", "Auto-start only applies to local-user discussion messages.");
  }
  if (channel.status !== "active") {
    return blocked("policy_requires_confirmation", `Channel is ${channel.status}; auto-start requires an active channel.`);
  }
  if (proposal.status === "blocked" || proposal.errorMessage) {
    return blocked("missing_executor", proposal.errorMessage ?? "Proposal is blocked and needs user review.");
  }
  if (proposal.status !== "draft") {
    return blocked("policy_requires_confirmation", `Proposal status is ${proposal.status}; only draft proposals are eligible.`);
  }
  if (proposal.linkedWorkflowId || proposal.linkedRunId || proposal.linkedTaskId) {
    return blocked("policy_requires_confirmation", "Proposal is already linked to executable work.");
  }
  const directWorkflow = isDirectWorkflowProposal(store, sourceMessage, proposal);
  if (proposal.collaborationSteps.length !== 1 && !directWorkflow) {
    return blocked("policy_requires_confirmation", "Multi-step collaboration requires user confirmation before start.");
  }
  for (const step of proposal.collaborationSteps.length > 0 ? proposal.collaborationSteps : [{ teammateId: proposal.assigneeTeammateId }]) {
    const participantId = step.teammateId;
    const participant = store.getAiTeammate(participantId);
    if (!isLingAgentExecutorId(participantId) && !participant) {
      return blocked("missing_executor", `Proposal teammate is not available: ${participantId}.`);
    }
    const providerPresetId = participant
      ? resolveEffectiveTeammateProviderPresetId({
          teammate: participant,
          surface: "channel",
          workspaceDefaultProviderPresetId: store.getWorkspaceSettings().defaultProviderPresetId,
          channelDefaultProviderPresetId: channel.defaultProviderPresetId,
        })
      : channel.defaultProviderPresetId;
    if (!providerPresetId) {
      return blocked("missing_executor", `No runnable provider is configured for proposal executor: ${participantId}.`);
    }
  }
  if (proposal.acceptanceCriteria.length === 0) {
    return blocked("ambiguous_acceptance", "Proposal has no acceptance criteria.");
  }
  const unsupportedTool = proposal.requiredTools.find((tool) => !autoStartAllowedTools.has(tool));
  if (unsupportedTool) {
    return blocked("policy_requires_confirmation", `Tool ${unsupportedTool} requires explicit confirmation before start.`);
  }
  const approvalPolicy = store.getApprovalPolicy();
  const deniedTools = proposal.requiredTools.filter((tool) => approvalPolicy.toolDecisions[tool] === "deny");
  if (deniedTools.length > 0) {
    return blocked("tool_denied", `Workspace approval policy denies required tools: ${deniedTools.join(", ")}.`);
  }

  const highRiskText = normalizeText([
    sourceMessage.body,
    proposal.title,
  ].join("\n"));
  const highRisk = classifyHighRiskText(highRiskText);

  const text = normalizeText([
    sourceMessage.body,
    proposal.title,
    proposal.prompt,
    proposal.riskSummary ?? "",
    ...proposal.acceptanceCriteria,
    ...proposal.collaborationSteps.map((step) => step.summary),
  ].join("\n"));

  if (resolveChannelConversationSurface(store, channel.id, sourceMessage).kind !== "root" && highRisk) {
    return blocked("policy_requires_confirmation", `Thread follow-up contains a high-risk side effect and needs confirmation before start: ${highRisk}.`);
  }

  if (proposal.requiredTools.includes("bash") && !directWorkflow && !looksLikeNarrowLocalCommand(text)) {
    return blocked("policy_requires_confirmation", "Bash work is not narrow enough for auto-start.");
  }
  if ((proposal.requiredTools.includes("write") || proposal.requiredTools.includes("edit")) && !directWorkflow && !looksLikeNamedLocalFileWork(text)) {
    return blocked("missing_target", "File work needs a named local file target before auto-start.");
  }
  const riskyToolDecisions = proposal.requiredTools
    .filter((tool) => tool === "bash" || tool === "write" || tool === "edit")
    .map((tool) => `${tool}=${approvalPolicy.toolDecisions[tool]}`);

  return {
    allowed: true,
    risk: highRisk ? "high" : proposal.requiredTools.some((tool) => tool === "bash" || tool === "write" || tool === "edit") ? "medium" : "low",
    reason: [
      `Ling Agent auto-start accepted executable work with tools: ${proposal.requiredTools.join(", ") || "read-only"}.`,
      riskyToolDecisions.length > 0 ? `Runtime approval policy: ${riskyToolDecisions.join(", ")}.` : "",
      highRisk ? `High-risk side effect is runtime-gated: ${highRisk}.` : "",
    ].filter(Boolean).join(" "),
  };
}

const autoStartAllowedTools = new Set<RunTool>(["read", "grep", "find", "ls", "bash", "edit", "write"]);

function blocked(blockReason: LingAutoStartBlockReason, reason: string): LingAutoStartDecision {
  return {
    allowed: false,
    risk: "high",
    blockReason,
    reason,
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isDirectWorkflowProposal(
  store: RunStore,
  sourceMessage: ChannelMessage,
  proposal: ChannelExecutionProposal,
): boolean {
  return store
    .listChannelIntentDecisions({
      channelId: proposal.channelId,
      sourceItemId: sourceMessage.id,
      action: "execute",
      status: "accepted",
      limit: 10,
    })
    .some((decision) => decision.proposalId === proposal.id);
}

function classifyHighRiskText(text: string): LingAutoStartRiskReason | undefined {
  if (/(git\s+)?(push|merge|rebase)|合并|推送|提交到远端|远端分支|pr\s*合并|pull request\s*merge/iu.test(text)) {
    return "git_push_or_merge";
  }
  if (/(deploy|deployment|release|publish|ship|上线|部署|发布|发版|上线发布)/iu.test(text)) {
    return "deploy_release_publish";
  }
  if (/(credential|secret|token|api\s*key|apikey|password|provider|oauth|keychain|凭据|密钥|令牌|密码|供应商|模型配置|provider|授权配置)/iu.test(text)) {
    return "credential_or_provider_change";
  }
  if (/(approval\s*policy|permission\s*policy|权限策略|审批策略|approval setting|权限设置)/iu.test(text)) {
    return "approval_policy_change";
  }
  if (/(rm\s+-rf|delete|remove|cleanup|clean\s+all|wipe|drop\s+table|删除|移除|清空|清理|重命名|移动).{0,80}(目录|文件夹|所有|全部|workspace|repo|仓库|项目|data|数据)?/iu.test(text)) {
    return "broad_delete_or_move";
  }
  if (/(send|email|slack|webhook|post to|charge|payment|buy|purchase|external|发送|发到|邮件|付款|支付|购买|外部服务|第三方)/iu.test(text)) {
    return "external_side_effect";
  }
  return undefined;
}

function looksLikeNarrowLocalCommand(text: string): boolean {
  return /\b(pnpm|npm|yarn|bun|cargo|go|pytest|make|swift|xcodebuild)\s+(test|run|build|lint|format|typecheck|check|test:[\w:-]+|e2e|ci)\b|测试|typecheck|lint|构建|检查|验收/iu.test(text);
}

function looksLikeNamedLocalFileWork(text: string): boolean {
  return /(?:\/(?!\/)|\.{1,2}\/|Users\/)?[\w.-]+\.(?:md|txt|json|jsonl|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|sql|css|scss|html|xml|csv|env|example)\b/iu.test(text);
}
