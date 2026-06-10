import type {
  AiTeammate,
  Channel,
  ChannelIntentDecision,
  ChannelExecutionProposal,
  ChannelExecutionProposalStep,
  ChannelMessage,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";

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
  readonly action: "no_reply" | "single_reply" | "clarify" | "workflow_proposal" | "direct_workflow";
  readonly reason: string;
}

interface RoleMatch {
  readonly roleKey: AiTeammate["roleKey"];
  readonly summary: string;
  readonly action: ChannelExecutionProposalStep["action"];
}

type ProposalParticipantSelection = {
  readonly teammate: AiTeammate;
  readonly role: RoleMatch;
};

const roleMatches: readonly RoleMatch[] = [
  {
    roleKey: "architect",
    summary: "Define implementation boundaries and sequencing before execution.",
    action: "coordinated",
  },
  {
    roleKey: "engineer",
    summary: "Implement the approved step after the boundary is clear.",
    action: "coordinated",
  },
  {
    roleKey: "qa",
    summary: "Validate the expected behavior and regression checks.",
    action: "reviewed",
  },
  {
    roleKey: "designer",
    summary: "Review interaction quality and visible product behavior.",
    action: "reviewed",
  },
  {
    roleKey: "product",
    summary: "Clarify product scope and acceptance before execution.",
    action: "consulted",
  },
  {
    roleKey: "security",
    summary: "Review trust boundaries and approval-sensitive risks.",
    action: "flagged_risk",
  },
  {
    roleKey: "docs",
    summary: "Keep documentation aligned with the shipped behavior.",
    action: "reviewed",
  },
  {
    roleKey: "release",
    summary: "Prepare shipping checks and approval-sensitive publication steps.",
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
  const reasonCode = detectWorkflowIntentReason(input.sourceMessage);
  if (!reasonCode) {
    const clarifyReasonCode = detectClarifyIntentReason(input.sourceMessage);
    if (!clarifyReasonCode) {
      return { action: "continue" };
    }
    return createClarifyReply(input, clarifyReasonCode);
  }

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

  return createWorkflowProposal(input, reasonCode, intentDecisionActionForReason(reasonCode), "deterministic", undefined, participants);
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
  const prompt = buildModelIntentPrompt(input);
  const provider = resolveProviderForRun(input.store, {
    cwd: input.store.paths.cwd,
    workspaceCwd: input.store.paths.cwd,
    task: {
      id: input.sourceMessage.id,
      title: `Channel intent selection in ${input.channel.name}`,
      prompt,
      channelId: input.channel.id,
    },
    providerPresetId,
    tools: [],
    thinkingLevel: "low",
    systemPrompt: "You are Ling's channel intent selector. Return strict JSON only.",
  }, input.secretResolver);
  const runnerResolution = input.runnerRegistry.resolve({ tools: [], allowFallback: true });
  const textDeltas: string[] = [];
  const result = await runnerResolution.runner.adapter.runTask({
    cwd: input.store.paths.cwd,
    task: {
      id: input.sourceMessage.id,
      title: `Channel intent selection in ${input.channel.name}`,
      prompt,
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

function buildModelIntentPrompt(input: ChannelIntentSelectorInput): string {
  const recentMessages = input.store
    .listChannelMessages({ channelId: input.channel.id, limit: 8 })
    .filter((message) => message.id !== input.sourceMessage.id)
    .map((message) => `${message.authorType}: ${message.body.slice(0, 180)}`)
    .join("\n");
  const teammateRoles = input.store
    .listAiTeammates({ status: "active", includeHidden: false, limit: 20 })
    .map((teammate) => ({ id: teammate.id, role: teammate.roleKey, label: teammate.displayName }))
    .slice(0, 12);
  return [
    "Classify the latest user channel message into exactly one Ling intent.",
    "Return strict JSON only: {\"action\":\"no_reply|single_reply|clarify|workflow_proposal|direct_workflow\",\"reason\":\"short reason\"}.",
    "Use single_reply for ordinary questions one teammate should answer.",
    "Use clarify for work-shaped requests missing target, scope, or acceptance checks.",
    "Use workflow_proposal for multi-role work that needs user confirmation before execution.",
    "Use direct_workflow only when the user explicitly asks to start/run a workflow; it still requires confirmation.",
    "Use no_reply for acknowledgements, notes, or messages that do not need AI.",
    `Channel: ${input.channel.name}`,
    `Latest user message: ${input.sourceMessage.body}`,
    recentMessages ? `Recent context:\n${recentMessages}` : "Recent context: none",
    `Available teammate roles JSON: ${JSON.stringify(teammateRoles)}`,
  ].join("\n\n");
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
  const now = new Date().toISOString();
  const proposal = input.store.createChannelExecutionProposal(
    {
      channelId: input.channel.id,
      sourceMessageId: input.sourceMessage.id,
      proposedByTeammateId: proposedBy.id,
      title: buildProposalTitle(input.sourceMessage.body, reasonCode),
      prompt: buildProposalPrompt(input.sourceMessage.body, participants),
      assigneeTeammateId: assignee.id,
      acceptanceCriteria: [
        "Confirm the collaboration scope before starting execution.",
        "Run each implementation step through the existing channel task/run path.",
        "Keep selector, handoff, run, approval, and artifact evidence expandable.",
      ],
      collaborationSteps: participants.map((participant) => ({
        teammateId: participant.teammate.id,
        action: participant.role.action,
        summary: participant.role.summary,
      })),
      requiredTools: deriveRequiredTools(participants),
      riskSummary: buildRiskSummary(reasonCode),
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
  const now = new Date().toISOString();
  const aiReply = input.store.createChannelMessage(
    {
      channelId: input.channel.id,
      threadId: input.sourceMessage.id,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: teammate.id,
      body: buildClarifyQuestion(input.sourceMessage.body, reasonCode),
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
  if (/(所有|全部|全体|每个|每位).{0,8}(队友|agent|teammate|agents)/iu.test(text)) {
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

function chooseAssignee(
  input: ChannelIntentSelectorInput,
  participants: readonly ProposalParticipantSelection[],
): AiTeammate {
  const defaultTeammate = input.channel.defaultTeammateId
    ? resolveAiTeammateReference(input.store, input.channel.defaultTeammateId)
    : undefined;
  if (defaultTeammate && participants.some((participant) => participant.teammate.id === defaultTeammate.id)) {
    return defaultTeammate;
  }
  return participants.find((participant) => participant.teammate.roleKey === "engineer")?.teammate ?? participants[0].teammate;
}

function chooseProposedBy(input: ChannelIntentSelectorInput, assignee: AiTeammate): AiTeammate {
  const defaultTeammate = input.channel.defaultTeammateId
    ? resolveAiTeammateReference(input.store, input.channel.defaultTeammateId)
    : undefined;
  return defaultTeammate ?? assignee;
}

function chooseClarifyingTeammate(input: ChannelIntentSelectorInput): AiTeammate | undefined {
  const activeTeammates = input.store.listAiTeammates({ status: "active", includeHidden: false, limit: 100 });
  const defaultTeammate = input.channel.defaultTeammateId
    ? activeTeammates.find((teammate) => teammate.id === input.channel.defaultTeammateId || teammate.templateId === input.channel.defaultTeammateId)
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
  if (channel.defaultTeammateId === teammateId) {
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

function buildClarifyQuestion(messageBody: string, reasonCode: ClarifyReasonCode): string {
  const chinese = /[\u3400-\u9fff]/u.test(messageBody);
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
): string {
  const steps = participants.map((participant, index) => `${index + 1}. ${participant.teammate.displayName}: ${participant.role.summary}`);
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

function buildRiskSummary(reasonCode: IntentReasonCode): string {
  if (reasonCode === "all_teammates_request") {
    return "Converted an all-teammates request into one workflow proposal instead of visible group chat.";
  }
  if (reasonCode === "explicit_workflow_start") {
    return "Direct workflow request is prefilled as a proposal; user confirmation is still required before execution.";
  }
  return "Multi-agent work starts only after confirmation and continues through existing workflow/run approvals.";
}

function persistIntentDecision(
  input: ChannelIntentSelectorInput,
  decision: Pick<
    Parameters<RunStore["createChannelIntentDecision"]>[0],
    "action" | "reason" | "status" | "createdBy"
  > & Partial<Pick<Parameters<RunStore["createChannelIntentDecision"]>[0], "selectedTeammateId" | "proposalId" | "replyMessageId" | "workflowId" | "errorMessage">>,
): ChannelIntentDecision {
  return input.store.createChannelIntentDecision({
    channelId: input.channel.id,
    sourceMessageId: input.sourceMessage.id,
    action: decision.action,
    selectedTeammateId: decision.selectedTeammateId,
    proposalId: decision.proposalId,
    replyMessageId: decision.replyMessageId,
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
