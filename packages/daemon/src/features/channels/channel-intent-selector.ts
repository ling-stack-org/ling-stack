import type {
  AiTeammate,
  Channel,
  ChannelIntentDecision,
  ChannelExecutionProposal,
  ChannelExecutionProposalStep,
  ChannelMessage,
  ResponseLanguage,
  RunTool,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { resolveEffectiveChannelCollaborationProtocol } from "./collaboration-protocol.js";
import { compactChannelDiscussionForNoToolsRetry, isContextLengthError } from "./context-compaction.js";
import { buildChannelIntentSelectorContextPack, renderContextPack } from "./context-packs.js";
import { resolveChannelResponseLanguage } from "./response-language.js";

export interface ChannelIntentSelectorInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly requestedProviderPresetId?: string;
  readonly secretResolver: SecretResolver;
  readonly config?: ResolvedDaemonConfig;
  readonly runnerRegistry?: RunnerRegistry;
}

export type ChannelIntentSelectorResult =
  | {
      readonly action: "continue";
    }
  | {
      readonly action: "no_reply";
      readonly intentDecisionId: string;
    }
  | {
      readonly action: "clarify";
      readonly aiReply: ChannelMessage;
      readonly intentDecisionId: string;
    }
  | {
      readonly action: "visible_multi_reply";
      readonly teammateIds: readonly string[];
      readonly reason: string;
      readonly createdBy: "deterministic" | "model";
      readonly aiReplies?: readonly ChannelMessage[];
      readonly intentDecisionId?: string;
    }
  | {
      readonly action: "workflow_proposal";
      readonly proposal: ChannelExecutionProposal;
      readonly intentDecisionId: string;
    };

type IntentReasonCode =
  | "all_teammates_request"
  | "ordered_work_request"
  | "multi_role_request"
  | "explicit_workflow_start";

type ClarifyReasonCode =
  | "missing_target"
  | "missing_acceptance"
  | "approval_sensitive_target";

interface ChannelIntentModelOutput {
  readonly action: "no_reply" | "single_reply" | "visible_multi_reply" | "clarify" | "workflow_proposal" | "direct_workflow";
  readonly reason: string;
}

interface RoleMatch {
  readonly roleKey: AiTeammate["roleKey"];
  readonly summary: string;
  readonly summaryZh: string;
  readonly action: ChannelExecutionProposalStep["action"];
}

type ProposalParticipantSelection = {
  readonly teammate: AiTeammate;
  readonly role: RoleMatch;
};

interface SingleStepExecutableIntent {
  readonly kind: "file_create" | "file_edit" | "command_run";
  readonly title: string;
  readonly prompt: string;
  readonly actionSummary: string;
  readonly targetLabel: string;
  readonly requiredTools: readonly RunTool[];
  readonly rolePreferences: readonly AiTeammate["roleKey"][];
  readonly acceptanceCriteria: readonly string[];
  readonly riskSummary: string;
}

const roleMatches: readonly RoleMatch[] = [
  {
    roleKey: "architect",
    summary: "Define implementation boundaries and sequencing before execution.",
    summaryZh: "执行前先拆解实现边界和步骤顺序。",
    action: "coordinated",
  },
  {
    roleKey: "engineer",
    summary: "Implement the approved step after the boundary is clear.",
    summaryZh: "在边界清楚后执行已确认的实现步骤。",
    action: "coordinated",
  },
  {
    roleKey: "qa",
    summary: "Validate the expected behavior and regression checks.",
    summaryZh: "验证预期行为和回归检查项。",
    action: "reviewed",
  },
  {
    roleKey: "designer",
    summary: "Review interaction quality and visible product behavior.",
    summaryZh: "检查交互质量和可见产品行为。",
    action: "reviewed",
  },
  {
    roleKey: "product",
    summary: "Clarify product scope and acceptance before execution.",
    summaryZh: "执行前澄清产品范围和验收标准。",
    action: "consulted",
  },
  {
    roleKey: "security",
    summary: "Review trust boundaries and approval-sensitive risks.",
    summaryZh: "审查信任边界和需要审批的风险。",
    action: "flagged_risk",
  },
  {
    roleKey: "docs",
    summary: "Keep documentation aligned with the shipped behavior.",
    summaryZh: "保持文档与实际交付行为一致。",
    action: "reviewed",
  },
  {
    roleKey: "release",
    summary: "Prepare shipping checks and approval-sensitive publication steps.",
    summaryZh: "准备发布检查和需要审批的发布步骤。",
    action: "coordinated",
  },
];

export async function selectChannelWorkflowIntent(input: ChannelIntentSelectorInput): Promise<ChannelIntentSelectorResult> {
  if (!messageCanCreateWorkflowProposal(input)) {
    return { action: "continue" };
  }
  const modelIntent = await maybeSelectModelAssistedIntent(input);
  if (modelIntent) {
    return modelIntent;
  }
  return selectDeterministicChannelWorkflowIntent(input);
}

function selectDeterministicChannelWorkflowIntent(input: ChannelIntentSelectorInput): ChannelIntentSelectorResult {
  const visibleMultiReply = selectVisibleMultiReply(input, "deterministic");
  if (visibleMultiReply) {
    return visibleMultiReply;
  }

  const reasonCode = detectWorkflowIntentReason(input.sourceMessage);
  if (reasonCode && reasonCode !== "explicit_workflow_start") {
    return createWorkflowIntentResult(input, reasonCode, "deterministic");
  }
  const executableIntent = detectSingleStepExecutableIntent(input.sourceMessage);
  if (executableIntent) {
    return createSingleStepExecutableProposal(input, executableIntent, "deterministic");
  }
  if (!reasonCode) {
    const clarifyReasonCode = detectClarifyIntentReason(input.sourceMessage);
    if (!clarifyReasonCode) {
      return { action: "continue" };
    }
    return createClarifyReply(input, clarifyReasonCode);
  }
  return createWorkflowIntentResult(input, reasonCode, "deterministic");
}

