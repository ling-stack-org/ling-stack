import type {
  AiTeammate,
  Channel,
  ChannelIntentDecision,
  ChannelExecutionProposal,
  ChannelExecutionProposalStep,
  ChannelExecutionProposalStepSource,
  ChannelRequirementShaping,
  ChannelMessage,
  ResponseLanguage,
  RunTool,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import type {
  ChannelIntentClarificationV2,
  ChannelIntentExecutionOperationV1,
  ChannelIntentExecutionPlanV1,
  CommandMatchPolicyV1,
  RequiredParticipantExpectedOutcomeV1,
  RequiredParticipantManifestV1,
  RequiredParticipantRequestedByV1,
} from "@ling-stack/contracts";
import { createRequiredParticipantManifestV1 } from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { listEffectiveChannelAiTeammateEntries, listEffectiveChannelAiTeammates, teammateCanWorkInEffectiveChannel } from "./channel-teammate-availability.js";
import { resolveEffectiveChannelCollaborationProtocol } from "./collaboration-protocol.js";
import { materializeCommandIntent, type MaterializedCommandIntent } from "./command-operation-match.js";
import { compactChannelDiscussionForNoToolsRetry, isContextLengthError } from "./context-compaction.js";
import { buildChannelIntentSelectorContextPack, renderContextPack } from "./context-packs.js";
import { buildWorkflowProposalContextView, proposalSourceRefsFromContextView } from "./context-processing/proposals.js";
import {
  buildConversationContextProjection,
  projectConversationContextMessages,
} from "./context-processing/conversation-context-projector.js";
import { createLingAgentExecutor, isLingAgentExecutorId, LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import {
  buildLingAgentTurnEnvelope,
  renderLingAgentTurnEnvelopeForPrompt,
  turnEnvelopeHasUserInput,
  type LingAgentTurnEnvelope,
} from "./ling-agent-turn-envelope.js";
import {
  recordProviderContextLengthObservation,
  recordProviderRuntimeAvailabilityIncident,
} from "./provider-runtime-observations.js";
import { resolveChannelResponseLanguage } from "./response-language.js";
import { resolveChannelConversationSurface } from "./conversation-surface.js";
import { extractFileTargetCandidate, resolveExecutableFileTarget } from "./target-resolver.js";
import {
  appendChannelAssistantMessage,
  findChannelAssistantReplyForSource,
  getChannelMessageView,
} from "./conversation-item-messages.js";
import {
  assignExecutionOperationOwners,
  ownedExecutionOperations,
  requiredToolsForExecutionOperations,
} from "./workflow-operation-ownership.js";

export interface ChannelIntentSelectorInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
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
      readonly createdBy: "deterministic" | "model_policy";
      readonly aiReplies?: readonly ChannelMessage[];
      readonly intentDecisionId?: string;
    }
  | {
      readonly action: "workflow_proposal";
      readonly proposal: ChannelExecutionProposal;
      readonly intentDecisionId: string;
    }
  | {
      readonly action: "blocked";
      readonly aiReply: ChannelMessage;
      readonly proposalId: string;
      readonly errorCode: "existing_proposal_participant_lineage_invalid";
    };

type IntentReasonCode =
  | "all_teammates_request"
  | "ordered_work_request"
  | "multi_role_request"
  | "explicit_workflow_start";

type ClarifyReasonCode =
  | "missing_target"
  | "missing_command"
  | "missing_acceptance"
  | "ambiguous_target"
  | "approval_sensitive_target";

interface MaterializationClarifyReason {
  readonly body: string;
  readonly sourceLabel: string;
  readonly issueKind: "attachment_unavailable" | "link_body_unavailable" | "workspace_file_ref_blocked";
  readonly technicalReason: string;
}

interface ChannelIntentModelOutput {
  readonly action: "no_reply" | "reply" | "visible_multi_reply" | "clarify" | "workflow_proposal" | "execute";
  readonly reason: string;
  readonly clarification?: ChannelIntentClarificationV2;
  readonly execution?: ChannelIntentModelExecutionPlan;
}

interface ChannelIntentModelExecutionPlan {
  readonly operations: readonly ChannelIntentModelExecutionOperation[];
}

interface ChannelIntentModelExecutionOperation {
  readonly id: string;
  readonly kind: ChannelIntentExecutionOperationV1["kind"];
  readonly targetKind: ChannelIntentExecutionOperationV1["targetKind"];
  readonly required: boolean;
  readonly dependsOn: readonly string[];
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
  readonly sources?: readonly ChannelExecutionProposalStepSource[];
  readonly fallbackSpecialistRoleKey?: AiTeammate["roleKey"];
};

interface SingleStepExecutableIntent {
  readonly kind: "file_create" | "file_edit" | "command_run";
  readonly execution: ChannelIntentExecutionPlanV1;
  readonly title: string;
  readonly prompt: string;
  readonly actionSummary: string;
  readonly targetLabel: string;
  readonly requiredTools: readonly RunTool[];
  readonly rolePreferences: readonly AiTeammate["roleKey"][];
  readonly acceptanceCriteria: readonly string[];
  readonly riskSummary: string;
}

interface SingleStepExecutableBlocker {
  readonly userMessage: string;
  readonly technicalReason?: string;
  readonly errorCode?: string;
}

interface SingleStepExecutableClarify {
  readonly reasonCode: ClarifyReasonCode;
  readonly missingFields?: readonly string[];
  readonly userMessage?: string;
  readonly technicalReason: string;
}

interface FileContentResolution {
  readonly content?: string;
  readonly objective?: string;
  readonly source: "current_message" | "attachment" | "recent_code_block" | "current_objective" | "recent_objective" | "none";
  readonly sourceMessageId?: string;
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
  if (!messageCanEnterLingAgentSession(input)) {
    return { action: "continue" };
  }
  const checkpoint = recoverPersistedIntentDecision(input);
  if (checkpoint) return checkpoint;
  const materializationClarify = detectMaterializationClarify(input);
  if (materializationClarify) {
    return createMaterializationClarifyReply(input, materializationClarify);
  }
  const modelIntent = await maybeSelectModelAssistedIntent(input);
  if (modelIntent) {
    return modelIntent;
  }
  if (input.config?.channels.intentSelector) {
    return createReplyIntentResult(input, "Intent model routing was unavailable; ordinary reply fallback applied.");
  }
  const executableClarify = detectSingleStepExecutableClarify(input);
  if (executableClarify) {
    return createClarifyReply(
      input,
      executableClarify.reasonCode,
      "deterministic",
      executableClarify.technicalReason,
      executableClarify.userMessage,
      executableClarify.userMessage
        ? {
            missingFields: executableClarify.missingFields ?? missingFieldsForClarifyReason(executableClarify.reasonCode),
            question: executableClarify.userMessage,
          }
        : undefined,
    );
  }
  const executableIntent = detectSingleStepExecutableIntent(input);
  if (executableIntent) {
    return createSingleStepExecutableProposal(
      input,
      executableIntent,
      "deterministic",
      "Bounded executable request resolved by Ling Agent coordinator.",
    );
  }
  if (hasNonLingExplicitAiMention(input.sourceMessage)) {
    return { action: "continue" };
  }
  if (resolveChannelConversationSurface(input.store, input.channel.id, input.sourceMessage).kind !== "root") {
    return createReplyIntentResult(input, "Non-root Ling turn remains an ordinary reply.");
  }
  return selectDeterministicChannelWorkflowIntent(input);
}

function recoverPersistedIntentDecision(input: ChannelIntentSelectorInput): ChannelIntentSelectorResult | undefined {
  const decision = input.store.listChannelIntentDecisions({
    channelId: input.channel.id,
    sourceItemId: input.sourceMessage.id,
    limit: 100,
  }).find((candidate) => candidate.status === "accepted" || candidate.status === "suppressed");
  if (!decision) return undefined;
  if (decision.action === "reply") return { action: "continue" };
  if (decision.action === "no_reply") return { action: "no_reply", intentDecisionId: decision.id };
  if (decision.action === "clarify") {
    const aiReply = decision.resultItemIds
      .map((itemId) => getChannelMessageView(input.store, itemId))
      .find((reply): reply is ChannelMessage => Boolean(reply));
    return aiReply ? { action: "clarify", aiReply, intentDecisionId: decision.id } : undefined;
  }
  if (decision.action === "visible_multi_reply") {
    const aiReplies = decision.resultItemIds
      .map((itemId) => getChannelMessageView(input.store, itemId))
      .filter((reply): reply is ChannelMessage => Boolean(reply));
    return {
      action: "visible_multi_reply",
      teammateIds: decision.selectedTeammateIds,
      reason: decision.reason,
      createdBy: decision.createdBy,
      aiReplies,
      intentDecisionId: decision.id,
    };
  }
  if (decision.proposalId) {
    const proposal = input.store.getChannelExecutionProposal(decision.proposalId);
    if (proposal) return recoverExistingProposalLineage(input, proposal);
  }
  return undefined;
}

function selectDeterministicChannelWorkflowIntent(input: ChannelIntentSelectorInput): ChannelIntentSelectorResult {
  const visibleMultiReply = selectVisibleMultiReply(input, "deterministic");
  if (visibleMultiReply) {
    return visibleMultiReply;
  }

  const reasonCode = detectWorkflowIntentReason(input.sourceMessage);
  // Explicit mentions are materialized before intent selection. Once more than
  // one participant is requested, execution verbs inside a participant's
  // operation (for example `@QA 执行命令…`) must not collapse the request into
  // a single-agent direct workflow. Preserve the full participant manifest and
  // compile the multi-agent graph first; the resulting decision may still be
  // `execute` and auto-start according to the normal workflow policy.
  const hasMultiParticipantMention = explicitRequestedParticipantIds(input).length > 1;
  if (reasonCode && (reasonCode !== "explicit_workflow_start" || hasMultiParticipantMention)) {
    return createWorkflowIntentResult(input, reasonCode, "deterministic");
  }
  const executableIntent = detectSingleStepExecutableIntent(input);
  if (executableIntent) {
    return createSingleStepExecutableProposal(input, executableIntent, "deterministic");
  }
  if (!reasonCode) {
    const clarifyReasonCode = detectClarifyIntentReason(input.sourceMessage);
    if (!clarifyReasonCode) {
      return createReplyIntentResult(input, "Deterministic fallback kept the turn as an ordinary reply.");
    }
    return createClarifyReply(input, clarifyReasonCode);
  }
  return createWorkflowIntentResult(input, reasonCode, "deterministic");
}

function createWorkflowIntentResult(
  input: ChannelIntentSelectorInput,
  reasonCode: IntentReasonCode,
  createdBy: "deterministic" | "model_policy",
  decisionReason?: string,
): ChannelIntentSelectorResult {
  const existingProposal = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, sourceMessageId: input.sourceMessage.id, limit: 1 })
    .find((proposal) => proposal.status !== "cancelled" && proposal.status !== "superseded");
  if (existingProposal) {
    return recoverExistingProposalLineage(input, existingProposal);
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
  } catch (error) {
    return createReplyIntentResult(
      input,
      `Intent model output was unavailable or invalid; fail-open to an ordinary reply. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function createReplyIntentResult(
  input: ChannelIntentSelectorInput,
  reason: string,
  createdBy: "deterministic" | "model_policy" = "deterministic",
): ChannelIntentSelectorResult {
  persistIntentDecision(input, {
    action: "reply",
    reason,
    status: "accepted",
    createdBy,
  });
  return { action: "continue" };
}

function applyModelIntentOutput(input: ChannelIntentSelectorInput, output: ChannelIntentModelOutput): ChannelIntentSelectorResult | undefined {
  if (output.action === "reply") {
    return createReplyIntentResult(input, output.reason, "model_policy");
  }
  if (output.action === "no_reply") {
    const decision = persistIntentDecision(input, {
      action: "no_reply",
      reason: output.reason,
      status: "suppressed",
      createdBy: "model_policy",
    });
    return { action: "no_reply", intentDecisionId: decision.id };
  }
  if (output.action === "clarify") {
    const clarification = output.clarification;
    if (!clarification) throw new Error("Intent model clarify output omitted structured clarification.");
    validateClarificationForCurrentTurn(input, clarification);
    return createClarifyReply(
      input,
      clarifyReasonFromMissingFields(clarification.missingFields),
      "model_policy",
      output.reason,
      clarification.question,
      clarification,
    );
  }
  if (output.action === "visible_multi_reply") {
    return selectVisibleMultiReply(input, "model_policy", output.reason);
  }
  if (output.action === "execute") {
    return createModelAssistedExecuteResult(input, output);
  }

  const reasonCode = detectWorkflowIntentReason(input.sourceMessage) ?? "ordered_work_request";
  const participants = selectProposalParticipants(input, reasonCode);
  if (participants.length === 0) {
    return undefined;
  }
  return createWorkflowProposal(input, reasonCode, output.action, "model_policy", output.reason, participants);
}

function createModelAssistedExecuteResult(input: ChannelIntentSelectorInput, output: ChannelIntentModelOutput): ChannelIntentSelectorResult {
  const execution = output.execution;
  if (!execution) {
    return createClarifyReply(
      input,
      "missing_target",
      "model_policy",
      `Model classified the turn as execute but omitted its typed execution contract. Model reason: ${output.reason}`,
    );
  }
  const text = normalizeWhitespace(input.sourceMessage.body);
  const operationKinds = new Set(execution.operations.map((operation) => operation.kind));
  if (operationKinds.size === 1 && operationKinds.has("run_command")) {
    const executableIntent = detectReleaseExecutableIntent(text) ?? detectCommandExecutableIntent(text);
    return executableIntent
      ? createSingleStepExecutableProposal(input, executableIntent, "model_policy", `Model-assisted execute/run_command validated. ${output.reason}`)
      : createClarifyReply(
          input,
          "missing_target",
          "model_policy",
          `Model classified the turn as execute/run_command, but no bounded command or check was materialized. Model reason: ${output.reason}`,
        );
  }
  if (operationKinds.has("run_command") && !materializeCommandIntent(text)) {
    const responseLanguage = resolveChannelResponseLanguage({
      store: input.store,
      channel: input.channel,
      sourceText: input.sourceMessage.body,
    }).language;
    const question = buildMissingCommandClarifyBody(responseLanguage);
    return createClarifyReply(
      input,
      "missing_command",
      "model_policy",
      `Model classified the turn as execute/${[...operationKinds].join("+")}, but the required run operation has no bounded command. Model reason: ${output.reason}`,
      question,
      { missingFields: ["command"], question },
    );
  }
  const explicitTarget = extractFileTargetCandidate(text);
  const targetResolution = resolveExecutableFileTarget({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    target: explicitTarget,
    allowRecentMessageTarget: true,
  });
  if (targetResolution.status === "ambiguous") {
    const responseLanguage = resolveChannelResponseLanguage({
      store: input.store,
      channel: input.channel,
      sourceText: input.sourceMessage.body,
    }).language;
    return createClarifyReply(
      input,
      "ambiguous_target",
      "model_policy",
      `Model classified the turn as execute/${[...operationKinds].join("+")}, but target validation found multiple candidates. ${targetResolution.reason} Model reason: ${output.reason}`,
      buildAmbiguousFileTargetClarifyBody(targetResolution.candidates, responseLanguage),
    );
  }
  if (targetResolution.status === "missing") {
    return createClarifyReply(
      input,
      "missing_target",
      "model_policy",
      `Model classified the turn as execute/${[...operationKinds].join("+")}, but target validation failed: ${targetResolution.reason} Model reason: ${output.reason}`,
    );
  }
  if (operationKinds.size === 1 && operationKinds.has("open_local_target")) {
    return createSingleStepExecutableProposal(
      input,
      buildOpenLocalTargetExecutableIntent(input, targetResolution.target),
      "model_policy",
      `Model-assisted execute/open_local_target validated against TargetResolver. ${output.reason}`,
    );
  }
  const fileAction = operationKinds.has("file_edit") ? "file_edit" : "file_create";
  const content = resolveFileContentForRequest(input, text, targetResolution.target);
  if (fileAction === "file_create" && !hasConcreteFileWorkInput(content) && requiresConcreteFileContent(text, targetResolution.source)) {
    const responseLanguage = resolveChannelResponseLanguage({
      store: input.store,
      channel: input.channel,
      sourceText: input.sourceMessage.body,
    }).language;
    const question = buildMissingFileContentClarifyBody(targetResolution.target, responseLanguage);
    return createClarifyReply(
      input,
      "missing_acceptance",
      "model_policy",
      `Model classified the turn as execute/${[...operationKinds].join("+")}, but validated target ${targetResolution.target} has no concrete content or objective source and the current turn is only a follow-up/capability check. Model reason: ${output.reason}`,
      question,
      { missingFields: ["content"], question },
    );
  }
  return createSingleStepExecutableProposal(
    input,
    buildFileExecutableIntent(input, text, targetResolution.target, fileAction, content),
    "model_policy",
    `Model-assisted execute/${[...operationKinds].join("+")} validated against TargetResolver. ${output.reason}`,
  );
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
    turnEnvelope: input.turnEnvelope,
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
    const observedAt = new Date().toISOString();
    const providerPreset = contextPack.providerPresetId ? input.store.getProviderPreset(contextPack.providerPresetId) : undefined;
    recordProviderContextLengthObservation({
      providerPreset,
      contextPack,
      now: observedAt,
    });
    recordProviderRuntimeAvailabilityIncident({
      store: input.store,
      providerPreset,
      providerPresetId: contextPack.providerPresetId,
      code: "context_length_error",
      error,
      now: observedAt,
    });
    const compaction = await compactChannelDiscussionForNoToolsRetry({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      inputBudgetTokens: contextPack.budget.inputBudgetTokens,
      now: observedAt,
    });
    contextPack = buildChannelIntentSelectorContextPack({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      turnEnvelope: input.turnEnvelope,
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
  ].filter((id): id is string => Boolean(id));
  for (const providerPresetId of [...new Set(candidateIds)]) {
    try {
      resolveProviderForRun(input.store, {
        cwd: input.store.paths.cwd,
        workspaceCwd: input.store.paths.cwd,
        task: {
          id: input.sourceMessage.id,
          title: `Channel intent selection in ${input.channel.name}`,
          prompt: input.turnEnvelope
            ? renderLingAgentTurnEnvelopeForPrompt(input.turnEnvelope)
            : input.sourceMessage.body || "Classify channel message intent",
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
      action !== "reply" &&
      action !== "visible_multi_reply" &&
      action !== "clarify" &&
      action !== "workflow_proposal" &&
      action !== "execute") ||
    typeof reason !== "string" ||
    reason.trim().length === 0
  ) {
    throw new Error("Intent model output schema is invalid.");
  }
  const allowedKeys = action === "clarify"
    ? new Set(["action", "reason", "clarification"])
    : action === "execute"
      ? new Set(["action", "reason", "execution"])
      : new Set(["action", "reason"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error("Intent model output contains unsupported fields.");
  }
  return {
    action,
    reason: reason.trim(),
    ...(action === "clarify" ? { clarification: parseModelClarification(record.clarification) } : {}),
    ...(action === "execute" ? { execution: parseModelExecution(record.execution) } : {}),
  };
}

function parseModelClarification(value: unknown): ChannelIntentClarificationV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Intent model clarify output must include a structured clarification object.");
  }
  const record = value as Record<string, unknown>;
  const missingFields = record.missingFields;
  const question = record.question;
  if (
    Object.keys(record).some((key) => key !== "missingFields" && key !== "question")
    || !Array.isArray(missingFields)
    || missingFields.length === 0
    || missingFields.some((field) => typeof field !== "string" || !field.trim())
    || new Set(missingFields).size !== missingFields.length
    || typeof question !== "string"
    || !question.trim()
  ) {
    throw new Error("Intent model clarification schema is invalid.");
  }
  return { missingFields: missingFields.map((field) => field.trim()), question: question.trim() };
}

function parseModelExecution(value: unknown): ChannelIntentModelExecutionPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Intent model execute output must include a structured execution object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "operations")
    || !Array.isArray(record.operations)
    || record.operations.length === 0
    || !record.operations.every(isModelExecutionOperation)) {
    throw new Error("Intent model execution schema is invalid.");
  }
  const operations = record.operations as ChannelIntentModelExecutionOperation[];
  const operationIds = new Set(operations.map((operation) => operation.id));
  if (operationIds.size !== operations.length
    || operations.some((operation) => operation.dependsOn.some((dependencyId) => !operationIds.has(dependencyId)))
    || modelExecutionPlanHasCycle(operations)) {
    throw new Error("Intent model execution graph is invalid.");
  }
  return { operations };
}

function isModelExecutionOperation(value: unknown): value is ChannelIntentModelExecutionOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !new Set(["id", "kind", "targetKind", "required", "dependsOn"]).has(key))
    || typeof record.id !== "string"
    || !record.id.trim()
    || (record.kind !== "file_create" && record.kind !== "file_edit" && record.kind !== "open_local_target" && record.kind !== "run_command")
    || (record.targetKind !== "file" && record.targetKind !== "directory" && record.targetKind !== "command" && record.targetKind !== "workspace")
    || typeof record.required !== "boolean"
    || !Array.isArray(record.dependsOn)
    || record.dependsOn.some((dependencyId) => typeof dependencyId !== "string" || !dependencyId.trim())
    || new Set(record.dependsOn).size !== record.dependsOn.length
    || record.dependsOn.includes(record.id)) {
    return false;
  }
  return record.kind === "run_command"
    ? record.targetKind === "command" || record.targetKind === "workspace"
    : record.targetKind === "file";
}

function modelExecutionPlanHasCycle(operations: readonly ChannelIntentModelExecutionOperation[]): boolean {
  const dependencies = new Map(operations.map((operation) => [operation.id, operation.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operationId: string): boolean => {
    if (visiting.has(operationId)) return true;
    if (visited.has(operationId)) return false;
    visiting.add(operationId);
    for (const dependencyId of dependencies.get(operationId) ?? []) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(operationId);
    visited.add(operationId);
    return false;
  };
  return operations.some((operation) => visit(operation.id));
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
  createdBy: "deterministic" | "model_policy",
  modelReason?: string,
): ChannelIntentSelectorResult | undefined {
  if (!detectVisibleMultiReplyIntent(input.sourceMessage)) {
    return undefined;
  }

  const existingDecision = input.store
    .listChannelIntentDecisions({
      channelId: input.channel.id,
      sourceItemId: input.sourceMessage.id,
      action: "visible_multi_reply",
      status: "accepted",
      limit: 1,
    })
    [0];
  if (existingDecision) {
    const aiReplies = existingDecision.resultItemIds
      .map((replyMessageId) => getChannelMessageView(input.store, replyMessageId))
      .filter((message): message is ChannelMessage => Boolean(message && message.channelId === input.channel.id));
    return {
      action: "visible_multi_reply",
      teammateIds: existingDecision.selectedTeammateIds,
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
  decisionAction: "workflow_proposal" | "execute",
  createdBy: "deterministic" | "model_policy",
  decisionReason: string | undefined,
  participants: readonly ProposalParticipantSelection[],
): ChannelIntentSelectorResult {
  const existingProposal = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, sourceMessageId: input.sourceMessage.id, limit: 1 })
    .find((proposal) => proposal.status !== "cancelled" && proposal.status !== "superseded");
  if (existingProposal) {
    return recoverExistingProposalLineage(input, existingProposal);
  }

  // A multi-role request can still be classified as workflow_proposal because it
  // needs proposal evidence before starting. Once the current turn contains a
  // concrete file operation, however, the accepted decision must carry the same
  // typed operation plan that the later graph compiler will consume. Otherwise the
  // manifest has participants but no owned operations and the Run is created with
  // an empty tool set. The materializer is deliberately narrow and fail-closed: it
  // only derives operations from an independently validated single-step file intent
  // and never invents a command or a target.
  const execution = decisionAction === "execute"
    ? genericWorkflowExecutionPlan(input)
    : deriveMultiParticipantExecutionPlan(input, participants);
  const persistedDecisionAction = execution ? "execute" : decisionAction;
  const participantManifest = createParticipantManifest(
    input,
    participants.map((participant) => participant.teammate),
    persistedDecisionAction,
    execution,
  );

  const assignee = chooseAssignee(input, participants);
  const proposedBy = chooseProposedBy(input, assignee);
  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel: input.channel,
    sourceText: input.sourceMessage.body,
  }).language;
  const now = new Date().toISOString();
  const fallbackRecommendations = uniqueStrings(
    participants
      .map((participant) => participant.fallbackSpecialistRoleKey)
      .filter((roleKey): roleKey is AiTeammate["roleKey"] => Boolean(roleKey))
      .map((roleKey) => lingAgentFallbackRecommendation(roleKey, responseLanguage)),
  );
  const riskSummary = [
    buildRiskSummary(reasonCode, responseLanguage),
    ...fallbackRecommendations,
  ].join("\n\n");
  const requiredTools = execution
    ? requiredToolsForExecutionOperations(execution.operations)
    : [];
  const proposal = input.store.createChannelExecutionProposal(
    {
      channelId: input.channel.id,
      sourceMessageId: input.sourceMessage.id,
      proposedByTeammateId: proposedBy.id,
      title: buildProposalTitle(input.sourceMessage.body, reasonCode),
      prompt: buildProposalPrompt(input.sourceMessage.body, participants, responseLanguage, execution),
      assigneeTeammateId: assignee.id,
      acceptanceCriteria: buildAcceptanceCriteria(responseLanguage),
      collaborationSteps: participants.map((participant) => ({
        teammateId: participant.teammate.id,
        action: participant.role.action,
        summary: roleSummary(participant.role, responseLanguage),
        ...(participant.sources && participant.sources.length > 0 ? { sources: participant.sources } : {}),
      })),
      requiredTools,
      riskSummary,
      responseLanguage,
      shaping: buildProposalShaping(input, buildProposalTitle(input.sourceMessage.body, reasonCode), now),
      status: "draft",
    },
    now,
  );
  const decision = persistIntentDecision(input, {
    action: persistedDecisionAction,
    selectedTeammateIds: participantManifest.participants.map((participant) => participant.participantId),
    participantManifest,
    proposalId: proposal.id,
    ...(execution ? { execution } : {}),
    reason: decisionReason ?? `${persistedDecisionAction === "execute" ? "Executable workflow proposal" : "Workflow proposal"} created from channel intent: ${reasonCode}.`,
    status: "accepted",
    createdBy,
  });
  return { action: "workflow_proposal", proposal, intentDecisionId: decision.id };
}

function createSingleStepExecutableProposal(
  input: ChannelIntentSelectorInput,
  executableIntent: SingleStepExecutableIntent,
  createdBy: "deterministic" | "model_policy",
  decisionReason?: string,
): ChannelIntentSelectorResult {
  const existingProposal = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, sourceMessageId: input.sourceMessage.id, limit: 1 })
    .find((proposal) => proposal.status !== "cancelled" && proposal.status !== "superseded");
  if (existingProposal) {
    return recoverExistingProposalLineage(input, existingProposal);
  }

  const participants = selectSingleStepExecutableParticipants(input, executableIntent);
  if (participants.length === 0) {
    return createClarifyReply(input, "missing_target", createdBy, decisionReason ?? "No active teammate is available for this executable request.");
  }
  const execution = participants.length > 1
    ? deriveMultiParticipantExecutionPlan(input, participants, executableIntent.execution)
    : executableIntent.execution;
  const operationPlan = execution ?? executableIntent.execution;
  const operationOwners = assignExecutionOperationOwners(
    operationPlan.operations,
    participants.map((participant) => ({ teammate: participant.teammate })),
  );
  const participantManifest = createParticipantManifest(
    input,
    participants.map((participant) => participant.teammate),
    "execute",
    operationPlan,
  );

  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel: input.channel,
    sourceText: input.sourceMessage.body,
  }).language;
  const blocker = executableProposalBlocker(input, executableIntent, participants, participantManifest, responseLanguage, operationPlan);
  const fallbackSpecialistRoleKeys = [...new Set<AiTeammate["roleKey"]>(participants.flatMap((participant) => {
    const fallbackRoleKey = participant.fallbackSpecialistRoleKey
      ?? (isLingAgentExecutorId(participant.teammate.id) ? executableIntent.rolePreferences[0] : undefined);
    return fallbackRoleKey ? [fallbackRoleKey] : [];
  }))];
  const assignee = chooseAssignee(input, participants);
  const explicitlyRequested = explicitRequestedParticipantIds(input).length > 0;
  const proposedBy = explicitlyRequested ? assignee : chooseProposedBy(input, assignee);
  const now = new Date().toISOString();
  const riskSummary = blocker
    ? `${executableIntent.riskSummary}\n\n${blocker.userMessage}`
    : fallbackSpecialistRoleKeys.length > 0
      ? `${executableIntent.riskSummary}\n\n${fallbackSpecialistRoleKeys.map((roleKey) => lingAgentFallbackRecommendation(roleKey, responseLanguage)).join("\n")}`
      : executableIntent.riskSummary;
  const requiredTools = requiredToolsForExecutionOperations(operationPlan.operations);
  const acceptanceCriteria = participants.length > 1
    ? [
        ...executableIntent.acceptanceCriteria,
        "Every required participant completes its owned operation subset with successful host evidence before the workflow can succeed.",
      ]
    : executableIntent.acceptanceCriteria;
  const proposal = input.store.createChannelExecutionProposal(
    {
      channelId: input.channel.id,
      sourceMessageId: input.sourceMessage.id,
      proposedByTeammateId: proposedBy.id,
      title: executableIntent.title,
      prompt: participants.length > 1
        ? buildMultiParticipantExecutablePrompt(input.sourceMessage.body, executableIntent, participants, operationPlan, operationOwners, responseLanguage)
        : buildSingleStepExecutablePrompt(input.sourceMessage.body, executableIntent, responseLanguage),
      assigneeTeammateId: assignee.id,
      acceptanceCriteria,
      collaborationSteps: participants.map((participant, index) => ({
        teammateId: participant.teammate.id,
        action: participant.role.action,
        summary: participants.length > 1
          ? summarizeOwnedExecutionOperations(
              participant.teammate.displayName,
              ownedExecutionOperations(operationPlan.operations, operationOwners, index),
              executableIntent.actionSummary,
              responseLanguage,
            )
          : executableIntent.actionSummary,
        ...(participant.sources && participant.sources.length > 0 ? { sources: participant.sources } : {}),
      })),
      requiredTools,
      riskSummary,
      responseLanguage,
      ...(blocker ? {} : { shaping: buildProposalShaping(input, executableIntent.title, now) }),
      status: blocker ? "blocked" : "draft",
      errorMessage: blocker?.userMessage,
    },
    now,
  );
  const decision = persistIntentDecision(input, {
    action: "execute",
    selectedTeammateIds: participantManifest.participants.map((participant) => participant.participantId),
    participantManifest,
    proposalId: proposal.id,
    execution: operationPlan,
    reason: blocker?.technicalReason
      ? `${participants.length > 1 ? "Multi-participant" : "Direct single-step"} executable proposal blocked for ${executableIntent.kind}: ${blocker.technicalReason}`
      : decisionReason ?? `${participants.length > 1 ? "Multi-participant" : "Direct single-step"} executable proposal created for ${executableIntent.kind}.`,
    status: "accepted",
    createdBy,
    errorCode: blocker?.errorCode,
  });
  return { action: "workflow_proposal", proposal, intentDecisionId: decision.id };
}

function recoverExistingProposalLineage(
  input: ChannelIntentSelectorInput,
  proposal: ChannelExecutionProposal,
): ChannelIntentSelectorResult {
  const decision = input.store.listChannelIntentDecisions({
    channelId: input.channel.id,
    sourceItemId: input.sourceMessage.id,
    limit: 100,
  }).find((candidate) =>
    (candidate.status === "accepted" || candidate.status === "suppressed")
    && candidate.proposalId === proposal.id
    && existingProposalDecisionLineageIsCompatible(candidate));
  if (decision) {
    return { action: "workflow_proposal", proposal, intentDecisionId: decision.id };
  }
  return createExistingProposalLineageBlocker(input, proposal);
}

function existingProposalDecisionLineageIsCompatible(decision: ChannelIntentDecision): boolean {
  if (decision.action !== "execute" && decision.action !== "workflow_proposal") return false;
  const manifestParticipantIds = decision.participantManifest.participants
    .map((participant) => participant.participantId);
  return manifestParticipantIds.length > 0
    && manifestParticipantIds.length === decision.selectedTeammateIds.length
    && manifestParticipantIds.every((participantId, index) =>
      participantId === decision.selectedTeammateIds[index]);
}

function createExistingProposalLineageBlocker(
  input: ChannelIntentSelectorInput,
  proposal: ChannelExecutionProposal,
): Extract<ChannelIntentSelectorResult, { action: "blocked" }> {
  const errorCode = "existing_proposal_participant_lineage_invalid" as const;
  const errorMessage = `${errorCode}:${proposal.id}`;
  const existingReply = findChannelAssistantReplyForSource({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
  });
  if (existingReply?.status === "blocked" && existingReply.errorMessage === errorMessage) {
    return { action: "blocked", aiReply: existingReply, proposalId: proposal.id, errorCode };
  }
  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel: input.channel,
    sourceText: input.sourceMessage.body,
  }).language;
  const aiReply = appendChannelAssistantMessage({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
    actorId: LING_AGENT_EXECUTOR_ID,
    body: responseLanguage === "zh-CN"
      ? "这个执行提案的参与者记录不完整，已停止自动执行。原始请求和提案已经保留，请重新发起或修复记录后重试。"
      : "This execution proposal has incomplete participant lineage, so automatic execution was stopped. The original request and proposal were preserved; retry with a new request or repair the stored lineage.",
    status: "blocked",
    errorMessage,
    idempotencyKey: `channel-intent-proposal-lineage-blocker:${input.sourceMessage.id}:${proposal.id}`,
    now: new Date().toISOString(),
  });
  return { action: "blocked", aiReply, proposalId: proposal.id, errorCode };
}

function buildProposalShaping(
  input: ChannelIntentSelectorInput,
  summary: string,
  now: string,
): ChannelRequirementShaping {
  const view = buildWorkflowProposalContextView({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    turnEnvelope: input.turnEnvelope,
  });
  const sourceRefs = proposalSourceRefsFromContextView(view);
  return {
    status: "ready_for_confirmation",
    summary,
    openQuestions: [],
    clarifications: [],
    sourceRefs: sourceRefs.length > 0 ? sourceRefs : [{ type: "message", id: input.sourceMessage.id }],
    updatedAt: now,
  };
}

function createClarifyReply(
  input: ChannelIntentSelectorInput,
  reasonCode: ClarifyReasonCode,
  createdBy: "deterministic" | "model_policy" = "deterministic",
  modelReason?: string,
  bodyOverride?: string,
  clarificationOverride?: ChannelIntentClarificationV2,
): ChannelIntentSelectorResult {
  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel: input.channel,
    sourceText: input.sourceMessage.body,
  }).language;
  const question = bodyOverride ?? buildClarifyQuestion(reasonCode, responseLanguage);
  const clarification = clarificationOverride ?? {
    missingFields: missingFieldsForClarifyReason(reasonCode),
    question,
  };
  validateClarificationShape(clarification);
  const existingReply = findChannelAssistantReplyForSource({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
  });
  if (existingReply) {
    const decision = persistIntentDecision(input, {
      action: "clarify",
      selectedTeammateIds: existingReply.authorId ? [existingReply.authorId] : [],
      resultItemIds: [existingReply.id],
      clarification,
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
  const aiReply = appendChannelAssistantMessage({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
    actorId: teammate.id,
    body: question,
    idempotencyKey: `clarify:${input.sourceMessage.id}:${reasonCode}`,
    now,
  });
  const decision = persistIntentDecision(input, {
    action: "clarify",
    selectedTeammateIds: [teammate.id],
    resultItemIds: [aiReply.id],
    clarification,
    reason: modelReason ?? `Clarify question created from channel intent: ${reasonCode}.`,
    status: "accepted",
    createdBy,
  });
  return { action: "clarify", aiReply, intentDecisionId: decision.id };
}

function createMaterializationClarifyReply(
  input: ChannelIntentSelectorInput,
  clarify: MaterializationClarifyReason,
  createdBy: "deterministic" | "model_policy" = "deterministic",
): ChannelIntentSelectorResult {
  const clarification: ChannelIntentClarificationV2 = {
    missingFields: ["materialized_input"],
    question: clarify.body,
  };
  validateClarificationShape(clarification);
  const existingReply = findChannelAssistantReplyForSource({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
  });
  if (existingReply) {
    const decision = persistIntentDecision(input, {
      action: "clarify",
      selectedTeammateIds: existingReply.authorId ? [existingReply.authorId] : [],
      resultItemIds: [existingReply.id],
      clarification,
      reason: `Existing materialization clarify reply already covers this message: ${existingReply.id}`,
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
  const aiReply = appendChannelAssistantMessage({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
    actorId: teammate.id,
    body: clarify.body,
    idempotencyKey: `materialization-clarify:${input.sourceMessage.id}`,
    now,
  });
  const decision = persistIntentDecision(input, {
    action: "clarify",
    selectedTeammateIds: [teammate.id],
    resultItemIds: [aiReply.id],
    clarification,
    reason: clarify.technicalReason,
    status: "accepted",
    createdBy,
  });
  return { action: "clarify", aiReply, intentDecisionId: decision.id };
}

function messageCanEnterLingAgentSession(input: ChannelIntentSelectorInput): boolean {
  const message = input.sourceMessage;
  if (message.authorType !== "local-user") {
    return false;
  }
  if (message.kind !== "message" || message.intent !== "discuss") {
    return false;
  }
  if (input.channel.status !== "active") {
    return false;
  }
  const envelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: message,
  });
  return turnEnvelopeHasUserInput(envelope);
}

function hasNonLingExplicitAiMention(message: ChannelMessage): boolean {
  return message.mentions.some((mention) => mention.kind === "ai-teammate" && !isLingAgentExecutorId(mention.id));
}

function detectWorkflowIntentReason(message: Pick<ChannelMessage, "body">): IntentReasonCode | undefined {
  const text = message.body.trim();
  const lower = text.toLowerCase();
  if (
    /(帮我|请|麻烦|开始|启动|执行|处理|推进|做|来).{0,60}(push|merge|合并|发布|部署|ship|release|deploy|pr\b)/iu.test(text) ||
    /(push|merge|合并|发布|部署|ship|release|deploy).{0,24}(代码|pr|pull request|分支|版本|上线)/iu.test(text)
  ) {
    return "explicit_workflow_start";
  }
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

function detectSingleStepExecutableIntent(input: ChannelIntentSelectorInput): SingleStepExecutableIntent | undefined {
  const text = normalizeWhitespace(input.sourceMessage.body);
  if (!text || asksForInstructionsOnly(text)) {
    return undefined;
  }
  return detectFileExecutableIntent(input, text)
    ?? detectBrowserOpenExecutableIntent(input, text)
    ?? detectReleaseExecutableIntent(text)
    ?? detectCommandExecutableIntent(text);
}

function detectSingleStepExecutableClarify(input: ChannelIntentSelectorInput): SingleStepExecutableClarify | undefined {
  const text = normalizeWhitespace(input.sourceMessage.body);
  if (!text || asksForInstructionsOnly(text)) {
    return undefined;
  }
  const implicitFileAction = detectImplicitRecentFileAction(text);
  const fileAction = detectFileAction(text) ?? implicitFileAction;
  if (!fileAction) {
    const browserOpenClarify = detectBrowserOpenExecutableClarify(input, text);
    if (browserOpenClarify) {
      return browserOpenClarify;
    }
    return undefined;
  }
  const explicitTarget = extractFileTargetCandidate(text);
  const targetResolution = resolveExecutableFileTarget({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    target: explicitTarget,
    allowRecentMessageTarget: Boolean(implicitFileAction && !explicitTarget),
  });
  if (targetResolution.status === "ambiguous") {
    const responseLanguage = resolveChannelResponseLanguage({
      store: input.store,
      channel: input.channel,
      sourceText: input.sourceMessage.body,
    }).language;
    return {
      reasonCode: "ambiguous_target",
      userMessage: buildAmbiguousFileTargetClarifyBody(targetResolution.candidates, responseLanguage),
      technicalReason: targetResolution.reason,
    };
  }
  if (targetResolution.status === "missing" && implicitFileAction) {
    return {
      reasonCode: "missing_target",
      technicalReason: targetResolution.reason,
    };
  }
  if (targetResolution.status === "resolved" && fileAction === "file_create") {
    const content = resolveFileContentForRequest(input, text, targetResolution.target);
    if (!hasConcreteFileWorkInput(content) && requiresConcreteFileContent(text, targetResolution.source)) {
      const responseLanguage = resolveChannelResponseLanguage({
        store: input.store,
        channel: input.channel,
        sourceText: input.sourceMessage.body,
      }).language;
      return {
        reasonCode: "missing_acceptance",
        missingFields: ["content"],
        userMessage: buildMissingFileContentClarifyBody(targetResolution.target, responseLanguage),
        technicalReason: `Resolved file target ${targetResolution.target}, but no concrete content or objective source was available for a follow-up/capability-style create request.`,
      };
    }
  }
  return undefined;
}

function detectFileExecutableIntent(input: ChannelIntentSelectorInput, text: string): SingleStepExecutableIntent | undefined {
  const implicitFileAction = detectImplicitRecentFileAction(text);
  const fileAction = detectFileAction(text) ?? implicitFileAction;
  if (!fileAction) {
    return undefined;
  }
  const explicitTarget = extractFileTargetCandidate(text);
  const targetResolution = resolveExecutableFileTarget({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    target: explicitTarget,
    allowRecentMessageTarget: Boolean(implicitFileAction && !explicitTarget),
  });
  if (targetResolution.status !== "resolved") {
    return undefined;
  }
  const content = resolveFileContentForRequest(input, text, targetResolution.target);
  if (fileAction === "file_create" && !hasConcreteFileWorkInput(content) && requiresConcreteFileContent(text, targetResolution.source)) {
    return undefined;
  }
  return buildFileExecutableIntent(input, text, targetResolution.target, fileAction, content);
}

function detectBrowserOpenExecutableIntent(input: ChannelIntentSelectorInput, text: string): SingleStepExecutableIntent | undefined {
  if (!mightRequestBrowserOpen(text)) {
    return undefined;
  }
  const explicitTarget = extractFileTargetCandidate(text);
  const targetResolution = resolveExecutableFileTarget({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    target: explicitTarget,
    allowRecentMessageTarget: true,
  });
  if (targetResolution.status !== "resolved") {
    return undefined;
  }
  return buildBrowserOpenExecutableIntent(input, text, targetResolution.target);
}

function detectBrowserOpenExecutableClarify(input: ChannelIntentSelectorInput, text: string): SingleStepExecutableClarify | undefined {
  if (!mightRequestBrowserOpen(text)) {
    return undefined;
  }
  const explicitTarget = extractFileTargetCandidate(text);
  const targetResolution = resolveExecutableFileTarget({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    target: explicitTarget,
    allowRecentMessageTarget: true,
  });
  if (targetResolution.status === "ambiguous") {
    const responseLanguage = resolveChannelResponseLanguage({
      store: input.store,
      channel: input.channel,
      sourceText: input.sourceMessage.body,
    }).language;
    return {
      reasonCode: "ambiguous_target",
      userMessage: buildAmbiguousFileTargetClarifyBody(targetResolution.candidates, responseLanguage),
      technicalReason: targetResolution.reason,
    };
  }
  if (targetResolution.status === "missing" && looksBrowserOpenRequest(text)) {
    return {
      reasonCode: "missing_target",
      technicalReason: targetResolution.reason,
    };
  }
  return undefined;
}

function buildBrowserOpenExecutableIntent(
  input: ChannelIntentSelectorInput,
  text: string,
  target: string,
): SingleStepExecutableIntent | undefined {
  if (!looksBrowserOpenRequest(text, target)) {
    return undefined;
  }
  return buildOpenLocalTargetExecutableIntent(input, target);
}

function buildOpenLocalTargetExecutableIntent(input: ChannelIntentSelectorInput, target: string): SingleStepExecutableIntent {
  const title = truncateTitle(`Open ${target}`);
  const rolePreferences: readonly AiTeammate["roleKey"][] = ["engineer", "qa"];
  return {
    kind: "command_run",
    execution: operationPlan(input, [{ id: "open_target", kind: "open_local_target", targetKind: "file", targetLabel: target }]),
    title,
    prompt: [
      "Open the requested local target for the user.",
      `Target: ${target}`,
      "Use the narrowest local command from the workspace root. For a local HTML file on macOS, prefer opening that file in the default browser.",
      "Do not recreate or edit the file. Do not run unrelated commands.",
    ].join("\n"),
    actionSummary: `Open ${target} in the local browser with the declared bash scope.`,
    targetLabel: target,
    requiredTools: ["bash"],
    rolePreferences,
    acceptanceCriteria: [
      `The local target ${target} is opened or a clear blocker explains why it cannot be opened.`,
      "No files are created or edited by this step.",
      "No undeclared commands, MCP tools, browser sessions, or external actions are used without a separate runtime permission request.",
    ],
    riskSummary: `需要 bash 权限打开 ${target}；proposal evidence 只声明本次打开/运行范围，实际副作用仍走 runtime approval。`,
  };
}

function buildFileExecutableIntent(
  input: ChannelIntentSelectorInput,
  text: string,
  target: string,
  fileAction: "file_create" | "file_edit",
  resolvedContent?: FileContentResolution,
): SingleStepExecutableIntent {
  const contentResolution = resolvedContent ?? resolveFileContentForRequest(input, text, target);
  const commandIntent = explicitlyRequestsCommandExecution(text) ? materializeCommandIntent(text) : undefined;
  const requiredTools: readonly RunTool[] = commandIntent
    ? [fileAction === "file_edit" ? "edit" : "write", "bash"]
    : [fileAction === "file_edit" ? "edit" : "write"];
  const rolePreferences: readonly AiTeammate["roleKey"][] = target.toLowerCase().endsWith(".md")
    ? ["docs", "engineer"]
    : ["engineer", "docs"];
  const title = truncateTitle(`${fileAction === "file_edit" ? "Edit" : "Create"} ${target}`);
  return {
    kind: fileAction,
    execution: operationPlan(input, [
      { id: fileAction === "file_edit" ? "edit_file" : "create_file", kind: fileAction, targetKind: "file", targetLabel: target },
      ...(commandIntent ? [{
        id: "run_command",
        kind: "run_command" as const,
        targetKind: "command" as const,
        targetLabel: commandIntent.targetLabel,
        commandMatchPolicy: commandIntent.policy,
        dependsOn: [fileAction === "file_edit" ? "edit_file" : "create_file"],
      }] : []),
    ]),
    title,
    prompt: [
      `${fileAction === "file_edit" ? "Edit" : "Create"} the requested file.`,
      `Target: ${target}`,
      fileContentPromptLine(contentResolution, fileAction),
      ...(commandIntent ? [commandInstruction(commandIntent)] : []),
    ].join("\n"),
    actionSummary: `${fileAction === "file_edit" ? "Edit" : "Create"} ${target} with the declared file tool scope.`,
    targetLabel: target,
    requiredTools,
    rolePreferences,
    acceptanceCriteria: [
      `Target file is ${fileAction === "file_edit" ? "updated" : "created"} at ${target}.`,
      ...(commandIntent ? [`The ${commandAcceptanceLabel(commandIntent)} completes successfully after the file operation.`] : []),
      "Do not create an empty placeholder file when neither content nor a concrete current objective is available.",
      "No undeclared files, commands, MCP tools, or external actions are used without a separate runtime permission request.",
    ],
    riskSummary: `需要 ${requiredTools.join(", ")} 权限处理 ${target}；proposal evidence 只声明本次任务的文件操作范围，实际副作用仍走 runtime approval。`,
  };
}

function commandInstruction(intent: MaterializedCommandIntent): string {
  return intent.policy.kind === "exact_command"
    ? `After the file operation succeeds, run this bounded command exactly: ${intent.policy.command}`
    : `After the file operation succeeds, use executable ${intent.policy.executable} with the narrowest arguments that satisfy the stated objective.`;
}

function commandAcceptanceLabel(intent: MaterializedCommandIntent): string {
  return intent.policy.kind === "exact_command"
    ? `command ${intent.policy.command}`
    : `command using executable ${intent.policy.executable}`;
}

function resolveFileContentForRequest(input: ChannelIntentSelectorInput, text: string, target: string): FileContentResolution {
  const currentMessageContent = extractRequestedFileContent(text);
  if (currentMessageContent) {
    return { source: "current_message", content: currentMessageContent };
  }
  const attachmentContent = extractMaterializedAttachmentContentForFileRequest(input, text);
  if (attachmentContent) {
    return { source: "attachment", content: attachmentContent };
  }
  const recentCodeBlock = extractRecentThreadCodeBlockContent(input, target);
  if (recentCodeBlock) {
    return recentCodeBlock;
  }
  const currentObjective = extractCurrentFileObjective(text);
  if (currentObjective) {
    return { source: "current_objective", objective: currentObjective };
  }
  const recentObjective = extractRecentFileObjective(input);
  if (recentObjective) {
    return recentObjective;
  }
  return { source: "none" };
}

function fileContentPromptLine(content: FileContentResolution, fileAction: "file_create" | "file_edit"): string {
  if (content.content) {
    const sourceLabel = content.source === "recent_code_block"
      ? `recent same-thread code block${content.sourceMessageId ? ` (${content.sourceMessageId})` : ""}`
      : content.source === "attachment"
        ? "materialized attachment"
        : "current message";
    return `Requested content from ${sourceLabel}:\n${content.content}`;
  }
  if (content.objective) {
    const sourceLabel = content.source === "recent_objective"
      ? `recent same-thread/channel objective${content.sourceMessageId ? ` (${content.sourceMessageId})` : ""}`
      : "current message objective";
    return [
      `Requested objective from ${sourceLabel}:`,
      content.objective,
      "No literal file content was supplied. Generate the file content required by this objective; ask for clarification rather than creating an empty placeholder if the objective is not actionable.",
    ].join("\n");
  }
  if (fileAction === "file_edit") {
    return "No literal replacement content was supplied. Apply only the concrete edit requested by the current user turn; ask for clarification rather than making unrelated edits.";
  }
  return "No literal file content was supplied. Generate the file content required by the current user objective only; if the current turn is only asking whether local writing is possible, ask for clarification rather than creating an empty placeholder.";
}

function hasConcreteFileWorkInput(content: FileContentResolution): boolean {
  return Boolean(content.content?.trim() || content.objective?.trim());
}

function requiresConcreteFileContent(text: string, targetSource: "explicit_path" | "explicit_name" | "recent_work" | "recent_message"): boolean {
  if (referencesAttachmentBody(text)) {
    return false;
  }
  return targetSource === "recent_message" || !hasCurrentFileCreationObjective(text);
}

function hasCurrentFileCreationObjective(text: string): boolean {
  const normalized = normalizeWhitespace(text)
    .replace(extractFileTargetCandidate(text) ?? "", "")
    .trim();
  if (!normalized) {
    return false;
  }
  if (/(游戏|页面|网页|组件|脚本|文档|说明|README|配置|测试|demo|app|website|page|component|script|doc|config|test)/iu.test(normalized)) {
    return true;
  }
  return normalized.length >= 18 && !/(现在可以了吗|可以了吗|能了吗|可以了没|can you now|is it possible now)/iu.test(normalized);
}

function extractCurrentFileObjective(text: string): string | undefined {
  const normalized = normalizeWhitespace(text);
  return hasCurrentFileCreationObjective(normalized) ? normalized : undefined;
}

function extractRecentThreadCodeBlockContent(input: ChannelIntentSelectorInput, target: string): FileContentResolution | undefined {
  const messages = recentFileContentMessages(input);
  for (const message of messages) {
    const blocks = extractMarkdownCodeBlocks(message.body);
    if (blocks.length === 0) {
      continue;
    }
    const matchingBlocks = blocks.filter((block) => codeBlockMatchesTarget(block, target));
    const selected = matchingBlocks.length === 1 ? matchingBlocks[0] : blocks.length === 1 ? blocks[0] : undefined;
    if (!selected?.content.trim()) {
      continue;
    }
    return {
      source: "recent_code_block",
      sourceMessageId: message.id,
      content: selected.content.trim(),
    };
  }
  return undefined;
}

function recentFileContentMessages(input: ChannelIntentSelectorInput): readonly ChannelMessage[] {
  const projection = buildConversationContextProjection({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
    view: "resolver",
  });
  return projectConversationContextMessages(projection, input.store)
    .filter((message) => message.id !== input.sourceMessage.id && message.status !== "failed")
    .slice()
    .reverse();
}

function extractRecentFileObjective(input: ChannelIntentSelectorInput): FileContentResolution | undefined {
  for (const message of recentFileContentMessages(input)) {
    if (message.authorType !== "local-user") {
      continue;
    }
    const objective = extractCurrentFileObjective(message.body);
    if (!objective) {
      continue;
    }
    return {
      source: "recent_objective",
      sourceMessageId: message.id,
      objective,
    };
  }
  return undefined;
}

function extractMarkdownCodeBlocks(text: string): readonly { readonly language: string; readonly content: string }[] {
  const blocks: Array<{ readonly language: string; readonly content: string }> = [];
  const pattern = /```([a-z0-9_-]*)[^\n]*\n([\s\S]*?)```/giu;
  for (const match of text.matchAll(pattern)) {
    const content = match[2]?.trim();
    if (!content) {
      continue;
    }
    blocks.push({
      language: (match[1] ?? "").trim().toLowerCase(),
      content,
    });
  }
  return blocks;
}

function codeBlockMatchesTarget(block: { readonly language: string; readonly content: string }, target: string): boolean {
  const extension = target.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension && (block.language === extension || (extension === "html" && /html?/u.test(block.language)))) {
    return true;
  }
  if (extension === "html" && /<!doctype html|<html[\s>]/iu.test(block.content)) {
    return true;
  }
  if ((extension === "js" || extension === "jsx" || extension === "ts" || extension === "tsx") && /\b(import|export|function|const|let|var)\b/u.test(block.content)) {
    return true;
  }
  return false;
}

function inferModelAssistedFileAction(text: string): "file_create" | "file_edit" {
  return /(修改|编辑|更新|替换|改一下|改成|添加|追加|插入|补充|补一句|加上|patch|edit|update|replace|append|insert|add)/iu.test(text)
    ? "file_edit"
    : "file_create";
}

function mightRequestBrowserOpen(text: string): boolean {
  return /(打开|开启|运行一下|跑一下|预览|看一下|浏览器|open|launch|preview|run it|open it)/iu.test(text);
}

function looksBrowserOpenRequest(text: string, target?: string): boolean {
  if (/(浏览器|browser|预览|preview)/iu.test(text) && /(打开|开启|运行|跑|看|open|launch|run|view)/iu.test(text)) {
    return true;
  }
  const targetExtension = target?.split(".").at(-1)?.toLowerCase();
  if (targetExtension === "html" && /(打开|开启|运行一下|跑一下|看一下|open|launch|run it|open it)/iu.test(text)) {
    return true;
  }
  return false;
}

function detectCommandExecutableIntent(text: string): SingleStepExecutableIntent | undefined {
  const commandIntent = materializeCommandIntent(text);
  const looksLikeTest = /(跑|运行|执行|开跑|帮我|请|麻烦).{0,24}(测试|test|e2e|回归|验收)/iu.test(text);
  const looksLikeBuild = /(跑|运行|执行|开跑|帮我|请|麻烦).{0,24}(build|构建|lint|format|格式化|typecheck|检查)/iu.test(text);
  if (!commandIntent && !looksLikeTest && !looksLikeBuild) return undefined;
  const target = commandIntent?.targetLabel ?? (looksLikeTest ? "project tests" : "project check");
  const title = truncateTitle(`Run ${target}`);
  const rolePreferences: readonly AiTeammate["roleKey"][] = looksLikeTest ? ["qa", "engineer"] : ["engineer", "qa"];
  return {
    kind: "command_run",
    execution: commandIntent
      ? operationPlanForText(target, "run_command", "command", commandIntent.policy)
      : operationPlanForText(target, "run_command", "workspace", undefined, false),
    title,
    prompt: [
      "Run the requested local command or project check.",
      `Target: ${target}`,
      commandIntent?.policy.kind === "exact_command"
        ? `Command requested by user: ${commandIntent.policy.command}`
        : commandIntent?.policy.kind === "executable"
          ? `Executable requested by user: ${commandIntent.policy.executable}. Choose the narrowest arguments that satisfy the stated objective.`
          : "No exact command was supplied; inspect the workspace and choose the narrowest existing project command that matches the objective.",
    ].join("\n"),
    actionSummary: `Run ${target} with the declared bash scope.`,
    targetLabel: target,
    requiredTools: ["bash"],
    rolePreferences,
    acceptanceCriteria: [
      `${target} has been run, or a clear blocker explains why it cannot run.`,
      "No undeclared file writes, edits, external actions, or broader commands are used without a separate runtime permission request.",
    ],
    riskSummary: `需要 bash 权限运行 ${target}；proposal evidence 只声明本次任务的命令范围，实际副作用仍走 runtime approval。`,
  };
}

function detectReleaseExecutableIntent(text: string): SingleStepExecutableIntent | undefined {
  const looksLikeGitPublication = /(帮我|请|麻烦|开始|启动|执行|处理|推进|做|来).{0,60}(push|merge|合并|发布|部署|ship|release|deploy|pr\b)/iu.test(text)
    || /(push|merge|合并|发布|部署|ship|release|deploy).{0,24}(代码|pr|pull request|分支|版本|上线)/iu.test(text);
  if (!looksLikeGitPublication) {
    return undefined;
  }
  const target = "Git push/merge workflow";
  return {
    kind: "command_run",
    execution: operationPlanForText("workspace publication workflow", "run_command", "workspace", undefined, false),
    title: "Prepare Git push/merge",
    prompt: [
      "Prepare and run the requested Git push/merge workflow.",
      `Target: ${target}`,
      "Inspect repository state first, run the narrowest relevant checks, and perform mutation steps only through the active runtime approval policy.",
    ].join("\n"),
    actionSummary: "Prepare Git push/merge with the declared bash scope.",
    targetLabel: target,
    requiredTools: ["bash"],
    rolePreferences: ["release", "engineer"],
    acceptanceCriteria: [
      "Repository state is inspected before any push, merge, release, deploy, or publish mutation.",
      "Required checks are run or a clear blocker explains why they cannot run.",
      "Git push/merge mutation follows runtime approval policy and is not silently bypassed.",
    ],
    riskSummary: "需要 bash 权限处理 Git push/merge；proposal evidence 只声明本次任务的发布/合并范围，真正的高风险副作用继续由 runtime approval policy 控制。",
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
  if (/(修改|编辑|更新|替换|改一下|改成|添加|追加|插入|补充|补一句|加上|patch|edit|update|replace|append|insert|add)/iu.test(text) && looksLikeFileTarget(text)) {
    return "file_edit";
  }
  if (/(创建|新建|生成|写入|写到|写进|保存|落盘|create|write|save)/iu.test(text) && looksLikeFileTarget(text)) {
    return "file_create";
  }
  return undefined;
}

function detectImplicitRecentFileAction(text: string): "file_create" | "file_edit" | undefined {
  const mentionsFileScope = /(工作区|workspace|文件|file)/iu.test(text);
  const refersToPriorTarget = /(刚才|上面|前面|这个|那个|里面|里边|这里|那里|this|that|it)/iu.test(text);
  if (/(修改|编辑|更新|替换|改好|改完|patch|edit|update|replace)/iu.test(text) && (mentionsFileScope || refersToPriorTarget)) {
    return "file_edit";
  }
  if (/(直接|现在|可以|能不能|可不可以|不可以|帮我|请|麻烦).{0,50}(做好|做完|落盘|保存|写入|写进|写到|放进|存进|创建|新建|生成|create|write|save)/iu.test(text)) {
    return "file_create";
  }
  if (/(做好|做完|落盘|保存|写入|写进|写到|放进|存进|创建|新建|生成|create|write|save).{0,50}(工作区|workspace|文件|file|里面|里边|这里|那里|this|that|it)/iu.test(text)) {
    return "file_create";
  }
  return undefined;
}

function looksLikeFileTarget(text: string): boolean {
  return Boolean(extractFileTargetCandidate(text));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

function extractRequestedFileContent(text: string): string | undefined {
  const match = /(?:内容是|内容为|写入|写成|改成|如下|content\s*(?:is|:)|with\s+content)\s*[:：]?\s*([\s\S]+)$/iu.exec(text);
  const content = match?.[1]
    ?.replace(/(?:，|,|；|;)\s*(?:然后|接着|再|and\s+then|then)\s*(?:由\s+[^，。；;!?！？]{0,40}?\s*)?(?:运行|执行|跑|读取|读一下|查看|验证|测试|检查|run|execute|read|inspect|verify|test|check)[\s\S]*$/iu, "")
    // A multi-participant request may name the verifying participant directly
    // (`；QA 执行命令…`) without a transitional word such as `然后`. That
    // clause is workflow instructions, not literal file content. Keep the
    // parser conservative: only trim a delimited suffix when a participant
    // token is immediately followed by an execution/verification verb, so
    // semicolons inside ordinary file content remain untouched.
    ?.replace(/(?:，|,|；|;)\s*(?:由\s*)?(?:@?[\p{L}\p{N}_-]+)\s*(?:运行|执行|跑|读取|读一下|查看|验证|测试|检查|run|execute|read|inspect|verify|test|check)[\s\S]*$/iu, "")
    .trim();
  return content && content.length > 0 ? content : undefined;
}

function extractMaterializedAttachmentContentForFileRequest(input: ChannelIntentSelectorInput, text: string): string | undefined {
  if (!referencesAttachmentBody(text)) {
    return undefined;
  }
  const envelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
  const previews = envelope.attachments
    .filter((attachment) => attachment.previewStatus === "available" && attachment.previewText?.trim())
    .map((attachment) => [
      `Attachment: ${attachment.fileName}`,
      attachment.previewText?.trim(),
    ].filter((line): line is string => Boolean(line)).join("\n"));
  return previews.length > 0 ? previews.join("\n\n") : undefined;
}

function detectMaterializationClarify(input: ChannelIntentSelectorInput): MaterializationClarifyReason | undefined {
  const text = normalizeWhitespace(input.sourceMessage.body);
  if (!text || detectFileAction(text)) {
    return undefined;
  }
  const envelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
  const responseLanguage = resolveChannelResponseLanguage({
    store: input.store,
    channel: input.channel,
    sourceText: input.sourceMessage.body,
  }).language;

  const blockedFileRef = envelope.fileRefs.find((ref) => ref.materializationStatus === "blocked");
  if (blockedFileRef) {
    const label = blockedFileRef.label ?? blockedFileRef.path;
    return {
      body: responseLanguage === "zh-CN"
        ? `这个路径不在当前工作区内。请换成工作区里的文件，或让我通过受控任务先检查它。`
        : `That path is outside this workspace. Use a workspace file, or ask me to inspect it as a controlled task.`,
      sourceLabel: label,
      issueKind: "workspace_file_ref_blocked",
      technicalReason: `Workspace file ref is blocked: ${label}${blockedFileRef.blockedReason ? ` (${blockedFileRef.blockedReason})` : ""}`,
    };
  }

  if (referencesLinkBody(text)) {
    const blockedLink = envelope.linkPreviews.find((preview) => preview.materializationStatus === "blocked");
    if (blockedLink) {
      return {
        body: buildBlockedLinkMaterializationClarifyBody(blockedLink, responseLanguage),
        sourceLabel: blockedLink.url,
        issueKind: "link_body_unavailable",
        technicalReason: `Link body materialization is blocked: ${blockedLink.url}${blockedLink.reason ? ` (${blockedLink.reason})` : ""}`,
      };
    }
    const metadataOnlyLink = envelope.linkPreviews.find((preview) => preview.materializationStatus === "metadata_only");
    if (metadataOnlyLink) {
      const label = metadataOnlyLink.title ?? metadataOnlyLink.url;
      return {
        body: responseLanguage === "zh-CN"
          ? `我可以先读取 ${label} 的页面内容，或者你直接把要总结的正文贴出来。`
          : `I can read ${label} first, or you can paste the text you want summarized.`,
        sourceLabel: label,
        issueKind: "link_body_unavailable",
        technicalReason: `Link body is metadata-only: ${metadataOnlyLink.url}`,
      };
    }
  }

  if (referencesAttachmentBody(text)) {
    const unavailableAttachment = envelope.attachments.find((attachment) => attachment.materializationStatus !== "available");
    if (unavailableAttachment) {
      return {
        body: buildAttachmentMaterializationClarifyBody(unavailableAttachment, responseLanguage),
        sourceLabel: unavailableAttachment.fileName,
        issueKind: "attachment_unavailable",
        technicalReason: `Attachment content is not materialized: ${unavailableAttachment.fileName} (${unavailableAttachment.materializationStatus}${unavailableAttachment.reason ? `: ${unavailableAttachment.reason}` : ""})`,
      };
    }
  }
  return undefined;
}

function buildBlockedLinkMaterializationClarifyBody(
  preview: LingAgentTurnEnvelope["linkPreviews"][number],
  responseLanguage: ResponseLanguage,
): string {
  const localOrPrivate = /localhost|local\/private|local or private|private network|本机|私有|loopback|127\.0\.0\.1|0\.0\.0\.0|::1|10\.|192\.168|172\.(1[6-9]|2\d|3[01])/iu
    .test(`${preview.url} ${preview.reason ?? ""}`);
  if (responseLanguage === "zh-CN") {
    return localOrPrivate
      ? "这个链接看起来是本机或私有地址，我不会自动打开。你可以贴正文，或让我作为受控任务检查它。"
      : "我没能自动读取这个页面。你可以让我重试，或直接把要处理的正文贴出来。";
  }
  return localOrPrivate
    ? "I will not open local/private links automatically. Paste the content, or ask me to inspect it as a controlled task."
    : "I could not read that page automatically. Ask me to retry, or paste the text you want to use.";
}

function buildAttachmentMaterializationClarifyBody(
  attachment: LingAgentTurnEnvelope["attachments"][number],
  responseLanguage: ResponseLanguage,
): string {
  if (responseLanguage === "zh-CN") {
    if (attachment.kind === "image") {
      return `我没能读取 ${attachment.fileName} 的图片内容。你可以换一个可读图片，或把关键内容贴出来。`;
    }
    if (attachment.kind === "pdf") {
      return `我没能读取 ${attachment.fileName} 的 PDF 内容。你可以换一个可读文件，或把需要处理的内容贴出来。`;
    }
    if (attachment.kind === "office") {
      return `我没能读取 ${attachment.fileName} 的文档内容。你可以换一个可读文件，或把关键内容贴出来。`;
    }
    return `我没能读取 ${attachment.fileName}。你可以换一个可读文件，或把需要处理的内容贴出来。`;
  }
  if (attachment.kind === "image") {
    return `I could not read image content from ${attachment.fileName}. Upload a readable image, or paste the relevant details.`;
  }
  if (attachment.kind === "pdf") {
    return `I could not read PDF content from ${attachment.fileName}. Upload a readable file, or paste the section to use.`;
  }
  if (attachment.kind === "office") {
    return `I could not read document content from ${attachment.fileName}. Upload a readable file, or paste the section that matters.`;
  }
  return `I could not read ${attachment.fileName}. Upload a readable file, or paste the content to use.`;
}

function attachmentMaterializationBlocker(
  input: ChannelIntentSelectorInput,
  executableIntent: SingleStepExecutableIntent,
  responseLanguage: ResponseLanguage,
): SingleStepExecutableBlocker | undefined {
  if (executableIntent.kind !== "file_create" && executableIntent.kind !== "file_edit") {
    return undefined;
  }
  const text = normalizeWhitespace(input.sourceMessage.body);
  if (!referencesAttachmentBody(text)) {
    return undefined;
  }
  const envelope = input.turnEnvelope ?? buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
  const available = envelope.attachments.filter((attachment) => attachment.previewStatus === "available" && attachment.previewText?.trim());
  if (available.length > 0) {
    return undefined;
  }
  const reasons = envelope.attachments.length > 0
    ? envelope.attachments.map((attachment) => `${attachment.fileName}: ${attachment.previewStatus}${attachment.reason ? ` (${attachment.reason})` : ""}`).join("; ")
    : responseLanguage === "zh-CN" ? "当前 turn 没有附件。" : "This turn has no attachments.";
  return {
    userMessage: responseLanguage === "zh-CN"
      ? "这个文件任务需要可读的附件内容，但当前附件没有成功读取。你可以换一个可读文件，或直接把要写入的内容贴出来。"
      : "This file task needs readable attachment content, but the attachment was not read successfully. Upload a readable file, or paste the content to write.",
    technicalReason: `Attachment-dependent file task has no available attachment preview/extraction: ${reasons}`,
  };
}

function referencesAttachmentBody(text: string): boolean {
  // "文件内容" is also common in an explicit local-file verification request
  // (for example, `QA 执行命令验证文件内容`). Treat it as attachment intent
  // only when the user names an attachment/image/document surface explicitly;
  // otherwise the ordinary workspace target resolver owns the file.
  return /(附件|附图|截图|图片|图里|这个图|这张图|这份文档|attached file|attachment|screenshot|image|this document)/iu.test(text);
}

function referencesLinkBody(text: string): boolean {
  return /(链接|网页|页面|网址|url|link|page|article)/iu.test(text) &&
    /(总结|概括|读取|读一下|提取|分析|看看|summarize|read|extract|analy[sz]e|what.*about)/iu.test(text);
}

function explicitlyRequestsCommandExecution(text: string): boolean {
  return /(运行|执行|跑一下|跑下|调用|验证|测试|检查|run|execute|invoke|verify|test|check)/iu.test(text);
}

function operationPlan(
  input: ChannelIntentSelectorInput,
  operations: readonly {
    readonly id: string;
    readonly kind: ChannelIntentExecutionOperationV1["kind"];
    readonly targetKind: ChannelIntentExecutionOperationV1["targetKind"];
    readonly targetLabel: string;
    readonly commandMatchPolicy?: CommandMatchPolicyV1;
    readonly dependsOn?: readonly string[];
  }[],
): ChannelIntentExecutionPlanV1 {
  return {
    operations: operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      targetKind: operation.targetKind,
      targetRef: {
        type: "operation",
        id: `${input.sourceMessage.id}:${operation.id}`,
        label: operation.targetLabel,
      },
      ...(operation.commandMatchPolicy ? { commandMatchPolicy: operation.commandMatchPolicy } : {}),
      required: true,
      dependsOn: operation.dependsOn ?? [],
    })),
  };
}

function operationPlanForText(
  target: string | undefined,
  kind: ChannelIntentExecutionOperationV1["kind"],
  targetKind: ChannelIntentExecutionOperationV1["targetKind"],
  commandMatchPolicy?: CommandMatchPolicyV1,
  required = true,
): ChannelIntentExecutionPlanV1 {
  return {
    operations: [{
      id: "run_command",
      kind,
      targetKind,
      targetRef: { type: "operation", id: `command:${target ?? "project_command"}`, label: target ?? "project command" },
      ...(commandMatchPolicy ? { commandMatchPolicy } : {}),
      required,
      dependsOn: [],
    }],
  };
}

function deriveMultiParticipantExecutionPlan(
  input: ChannelIntentSelectorInput,
  participants: readonly ProposalParticipantSelection[],
  baseExecution?: ChannelIntentExecutionPlanV1,
): ChannelIntentExecutionPlanV1 | undefined {
  if (participants.length < 2) {
    return undefined;
  }
  const execution = baseExecution ?? detectSingleStepExecutableIntent(input)?.execution;
  if (!execution) {
    return undefined;
  }

  const operations = [...execution.operations];
  const fileOperation = operations.find((operation) => operation.kind === "file_create" || operation.kind === "file_edit");
  const text = normalizeWhitespace(input.sourceMessage.body);
  const requestsVerification = /(读取|读一下|阅读|验证|检查|测试|验收|查看|read|verify|check|test|validate|inspect)/iu.test(text);

  // Prefer a host-materialized exact content check when the request contains
  // literal file content. Exit-code evidence from that exact command proves the
  // QA step read and compared the target instead of merely mentioning it.
  // Without literal content, retain the bounded path-scoped open operation.
  if (fileOperation
    && requestsVerification
    && !operations.some((operation) => operation.kind === "run_command" || operation.kind === "open_local_target")) {
    const expectedContent = resolveFileContentForRequest(input, text, fileOperation.targetRef.label ?? "").content;
    const exactVerificationCommand = expectedContent
      ? materializeFileContentVerificationCommand(fileOperation.targetRef.label ?? "", expectedContent)
      : undefined;
    if (exactVerificationCommand) {
      operations.push({
        id: "verify_target",
        kind: "run_command",
        targetKind: "command",
        targetRef: {
          type: "operation",
          id: `${input.sourceMessage.id}:verify_target`,
          label: `verify ${fileOperation.targetRef.label ?? "file"} content`,
        },
        commandMatchPolicy: { kind: "exact_command", command: exactVerificationCommand },
        required: true,
        dependsOn: [fileOperation.id],
      });
    } else if (!expectedContent) {
      operations.push({
        id: "verify_target",
        kind: "open_local_target",
        targetKind: "file",
        targetRef: {
          type: "operation",
          id: `${input.sourceMessage.id}:verify_target`,
          label: fileOperation.targetRef.label,
        },
        required: true,
        dependsOn: [fileOperation.id],
      });
    }
  }

  return operations.length > 0 ? { operations } : undefined;
}

function materializeFileContentVerificationCommand(target: string, expectedContent: string): string | undefined {
  if (!target || !expectedContent) return undefined;
  const targetBase64 = Buffer.from(target, "utf8").toString("base64");
  const contentBase64 = Buffer.from(expectedContent, "utf8").toString("base64");
  const command = `node -e "const fs=require('fs');const p=Buffer.from('${targetBase64}','base64').toString('utf8');const e=Buffer.from('${contentBase64}','base64').toString('utf8');if(fs.readFileSync(p,'utf8')!==e)process.exit(1)"`;
  return command.length <= 512 ? command : undefined;
}

function genericWorkflowExecutionPlan(input: ChannelIntentSelectorInput): ChannelIntentExecutionPlanV1 {
  return {
    operations: [{
      id: "workflow_execution",
      kind: "run_command",
      targetKind: "workspace",
      targetRef: {
        type: "operation",
        id: `${input.sourceMessage.id}:workflow_execution`,
        label: normalizeWhitespace(input.sourceMessage.body),
      },
      required: false,
      dependsOn: [],
    }],
  };
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

function intentDecisionActionForReason(reasonCode: IntentReasonCode): "workflow_proposal" | "execute" {
  return reasonCode === "explicit_workflow_start" ? "execute" : "workflow_proposal";
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

function clarifyReasonFromMissingFields(fields: readonly string[]): ClarifyReasonCode {
  if (fields.includes("approval_scope")) return "approval_sensitive_target";
  if (fields.includes("command")) return "missing_command";
  if (fields.includes("target") && fields.length > 1) return "ambiguous_target";
  if (fields.includes("target")) return "missing_target";
  return "missing_acceptance";
}

function missingFieldsForClarifyReason(reasonCode: ClarifyReasonCode): readonly string[] {
  if (reasonCode === "approval_sensitive_target") {
    return ["target", "approval_scope", "acceptance_criteria"];
  }
  if (reasonCode === "missing_command") return ["command"];
  if (reasonCode === "missing_acceptance") return ["acceptance_criteria"];
  return ["target"];
}

function validateClarificationForCurrentTurn(
  input: ChannelIntentSelectorInput,
  clarification: ChannelIntentClarificationV2,
): void {
  validateClarificationShape(clarification);
  if (clarification.missingFields.includes("target") && !currentTurnMayRequireExecutionTarget(input.sourceMessage.body)) {
    throw new Error("Intent model cannot request a local target for an independently answerable content turn.");
  }
}

function validateClarificationShape(clarification: ChannelIntentClarificationV2): void {
  if (clarification.missingFields.length === 0 || !clarification.question.trim()) {
    throw new Error("Channel clarification requires missingFields and a specific question.");
  }
  const question = clarification.question.toLowerCase();
  for (const field of clarification.missingFields) {
    const pattern = clarificationQuestionPattern(field);
    if (!pattern.test(question)) {
      throw new Error(`Channel clarification question does not name missing field: ${field}`);
    }
  }
}

function clarificationQuestionPattern(field: string): RegExp {
  if (field === "target") return /(target|file|path|directory|branch|pr|对象|目标|文件|路径|目录|分支)/iu;
  if (field === "content") return /(content|body|text|page|feature|内容|正文|文本|页面|功能)/iu;
  if (field === "acceptance_criteria") return /(acceptance|criteria|check|done|verify|验收|检查|完成|通过|验证)/iu;
  if (field === "approval_scope") return /(approval|permission|allow|remote|授权|审批|权限|允许|远端)/iu;
  if (field === "materialized_input") return /(attachment|link|input|file|image|document|附件|链接|输入|文件|图片|文档)/iu;
  if (field === "command") return /(command|check|test|命令|检查|测试)/iu;
  return new RegExp(field.replace(/[_-]+/gu, "[ _-]+"), "iu");
}

function currentTurnMayRequireExecutionTarget(body: string): boolean {
  const text = normalizeWhitespace(body);
  return Boolean(
    detectFileAction(text)
    || detectImplicitRecentFileAction(text)
    || mightRequestBrowserOpen(text)
    || detectReleaseExecutableIntent(text)
    || detectCommandExecutableIntent(text)
    || detectWorkflowIntentReason({ body: text })
    || looksWorkShapedButUnderspecified(text)
  );
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
  const channelSpecialists = listEffectiveChannelAiTeammateEntries(input.store, input.channel);
  const sourcesByTeammateId = new Map(channelSpecialists.map((entry) => [entry.teammate.id, entry.sources]));
  const explicitParticipants = explicitRequestedParticipantIds(input).map((participantId) => {
    const teammate = resolveAiTeammateReference(input.store, participantId);
    if (!teammate) {
      throw new Error(`mention_materialization_incomplete: unknown teammate ${participantId}`);
    }
    return {
      teammate,
      role: roleMatchForTeammate(teammate, teammate.roleKey),
      sources: sourcesByTeammateId.get(teammate.id),
    } satisfies ProposalParticipantSelection;
  });
  if (explicitParticipants.length > 0) return explicitParticipants;

  const byRole = new Map<AiTeammate["roleKey"], (typeof channelSpecialists)[number]>();
  for (const entry of channelSpecialists) {
    if (!byRole.has(entry.teammate.roleKey)) {
      byRole.set(entry.teammate.roleKey, entry);
    }
  }
  const text = input.sourceMessage.body.toLowerCase();
  const selectedRoles = reasonCode === "all_teammates_request"
    ? roleMatches.filter((role) => byRole.has(role.roleKey)).slice(0, 5)
    : roleMatches.filter((role) => textMentionsRole(text, role.roleKey));

  const orderedRoles = reasonCode === "explicit_workflow_start" && selectedRoles.length === 0
    ? roleMatches.filter((role) => ["release", "engineer", "qa"].includes(role.roleKey) && byRole.has(role.roleKey))
    : selectedRoles;

  const participants = orderedRoles.flatMap((role) => {
    const entry = byRole.get(role.roleKey);
    return entry ? [{ teammate: entry.teammate, role, sources: entry.sources }] : [];
  });
  if (participants.length > 0) {
    return participants;
  }

  const fallbackRoleKey = inferFallbackSpecialistRoleKey(reasonCode, text);
  const lingAgent = input.store.getAiTeammate(LING_AGENT_EXECUTOR_ID) ?? createLingAgentExecutor();
  return [{
    teammate: lingAgent,
    role: roleMatchForTeammate(lingAgent, fallbackRoleKey),
    fallbackSpecialistRoleKey: fallbackRoleKey,
  }];
}

function selectVisibleMultiReplyTeammates(input: ChannelIntentSelectorInput): readonly AiTeammate[] {
  const protocol = resolveEffectiveChannelCollaborationProtocol({
    store: input.store,
    channel: input.channel,
  });
  const activeTeammates = input.store.listAiTeammates({ status: "active", includeHidden: false, limit: 100 });
  const channelTeammates = listEffectiveChannelAiTeammates(input.store, input.channel);
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

function selectSingleStepExecutableParticipants(
  input: ChannelIntentSelectorInput,
  executableIntent: SingleStepExecutableIntent,
): readonly ProposalParticipantSelection[] {
  const channelEntries = listEffectiveChannelAiTeammateEntries(input.store, input.channel);
  const sourcesByTeammateId = new Map(channelEntries.map((entry) => [entry.teammate.id, entry.sources]));
  const explicitParticipants = explicitRequestedParticipantIds(input).map((participantId) => {
    const teammate = resolveAiTeammateReference(input.store, participantId);
    if (!teammate) {
      throw new Error(`mention_materialization_incomplete: unknown teammate ${participantId}`);
    }
    return {
      teammate,
      role: roleMatchForTeammate(teammate, executableIntent.rolePreferences[0]),
      sources: sourcesByTeammateId.get(teammate.id),
    } satisfies ProposalParticipantSelection;
  });
  if (explicitParticipants.length > 0) return explicitParticipants;

  const channelTeammates = channelEntries.map((entry) => entry.teammate);
  const rolePreferenceSet = new Set(executableIntent.rolePreferences);
  const rolePreferred = channelTeammates.filter((teammate) => rolePreferenceSet.has(teammate.roleKey));
  const supportsTools = (teammate: AiTeammate): boolean =>
    executableIntent.requiredTools.every((tool) => teammate.allowedTools.includes(tool));
  const preferredSupporting = rolePreferred.find(supportsTools);
  if (preferredSupporting) {
    return [{
      teammate: preferredSupporting,
      role: roleMatchForTeammate(preferredSupporting, executableIntent.rolePreferences[0]),
      sources: sourcesByTeammateId.get(preferredSupporting.id),
    }];
  }
  const channelSupporting = channelTeammates.find(supportsTools);
  if (channelSupporting) {
    return [{
      teammate: channelSupporting,
      role: roleMatchForTeammate(channelSupporting, executableIntent.rolePreferences[0]),
      sources: sourcesByTeammateId.get(channelSupporting.id),
    }];
  }

  const lingAgent = input.store.getAiTeammate(LING_AGENT_EXECUTOR_ID) ?? createLingAgentExecutor();
  const fallbackRoleKey = executableIntent.rolePreferences[0];
  return [{
    teammate: lingAgent,
    role: roleMatchForTeammate(lingAgent, fallbackRoleKey),
    fallbackSpecialistRoleKey: fallbackRoleKey,
  }];
}

function explicitRequestedParticipantIds(input: ChannelIntentSelectorInput): readonly string[] {
  return [...new Set(input.sourceMessage.mentions
    .filter((mention) => mention.kind === "ai-teammate")
    .map((mention) => mention.id))];
}

function inferFallbackSpecialistRoleKey(reasonCode: IntentReasonCode, text: string): AiTeammate["roleKey"] {
  const mentionedRole = roleMatches.find((role) => textMentionsRole(text, role.roleKey));
  if (mentionedRole) {
    return mentionedRole.roleKey;
  }
  if (reasonCode === "explicit_workflow_start" || reasonCode === "ordered_work_request") {
    return "engineer";
  }
  if (reasonCode === "all_teammates_request" || reasonCode === "multi_role_request") {
    return "engineer";
  }
  return "custom";
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

function executableProposalBlocker(
  input: ChannelIntentSelectorInput,
  executableIntent: SingleStepExecutableIntent,
  participants: readonly ProposalParticipantSelection[],
  participantManifest: RequiredParticipantManifestV1,
  responseLanguage: ResponseLanguage,
  execution: ChannelIntentExecutionPlanV1 = executableIntent.execution,
): SingleStepExecutableBlocker | undefined {
  const userMessages: string[] = [];
  const technicalReasons: string[] = [];
  let errorCode: string | undefined;
  const manifestByParticipantId = new Map(participantManifest.participants.map((participant) => [participant.participantId, participant]));
  const operationById = new Map(execution.operations.map((operation) => [operation.id, operation]));
  for (const participant of participants) {
    const teammate = participant.teammate;
    if (!teammateCanWorkInEffectiveChannel(input.store, input.channel, teammate.id)) {
      userMessages.push(responseLanguage === "zh-CN"
        ? `${teammate.displayName} 当前不在这个频道可执行名单里；请把该队友加入频道或编辑 proposal 的执行人。`
        : `${teammate.displayName} is not available in this channel; add the teammate to the channel or edit the proposal assignee.`);
      technicalReasons.push(`Assignee is not available in channel: ${teammate.id}`);
      errorCode ??= "participant_unavailable_in_channel";
    }
    const requiredOperationIds = manifestByParticipantId.get(teammate.id)?.requiredOperationIds ?? [];
    const ownedRequiredOperations = requiredOperationIds.flatMap((operationId) => {
      const operation = operationById.get(operationId);
      return operation?.required ? [operation] : [];
    });
    if (participants.length > 1
      && execution.operations.some((operation) => operation.required)
      && ownedRequiredOperations.length === 0) {
      userMessages.push(responseLanguage === "zh-CN"
        ? `${teammate.displayName} 没有可安全分配的必需操作；请明确该参与者负责的执行或验证步骤。`
        : `${teammate.displayName} has no safely assignable required operation; clarify the execution or verification step this participant owns.`);
      technicalReasons.push(`Required participant ${teammate.id} owns no required execution operation.`);
      errorCode ??= "participant_operation_assignment_incomplete";
    }
    const requiredTools = requiredToolsForExecutionOperations(ownedRequiredOperations);
    const missingTeammateTools = requiredTools.filter((tool) => !teammate.allowedTools.includes(tool));
    if (missingTeammateTools.length > 0) {
      userMessages.push(responseLanguage === "zh-CN"
        ? `${teammate.displayName} 缺少所需工具: ${missingTeammateTools.join(", ")}；请调整该队友工具范围或显式更改执行人。`
        : `${teammate.displayName} is missing required tools: ${missingTeammateTools.join(", ")}. Update this teammate's tool scope or explicitly change the assignee.`);
      technicalReasons.push(`Assignee ${teammate.id} is missing required tools: ${missingTeammateTools.join(", ")}`);
      errorCode ??= "participant_required_tools_unavailable";
    }
  }
  const missingMaterializedInput = attachmentMaterializationBlocker(input, executableIntent, responseLanguage);
  if (missingMaterializedInput) {
    userMessages.push(missingMaterializedInput.userMessage);
    if (missingMaterializedInput.technicalReason) {
      technicalReasons.push(missingMaterializedInput.technicalReason);
    }
  }
  return userMessages.length > 0
      ? {
        userMessage: userMessages.join("\n"),
        technicalReason: technicalReasons.length > 0 ? technicalReasons.join("\n") : undefined,
        ...(errorCode ? { errorCode } : {}),
      }
    : undefined;
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
      "权限边界: proposal evidence 只声明本次任务的工具和目标；运行中如需未声明工具、路径、命令、MCP 或外部副作用，必须走 runtime permission request。",
      "开始边界: Ling Agent Session 会在 scope 清楚且所需工具未被 deny 时自动开始；高风险副作用继续由 runtime approval policy 控制，不完整任务必须先澄清。",
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
    "Permission boundary: proposal evidence only declares the tools and target for this task; undeclared tools, paths, commands, MCP actions, or external side effects must use runtime permission request.",
    "Start boundary: Ling Agent Session may auto-start when scope is clear and required tools are not denied; high-risk side effects remain governed by runtime approval policy, and incomplete work must be clarified first.",
  ].join("\n");
}

