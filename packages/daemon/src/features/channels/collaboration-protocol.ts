import type { IncomingMessage, ServerResponse } from "node:http";
import {
  channelAutoReplyModes,
  channelResponseLanguages,
  channelWorkflowPreferences,
  type Channel,
  type ChannelAutoReplyMode,
  type ChannelCollaborationProtocolDraft,
  type ChannelCollaborationProtocolPatch,
  type ChannelStoreFacet,
  type ChannelProtocolDraftCreatedBy,
  type ChannelProtocolDraftStatus,
  type ChannelProtocolSourceRef,
  type ChannelResponseLanguage,
  type ChannelWorkflowPreference,
  type ProcedureObservationCluster,
  type ResponseLanguagePreference,
  type RunStore,
  type SkillCandidateSourceRef,
  type WorkspaceStoreFacet,
} from "@ling-stack/core";
import type { ChannelProtocolCanvasSection } from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalJsonBody } from "../../shared/request.js";
import { isRecord } from "../../shared/validation.js";
import { writeJson } from "../../shared/response.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";

export type ChannelProtocolFieldSource =
  | "current_message"
  | "channel_setting"
  | "protocol_override"
  | "workspace_setting"
  | "default"
  | "teammate_instruction";

export interface ChannelProtocolFieldResolution<T> {
  readonly value: T;
  readonly source: ChannelProtocolFieldSource;
  readonly channelValue?: T;
  readonly workspaceValue?: T;
}

export interface EffectiveChannelCollaborationProtocol {
  readonly schemaVersion: 1;
  readonly channelId: string;
  readonly responseLanguage: ChannelResponseLanguage;
  readonly autoReplyMode: ChannelAutoReplyMode;
  readonly defaultTeammateId?: string;
  readonly protocolVersion?: number;
  readonly defaultWorkflowPreference: ChannelWorkflowPreference;
  readonly visibleMultiReplyMaxParticipants: number;
  readonly privacyRules: readonly string[];
  readonly reviewRules: readonly string[];
  readonly updatedBy: "local-user" | "system_template" | "ai-draft";
  readonly updatedAt: string;
}

export interface EffectiveChannelCollaborationProtocolResult {
  readonly protocol: EffectiveChannelCollaborationProtocol;
  readonly sources: {
    readonly responseLanguage: ChannelProtocolFieldResolution<ChannelResponseLanguage>;
    readonly autoReplyMode: ChannelProtocolFieldResolution<ChannelAutoReplyMode>;
    readonly defaultTeammateId: ChannelProtocolFieldResolution<string | undefined>;
    readonly defaultWorkflowPreference: ChannelProtocolFieldResolution<ChannelWorkflowPreference>;
    readonly visibleMultiReplyMaxParticipants: ChannelProtocolFieldResolution<number>;
    readonly privacyRules: ChannelProtocolFieldResolution<readonly string[]>;
    readonly reviewRules: ChannelProtocolFieldResolution<readonly string[]>;
  };
  readonly storage: {
    readonly mode: "channel_fields" | "channel_fields_and_protocol_overrides";
    readonly editableFields: readonly string[];
    readonly unsupportedFields: readonly string[];
  };
}

const EDITABLE_PROTOCOL_FIELDS = ["responseLanguage", "autoReplyMode", "defaultTeammateId"] as const;
const PROTOCOL_OVERRIDE_FIELDS = [
  "defaultWorkflowPreference",
  "visibleMultiReplyMaxParticipants",
  "privacyRules",
  "reviewRules",
] as const;
const ALL_PROTOCOL_FIELDS = [...EDITABLE_PROTOCOL_FIELDS, ...PROTOCOL_OVERRIDE_FIELDS] as const;

type ProtocolPatchInput = {
  readonly responseLanguage?: ChannelResponseLanguage | null;
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
  readonly defaultTeammateId?: string | null;
};

type ProtocolCandidateFromClusterInput = {
  readonly proposedPatch?: ChannelCollaborationProtocolPatch;
  readonly reason?: string;
  readonly expiresAt?: string;
};

type MutableProtocolPatch = {
  -readonly [K in keyof ChannelCollaborationProtocolPatch]: ChannelCollaborationProtocolPatch[K];
};

type EffectiveChannelProtocolStore = ChannelStoreFacet & WorkspaceStoreFacet;