function createWorkflowIntentResult(
  input: ChannelIntentSelectorInput,
  reasonCode: IntentReasonCode,
  createdBy: "deterministic" | "model",
  decisionReason?: string,
): ChannelIntentSelectorResult {
  const existingProposal = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, sourceMessageId: input.sourceMessage.id, limit: 1 })
    .find((proposal) => proposal.status !== "cancelled" && proposal.status !== "superseded");
  if (existingProposal) {
    const action = intentDecisionActionForReason(reasonCode);
    const decision = persistIntentDecision(input, {
      action,
      proposalId: existingProposal.id,
      reason: `Existing ${action} proposal already covers this message: ${existingProposal.id}`,
      status: "suppressed",
      createdBy: "deterministic",
    });
    return { action: "workflow_proposal", proposal: existingProposal, intentDecisionId: decision.id };
  }

  const participants = selectProposalParticipants(input, reasonCode);
  if (participants.length === 0) {
    return { action: "continue" };
  }

  return createWorkflowProposal(input, reasonCode, intentDecisionActionForReason(reasonCode), createdBy, decisionReason, participants);
}

async function maybeSelectModelAssistedIntent(input: ChannelIntentSelectorInput): Promise<ChannelIntentSelectorResult | undefined> {
  if (!input.config?.channels.intentSelector || !input.runnerRegistry) {
    return undefined;
  }
  try {
    const output = await requestModelIntent(input);
    return applyModelIntentOutput(input, output);
  } catch {
    return undefined;
  }
}

function applyModelIntentOutput(input: ChannelIntentSelectorInput, output: ChannelIntentModelOutput): ChannelIntentSelectorResult | undefined {
  if (output.action === "single_reply") {
    persistIntentDecision(input, {
      action: "single_reply",
      reason: output.reason,
      status: "accepted",
      createdBy: "model",
    });
    return { action: "continue" };
  }
  if (output.action === "no_reply") {
    const decision = persistIntentDecision(input, {
      action: "no_reply",
      reason: output.reason,
      status: "suppressed",
      createdBy: "model",
    });
    return { action: "no_reply", intentDecisionId: decision.id };
  }
  if (output.action === "clarify") {
    return createClarifyReply(input, clarifyReasonFromMessage(input.sourceMessage), "model", output.reason);
  }
  if (output.action === "visible_multi_reply") {
    return selectVisibleMultiReply(input, "model", output.reason);
  }
  if (output.action === "direct_workflow") {
    const executableIntent = detectSingleStepExecutableIntent(input.sourceMessage);
    if (executableIntent) {
      return createSingleStepExecutableProposal(input, executableIntent, "model", output.reason);
    }
  }

  const reasonCode = output.action === "direct_workflow"
    ? "explicit_workflow_start"
    : detectWorkflowIntentReason(input.sourceMessage) ?? "ordered_work_request";
  const participants = selectProposalParticipants(input, reasonCode);
  if (participants.length === 0) {
    return undefined;
  }
  return createWorkflowProposal(input, reasonCode, output.action, "model", output.reason, participants);
}

async function requestModelIntent(input: ChannelIntentSelectorInput): Promise<ChannelIntentModelOutput> {
  if (!input.runnerRegistry) {
    throw new Error("Channel intent selector runner registry is not available.");
  }
  const providerPresetId = resolveRunnableIntentProviderPresetId(input);
  if (!providerPresetId) {
    throw new Error("No runnable provider is available for channel intent selection.");
  }
  let contextPack = buildChannelIntentSelectorContextPack({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    providerPresetId,
  });
  let prompt = renderContextPack(contextPack);
  const runnerResolution = input.runnerRegistry.resolve({ tools: [], allowFallback: true });
  const textDeltas: string[] = [];
  const runIntentTask = async (taskPrompt: string) => {
    const provider = resolveProviderForRun(input.store, {
      cwd: input.store.paths.cwd,
      workspaceCwd: input.store.paths.cwd,
      task: {
        id: input.sourceMessage.id,
        title: `Channel intent selection in ${input.channel.name}`,
        prompt: taskPrompt,
        channelId: input.channel.id,
      },
      providerPresetId,
      tools: [],
      thinkingLevel: "low",
      systemPrompt: "You are Ling's channel intent selector. Return strict JSON only.",
    }, input.secretResolver);
    return runnerResolution.runner.adapter.runTask({
      cwd: input.store.paths.cwd,
      task: {
        id: input.sourceMessage.id,
        title: `Channel intent selection in ${input.channel.name}`,
        prompt: taskPrompt,
        channelId: input.channel.id,
      },
      provider,
      tools: [],
      thinkingLevel: "low",
      systemPrompt: "You are Ling's channel intent selector. Return strict JSON only.",
      onEvent: (event) => {
        if (event.type === "assistant_text_delta") {
          textDeltas.push(event.text);
        }
      },
    });
  };
  let result: Awaited<ReturnType<typeof runIntentTask>>;
  try {
    result = await runIntentTask(prompt);
  } catch (error) {
    if (!isContextLengthError(error)) {
      throw error;
    }
    const compaction = compactChannelDiscussionForNoToolsRetry({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      now: new Date().toISOString(),
    });
    contextPack = buildChannelIntentSelectorContextPack({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      providerPresetId,
      compactedChannelSummary: compaction.compactedSummary,
      minimal: true,
    });
    prompt = renderContextPack(contextPack);
    textDeltas.length = 0;
    result = await runIntentTask(prompt);
  }
  const text = textDeltas.join("").trim() || extractAssistantText(result.messages) || "";
  return parseModelIntentOutput(text);
}

function resolveRunnableIntentProviderPresetId(input: ChannelIntentSelectorInput): string | undefined {
  const candidateIds = [
    input.requestedProviderPresetId,
    input.channel.defaultProviderPresetId,
    ...input.store.listProviderPresets({ enabled: true })
      .filter((preset) => preset.capabilities.includes("chat") && preset.api !== "media-job")
      .map((preset) => preset.id),
  ].filter((id): id is string => Boolean(id));
  for (const providerPresetId of [...new Set(candidateIds)]) {
    try {
      resolveProviderForRun(input.store, {
        cwd: input.store.paths.cwd,
        workspaceCwd: input.store.paths.cwd,
        task: {
          id: input.sourceMessage.id,
          title: `Channel intent selection in ${input.channel.name}`,
          prompt: input.sourceMessage.body || "Classify channel message intent",
          channelId: input.channel.id,
        },
        providerPresetId,
        tools: [],
        thinkingLevel: "low",
      }, input.secretResolver);
      return providerPresetId;
    } catch {
      continue;
    }
  }
  return undefined;
}