function buildMultiParticipantExecutablePrompt(
  messageBody: string,
  executableIntent: SingleStepExecutableIntent,
  participants: readonly ProposalParticipantSelection[],
  execution: ChannelIntentExecutionPlanV1,
  operationOwners: ReadonlyMap<string, number>,
  responseLanguage: ResponseLanguage,
): string {
  const operationLines = execution.operations.map((operation) => {
    const ownerIndex = operationOwners.get(operation.id);
    const owner = ownerIndex === undefined ? undefined : participants[ownerIndex]?.teammate.displayName;
    const dependency = operation.dependsOn.length > 0 ? `; depends on ${operation.dependsOn.join(", ")}` : "";
    const commandPolicy = operation.commandMatchPolicy?.kind === "exact_command"
      ? `; exact command: ${operation.commandMatchPolicy.command}`
      : operation.commandMatchPolicy?.kind === "executable"
        ? `; executable: ${operation.commandMatchPolicy.executable}`
        : "";
    return `- ${operation.id}: ${operation.kind} -> ${operation.targetRef.label ?? operation.targetKind}${owner ? `; owner ${owner}` : ""}${dependency}${commandPolicy}`;
  });
  const participantLines = participants.map((participant, index) => {
    const owned = ownedExecutionOperations(execution.operations, operationOwners, index);
    return `- ${participant.teammate.displayName}: ${owned.map((operation) => operation.id).join(", ") || "no operation"}`;
  });
  const header = responseLanguage === "zh-CN"
    ? "这条用户消息是一个多参与者可执行 workflow。"
    : "The user message is a multi-participant executable workflow.";
  const originalLabel = responseLanguage === "zh-CN" ? "原始请求" : "Original request";
  const operationsLabel = responseLanguage === "zh-CN" ? "已物化的执行操作" : "Materialized execution operations";
  const participantsLabel = responseLanguage === "zh-CN" ? "参与者操作归属" : "Participant operation ownership";
  return [
    header,
    "",
    `${originalLabel}: ${normalizeWhitespace(messageBody)}`,
    "",
    executableIntent.prompt,
    "",
    `${operationsLabel}:`,
    ...operationLines,
    "",
    `${participantsLabel}:`,
    ...participantLines,
    "",
    responseLanguage === "zh-CN"
      ? "每个参与者只能完成自己拥有的操作；后续参与者必须等待依赖操作的 Host evidence。最终成功需要所有 required participant 和 operation evidence 都通过。"
      : "Each participant may complete only its owned operations; later participants must wait for dependency Host evidence. Final success requires every required participant and operation evidence to verify.",
    "Permission boundary: undeclared tools, paths, commands, MCP actions, or external side effects require a separate runtime permission request.",
  ].join("\n");
}