export function resolveEffectiveChannelCollaborationProtocol(input: {
  readonly store: EffectiveChannelProtocolStore;
  readonly channel: Channel;
}): EffectiveChannelCollaborationProtocolResult {
  const workspaceSettings = input.store.getWorkspaceSettings();
  const override = input.store.getChannelCollaborationProtocolOverride(input.channel.id);
  const responseLanguage = resolveResponseLanguageField(input.channel, workspaceSettings.responseLanguage);
  const autoReplyMode = resolveAutoReplyModeField(input.channel);
  const defaultTeammateId = resolveDefaultTeammateField(input.channel);
  const defaultWorkflowPreference = resolveProtocolOverrideField<ChannelWorkflowPreference>(override?.defaultWorkflowPreference, "manual");
  const visibleMultiReplyMaxParticipants = resolveProtocolOverrideField(override?.visibleMultiReplyMaxParticipants, 3);
  const privacyRules = resolveProtocolOverrideField<readonly string[]>(override?.privacyRules, []);
  const reviewRules = resolveProtocolOverrideField<readonly string[]>(override?.reviewRules, []);
  const updatedBy = override
    ? override.updatedBy
    : responseLanguage.source === "default" &&
      autoReplyMode.source === "default" &&
      defaultTeammateId.source === "default"
      ? "system_template"
      : "local-user";
  const updatedAt = override && override.updatedAt.localeCompare(input.channel.updatedAt) > 0
    ? override.updatedAt
    : input.channel.updatedAt;

  return {
    protocol: {
      schemaVersion: 1,
      channelId: input.channel.id,
      responseLanguage: responseLanguage.value,
      autoReplyMode: autoReplyMode.value,
      defaultTeammateId: defaultTeammateId.value,
      protocolVersion: override?.version,
      defaultWorkflowPreference: defaultWorkflowPreference.value,
      visibleMultiReplyMaxParticipants: visibleMultiReplyMaxParticipants.value,
      privacyRules: privacyRules.value,
      reviewRules: reviewRules.value,
      updatedBy,
      updatedAt,
    },
    sources: {
      responseLanguage,
      autoReplyMode,
      defaultTeammateId,
      defaultWorkflowPreference,
      visibleMultiReplyMaxParticipants,
      privacyRules,
      reviewRules,
    },
    storage: {
      mode: "channel_fields_and_protocol_overrides",
      editableFields: ALL_PROTOCOL_FIELDS,
      unsupportedFields: [],
    },
  };
}

function resolveProtocolOverrideField<T>(overrideValue: T | undefined, defaultValue: T): ChannelProtocolFieldResolution<T> {
  if (overrideValue !== undefined) {
    return {
      value: overrideValue,
      source: "protocol_override",
    };
  }
  return {
    value: defaultValue,
    source: "default",
  };
}