function parseModelIntentOutput(text: string): ChannelIntentModelOutput {
  const parsed = JSON.parse(readStrictJsonObject(text)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Intent model output must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const action = record.action;
  const reason = record.reason;
  if (
    (action !== "no_reply" &&
      action !== "single_reply" &&
      action !== "visible_multi_reply" &&
      action !== "clarify" &&
      action !== "workflow_proposal" &&
      action !== "direct_workflow") ||
    typeof reason !== "string" ||
    reason.trim().length === 0
  ) {
    throw new Error("Intent model output schema is invalid.");
  }
  return { action, reason: reason.trim() };
}

function readStrictJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  throw new Error("Intent model output must be a strict JSON object.");
}

function selectVisibleMultiReply(
  input: ChannelIntentSelectorInput,
  createdBy: "deterministic" | "model",
  modelReason?: string,
): ChannelIntentSelectorResult | undefined {
  if (!detectVisibleMultiReplyIntent(input.sourceMessage)) {
    return undefined;
  }

  const existingDecision = input.store
    .listChannelIntentDecisions({
      channelId: input.channel.id,
      sourceMessageId: input.sourceMessage.id,
      action: "visible_multi_reply",
      status: "accepted",
      limit: 1,
    })
    [0];
  if (existingDecision) {
    const aiReplies = (existingDecision.replyMessageIds ?? [])
      .map((replyMessageId) => input.store.getChannelMessage(replyMessageId))
      .filter((message): message is ChannelMessage => Boolean(message && message.channelId === input.channel.id));
    return {
      action: "visible_multi_reply",
      teammateIds: existingDecision.selectedTeammateIds ?? [],
      reason: existingDecision.reason,
      createdBy: existingDecision.createdBy,
      aiReplies,
      intentDecisionId: existingDecision.id,
    };
  }

  const teammates = selectVisibleMultiReplyTeammates(input);
  if (teammates.length < 2) {
    return undefined;
  }
  return {
    action: "visible_multi_reply",
    teammateIds: teammates.map((teammate) => teammate.id),
    reason: modelReason ?? "Visible multi-reply selected for explicit discussion-only multi-teammate request.",
    createdBy,
  };
}

function createWorkflowProposal(
  input: ChannelIntentSelectorInput,
  reasonCode: IntentReasonCode,
  decisionAction: "workflow_proposal" | "direct_workflow",
  createdBy: "deterministic" | "model",
  decisionReason: string | undefined,
  participants: readonly ProposalParticipantSelection[],
): ChannelIntentSelectorResult {
  const existingProposal = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, sourceMessageId: input.sourceMessage.id, limit: 1 })
    .find((proposal) => proposal.status !== "cancelled" && proposal.status !== "superseded");
  if (existingProposal) {
    const decision = persistIntentDecision(input, {
      action: decisionAction,
      proposalId: existingProposal.id,
      reason: `Existing ${decisionAction} proposal already covers this message: ${existingProposal.id}`,
      status: "suppressed",
      createdBy,
    });
    return { action: "workflow_proposal", proposal: existingProposal, intentDecisionId: decision.id };
  }

  const assignee = chooseAssignee(input, participants);
  const proposedBy = chooseProposedBy(input, assignee);
  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel: input.channel,
    sourceText: input.sourceMessage.body,
  }).language;
  const now = new Date().toISOString();
  const proposal = input.store.createChannelExecutionProposal(
    {
      channelId: input.channel.id,
      sourceMessageId: input.sourceMessage.id,
      proposedByTeammateId: proposedBy.id,
      title: buildProposalTitle(input.sourceMessage.body, reasonCode),
      prompt: buildProposalPrompt(input.sourceMessage.body, participants, responseLanguage),
      assigneeTeammateId: assignee.id,
      acceptanceCriteria: buildAcceptanceCriteria(responseLanguage),
      collaborationSteps: participants.map((participant) => ({
        teammateId: participant.teammate.id,
        action: participant.role.action,
        summary: roleSummary(participant.role, responseLanguage),
      })),
      requiredTools: deriveRequiredTools(participants),
      riskSummary: buildRiskSummary(reasonCode, responseLanguage),
      responseLanguage,
      status: "draft",
    },
    now,
  );
  const decision = persistIntentDecision(input, {
    action: decisionAction,
    proposalId: proposal.id,
    reason: decisionReason ?? `${decisionAction === "direct_workflow" ? "Direct workflow proposal" : "Workflow proposal"} created from channel intent: ${reasonCode}.`,
    status: "accepted",
    createdBy,
  });
  return { action: "workflow_proposal", proposal, intentDecisionId: decision.id };
}

function createSingleStepExecutableProposal(
  input: ChannelIntentSelectorInput,
  executableIntent: SingleStepExecutableIntent,
  createdBy: "deterministic" | "model",
  decisionReason?: string,
): ChannelIntentSelectorResult {
  const existingProposal = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, sourceMessageId: input.sourceMessage.id, limit: 1 })
    .find((proposal) => proposal.status !== "cancelled" && proposal.status !== "superseded");
  if (existingProposal) {
    const decision = persistIntentDecision(input, {
      action: "direct_workflow",
      proposalId: existingProposal.id,
      reason: `Existing direct_workflow proposal already covers this message: ${existingProposal.id}`,
      status: "suppressed",
      createdBy,
    });
    return { action: "workflow_proposal", proposal: existingProposal, intentDecisionId: decision.id };
  }

  const participant = selectSingleStepExecutableParticipant(input, executableIntent);
  if (!participant) {
    return createClarifyReply(input, "missing_target", createdBy, decisionReason ?? "No active teammate is available for this executable request.");
  }

  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel: input.channel,
    sourceText: input.sourceMessage.body,
  }).language;
  const blocker = singleStepExecutableBlocker(input, executableIntent, participant.teammate, responseLanguage);
  const now = new Date().toISOString();
  const riskSummary = blocker
    ? `${executableIntent.riskSummary}\n\n${blocker}`
    : executableIntent.riskSummary;
  const proposal = input.store.createChannelExecutionProposal(
    {
      channelId: input.channel.id,
      sourceMessageId: input.sourceMessage.id,
      proposedByTeammateId: participant.teammate.id,
      title: executableIntent.title,
      prompt: buildSingleStepExecutablePrompt(input.sourceMessage.body, executableIntent, responseLanguage),
      assigneeTeammateId: participant.teammate.id,
      acceptanceCriteria: executableIntent.acceptanceCriteria,
      collaborationSteps: [{
        teammateId: participant.teammate.id,
        action: participant.role.action,
        summary: executableIntent.actionSummary,
      }],
      requiredTools: executableIntent.requiredTools,
      riskSummary,
      responseLanguage,
      status: blocker ? "blocked" : "draft",
      errorMessage: blocker,
    },
    now,
  );
  const decision = persistIntentDecision(input, {
    action: "direct_workflow",
    proposalId: proposal.id,
    reason: decisionReason ?? `Direct single-step executable proposal created for ${executableIntent.kind}.`,
    status: "accepted",
    createdBy,
  });
  return { action: "workflow_proposal", proposal, intentDecisionId: decision.id };
}