function summarizeOwnedExecutionOperations(
  displayName: string,
  operations: readonly ChannelIntentExecutionOperationV1[],
  fallback: string,
  responseLanguage: ResponseLanguage,
): string {
  if (operations.length === 0) {
    return fallback;
  }
  const labels = operations.map((operation) => {
    const target = operation.targetRef.label ?? operation.targetKind;
    if (responseLanguage === "zh-CN") {
      if (operation.kind === "file_create") return `创建 ${target}`;
      if (operation.kind === "file_edit") return `修改 ${target}`;
      if (operation.kind === "open_local_target") return `读取/检查 ${target}`;
      return `执行 ${target}`;
    }
    if (operation.kind === "file_create") return `create ${target}`;
    if (operation.kind === "file_edit") return `edit ${target}`;
    if (operation.kind === "open_local_target") return `read/check ${target}`;
    return `run ${target}`;
  });
  return `${displayName}: ${labels.join(responseLanguage === "zh-CN" ? "，" : ", ")}`;
}

function chooseClarifyingTeammate(input: ChannelIntentSelectorInput): AiTeammate | undefined {
  return input.store.getAiTeammate(LING_AGENT_EXECUTOR_ID) ?? createLingAgentExecutor(new Date().toISOString());
}

function lingAgentFallbackRecommendation(roleKey: AiTeammate["roleKey"], responseLanguage: ResponseLanguage): string {
  const roleLabel = specialistRoleLabel(roleKey, responseLanguage);
  return responseLanguage === "zh-CN"
    ? `没有配置可用的专门 ${roleLabel} 队友；Ling Agent 可以先处理这个有边界的任务，之后也可以添加 ${roleLabel} 队友用于未来任务。`
    : `No dedicated ${roleLabel} teammate is configured. Ling Agent can handle this bounded task now, or you can add a ${roleLabel} teammate for future runs.`;
}

