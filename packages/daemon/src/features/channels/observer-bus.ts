import {
  buildAgentRelevanceCardEvidenceInputs,
  buildChannelTeamAttentionPlan,
  buildChannelTeamRuntimePlan,
  createBuiltinAiTeammateId,
  deriveAgentLifecycleState,
  resolveEffectiveTeammateProviderPresetId,
  type AgentAvailabilityState,
  type AgentCapabilityManifest,
  type AiTeammate,
  type AttentionPlan,
  type AvailabilityIncident,
  type Channel,
  type ChannelParticipationMode,
  type ChannelTeamTurnSignal,
  type RunStore,
  type SecretResolver,
  type TeamRuntimePlan,
} from "@ling-stack/core";
import { listEffectiveChannelAiTeammateEntries } from "./channel-teammate-availability.js";
import type { LingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";
import { listCurrentlyApplicableAvailabilityIncidents } from "../providers/runtime-failure-observations.js";

export interface ChannelObserverBusResult {
  readonly attentionPlan?: AttentionPlan;
  readonly runtimePlan?: TeamRuntimePlan;
  readonly createdEvidenceIds: readonly string[];
  readonly skippedObserverIds: readonly string[];
  readonly constraints: readonly string[];
}

export function runChannelObserverBusForTurn(input: {
  readonly enabled: boolean;
  readonly store: RunStore;
  readonly secretResolver?: SecretResolver;
  readonly channel: Channel;
  readonly sourceMessageId: string;
  readonly turnEnvelope: LingAgentTurnEnvelope;
  readonly now: string;
}): ChannelObserverBusResult {
  if (!input.enabled) {
    return emptyObserverBusResult();
  }

  const entries = listEffectiveChannelAiTeammateEntries(input.store, input.channel);
  if (entries.length === 0) {
    return emptyObserverBusResult();
  }

  const candidateProfiles = entries.map((entry) => {
    const capabilityManifest = inferCapabilityManifest(entry.teammate);
    const lifecycle = deriveLifecycleForCandidate(
      input.store,
      entry.teammate,
      capabilityManifest,
      input.channel.defaultProviderPresetId,
      input.now,
      input.secretResolver,
    );
    return {
      entry,
      capabilityManifest,
      availabilityState: lifecycle.availabilityState,
      qualityState: lifecycle.qualityState,
    };
  });
  const signals = buildTurnSignals(input.turnEnvelope, candidateProfiles.map((profile) => profile.entry.teammate));
  const attentionPlan = buildChannelTeamAttentionPlan({
    channelId: input.channel.id,
    turnId: input.sourceMessageId,
    turnMode: "quick_answer",
    candidates: candidateProfiles.map((profile) => ({
      agentId: profile.entry.teammate.id,
      participationMode: participationModeForRole(profile.entry.teammate.roleKey),
      capabilityManifest: profile.capabilityManifest,
      availabilityState: profile.availabilityState,
      qualityState: profile.qualityState,
      isDefault: profile.entry.isDefault,
    })),
    signals,
    maxObservers: 4,
    now: input.now,
    flags: {
      attentionPlanEnabled: true,
      agentRelevanceCardsEnabled: true,
    },
  });
  const runtimePlan = buildChannelTeamRuntimePlan({
    attentionPlan,
    now: input.now,
  });
  const evidenceAttentionPlan: AttentionPlan = {
    ...attentionPlan,
    observers: runtimePlan.observers,
  };
  const evidenceInputs = buildAgentRelevanceCardEvidenceInputs({
    attentionPlan: evidenceAttentionPlan,
    now: input.now,
    flags: {
      agentRelevanceCardsEnabled: true,
    },
  });
  const createdEvidenceIds = evidenceInputs.map((evidenceInput) =>
    input.store.createChannelTeamEvidenceItem(evidenceInput, input.now).id,
  );

  return {
    attentionPlan,
    runtimePlan,
    createdEvidenceIds,
    skippedObserverIds: runtimePlan.skippedObserverIds,
    constraints: runtimePlan.constraints,
  };
}

function emptyObserverBusResult(): ChannelObserverBusResult {
  return {
    createdEvidenceIds: [],
    skippedObserverIds: [],
    constraints: [],
  };
}

function inferCapabilityManifest(teammate: AiTeammate): AgentCapabilityManifest {
  const scopes = capabilityScopesForRole(teammate.roleKey);
  return {
    agentId: teammate.id,
    summary: `${teammate.displayName} can observe ${scopes.join(", ")}`,
    capabilityScopes: scopes,
    preferredTurnModes: preferredTurnModesForRole(teammate.roleKey),
    maxLeaseLevel: "L0",
    riskReviewEligible: participationModeForRole(teammate.roleKey) === "reviewer",
    source: "inferred",
  };
}

function deriveLifecycleForCandidate(
  store: RunStore,
  teammate: AiTeammate,
  capabilityManifest: AgentCapabilityManifest,
  channelDefaultProviderPresetId: string | undefined,
  now: string,
  secretResolver?: SecretResolver,
): { readonly availabilityState: AgentAvailabilityState; readonly qualityState: ReturnType<typeof deriveAgentLifecycleState>["qualityState"] } {
  const capabilityScope = capabilityManifest.capabilityScopes[0] ?? "general";
  const providerPresetId = resolveEffectiveTeammateProviderPresetId({
    teammate,
    surface: "channel",
    workspaceDefaultProviderPresetId: store.getWorkspaceSettings().defaultProviderPresetId,
    channelDefaultProviderPresetId,
  });
  const availabilityIncidents = uniqueAvailabilityIncidents([
    ...listCurrentlyApplicableAvailabilityIncidents({
      store, secretResolver,
      agentId: teammate.id,
      applicableProviderPresetId: providerPresetId ?? null,
      now,
      limit: 50,
    }),
    ...(providerPresetId
      ? listCurrentlyApplicableAvailabilityIncidents({
          store, secretResolver,
          providerPresetId,
          now,
          limit: 50,
        })
      : []),
  ]);
  const lifecycle = deriveAgentLifecycleState({
    agentId: teammate.id,
    capabilityScope,
    reliabilityIncidents: store.listReliabilityIncidents({
      agentId: teammate.id,
      capabilityScope,
      now,
      limit: 50,
    }),
    availabilityIncidents,
    now,
  });
  return {
    availabilityState: lifecycle.availabilityState,
    qualityState: lifecycle.qualityState,
  };
}

function uniqueAvailabilityIncidents(incidents: readonly AvailabilityIncident[]): readonly AvailabilityIncident[] {
  const selected: AvailabilityIncident[] = [];
  const seen = new Set<string>();
  for (const incident of incidents) {
    if (seen.has(incident.id)) {
      continue;
    }
    seen.add(incident.id);
    selected.push(incident);
  }
  return selected;
}

function buildTurnSignals(turnEnvelope: LingAgentTurnEnvelope, teammates: readonly AiTeammate[]): readonly ChannelTeamTurnSignal[] {
  const messageSourceRef = { type: "message" as const, id: turnEnvelope.sourceMessageId };
  const signals: ChannelTeamTurnSignal[] = [];
  for (const teammate of teammates) {
    if (!turnEnvelope.mentions.some((mention) => mention.kind === "ai-teammate" && mentionMatchesTeammate(mention, teammate))) {
      continue;
    }
    for (const scope of capabilityScopesForRole(teammate.roleKey)) {
      signals.push({
        kind: "user_mention",
        scope,
        weight: 3,
        sourceRefs: [messageSourceRef],
      });
    }
  }
  for (const attachment of turnEnvelope.attachments) {
    signals.push({
      kind: "file",
      scope: "attachment",
      weight: 1,
      sourceRefs: [{ type: "attachment", id: attachment.id, label: attachment.fileName }],
    });
  }
  for (const fileRef of turnEnvelope.fileRefs) {
    signals.push({
      kind: "file",
      scope: "code",
      weight: 1,
      sourceRefs: [{ type: "external", id: fileRef.path, label: fileRef.label ?? fileRef.path }],
    });
  }
  for (const preview of turnEnvelope.linkPreviews) {
    signals.push({
      kind: "topic",
      scope: "research",
      weight: 0.75,
      sourceRefs: [{ type: "link_preview", id: preview.id, label: preview.title ?? preview.url }],
    });
  }
  if (turnEnvelope.guidancePayload?.targetRunId) {
    signals.push({
      kind: "workflow",
      scope: "workflow",
      weight: 1,
      sourceRefs: [{ type: "run", id: turnEnvelope.guidancePayload.targetRunId }],
    });
  }
  if (signals.length === 0) {
    signals.push({
      kind: "default",
      scope: "general",
      weight: 0.25,
      sourceRefs: [messageSourceRef],
    });
  }
  return signals;
}

function mentionMatchesTeammate(
  mention: { readonly id: string; readonly label: string },
  teammate: AiTeammate,
): boolean {
  const normalizedMentionId = normalizeIdentifier(mention.id);
  const normalizedLabel = normalizeIdentifier(mention.label);
  const normalizedRole = normalizeIdentifier(teammate.roleKey);
  return normalizedMentionId === normalizeIdentifier(teammate.id) ||
    normalizedMentionId === normalizeIdentifier(teammate.templateId) ||
    normalizedMentionId === normalizeIdentifier(createBuiltinAiTeammateId(teammate.roleKey)) ||
    normalizedMentionId === normalizedRole ||
    normalizedLabel === normalizedRole ||
    normalizeIdentifier(teammate.displayName) === normalizedLabel;
}

function capabilityScopesForRole(roleKey: AiTeammate["roleKey"]): readonly string[] {
  switch (roleKey) {
    case "product":
      return ["product", "planning", "prioritization"];
    case "architect":
      return ["architecture", "system_design", "protocol"];
    case "engineer":
      return ["code", "implementation", "debugging"];
    case "designer":
      return ["design", "ux", "frontend"];
    case "qa":
      return ["testing", "quality", "regression"];
    case "security":
      return ["security", "risk", "approval"];
    case "release":
      return ["release", "deploy", "operations"];
    case "docs":
      return ["docs", "writing", "knowledge"];
    case "custom":
    default:
      return ["general"];
  }
}

function participationModeForRole(roleKey: AiTeammate["roleKey"]): ChannelParticipationMode {
  switch (roleKey) {
    case "qa":
    case "security":
    case "release":
      return "reviewer";
    case "custom":
      return "observer";
    default:
      return "specialist";
  }
}

function preferredTurnModesForRole(roleKey: AiTeammate["roleKey"]): AgentCapabilityManifest["preferredTurnModes"] {
  switch (roleKey) {
    case "qa":
    case "security":
    case "release":
      return ["safe_action", "deep_review"];
    case "architect":
    case "engineer":
      return ["deep_review", "background_work"];
    default:
      return ["quick_answer", "deep_review"];
  }
}

function normalizeIdentifier(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^@/u, "");
}