function createClarifyReply(
  input: ChannelIntentSelectorInput,
  reasonCode: ClarifyReasonCode,
  createdBy: "deterministic" | "model" = "deterministic",
  modelReason?: string,
): ChannelIntentSelectorResult {
  const existingReply = input.store
    .listChannelMessages({ channelId: input.channel.id, threadId: input.sourceMessage.id, limit: 20 })
    .find((message) => message.kind === "ai_reply" && message.status !== "failed");
  if (existingReply) {
    const decision = persistIntentDecision(input, {
      action: "clarify",
      selectedTeammateId: existingReply.authorId,
      replyMessageId: existingReply.id,
      reason: `Existing clarify reply already covers this message: ${existingReply.id}`,
      status: "suppressed",
      createdBy,
    });
    return { action: "clarify", aiReply: existingReply, intentDecisionId: decision.id };
  }

  const teammate = chooseClarifyingTeammate(input);
  if (!teammate) {
    return { action: "continue" };
  }
  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel: input.channel,
    sourceText: input.sourceMessage.body,
  }).language;
  const now = new Date().toISOString();
  const aiReply = input.store.createChannelMessage(
    {
      channelId: input.channel.id,
      threadId: input.sourceMessage.id,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: teammate.id,
      body: buildClarifyQuestion(reasonCode, responseLanguage),
      status: "ready",
    },
    now,
  );
  const decision = persistIntentDecision(input, {
    action: "clarify",
    selectedTeammateId: teammate.id,
    replyMessageId: aiReply.id,
    reason: modelReason ?? `Clarify question created from channel intent: ${reasonCode}.`,
    status: "accepted",
    createdBy,
  });
  return { action: "clarify", aiReply, intentDecisionId: decision.id };
}

function messageCanCreateWorkflowProposal(input: ChannelIntentSelectorInput): boolean {
  const message = input.sourceMessage;
  if (message.authorType !== "local-user") {
    return false;
  }
  if (message.kind !== "message" || message.intent !== "discuss") {
    return false;
  }
  if (message.threadId) {
    return false;
  }
  if (message.mentions.some((mention) => mention.kind === "ai-teammate")) {
    return false;
  }
  if (input.channel.status !== "active") {
    return false;
  }
  return message.body.trim().length > 0;
}

function detectWorkflowIntentReason(message: ChannelMessage): IntentReasonCode | undefined {
  const text = message.body.trim();
  const lower = text.toLowerCase();
  if (
    /(开始|启动|执行|开跑|start|run).{0,80}(workflow|工作流|协作|多.?agent|multi.?agent|autoplan|ship|push|合并|发布|architect|engineer|qa|架构|工程|测试|验证)/iu.test(text)
  ) {
    return "explicit_workflow_start";
  }
  if (hasAllTeammatesAudience(text) && looksExecutionAllTeammatesRequest(text)) {
    return "all_teammates_request";
  }
  if (
    /(architect|架构|架构师).{0,80}(engineer|工程|实现|开发|qa|测试|验证|验收)/iu.test(text) ||
    /(engineer|工程|实现|开发).{0,80}(qa|测试|验证|验收)/iu.test(text) ||
    /(先|然后|接着|再).{0,80}(实现|验证|测试|review|qa|工程|架构|拆解)/iu.test(text)
  ) {
    return "ordered_work_request";
  }
  const matchedRoleCount = roleMatches.filter((role) => textMentionsRole(lower, role.roleKey)).length;
  if (matchedRoleCount >= 2) {
    return "multi_role_request";
  }
  return undefined;
}

function detectSingleStepExecutableIntent(message: ChannelMessage): SingleStepExecutableIntent | undefined {
  const text = normalizeWhitespace(message.body);
  if (!text || asksForInstructionsOnly(text)) {
    return undefined;
  }
  return detectFileExecutableIntent(text) ?? detectCommandExecutableIntent(text);
}

function detectFileExecutableIntent(text: string): SingleStepExecutableIntent | undefined {
  const fileAction = detectFileAction(text);
  if (!fileAction) {
    return undefined;
  }
  const target = extractFileTarget(text);
  if (!target) {
    return undefined;
  }
  const content = extractRequestedFileContent(text);
  const requiredTools = fileAction === "file_edit" ? ["edit"] as const : ["write"] as const;
  const rolePreferences: readonly AiTeammate["roleKey"][] = target.toLowerCase().endsWith(".md")
    ? ["docs", "engineer"]
    : ["engineer", "docs"];
  const title = truncateTitle(`${fileAction === "file_edit" ? "Edit" : "Create"} ${target}`);
  return {
    kind: fileAction,
    title,
    prompt: [
      `${fileAction === "file_edit" ? "Edit" : "Create"} the requested file.`,
      `Target: ${target}`,
      content ? `Requested content:\n${content}` : "The user did not provide file content; do not invent extra content beyond what is needed to satisfy file creation.",
    ].join("\n"),
    actionSummary: `${fileAction === "file_edit" ? "Edit" : "Create"} ${target} with the declared file tool scope.`,
    targetLabel: target,
    requiredTools,
    rolePreferences,
    acceptanceCriteria: [
      `Target file is ${fileAction === "file_edit" ? "updated" : "created"} at ${target}.`,
      "No undeclared files, commands, MCP tools, or external actions are used without a separate runtime permission request.",
    ],
    riskSummary: `需要 ${requiredTools.join(", ")} 权限处理 ${target}；用户确认只授权本次任务声明的文件操作范围。`,
  };
}