function specialistRoleLabel(roleKey: AiTeammate["roleKey"], responseLanguage: ResponseLanguage): string {
  if (responseLanguage === "zh-CN") {
    if (roleKey === "docs") {
      return "Docs";
    }
    if (roleKey === "engineer") {
      return "Engineer";
    }
    if (roleKey === "qa") {
      return "QA";
    }
    if (roleKey === "architect") {
      return "Architect";
    }
    if (roleKey === "designer") {
      return "Designer";
    }
    if (roleKey === "security") {
      return "Security";
    }
    if (roleKey === "product") {
      return "Product";
    }
    if (roleKey === "release") {
      return "Release";
    }
    return "Specialist";
  }
  if (roleKey === "docs") {
    return "Docs";
  }
  if (roleKey === "engineer") {
    return "Engineer";
  }
  if (roleKey === "qa") {
    return "QA";
  }
  if (roleKey === "architect") {
    return "Architect";
  }
  if (roleKey === "designer") {
    return "Designer";
  }
  if (roleKey === "security") {
    return "Security";
  }
  if (roleKey === "product") {
    return "Product";
  }
  if (roleKey === "release") {
    return "Release";
  }
  return "specialist";
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
  if (reasonCode === "missing_command") {
    return buildMissingCommandClarifyBody(responseLanguage);
  }
  if (reasonCode === "ambiguous_target") {
    return chinese
      ? "我看到多个可能目标。请指定要处理哪一个文件。"
      : "I found multiple possible targets. Please specify which file I should handle.";
  }
  return chinese
    ? "我需要先确认范围：你希望我处理哪个具体目标？完成后用哪几个检查项验收？"
    : "I need to clarify scope first: what specific target should I handle, and which checks should verify the result?";
}