export async function handleChannelCollaborationProtocol(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  action?: "revert" | "drafts" | "apply-draft" | "candidates" | "review-candidate" | "candidate-from-cluster" | "canvas",
  draftId?: string,
  clusterId?: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (!action && request.method === "GET") {
      writeJson(response, 200, { cwd, ...resolveEffectiveChannelCollaborationProtocol({ store, channel }) });
      return;
    }

    if (action === "canvas" && request.method === "GET") {
      const resolved = resolveEffectiveChannelCollaborationProtocol({ store, channel });
      const limit = readLimit(url.searchParams.get("limit")) ?? 50;
      const candidateClusters = store.listProcedureObservationClusters({ channelId, limit: 100 })
        .filter((cluster) => cluster.routeKind === "channel_protocol" || cluster.routeKind === "playbook")
        .slice(0, limit);
      const draftCandidates = store.listChannelCollaborationProtocolDrafts({
        channelId,
        status: "draft",
        limit: 50,
      });
      writeJson(response, 200, {
        cwd,
        ...resolved,
        candidateClusters,
        draftCandidates,
        sections: buildChannelProtocolCanvasSections(resolved, candidateClusters, draftCandidates),
      });
      return;
    }

    if ((action === "drafts" || action === "candidates") && request.method === "GET") {
      const status = readDraftStatusFilter(url.searchParams.get("status"));
      writeJson(response, 200, {
        cwd,
        channelId,
        drafts: store.listChannelCollaborationProtocolDrafts({
          channelId,
          status,
          limit: readLimit(url.searchParams.get("limit")),
        }),
      });
      return;
    }

    if ((action === "drafts" || action === "candidates") && request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const draftInput = parseCreateProtocolDraftInput(body);
      const validationError = validateProtocolPatch(store, draftInput.proposedPatch, config);
      if (validationError) {
        writeJson(response, validationError.statusCode, {
          error: validationError.code,
          message: validationError.message,
        });
        return;
      }
      const draft = store.createChannelCollaborationProtocolDraft(
        {
          channelId,
          baseVersion: draftInput.baseVersion,
          proposedPatch: draftInput.proposedPatch,
          reason: draftInput.reason,
          createdBy: draftInput.createdBy ?? "ai-draft",
          sourceRefs: draftInput.sourceRefs,
          expiresAt: draftInput.expiresAt,
        },
        new Date().toISOString(),
      );
      writeJson(response, 201, {
        cwd,
        draft,
        ...resolveEffectiveChannelCollaborationProtocol({ store, channel }),
      });
      return;
    }

    if (action === "candidate-from-cluster" && request.method === "POST") {
      if (!clusterId) {
        writeJson(response, 400, { error: "bad_request", message: "Procedure observation cluster id is required." });
        return;
      }
      const cluster = store.getProcedureObservationCluster(clusterId);
      if (!cluster) {
        writeJson(response, 404, { error: "procedure_observation_cluster_not_found", message: `Procedure observation cluster not found: ${clusterId}` });
        return;
      }
      const body = await readOptionalJsonBody(request, config.maxBodyBytes);
      const input = parseProtocolCandidateFromClusterInput(body);
      const built = protocolDraftInputFromCluster(cluster, channelId, input);
      if ("error" in built) {
        writeJson(response, built.statusCode, built.error);
        return;
      }
      const validationError = validateProtocolPatch(store, built.proposedPatch, config);
      if (validationError) {
        writeJson(response, validationError.statusCode, {
          error: validationError.code,
          message: validationError.message,
        });
        return;
      }
      const draft = store.createChannelCollaborationProtocolDraft(
        {
          channelId,
          proposedPatch: built.proposedPatch,
          reason: built.reason,
          createdBy: "ai-draft",
          sourceRefs: built.sourceRefs,
          expiresAt: built.expiresAt,
        },
        new Date().toISOString(),
      );
      writeJson(response, 201, {
        cwd,
        draft,
        ...resolveEffectiveChannelCollaborationProtocol({ store, channel }),
      });
      return;
    }

    if (action === "review-candidate" && request.method === "POST") {
      if (!draftId) {
        writeJson(response, 400, { error: "bad_request", message: "Protocol candidate id is required." });
        return;
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const reviewAction = readProtocolCandidateReviewAction(body);
      if (reviewAction === "approve") {
        const applied = applyProtocolDraft(store, channel, draftId, config);
        if ("error" in applied) {
          writeJson(response, applied.statusCode, applied.error);
          return;
        }
        writeJson(response, 200, {
          cwd,
          draft: applied.draft,
          ...resolveEffectiveChannelCollaborationProtocol({ store, channel: applied.channel }),
        });
        return;
      }
      const cancelled = cancelProtocolDraftCandidate(store, channel, draftId);
      if ("error" in cancelled) {
        writeJson(response, cancelled.statusCode, cancelled.error);
        return;
      }
      writeJson(response, 200, {
        cwd,
        draft: cancelled.draft,
        ...resolveEffectiveChannelCollaborationProtocol({ store, channel }),
      });
      return;
    }

    if (!action && request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const patch = parseProtocolPatchInput(body);
      const validationError = validateProtocolPatch(store, patch, config);
      if (validationError) {
        writeJson(response, validationError.statusCode, {
          error: validationError.code,
          message: validationError.message,
        });
        return;
      }
      const updated = store.updateChannel(channelId, {
        responseLanguage: patch.responseLanguage,
        autoReplyMode: patch.autoReplyMode,
        defaultTeammateId: patch.defaultTeammateId,
      }, new Date().toISOString());
      writeJson(response, 200, {
        cwd,
        ...resolveEffectiveChannelCollaborationProtocol({ store, channel: updated ?? channel }),
      });
      return;
    }

    if (action === "revert" && request.method === "POST") {
      const updated = store.updateChannel(channelId, {
        responseLanguage: null,
        autoReplyMode: null,
        defaultTeammateId: null,
      }, new Date().toISOString());
      store.deleteChannelCollaborationProtocolOverride(channelId);
      writeJson(response, 200, {
        cwd,
        revertedFields: ALL_PROTOCOL_FIELDS,
        ...resolveEffectiveChannelCollaborationProtocol({ store, channel: updated ?? channel }),
      });
      return;
    }

    if (action === "apply-draft" && request.method === "POST") {
      if (!draftId) {
        writeJson(response, 400, { error: "bad_request", message: "Protocol draft id is required." });
        return;
      }
      const applied = applyProtocolDraft(store, channel, draftId, config);
      if ("error" in applied) {
        writeJson(response, applied.statusCode, applied.error);
        return;
      }
      writeJson(response, 200, {
        cwd,
        draft: applied.draft,
        ...resolveEffectiveChannelCollaborationProtocol({ store, channel: applied.channel }),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel protocol` });
  } catch (error) {
    if (error instanceof UnsupportedProtocolFieldError) {
      writeJson(response, 400, {
        error: "unsupported_protocol_field",
        message: error.message,
        field: error.field,
      });
      return;
    }
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildChannelProtocolCanvasSections(
  resolved: EffectiveChannelCollaborationProtocolResult,
  candidateClusters: readonly { readonly status: string; readonly routeBlockers: readonly string[] }[],
  draftCandidates: readonly ChannelCollaborationProtocolDraft[],
): readonly ChannelProtocolCanvasSection[] {
  const blockedClusters = candidateClusters.filter((cluster) => cluster.status === "blocked" || cluster.routeBlockers.length > 0);
  const readyClusters = candidateClusters.filter((cluster) => cluster.status === "ready_for_review");
  return [
    {
      kind: "current_protocol",
      title: "Current protocol",
      summary: "Effective channel coordination settings are available for Web and desktop clients.",
      itemCount: 1,
      status: "healthy",
    },
    {
      kind: "candidate_clusters",
      title: "Candidate clusters",
      summary: blockedClusters.length > 0
        ? "Some observed protocol or playbook candidates are blocked before review."
        : readyClusters.length > 0
          ? "Observed channel candidates are ready for human review."
          : "No channel protocol or playbook candidate clusters need review.",
      itemCount: candidateClusters.length,
      status: blockedClusters.length > 0 ? "blocked" : readyClusters.length > 0 ? "needs_review" : candidateClusters.length > 0 ? "healthy" : "empty",
    },
    {
      kind: "draft_backlog",
      title: "Draft backlog",
      summary: draftCandidates.length > 0
        ? "Protocol draft candidates are waiting for approve or reject."
        : "No protocol draft candidates are waiting.",
      itemCount: draftCandidates.length,
      status: draftCandidates.length > 0 ? "needs_review" : "empty",
    },
    {
      kind: "review_rules",
      title: "Review rules",
      summary: resolved.protocol.reviewRules.length > 0
        ? "Channel review rules are active."
        : "No channel-specific review rules are set.",
      itemCount: resolved.protocol.reviewRules.length,
      status: resolved.protocol.reviewRules.length > 0 ? "healthy" : "empty",
    },
    {
      kind: "privacy_rules",
      title: "Privacy rules",
      summary: resolved.protocol.privacyRules.length > 0
        ? "Channel privacy rules are active."
        : "No channel-specific privacy rules are set.",
      itemCount: resolved.protocol.privacyRules.length,
      status: resolved.protocol.privacyRules.length > 0 ? "healthy" : "empty",
    },
  ];
}

function protocolDraftInputFromCluster(
  cluster: ProcedureObservationCluster,
  channelId: string,
  input: ProtocolCandidateFromClusterInput,
):
  | {
    readonly proposedPatch: ChannelCollaborationProtocolPatch;
    readonly reason: string;
    readonly sourceRefs: readonly ChannelProtocolSourceRef[];
    readonly expiresAt?: string;
  }
  | { readonly statusCode: number; readonly error: Record<string, unknown> } {
  if (cluster.channelId !== channelId) {
    return {
      statusCode: 400,
      error: {
        error: "procedure_observation_cluster_channel_mismatch",
        message: `Procedure observation cluster ${cluster.id} does not belong to channel ${channelId}.`,
      },
    };
  }
  if (cluster.routeKind !== "channel_protocol") {
    return {
      statusCode: 400,
      error: {
        error: "unsupported_procedure_observation_cluster_route",
        message: `Only channel_protocol clusters can create channel protocol candidates. Cluster route is ${cluster.routeKind}.`,
      },
    };
  }
  if (cluster.status !== "ready_for_review" || cluster.routeBlockers.length > 0) {
    return {
      statusCode: 400,
      error: {
        error: "procedure_observation_cluster_not_ready",
        message: `Procedure observation cluster ${cluster.id} is ${cluster.status}.`,
        blockers: cluster.routeBlockers,
      },
    };
  }
  return {
    proposedPatch: input.proposedPatch ?? { reviewRules: [defaultReviewRuleFromCluster(cluster)] },
    reason: input.reason ?? `Created from procedure observation cluster ${cluster.id}: ${cluster.title}`,
    sourceRefs: protocolSourceRefsFromSkillRefs(cluster.sourceRefs),
    expiresAt: input.expiresAt,
  };
}

function defaultReviewRuleFromCluster(cluster: ProcedureObservationCluster): string {
  const triggerText = cluster.positiveTriggers.length > 0
    ? ` Trigger: ${cluster.positiveTriggers.slice(0, 3).join("; ")}.`
    : "";
  return `${cluster.title}: ${cluster.summary}${triggerText}`.trim();
}

function protocolSourceRefsFromSkillRefs(sourceRefs: readonly SkillCandidateSourceRef[]): readonly ChannelProtocolSourceRef[] {
  return sourceRefs.flatMap((sourceRef) => {
    const type = protocolSourceRefTypeFromSkillRef(sourceRef.type);
    return type ? [{ type, id: sourceRef.id, label: sourceRef.label }] : [];
  });
}

function protocolSourceRefTypeFromSkillRef(type: SkillCandidateSourceRef["type"]): ChannelProtocolSourceRef["type"] | undefined {
  if (type === "message" || type === "run") {
    return type;
  }
  if (type === "decision") {
    return "channel_decision";
  }
  return undefined;
}

function applyProtocolDraft(
  store: RunStore,
  channel: Channel,
  draftId: string,
  config: ResolvedDaemonConfig,
):
  | { readonly channel: Channel; readonly draft: ChannelCollaborationProtocolDraft }
  | { readonly statusCode: number; readonly error: Record<string, unknown> } {
  const draft = store.getChannelCollaborationProtocolDraft(draftId);
  if (!draft || draft.channelId !== channel.id) {
    return {
      statusCode: 404,
      error: { error: "protocol_draft_not_found", message: `Channel protocol draft not found: ${draftId}` },
    };
  }
  if (draft.status !== "draft") {
    return {
      statusCode: 409,
      error: { error: "protocol_draft_not_applyable", message: `Channel protocol draft is ${draft.status}.`, draft },
    };
  }

  const validationError = validateProtocolPatch(store, draft.proposedPatch, config);
  if (validationError) {
    return {
      statusCode: validationError.statusCode,
      error: {
        error: validationError.code,
        message: validationError.message,
      },
    };
  }

  const currentOverride = store.getChannelCollaborationProtocolOverride(channel.id);
  const currentVersion = currentOverride?.version ?? 0;
  if (draft.baseVersion !== undefined && draft.baseVersion !== currentVersion) {
    const stale = store.updateChannelCollaborationProtocolDraft(draft.id, { status: "stale" }, new Date().toISOString()) ?? draft;
    return {
      statusCode: 409,
      error: {
        error: "draft_base_version_mismatch",
        message: `Channel protocol draft base version ${draft.baseVersion} does not match current version ${currentVersion}.`,
        draft: stale,
        currentVersion,
      },
    };
  }

  let nextChannel = channel;
  const patch = draft.proposedPatch;
  if (hasChannelFieldPatch(patch)) {
    nextChannel = store.updateChannel(channel.id, {
      responseLanguage: patch.responseLanguage,
      autoReplyMode: patch.autoReplyMode,
      defaultTeammateId: patch.defaultTeammateId,
    }, new Date().toISOString()) ?? channel;
  }

  const overridePatch = protocolOverridePatch(patch);
  let appliedProtocolVersion = currentOverride?.version ?? 0;
  if (Object.keys(overridePatch).length > 0) {
    const override = store.upsertChannelCollaborationProtocolOverride({
      channelId: channel.id,
      ...overridePatch,
      sourceRefs: draft.sourceRefs,
      updatedBy: draft.createdBy,
    }, new Date().toISOString());
    appliedProtocolVersion = override.version;
  }
  const appliedDraft = store.updateChannelCollaborationProtocolDraft(
    draft.id,
    {
      status: "applied",
      appliedProtocolVersion,
    },
    new Date().toISOString(),
  ) ?? draft;
  return { channel: nextChannel, draft: appliedDraft };
}

function cancelProtocolDraftCandidate(
  store: RunStore,
  channel: Channel,
  draftId: string,
):
  | { readonly draft: ChannelCollaborationProtocolDraft }
  | { readonly statusCode: number; readonly error: Record<string, unknown> } {
  const draft = store.getChannelCollaborationProtocolDraft(draftId);
  if (!draft || draft.channelId !== channel.id) {
    return {
      statusCode: 404,
      error: { error: "protocol_candidate_not_found", message: `Channel protocol candidate not found: ${draftId}` },
    };
  }
  if (draft.status !== "draft") {
    return {
      statusCode: 409,
      error: { error: "protocol_candidate_not_reviewable", message: `Channel protocol candidate is ${draft.status}.`, draft },
    };
  }
  const cancelled = store.updateChannelCollaborationProtocolDraft(draft.id, { status: "cancelled" }, new Date().toISOString()) ?? draft;
  return { draft: cancelled };
}

function hasChannelFieldPatch(patch: ChannelCollaborationProtocolPatch): boolean {
  return patch.responseLanguage !== undefined || patch.autoReplyMode !== undefined || patch.defaultTeammateId !== undefined;
}

function protocolOverridePatch(patch: ChannelCollaborationProtocolPatch): Pick<
  ChannelCollaborationProtocolPatch,
  "defaultWorkflowPreference" | "visibleMultiReplyMaxParticipants" | "privacyRules" | "reviewRules"
> {
  const result: {
    defaultWorkflowPreference?: ChannelWorkflowPreference;
    visibleMultiReplyMaxParticipants?: number;
    privacyRules?: readonly string[];
    reviewRules?: readonly string[];
  } = {};
  if (patch.defaultWorkflowPreference !== undefined) {
    result.defaultWorkflowPreference = patch.defaultWorkflowPreference;
  }
  if (patch.visibleMultiReplyMaxParticipants !== undefined) {
    result.visibleMultiReplyMaxParticipants = patch.visibleMultiReplyMaxParticipants;
  }
  if (patch.privacyRules !== undefined) {
    result.privacyRules = patch.privacyRules;
  }
  if (patch.reviewRules !== undefined) {
    result.reviewRules = patch.reviewRules;
  }
  return result;
}

function readDraftStatusFilter(value: string | null): ChannelProtocolDraftStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (value !== "draft" && value !== "applied" && value !== "cancelled" && value !== "stale") {
    throw new Error("Unsupported channel protocol draft status filter");
  }
  return value;
}

function readLimit(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("limit must be a positive integer");
  }
  return parsed;
}

function resolveResponseLanguageField(
  channel: Channel,
  workspaceResponseLanguage: ResponseLanguagePreference | undefined,
): ChannelProtocolFieldResolution<ChannelResponseLanguage> {
  if (channel.responseLanguage && channel.responseLanguage !== "workspace") {
    return {
      value: channel.responseLanguage,
      source: "channel_setting",
      channelValue: channel.responseLanguage,
      workspaceValue: workspaceResponseLanguage,
    };
  }
  if (workspaceResponseLanguage) {
    return {
      value: workspaceResponseLanguage,
      source: "workspace_setting",
      channelValue: channel.responseLanguage ?? "workspace",
      workspaceValue: workspaceResponseLanguage,
    };
  }
  return {
    value: "follow_user",
    source: "default",
    channelValue: channel.responseLanguage ?? "workspace",
  };
}

function resolveAutoReplyModeField(channel: Channel): ChannelProtocolFieldResolution<ChannelAutoReplyMode> {
  if (channel.autoReplyMode !== "mentions_only") {
    return {
      value: channel.autoReplyMode,
      source: "channel_setting",
      channelValue: channel.autoReplyMode,
    };
  }
  return {
    value: "mentions_only",
    source: "default",
    channelValue: channel.autoReplyMode,
  };
}

function resolveDefaultTeammateField(channel: Channel): ChannelProtocolFieldResolution<string | undefined> {
  if (channel.defaultTeammateId) {
    return {
      value: channel.defaultTeammateId,
      source: "channel_setting",
      channelValue: channel.defaultTeammateId,
    };
  }
  return {
    value: undefined,
    source: "default",
  };
}

function parseProtocolPatchInput(value: unknown): ProtocolPatchInput {
  if (!isRecord(value)) {
    throw new Error("Channel protocol patch must be a JSON object");
  }
  const unknownFields = Object.keys(value).filter((key) =>
    !EDITABLE_PROTOCOL_FIELDS.includes(key as typeof EDITABLE_PROTOCOL_FIELDS[number]) &&
    !PROTOCOL_OVERRIDE_FIELDS.includes(key as typeof PROTOCOL_OVERRIDE_FIELDS[number])
  );
  if (unknownFields.length > 0) {
    throw new Error(`Unsupported channel protocol field: ${unknownFields.join(", ")}`);
  }
  const unsupportedField = PROTOCOL_OVERRIDE_FIELDS.find((field) => value[field] !== undefined);
  if (unsupportedField) {
    throw new UnsupportedProtocolFieldError(unsupportedField);
  }
  return {
    responseLanguage: readNullableProtocolResponseLanguage(value, "responseLanguage"),
    autoReplyMode: readNullableProtocolAutoReplyMode(value, "autoReplyMode"),
    defaultTeammateId: readNullableProtocolString(value, "defaultTeammateId"),
  };
}

function parseCreateProtocolDraftInput(value: unknown): {
  readonly baseVersion?: number;
  readonly proposedPatch: ChannelCollaborationProtocolPatch;
  readonly reason: string;
  readonly createdBy?: ChannelProtocolDraftCreatedBy;
  readonly sourceRefs?: readonly ChannelProtocolSourceRef[];
  readonly expiresAt?: string;
} {
  if (!isRecord(value)) {
    throw new Error("Channel protocol draft request must be a JSON object");
  }
  const proposedPatch = readProtocolDraftPatch(value.proposedPatch);
  const reason = typeof value.reason === "string" && value.reason.trim().length > 0
    ? value.reason.trim()
    : "AI drafted channel protocol changes for user review.";
  return {
    baseVersion: readOptionalVersion(value.baseVersion, "baseVersion"),
    proposedPatch,
    reason,
    createdBy: readOptionalDraftCreatedBy(value.createdBy),
    sourceRefs: readOptionalProtocolSourceRefs(value.sourceRefs),
    expiresAt: readOptionalString(value.expiresAt, "expiresAt"),
  };
}

function parseProtocolCandidateFromClusterInput(value: unknown): ProtocolCandidateFromClusterInput {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Channel protocol candidate cluster request must be a JSON object");
  }
  const unknownFields = Object.keys(value).filter((key) => key !== "proposedPatch" && key !== "reason" && key !== "expiresAt");
  if (unknownFields.length > 0) {
    throw new Error(`Unsupported channel protocol candidate cluster field: ${unknownFields.join(", ")}`);
  }
  return {
    proposedPatch: value.proposedPatch === undefined ? undefined : readProtocolDraftPatch(value.proposedPatch),
    reason: readOptionalString(value.reason, "reason"),
    expiresAt: readOptionalString(value.expiresAt, "expiresAt"),
  };
}

function readProtocolCandidateReviewAction(value: unknown): "approve" | "reject" {
  if (!isRecord(value)) {
    throw new Error("Channel protocol candidate review request must be a JSON object");
  }
  if (value.action === "approve" || value.action === "reject") {
    return value.action;
  }
  throw new Error("Channel protocol candidate review action must be approve or reject");
}

function readProtocolDraftPatch(value: unknown): ChannelCollaborationProtocolPatch {
  if (!isRecord(value)) {
    throw new Error("proposedPatch must be a JSON object");
  }
  const unknownFields = Object.keys(value).filter((key) => !ALL_PROTOCOL_FIELDS.includes(key as typeof ALL_PROTOCOL_FIELDS[number]));
  if (unknownFields.length > 0) {
    throw new Error(`Unsupported channel protocol draft field: ${unknownFields.join(", ")}`);
  }
  const patch: MutableProtocolPatch = {};
  const responseLanguage = readNullableProtocolResponseLanguage(value, "responseLanguage");
  const autoReplyMode = readNullableProtocolAutoReplyMode(value, "autoReplyMode");
  const defaultTeammateId = readNullableProtocolString(value, "defaultTeammateId");
  const defaultWorkflowPreference = readOptionalWorkflowPreference(value, "defaultWorkflowPreference");
  const visibleMultiReplyMaxParticipants = readOptionalVisibleMultiReplyMaxParticipants(value, "visibleMultiReplyMaxParticipants");
  const privacyRules = readOptionalStringList(value, "privacyRules");
  const reviewRules = readOptionalStringList(value, "reviewRules");
  if (responseLanguage !== undefined) {
    patch.responseLanguage = responseLanguage;
  }
  if (autoReplyMode !== undefined) {
    patch.autoReplyMode = autoReplyMode;
  }
  if (defaultTeammateId !== undefined) {
    patch.defaultTeammateId = defaultTeammateId;
  }
  if (defaultWorkflowPreference !== undefined) {
    patch.defaultWorkflowPreference = defaultWorkflowPreference;
  }
  if (visibleMultiReplyMaxParticipants !== undefined) {
    patch.visibleMultiReplyMaxParticipants = visibleMultiReplyMaxParticipants;
  }
  if (privacyRules !== undefined) {
    patch.privacyRules = privacyRules;
  }
  if (reviewRules !== undefined) {
    patch.reviewRules = reviewRules;
  }
  if (Object.values(patch).every((entry) => entry === undefined)) {
    throw new Error("proposedPatch must include at least one protocol field");
  }
  return patch;
}

function validateProtocolPatch(
  store: RunStore,
  patch: ChannelCollaborationProtocolPatch,
  config: ResolvedDaemonConfig,
): { readonly statusCode: number; readonly code: string; readonly message: string } | undefined {
  if (patch.autoReplyMode === "auto_route" && !config.channels.autoRoute) {
    return { statusCode: 400, code: "auto_route_disabled", message: "Channel auto_route is disabled." };
  }
  if (patch.defaultTeammateId) {
    const teammate = resolveAiTeammateReference(store, patch.defaultTeammateId);
    if (!teammate) {
      return { statusCode: 400, code: "default_teammate_not_found", message: `Default teammate not found: ${patch.defaultTeammateId}` };
    }
    if (teammate.status !== "active" || teammate.hidden) {
      return { statusCode: 400, code: "default_teammate_not_available", message: `Default teammate is not available: ${patch.defaultTeammateId}` };
    }
  }
  if (patch.defaultWorkflowPreference !== undefined && !channelWorkflowPreferences.includes(patch.defaultWorkflowPreference)) {
    return { statusCode: 400, code: "invalid_workflow_preference", message: "Channel workflow preference is invalid." };
  }
  if (
    patch.visibleMultiReplyMaxParticipants !== undefined &&
    (!Number.isInteger(patch.visibleMultiReplyMaxParticipants) || patch.visibleMultiReplyMaxParticipants < 1 || patch.visibleMultiReplyMaxParticipants > 8)
  ) {
    return { statusCode: 400, code: "invalid_visible_multi_reply_cap", message: "Visible multi-reply cap must be between 1 and 8." };
  }
  if (patch.privacyRules?.some((rule) => !rule.trim()) || patch.reviewRules?.some((rule) => !rule.trim())) {
    return { statusCode: 400, code: "invalid_protocol_rules", message: "Protocol rules cannot contain empty entries." };
  }
  return undefined;
}

function readNullableProtocolResponseLanguage(record: Record<string, unknown>, key: string): ChannelResponseLanguage | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !channelResponseLanguages.includes(value as ChannelResponseLanguage)) {
    throw new Error(`${key} must be one of: ${channelResponseLanguages.join(", ")}, or null`);
  }
  return value as ChannelResponseLanguage;
}

function readNullableProtocolAutoReplyMode(record: Record<string, unknown>, key: string): ChannelAutoReplyMode | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !channelAutoReplyModes.includes(value as ChannelAutoReplyMode)) {
    throw new Error(`${key} must be one of: ${channelAutoReplyModes.join(", ")}, or null`);
  }
  return value as ChannelAutoReplyMode;
}

function readNullableProtocolString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string or null`);
  }
  return value;
}

function readOptionalWorkflowPreference(record: Record<string, unknown>, key: string): ChannelWorkflowPreference | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !channelWorkflowPreferences.includes(value as ChannelWorkflowPreference)) {
    throw new Error(`${key} must be one of: ${channelWorkflowPreferences.join(", ")}`);
  }
  return value as ChannelWorkflowPreference;
}