function detectCommandExecutableIntent(text: string): SingleStepExecutableIntent | undefined {
  const command = extractExplicitCommand(text);
  const looksLikeTest = /(跑|运行|执行|开跑|帮我|请|麻烦).{0,24}(测试|test|e2e|回归|验收)/iu.test(text);
  const looksLikeBuild = /(跑|运行|执行|开跑|帮我|请|麻烦).{0,24}(build|构建|lint|format|格式化|typecheck|检查)/iu.test(text);
  const looksLikeKnownCommand = Boolean(command && /\b(pnpm|npm|yarn|bun|cargo|go|pytest|make|swift|xcodebuild)\b/iu.test(command));
  if (!looksLikeTest && !looksLikeBuild && !looksLikeKnownCommand) {
    return undefined;
  }
  const target = command ?? (looksLikeTest ? "project tests" : "project command");
  const title = truncateTitle(command ? `Run ${command}` : looksLikeTest ? "Run project tests" : "Run project check");
  const rolePreferences: readonly AiTeammate["roleKey"][] = looksLikeTest ? ["qa", "engineer"] : ["engineer", "qa"];
  return {
    kind: "command_run",
    title,
    prompt: [
      "Run the requested local command or project check.",
      `Target: ${target}`,
      command ? `Command requested by user: ${command}` : "No exact command was supplied; choose the narrowest existing project command that matches the request.",
    ].join("\n"),
    actionSummary: `Run ${target} with the declared bash scope.`,
    targetLabel: target,
    requiredTools: ["bash"],
    rolePreferences,
    acceptanceCriteria: [
      `${target} has been run, or a clear blocker explains why it cannot run.`,
      "No undeclared file writes, edits, external actions, or broader commands are used without a separate runtime permission request.",
    ],
    riskSummary: `需要 bash 权限运行 ${target}；用户确认只授权本次任务声明的命令范围。`,
  };
}

function asksForInstructionsOnly(text: string): boolean {
  if (/(怎么|如何|怎样|为什么|为何|why\b|how\s+to|命令怎么写)/iu.test(text) && !/(帮我|请|麻烦|开始|执行|运行|跑一下|开跑)/iu.test(text)) {
    return true;
  }
  if (/(帮我|请|麻烦|开始|执行|运行|跑一下|开跑|创建|新建|写入|保存|修改|编辑|更新|删除|移动|重命名)/iu.test(text)) {
    return false;
  }
  return /(怎么|如何|怎样|为什么|为何|能不能解释|how\s+to|why\b|example|示例|例子|命令怎么写)/iu.test(text);
}

function detectFileAction(text: string): "file_create" | "file_edit" | undefined {
  if (/(修改|编辑|更新|替换|改一下|改成|patch|edit|update|replace)/iu.test(text) && looksLikeFileTarget(text)) {
    return "file_edit";
  }
  if (/(创建|新建|生成|写入|写到|保存|落盘|create|write|add|save)/iu.test(text) && looksLikeFileTarget(text)) {
    return "file_create";
  }
  return undefined;
}

function looksLikeFileTarget(text: string): boolean {
  return Boolean(extractFileTarget(text));
}

function extractFileTarget(text: string): string | undefined {
  const absolutePath = extractAbsoluteOrRelativePath(text);
  if (absolutePath && hasFileExtension(absolutePath)) {
    return stripTrailingPunctuation(absolutePath);
  }
  const fileName = extractFileName(text);
  if (absolutePath && fileName) {
    return `${stripTrailingSlash(stripTrailingPunctuation(absolutePath))}/${fileName}`;
  }
  return fileName;
}

function extractAbsoluteOrRelativePath(text: string): string | undefined {
  const matches = text.match(/(?:^|[\s"'`([{（，。:：])((?:\/(?!\/)|\.{1,2}\/)[^\s"'`，。；;：:!?！？)）\]}]+)/u);
  const candidate = matches?.[1];
  if (!candidate || candidate.startsWith("//")) {
    return undefined;
  }
  return stripTrailingPunctuation(candidate);
}

function extractFileName(text: string): string | undefined {
  const match = /\b([\w.-]+\.(?:md|txt|json|jsonl|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|sql|css|scss|html|xml|csv|env|example))\b/iu.exec(text);
  return match?.[1];
}

function hasFileExtension(value: string): boolean {
  return /\.[a-z0-9][a-z0-9_-]*$/iu.test(stripTrailingPunctuation(value));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[，。；;:：!?！？)）\]}]+$/u, "");
}

function extractRequestedFileContent(text: string): string | undefined {
  const match = /(?:内容是|内容为|写入|写成|改成|如下|content\s*(?:is|:)|with\s+content)\s*[:：]?\s*([\s\S]+)$/iu.exec(text);
  const content = match?.[1]?.trim();
  return content && content.length > 0 ? content : undefined;
}