function buildMissingCommandClarifyBody(responseLanguage: ResponseLanguage): string {
  return responseLanguage === "zh-CN"
    ? "文件操作完成后要运行哪条具体命令？请提供一条有边界的命令，例如 `node app.js`。"
    : "Which exact command should run after the file operation? Provide one bounded command, for example `node app.js`.";
}

function buildAmbiguousFileTargetClarifyBody(candidates: readonly string[], responseLanguage: ResponseLanguage): string {
  const listedCandidates = candidates.slice(0, 5).map((candidate) => `- ${candidate}`).join("\n");
  if (responseLanguage === "zh-CN") {
    return [
      "我看到多个可能的文件目标。请指定要落到哪一个：",
      listedCandidates,
    ].join("\n");
  }
  return [
    "I found multiple possible file targets. Specify which one I should use:",
    listedCandidates,
  ].join("\n");
}

function buildMissingFileContentClarifyBody(target: string, responseLanguage: ResponseLanguage): string {
  if (responseLanguage === "zh-CN") {
    return `我已经识别到目标文件是 ${target}，但当前上下文里没有明确要写入的内容。请把要写入的内容、或要生成的具体页面/功能再发一次。`;
  }
  return `I found the target file ${target}, but the current context does not contain clear content to write. Send the content or the concrete page/feature to generate.`;
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
  execution?: ChannelIntentExecutionPlanV1,
): string {
  const steps = participants.map((participant, index) => `${index + 1}. ${participant.teammate.displayName}: ${roleSummary(participant.role, responseLanguage)}`);
  const operations = execution?.operations.map((operation) =>
    `- ${operation.id}: ${operation.kind} (${operation.targetRef.label ?? operation.targetKind})${operation.dependsOn.length > 0 ? ` after ${operation.dependsOn.join(", ")}` : ""}`);
  if (responseLanguage === "zh-CN") {
    return [
      "这条用户消息看起来是一个需要协作执行的工作流请求。",
      "",
      `原始请求: ${normalizeWhitespace(messageBody)}`,
      "",
      "建议协作步骤:",
      ...steps,
      ...(operations && operations.length > 0 ? ["", "已物化的执行操作:", ...operations] : []),
      "",
      "多步骤协作默认等待用户确认；清晰可执行任务在所需工具未被 deny 时可由 Ling Agent Session 自动开始，副作用继续由 runtime approval policy 控制。",
    ].join("\n");
  }
  return [
    "The user message looks like a coordinated workflow request.",
    "",
    `Original request: ${normalizeWhitespace(messageBody)}`,
    "",
    "Proposed collaboration:",
    ...steps,
    ...(operations && operations.length > 0 ? ["", "Materialized operations:", ...operations] : []),
    "",
    "Multi-step collaboration waits for user confirmation by default; clear executable work may be auto-started by Ling Agent Session when required tools are not denied, while side effects remain governed by runtime approval policy.",
  ].join("\n");
}