function readOptionalVisibleMultiReplyMaxParticipants(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error(`${key} must be an integer between 1 and 8`);
  }
  return value;
}

function readOptionalStringList(record: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string array`);
  }
  return value;
}

function readOptionalVersion(value: unknown, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function readOptionalDraftCreatedBy(value: unknown): ChannelProtocolDraftCreatedBy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "local-user" && value !== "ai-draft") {
    throw new Error("createdBy must be local-user or ai-draft");
  }
  return value;
}

function readOptionalProtocolSourceRefs(value: unknown): readonly ChannelProtocolSourceRef[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("sourceRefs must be an array");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("sourceRefs entries must be JSON objects");
    }
    if (
      item.type !== "message" &&
      item.type !== "channel_decision" &&
      item.type !== "context_summary" &&
      item.type !== "task" &&
      item.type !== "run" &&
      item.type !== "workflow" &&
      item.type !== "workflow_step"
    ) {
      throw new Error("sourceRefs entries must use a supported type");
    }
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      throw new Error("sourceRefs entries must include a non-empty id");
    }
    return {
      type: item.type,
      id: item.id,
      label: typeof item.label === "string" && item.label.trim() ? item.label : undefined,
    };
  });
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

class UnsupportedProtocolFieldError extends Error {
  constructor(readonly field: string) {
    super(`Protocol field is not editable through direct PATCH: ${field}`);
    this.name = "UnsupportedProtocolFieldError";
  }
}