function extractExplicitCommand(text: string): string | undefined {
  const fenced = /`([^`]+)`/u.exec(text)?.[1]?.trim();
  if (fenced) {
    return fenced;
  }
  const match = /\b((?:pnpm|npm|yarn|bun|cargo|go|pytest|make|swift|xcodebuild)\s+[^\n，。；;!?！？]*)/iu.exec(text);
  return match?.[1]?.trim();
}

function detectVisibleMultiReplyIntent(message: ChannelMessage): boolean {
  const text = normalizeWhitespace(message.body);
  if (!text || looksExecutionAllTeammatesRequest(text)) {
    return false;
  }
  const lower = text.toLowerCase();
  if (
    /(所有|全部|全体|每个|每位).{0,12}(队友|agent|teammate|agents).{0,28}(回复|回答|说|讲|看法|意见|评价|讨论|角度|怎么看)/iu.test(text) ||
    /(所有|全部|全体|每个|每位).{0,12}(回复|回答|说|讲|看法|意见|评价|讨论|角度).{0,28}(队友|agent|teammate|agents)/iu.test(text)
  ) {
    return true;
  }
  if (/(大家|各位|所有人|全部人).{0,18}(都|分别|各自|一起)?.{0,18}(回复|回答|说|讲|看法|意见|评价|讨论|角度|怎么看)/iu.test(text)) {
    return true;
  }
  const mentionedRoleCount = roleMatches.filter((role) => textMentionsRole(lower, role.roleKey)).length;
  return mentionedRoleCount >= 2 && /(都|分别|各自|一起).{0,24}(回复|回答|说|讲|看法|意见|评价|讨论|角度|怎么看)/iu.test(text);
}

function hasAllTeammatesAudience(text: string): boolean {
  return /(所有|全部|全体|每个|每位).{0,12}(队友|agent|teammate|agents)/iu.test(text);
}

function looksExecutionAllTeammatesRequest(text: string): boolean {
  return /(开始|启动|执行|开跑|工作流|workflow|协作|实现|修复|验证|验收|测试|跑测试|e2e|push|合并|发布|部署|ship|release|deploy|改代码|写代码|处理)/iu.test(text);
}

function intentDecisionActionForReason(reasonCode: IntentReasonCode): "workflow_proposal" | "direct_workflow" {
  return reasonCode === "explicit_workflow_start" ? "direct_workflow" : "workflow_proposal";
}

function detectClarifyIntentReason(message: ChannelMessage): ClarifyReasonCode | undefined {
  const text = message.body.trim();
  const lower = text.toLowerCase();
  if (!looksWorkShapedButUnderspecified(text)) {
    return undefined;
  }
  if (/(push|合并|发布|部署|ship|release)/iu.test(text)) {
    return "approval_sensitive_target";
  }
  if (/(验收|验证|测试|目标|标准|acceptance|criteria|check)/iu.test(lower)) {
    return "missing_target";
  }
  return lower.length <= 24 || /(这个|那个|这些|这块|上面|刚才|一下|吧|it|this|that)/iu.test(text)
    ? "missing_acceptance"
    : undefined;
}

function clarifyReasonFromMessage(message: ChannelMessage): ClarifyReasonCode {
  return detectClarifyIntentReason(message) ?? "missing_acceptance";
}

function looksWorkShapedButUnderspecified(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) {
    return false;
  }
  if (/[#][0-9]+|https?:\/\/|\/[\w.-]+|[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|md|json|sql|py|go|rs|swift|kt)\b/iu.test(normalized)) {
    return false;
  }
  if (textMentionsAnyRole(normalized.toLowerCase())) {
    return false;
  }
  if (/^(做|处理|修|改|实现|执行|开始|开跑|推进|搞定|跑一下|继续)(?:一下|下)?(?:吧)?(?:这个|那个|这些|这块|上面|刚才)?[。.!！]*$/iu.test(normalized)) {
    return true;
  }
  return /(帮我|麻烦|请|可以).{0,8}(处理一下|做一下|改一下|修一下|实现一下|推进一下|搞一下|开跑一下|执行一下|弄一下)/iu.test(normalized);
}

function selectProposalParticipants(input: ChannelIntentSelectorInput, reasonCode: IntentReasonCode):
  readonly ProposalParticipantSelection[] {
  const activeTeammates = input.store.listAiTeammates({ status: "active", includeHidden: false, limit: 100 });
  const byRole = new Map(activeTeammates.map((teammate) => [teammate.roleKey, teammate]));
  const text = input.sourceMessage.body.toLowerCase();
  const selectedRoles = reasonCode === "all_teammates_request"
    ? roleMatches.filter((role) => byRole.has(role.roleKey)).slice(0, 5)
    : roleMatches.filter((role) => textMentionsRole(text, role.roleKey));

  const orderedRoles = reasonCode === "explicit_workflow_start" && selectedRoles.length === 0
    ? roleMatches.filter((role) => ["release", "engineer", "qa"].includes(role.roleKey) && byRole.has(role.roleKey))
    : selectedRoles;

  return orderedRoles.flatMap((role) => {
    const teammate = byRole.get(role.roleKey);
    return teammate ? [{ teammate, role }] : [];
  });
}

function selectVisibleMultiReplyTeammates(input: ChannelIntentSelectorInput): readonly AiTeammate[] {
  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  const activeTeammates = input.store.listAiTeammates({ status: "active", includeHidden: false, limit: 100 });
  const channelTeammates = activeTeammates.filter((teammate) => teammateCanReplyInChannel(input.store, input.channel, teammate.id));
  const byId = new Map(channelTeammates.map((teammate) => [teammate.id, teammate]));
  const text = input.sourceMessage.body.toLowerCase();
  const mentionedRoleKeys = roleMatches
    .filter((role) => textMentionsRole(text, role.roleKey))
    .map((role) => role.roleKey);
  const roleOrder = mentionedRoleKeys.length > 0
    ? mentionedRoleKeys
    : ["architect", "engineer", "qa", "product", "designer", "security", "docs", "release", "custom"] satisfies readonly AiTeammate["roleKey"][];
  const selected: AiTeammate[] = [];
  const add = (teammate: AiTeammate | undefined): void => {
    if (!teammate || !byId.has(teammate.id) || selected.some((existing) => existing.id === teammate.id)) {
      return;
    }
    selected.push(teammate);
  };

  if (protocol.protocol.defaultTeammateId) {
    const defaultTeammate = activeTeammates.find((teammate) => teammate.id === protocol.protocol.defaultTeammateId || teammate.templateId === protocol.protocol.defaultTeammateId);
    add(defaultTeammate);
  }
  for (const roleKey of roleOrder) {
    add(channelTeammates.find((teammate) => teammate.roleKey === roleKey));
  }
  for (const teammate of channelTeammates) {
    add(teammate);
  }
  return selected.slice(0, protocol.protocol.visibleMultiReplyMaxParticipants);
}

function chooseAssignee(
  input: ChannelIntentSelectorInput,
  participants: readonly ProposalParticipantSelection[],
): AiTeammate {
  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  const defaultTeammate = protocol.protocol.defaultTeammateId
    ? resolveAiTeammateReference(input.store, protocol.protocol.defaultTeammateId)
    : undefined;
  if (defaultTeammate && participants.some((participant) => participant.teammate.id === defaultTeammate.id)) {
    return defaultTeammate;
  }
  return participants.find((participant) => participant.teammate.roleKey === "engineer")?.teammate ?? participants[0].teammate;
}

function chooseProposedBy(input: ChannelIntentSelectorInput, assignee: AiTeammate): AiTeammate {
  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  const defaultTeammate = protocol.protocol.defaultTeammateId
    ? resolveAiTeammateReference(input.store, protocol.protocol.defaultTeammateId)
    : undefined;
  return defaultTeammate ?? assignee;
}

function selectSingleStepExecutableParticipant(
  input: ChannelIntentSelectorInput,
  executableIntent: SingleStepExecutableIntent,
): ProposalParticipantSelection | undefined {
  const activeTeammates = input.store.listAiTeammates({ status: "active", includeHidden: false, limit: 100 });
  const rolePreferenceSet = new Set(executableIntent.rolePreferences);
  const rolePreferred = activeTeammates.filter((teammate) => rolePreferenceSet.has(teammate.roleKey));
  const inChannel = activeTeammates.filter((teammate) => teammateCanReplyInChannel(input.store, input.channel, teammate.id));
  const supportsTools = (teammate: AiTeammate): boolean =>
    executableIntent.requiredTools.every((tool) => teammate.allowedTools.includes(tool));
  const preferredSupporting = rolePreferred.find((teammate) => supportsTools(teammate) && teammateCanReplyInChannel(input.store, input.channel, teammate.id))
    ?? rolePreferred.find(supportsTools)
    ?? inChannel.find(supportsTools)
    ?? rolePreferred[0]
    ?? inChannel[0]
    ?? activeTeammates[0];
  if (!preferredSupporting) {
    return undefined;
  }
  return {
    teammate: preferredSupporting,
    role: roleMatchForTeammate(preferredSupporting, executableIntent.rolePreferences[0]),
  };
}

function roleMatchForTeammate(teammate: AiTeammate, fallbackRoleKey: AiTeammate["roleKey"] | undefined): RoleMatch {
  const fallback = roleMatches[0];
  if (!fallback) {
    throw new Error("No channel role matches are configured.");
  }
  return roleMatches.find((role) => role.roleKey === teammate.roleKey)
    ?? roleMatches.find((role) => role.roleKey === fallbackRoleKey)
    ?? fallback;
}

function singleStepExecutableBlocker(
  input: ChannelIntentSelectorInput,
  executableIntent: SingleStepExecutableIntent,
  teammate: AiTeammate,
  responseLanguage: ResponseLanguage,
): string | undefined {
  const blockers: string[] = [];
  if (!teammateCanReplyInChannel(input.store, input.channel, teammate.id)) {
    blockers.push(responseLanguage === "zh-CN"
      ? `${teammate.displayName} 当前不在这个频道可执行名单里；请把该队友加入频道或编辑 proposal 的执行人。`
      : `${teammate.displayName} is not available in this channel; add the teammate to the channel or edit the proposal assignee.`);
  }
  const missingTeammateTools = executableIntent.requiredTools.filter((tool) => !teammate.allowedTools.includes(tool));
  if (missingTeammateTools.length > 0) {
    blockers.push(responseLanguage === "zh-CN"
      ? `${teammate.displayName} 缺少所需工具: ${missingTeammateTools.join(", ")}；请换执行人或调整队友工具范围。`
      : `${teammate.displayName} is missing required tools: ${missingTeammateTools.join(", ")}. Choose another assignee or update teammate tool scope.`);
  }
  return blockers.length > 0 ? blockers.join("\n") : undefined;
}

function buildSingleStepExecutablePrompt(
  messageBody: string,
  executableIntent: SingleStepExecutableIntent,
  responseLanguage: ResponseLanguage,
): string {
  if (responseLanguage === "zh-CN") {
    return [
      "这条用户消息是一个单步可执行请求。",
      "",
      `原始请求: ${normalizeWhitespace(messageBody)}`,
      "",
      `执行动作: ${executableIntent.actionSummary}`,
      `目标: ${executableIntent.targetLabel}`,
      `需要工具: ${executableIntent.requiredTools.join(", ")}`,
      "",
      executableIntent.prompt,
      "",
      "权限边界: 用户确认 proposal 只授权本次任务声明的工具和目标；运行中如需未声明工具、路径、命令、MCP 或外部副作用，必须走 runtime permission request。",
      "等待用户明确确认后再开始可执行工作。",
    ].join("\n");
  }
  return [
    "The user message is a single-step executable request.",
    "",
    `Original request: ${normalizeWhitespace(messageBody)}`,
    "",
    `Action: ${executableIntent.actionSummary}`,
    `Target: ${executableIntent.targetLabel}`,
    `Required tools: ${executableIntent.requiredTools.join(", ")}`,
    "",
    executableIntent.prompt,
    "",
    "Permission boundary: confirming the proposal only authorizes the declared tools and target for this task; undeclared tools, paths, commands, MCP actions, or external side effects must use runtime permission request.",
    "Wait for explicit user confirmation before starting executable work.",
  ].join("\n");
}

function chooseClarifyingTeammate(input: ChannelIntentSelectorInput): AiTeammate | undefined {
  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  const activeTeammates = input.store.listAiTeammates({ status: "active", includeHidden: false, limit: 100 });
  const defaultTeammate = protocol.protocol.defaultTeammateId
    ? activeTeammates.find((teammate) => teammate.id === protocol.protocol.defaultTeammateId || teammate.templateId === protocol.protocol.defaultTeammateId)
    : undefined;
  const candidates = [
    defaultTeammate,
    activeTeammates.find((teammate) => teammate.roleKey === "product" && teammateCanClarifyInChannel(input.store, input.channel, teammate.id)),
    activeTeammates.find((teammate) => teammate.roleKey === "architect" && teammateCanClarifyInChannel(input.store, input.channel, teammate.id)),
    activeTeammates.find((teammate) => teammate.roleKey === "engineer" && teammateCanClarifyInChannel(input.store, input.channel, teammate.id)),
    activeTeammates.find((teammate) => teammateCanClarifyInChannel(input.store, input.channel, teammate.id)),
  ];
  return candidates.find((teammate): teammate is AiTeammate => Boolean(teammate && teammateCanClarifyInChannel(input.store, input.channel, teammate.id)));
}

function teammateCanClarifyInChannel(store: RunStore, channel: Channel, teammateId: string): boolean {
  return teammateCanReplyInChannel(store, channel, teammateId);
}

function teammateCanReplyInChannel(store: RunStore, channel: Channel, teammateId: string): boolean {
  const protocol = resolveEffectiveChannelCollaborationProtocol({ store, channel });
  if (protocol.protocol.defaultTeammateId === teammateId) {
    return true;
  }
  const defaultTeammate = protocol.protocol.defaultTeammateId ? resolveAiTeammateReference(store, protocol.protocol.defaultTeammateId) : undefined;
  if (defaultTeammate?.id === teammateId) {
    return true;
  }
  return store.listTeammateChannelMemberships(teammateId).some((membership) => membership.channelId === channel.id);
}

function textMentionsRole(text: string, roleKey: AiTeammate["roleKey"]): boolean {
  if (roleKey === "architect") {
    return /(architect|架构|架构师|技术方案|拆解)/iu.test(text);
  }
  if (roleKey === "engineer") {
    return /(engineer|工程|开发|写代码|改代码|修复|执行实现)/iu.test(text);
  }
  if (roleKey === "qa") {
    return /(qa|测试|验证|验收|e2e|回归)/iu.test(text);
  }
  if (roleKey === "designer") {
    return /(designer|design|设计|ui|ux|交互|视觉)/iu.test(text);
  }
  if (roleKey === "product") {
    return /(product|产品|需求|范围|scope|取舍)/iu.test(text);
  }
  if (roleKey === "security") {
    return /(security|安全|审计|威胁|trust boundary)/iu.test(text);
  }
  if (roleKey === "docs") {
    return /(docs|document|文档|说明)/iu.test(text);
  }
  if (roleKey === "release") {
    return /(release|ship|push|合并|发布|部署)/iu.test(text);
  }
  return false;
}

function textMentionsAnyRole(text: string): boolean {
  return roleMatches.some((role) => textMentionsRole(text, role.roleKey));
}

function buildClarifyQuestion(reasonCode: ClarifyReasonCode, responseLanguage: ResponseLanguage): string {
  const chinese = responseLanguage === "zh-CN";
  if (reasonCode === "approval_sensitive_target") {
    return chinese
      ? "我需要先确认范围：目标分支/PR 是哪个？是否允许执行会修改远端状态的步骤？完成后用什么检查验收？"
      : "I need to clarify scope first: which branch or PR is the target, are remote-mutating steps allowed, and what check should verify completion?";
  }
  if (reasonCode === "missing_target") {
    return chinese
      ? "我需要先确认目标：要处理的具体对象是什么？完成后用什么结果判断通过？"
      : "I need to clarify the target first: what exactly should be changed, and what result should count as done?";
  }
  return chinese
    ? "我需要先确认范围：你希望我处理哪个具体目标？完成后用哪几个检查项验收？"
    : "I need to clarify scope first: what specific target should I handle, and which checks should verify the result?";
}

function buildProposalTitle(messageBody: string, reasonCode: IntentReasonCode): string {
  const normalized = normalizeWhitespace(messageBody);
  if (normalized.length > 0) {
    return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
  }
  if (reasonCode === "all_teammates_request") {
    return "Coordinate teammate collaboration";
  }
  return "Coordinate channel workflow";
}

function buildProposalPrompt(
  messageBody: string,
  participants: readonly ProposalParticipantSelection[],
  responseLanguage: ResponseLanguage,
): string {
  const steps = participants.map((participant, index) => `${index + 1}. ${participant.teammate.displayName}: ${roleSummary(participant.role, responseLanguage)}`);
  if (responseLanguage === "zh-CN") {
    return [
      "这条用户消息看起来是一个需要协作执行的工作流请求。",
      "",
      `原始请求: ${normalizeWhitespace(messageBody)}`,
      "",
      "建议协作步骤:",
      ...steps,
      "",
      "等待用户明确确认后再开始可执行工作。",
    ].join("\n");
  }
  return [
    "The user message looks like a coordinated workflow request.",
    "",
    `Original request: ${normalizeWhitespace(messageBody)}`,
    "",
    "Proposed collaboration:",
    ...steps,
    "",
    "Wait for explicit user confirmation before starting executable work.",
  ].join("\n");
}

function buildAcceptanceCriteria(responseLanguage: ResponseLanguage): readonly string[] {
  return responseLanguage === "zh-CN"
    ? [
        "开始执行前先确认协作范围。",
        "每个实现步骤都通过现有频道 task/run 路径执行。",
        "selector、handoff、run、approval 和 artifact 证据都保持可展开查看。",
      ]
    : [
        "Confirm the collaboration scope before starting execution.",
        "Run each implementation step through the existing channel task/run path.",
        "Keep selector, handoff, run, approval, and artifact evidence expandable.",
      ];
}

function deriveRequiredTools(
  participants: readonly ProposalParticipantSelection[],
): ChannelExecutionProposal["requiredTools"] {
  const tools = new Set<ChannelExecutionProposal["requiredTools"][number]>();
  for (const participant of participants) {
    for (const tool of participant.teammate.allowedTools) {
      tools.add(tool);
    }
  }
  return [...tools];
}

function buildRiskSummary(reasonCode: IntentReasonCode, responseLanguage: ResponseLanguage): string {
  if (reasonCode === "all_teammates_request") {
    return responseLanguage === "zh-CN"
      ? "已把全员协作执行请求转换为一个工作流 proposal；纯讨论型全员发言会走可见多队友回复。"
      : "Converted an all-teammates execution request into one workflow proposal; discussion-only all-teammate requests use visible multi-reply.";
  }
  if (reasonCode === "explicit_workflow_start") {
    return responseLanguage === "zh-CN"
      ? "显式开始 workflow 的请求会先预填为 proposal；执行前仍需要用户确认。"
      : "Direct workflow request is prefilled as a proposal; user confirmation is still required before execution.";
  }
  return responseLanguage === "zh-CN"
    ? "多 agent 工作只会在确认后开始，并继续沿用现有 workflow/run approval。"
    : "Multi-agent work starts only after confirmation and continues through existing workflow/run approvals.";
}

function roleSummary(role: RoleMatch, responseLanguage: ResponseLanguage): string {
  return responseLanguage === "zh-CN" ? role.summaryZh : role.summary;
}

function persistIntentDecision(
  input: ChannelIntentSelectorInput,
  decision: Pick<
    Parameters<RunStore["createChannelIntentDecision"]>[0],
    "action" | "reason" | "status" | "createdBy"
  > & Partial<Pick<Parameters<RunStore["createChannelIntentDecision"]>[0], "selectedTeammateId" | "selectedTeammateIds" | "proposalId" | "replyMessageId" | "replyMessageIds" | "workflowId" | "errorMessage">>,
): ChannelIntentDecision {
  return input.store.createChannelIntentDecision({
    channelId: input.channel.id,
    sourceMessageId: input.sourceMessage.id,
    action: decision.action,
    selectedTeammateId: decision.selectedTeammateId,
    selectedTeammateIds: decision.selectedTeammateIds,
    proposalId: decision.proposalId,
    replyMessageId: decision.replyMessageId,
    replyMessageIds: decision.replyMessageIds,
    workflowId: decision.workflowId,
    reason: decision.reason,
    status: decision.status,
    createdBy: decision.createdBy,
    errorMessage: decision.errorMessage,
  }, new Date().toISOString());
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateTitle(value: string): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}