function buildAcceptanceCriteria(responseLanguage: ResponseLanguage): readonly string[] {
  return responseLanguage === "zh-CN"
    ? [
        "执行前先产生可审计 proposal evidence；多步骤、范围不完整或 policy-denied 的工作需要确认或阻断。",
        "每个实现步骤都通过现有频道 task/run 路径执行。",
        "selector、handoff、run、approval 和 artifact 证据都保持可展开查看。",
      ]
    : [
        "Create auditable proposal evidence before execution; multi-step, incomplete-scope, or policy-denied work needs confirmation or blocking.",
        "Run each implementation step through the existing channel task/run path.",
        "Keep selector, handoff, run, approval, and artifact evidence expandable.",
      ];
}

function buildRiskSummary(reasonCode: IntentReasonCode, responseLanguage: ResponseLanguage): string {
  if (reasonCode === "all_teammates_request") {
    return responseLanguage === "zh-CN"
      ? "已把全员协作执行请求转换为一个工作流 proposal；纯讨论型全员发言会走可见多队友回复。"
      : "Converted an all-teammates execution request into one workflow proposal; discussion-only all-teammate requests use visible multi-reply.";
  }
  if (reasonCode === "explicit_workflow_start") {
    return responseLanguage === "zh-CN"
      ? "显式开始 workflow 的请求会先预填为 proposal evidence；Ling Agent Session 会在工具未被 deny 时自动开始，真正的高风险副作用继续由 runtime approval policy 控制。"
      : "Direct workflow request is prefilled as proposal evidence; Ling Agent Session auto-starts when required tools are not denied, while high-risk side effects remain governed by runtime approval policy.";
  }
  return responseLanguage === "zh-CN"
    ? "多 agent 工作只会在确认后开始，并继续沿用现有 workflow/run approval。"
    : "Multi-agent work starts after confirmation and continues through existing workflow/run approvals.";
}

