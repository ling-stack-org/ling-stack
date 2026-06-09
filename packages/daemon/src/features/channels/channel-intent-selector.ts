import type {
  AiTeammate,
  Channel,
  ChannelExecutionProposal,
  ChannelExecutionProposalStep,
  ChannelMessage,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import { resolveProviderForRun } from "../runs/providers.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";

export interface ChannelIntentSelectorInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly requestedProviderPresetId?: string;
  readonly secretResolver: SecretResolver;
}

export type ChannelIntentSelectorResult =
  | {
      readonly action: "continue";
    }
  | {
      readonly action: "workflow_proposal";
      readonly proposal: ChannelExecutionProposal;
      readonly routeDecisionId: string;
    };

type IntentReasonCode =
  | "all_teammates_request"
  | "ordered_work_request"
  | "multi_role_request"
  | "explicit_workflow_start";

interface RoleMatch {
  readonly roleKey: AiTeammate["roleKey"];
  readonly summary: string;
  readonly action: ChannelExecutionProposalStep["action"];
}

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

export function selectChannelWorkflowIntent(input: ChannelIntentSelectorInput): ChannelIntentSelectorResult {
  const reasonCode = detectWorkflowIntentReason(input.sourceMessage);
  if (!reasonCode || !messageCanCreateWorkflowProposal(input)) {
    return { action: "continue" };
  }

  const existingProposal = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, sourceMessageId: input.sourceMessage.id, limit: 1 })
    .find((proposal) => proposal.status !== "cancelled" && proposal.status !== "superseded");
  if (existingProposal) {
    const decision = persistSuppressedRouteDecision(input, `Existing workflow proposal already covers this message: ${existingProposal.id}`);
    return { action: "workflow_proposal", proposal: existingProposal, routeDecisionId: decision.id };
  }

  const participants = selectProposalParticipants(input, reasonCode);
  if (participants.length === 0) {
    return { action: "continue" };
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
  const decision = persistSuppressedRouteDecision(input, `Workflow proposal created from channel intent: ${reasonCode}.`);
  return { action: "workflow_proposal", proposal, routeDecisionId: decision.id };
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
  if (/(开始|启动|执行|开跑|start|run).{0,40}(workflow|工作流|协作|多.?agent|multi.?agent|autoplan|ship|push|合并|发布)/iu.test(text)) {
    return "explicit_workflow_start";
  }
  return undefined;
}

function selectProposalParticipants(input: ChannelIntentSelectorInput, reasonCode: IntentReasonCode):
  readonly { readonly teammate: AiTeammate; readonly role: RoleMatch }[] {
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
  participants: readonly { readonly teammate: AiTeammate; readonly role: RoleMatch }[],
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
  participants: readonly { readonly teammate: AiTeammate; readonly role: RoleMatch }[],
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
  participants: readonly { readonly teammate: AiTeammate; readonly role: RoleMatch }[],
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
    return "Direct workflow start is downgraded to a proposal until scope, participants, and approvals are confirmed.";
  }
  return "Multi-agent work starts only after confirmation and continues through existing workflow/run approvals.";
}

function persistSuppressedRouteDecision(input: ChannelIntentSelectorInput, reason: string) {
  return input.store.createChannelMessageRouteDecision({
    channelId: input.channel.id,
    sourceMessageId: input.sourceMessage.id,
    mode: input.channel.autoReplyMode,
    action: "no_reply",
    selectedProviderPresetId: resolveDecisionProviderPresetId(input),
    reason,
    alternativesConsidered: [],
    status: "suppressed",
    createdBy: "deterministic",
  }, new Date().toISOString());
}

function resolveDecisionProviderPresetId(input: ChannelIntentSelectorInput): string | undefined {
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
          title: `Channel intent decision in ${input.channel.name}`,
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