function roleSummary(role: RoleMatch, responseLanguage: ResponseLanguage): string {
  return responseLanguage === "zh-CN" ? role.summaryZh : role.summary;
}

function persistIntentDecision(
  input: ChannelIntentSelectorInput,
  decision: Pick<
    Parameters<RunStore["createChannelIntentDecision"]>[0],
    "action" | "reason" | "status" | "createdBy"
  > & Partial<Pick<Parameters<RunStore["createChannelIntentDecision"]>[0], "selectedTeammateIds" | "participantManifest" | "proposalId" | "resultItemIds" | "workflowId" | "clarification" | "execution" | "errorCode">>,
): ChannelIntentDecision {
  const projection = buildConversationContextProjection({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
    view: "selector",
  });
  return input.store.createChannelIntentDecision({
    channelId: input.channel.id,
    sourceItemId: input.sourceMessage.id,
    contextProjection: projection.metadata,
    action: decision.action,
    selectedTeammateIds: decision.selectedTeammateIds,
    participantManifest: decision.participantManifest ?? createParticipantManifestFromSelected(
      input,
      decision.selectedTeammateIds ?? [],
      decision.action,
      decision.execution,
    ),
    proposalId: decision.proposalId,
    resultItemIds: decision.resultItemIds,
    workflowId: decision.workflowId,
    reason: decision.reason,
    clarification: decision.clarification,
    execution: decision.execution,
    status: decision.status,
    createdBy: decision.createdBy,
    errorCode: decision.errorCode,
  }, new Date().toISOString());
}

function createParticipantManifest(
  input: ChannelIntentSelectorInput,
  teammates: readonly AiTeammate[],
  action: Parameters<RunStore["createChannelIntentDecision"]>[0]["action"],
  execution: ChannelIntentExecutionPlanV1 | undefined,
): RequiredParticipantManifestV1 {
  const explicitIds = new Set(
    input.sourceMessage.mentions
      .filter((mention) => mention.kind === "ai-teammate")
      .map((mention) => mention.id),
  );
  const operations = execution?.operations ?? [];
  const operationOwners = assignExecutionOperationOwners(
    operations,
    teammates.map((teammate) => ({ teammate })),
  );
  return createRequiredParticipantManifestV1(teammates.map((teammate, index) => ({
    participantId: teammate.id,
    role: teammate.roleKey,
    requirement: "required" as const,
    expectedOutcome: expectedParticipantOutcome(action, teammate, index, teammates.length),
    requiredOperationIds: ownedExecutionOperations(operations, operationOwners, index)
      .filter((operation) => operation.required)
      .map((operation) => operation.id),
    requestedBy: (explicitIds.has(teammate.id) ? "structured_mention" : "selector_policy") as RequiredParticipantRequestedByV1,
  })));
}

function createParticipantManifestFromSelected(
  input: ChannelIntentSelectorInput,
  teammateIds: readonly string[],
  action: Parameters<RunStore["createChannelIntentDecision"]>[0]["action"],
  execution: ChannelIntentExecutionPlanV1 | undefined,
): RequiredParticipantManifestV1 {
  const teammates = teammateIds.flatMap((id) => {
    const teammate = input.store.getAiTeammate(id);
    return teammate ? [teammate] : [];
  });
  return createParticipantManifest(input, teammates, action, execution);
}

function expectedParticipantOutcome(
  action: Parameters<RunStore["createChannelIntentDecision"]>[0]["action"],
  teammate: AiTeammate,
  index: number,
  participantCount: number,
): RequiredParticipantExpectedOutcomeV1 {
  if (action === "reply" || action === "visible_multi_reply" || action === "clarify") return "discussion_reply";
  if (teammate.roleKey === "qa" || teammate.roleKey === "security" || teammate.roleKey === "release") return "verification";
  if (participantCount > 1 && index === participantCount - 1 && teammate.roleKey === "architect") return "synthesis";
  return "execution";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateTitle(value: string): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}
