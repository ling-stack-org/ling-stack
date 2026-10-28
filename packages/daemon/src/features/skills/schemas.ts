import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import {
  providerCapabilities,
  readOnlyRunTools,
  type CandidateGenerationDecisionAction,
  type ApplySkillCandidateReviewActionInput,
  type CreateSkillCandidateInput,
  type CreateProcedureObservationInput,
  type ProcedureObservationJobInput,
  type ProcedureObservationJobTerminalStatus,
  type CandidateRouteKind,
  type CreateSkillImportDraftInput,
  type CreateSkillUsageEventInput,
  type ListProcedureObservationsOptions,
  type ListProcedureObservationClustersOptions,
  type ListSkillUsageEventsOptions,
  type RunTool,
  type SkillRecordingObservationInput,
  type SkillCandidateOrigin,
  type SkillCandidateProposedAction,
  type SkillCandidateReviewAction,
  type SkillCandidateSourceRef,
  type SkillCandidateStatus,
  type SkillDefinition,
  type SkillDuplicateAnalysis,
  type SkillHealthFinding,
  type SkillImportWarning,
  type SkillImportPreview,
  type SkillOptimizationMode,
  type SkillPackSource,
  type SkillRegistryEntry,
  type SkillSourceKind,
  type SkillSourceScanRoot,
  type SkillSourceUpgradeMode,
  type SkillUsageEventKind,
} from "@ling-stack/core";
import { parseApprovalProfileObject } from "../../shared/approval-profile.js";
import { extractMarkdownTitle, firstMarkdownParagraph, parseMarkdownFrontmatter } from "../../shared/markdown.js";
import { isRecord, readOptionalBoolean, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";

export type ParsedCreateSkillCandidateRequest = Omit<CreateSkillCandidateInput, "duplicateAnalysis"> & {
  readonly duplicateAnalysis?: SkillDuplicateAnalysis;
};

export interface ParsedSkillInvocationSuggestionRequest {
  readonly teammateId: string;
  readonly channelId?: string;
  readonly providerPresetId?: string;
  readonly taskId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly requestedSkillId?: string;
  readonly limit?: number;
}

export interface ParsedSkillSourceSyncRequest {
  readonly roots?: readonly SkillSourceScanRoot[];
  readonly skillRoots?: readonly string[];
  readonly gstackRepoRoots?: readonly string[];
  readonly codexSkillRoots?: readonly string[];
  readonly includeDetectedRoots?: boolean;
  readonly includeSkillIds?: readonly string[];
  readonly excludeSkillIds?: readonly string[];
  readonly maxSourceBytes?: number;
}

export interface ParsedSkillSourceSyncPublishRequest extends ParsedSkillSourceSyncRequest {
  readonly selectedSkillIds: readonly string[];
  readonly allowNewSkills: boolean;
  readonly publishArtifacts: boolean;
}

export interface ParsedSkillSourceUpgradePolicyUpdateRequest {
  readonly mode?: SkillSourceUpgradeMode;
  readonly approvedRootIds?: readonly string[];
  readonly allowNewSkills?: boolean;
}

export interface ParsedSkillImportDraftOptimizationPreviewRequest {
  readonly draftInput: CreateSkillImportDraftInput;
  readonly content: string;
  readonly mode?: SkillOptimizationMode;
}

export interface ParsedSkillSourceSnapshotRollbackRequest {
  readonly snapshotId: string;
}

export interface ParsedSkillOptimizationPreviewRequest {
  readonly mode?: SkillOptimizationMode;
}

export interface ParsedSkillCandidateDraftRequest {
  readonly content?: string;
}

export function parseCreateSkillCandidateRequest(value: unknown): ParsedCreateSkillCandidateRequest {
  if (!isRecord(value)) {
    throw new Error("Skill candidate request must be a JSON object");
  }
  const definition = readSkillCandidateDraftDefinition(value.definition);
  return {
    id: readOptionalString(value, "id"),
    origin: readOptionalSkillCandidateOrigin(value, "origin") ?? "manual-draft",
    targetSkillId: readOptionalString(value, "targetSkillId"),
    proposedAction: readOptionalSkillCandidateProposedAction(value, "proposedAction") ?? "create",
    status: readOptionalSkillCandidateStatus(value, "status"),
    title: readString(value, "title"),
    summary: readString(value, "summary"),
    definition,
    duplicateAnalysis: readOptionalSkillDuplicateAnalysis(value, "duplicateAnalysis"),
    safetyFindings: readOptionalSkillHealthFindings(value, "safetyFindings"),
    sourceRefs: readSkillCandidateSourceRefs(value.sourceRefs),
    reviewNotes: readOptionalStringArray(value, "reviewNotes"),
    expiresAt: readOptionalString(value, "expiresAt"),
    supersededBy: readOptionalString(value, "supersededBy"),
  };
}

export function parseSkillCandidateReviewRequest(value: unknown): Omit<ApplySkillCandidateReviewActionInput, "candidateId" | "actor"> {
  if (!isRecord(value)) {
    throw new Error("Skill candidate review request must be a JSON object");
  }
  return {
    action: readSkillCandidateReviewAction(value, "action"),
    reason: readOptionalString(value, "reason"),
    supersededBy: readOptionalString(value, "supersededBy"),
  };
}

export function parseSkillCandidateDraftRequest(value: unknown): ParsedSkillCandidateDraftRequest {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Skill candidate draft request must be a JSON object");
  }
  return { content: readOptionalString(value, "content") };
}

export function parseProcedureObservationRequest(value: unknown): CreateProcedureObservationInput {
  if (!isRecord(value)) {
    throw new Error("Procedure observation request must be a JSON object");
  }
  return {
    id: readOptionalString(value, "id"),
    clusterId: readOptionalString(value, "clusterId"),
    channelId: readOptionalString(value, "channelId"),
    teammateId: readOptionalString(value, "teammateId"),
    taskId: readOptionalString(value, "taskId"),
    runId: readOptionalString(value, "runId"),
    source: readProcedureObservationSource(value, "source"),
    signals: readProcedureObservationSignals(value.signals),
    title: readString(value, "title"),
    summary: readString(value, "summary"),
    normalizedGoal: readString(value, "normalizedGoal"),
    positiveTriggers: readOptionalStringArray(value, "positiveTriggers"),
    negativeTriggers: readOptionalStringArray(value, "negativeTriggers"),
    procedureSteps: readProcedureObservationSteps(value.procedureSteps),
    validationSteps: readProcedureObservationValidationSteps(value.validationSteps),
    sourceRefs: readSkillCandidateSourceRefs(value.sourceRefs),
    confidence: readOptionalProcedureObservationConfidence(value, "confidence"),
    reusableScore: readOptionalNumber(value, "reusableScore"),
  };
}

export function parseProcedureObservationJobRequest(value: unknown): ProcedureObservationJobInput {
  if (!isRecord(value)) {
    throw new Error("Procedure observation job request must be a JSON object");
  }
  return {
    id: readOptionalString(value, "id"),
    workspaceId: readOptionalString(value, "workspaceId"),
    source: readProcedureObservationSource(value, "source"),
    signals: readProcedureObservationSignals(value.signals),
    runId: readOptionalString(value, "runId"),
    effectiveAttemptId: readOptionalString(value, "effectiveAttemptId"),
    evidenceVersion: readOptionalString(value, "evidenceVersion"),
    messageId: readOptionalString(value, "messageId"),
    reviewActionId: readOptionalString(value, "reviewActionId"),
    channelId: readOptionalString(value, "channelId"),
    teammateId: readOptionalString(value, "teammateId"),
    taskId: readOptionalString(value, "taskId"),
    selectedSkillId: readOptionalString(value, "selectedSkillId"),
    terminalStatus: readOptionalProcedureObservationJobTerminalStatus(value, "terminalStatus"),
    toolLabels: readOptionalStringArray(value, "toolLabels"),
    validationLabels: readOptionalStringArray(value, "validationLabels"),
    artifactRefs: readOptionalStringArray(value, "artifactRefs"),
    userConfirmed: readBoolean(value, "userConfirmed"),
    destinationHint: readOptionalDestinationHint(value, "destinationHint"),
    title: readString(value, "title"),
    summary: readString(value, "summary"),
    normalizedGoal: readString(value, "normalizedGoal"),
    positiveTriggers: readOptionalStringArray(value, "positiveTriggers"),
    negativeTriggers: readOptionalStringArray(value, "negativeTriggers"),
    procedureSteps: readProcedureObservationSteps(value.procedureSteps),
    validationSteps: readProcedureObservationValidationSteps(value.validationSteps),
    confidence: readOptionalProcedureObservationConfidence(value, "confidence"),
    reusableScore: readOptionalNumber(value, "reusableScore"),
  };
}

export function parseSkillRecordingObservationRequest(value: unknown): SkillRecordingObservationInput {
  if (!isRecord(value)) {
    throw new Error("Skill recording observation request must be a JSON object");
  }
  return {
    id: readOptionalString(value, "id"),
    workspaceId: readOptionalString(value, "workspaceId"),
    runId: readOptionalString(value, "runId"),
    messageId: readOptionalString(value, "messageId"),
    reviewActionId: readOptionalString(value, "reviewActionId"),
    channelId: readOptionalString(value, "channelId"),
    teammateId: readOptionalString(value, "teammateId"),
    taskId: readOptionalString(value, "taskId"),
    selectedSkillId: readOptionalString(value, "selectedSkillId"),
    terminalStatus: readOptionalProcedureObservationJobTerminalStatus(value, "terminalStatus"),
    toolLabels: readOptionalStringArray(value, "toolLabels"),
    validationLabels: readOptionalStringArray(value, "validationLabels"),
    artifactRefs: readOptionalStringArray(value, "artifactRefs"),
    destinationHint: readOptionalDestinationHint(value, "destinationHint"),
    title: readString(value, "title"),
    summary: readString(value, "summary"),
    normalizedGoal: readString(value, "normalizedGoal"),
    positiveTriggers: readOptionalStringArray(value, "positiveTriggers"),
    negativeTriggers: readOptionalStringArray(value, "negativeTriggers"),
    procedureSteps: readProcedureObservationSteps(value.procedureSteps),
    validationSteps: readProcedureObservationValidationSteps(value.validationSteps),
    confidence: readOptionalProcedureObservationConfidence(value, "confidence"),
    reusableScore: readOptionalNumber(value, "reusableScore"),
  };
}

export function readOptionalSkillCandidateStatusQuery(url: URL, key: string): SkillCandidateStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }
  if (!skillCandidateStatuses.includes(value as SkillCandidateStatus)) {
    throw new Error(`${key} must be one of: ${skillCandidateStatuses.join(", ")}`);
  }
  return value as SkillCandidateStatus;
}

export function readOptionalSkillCandidateOriginQuery(url: URL, key: string): SkillCandidateOrigin | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }
  if (!skillCandidateOrigins.includes(value as SkillCandidateOrigin)) {
    throw new Error(`${key} must be one of: ${skillCandidateOrigins.join(", ")}`);
  }
  return value as SkillCandidateOrigin;
}

export function readOptionalCandidateRouteKindQuery(url: URL, key: string): ListProcedureObservationsOptions["routeKind"] {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }
  if (!candidateRouteKinds.includes(value as CandidateRouteKind)) {
    throw new Error(`${key} must be one of: ${candidateRouteKinds.join(", ")}`);
  }
  return value as CandidateRouteKind;
}

export function readOptionalProcedureObservationClusterStatusQuery(
  url: URL,
  key: string,
): ListProcedureObservationClustersOptions["status"] {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }
  if (!procedureObservationClusterStatuses.includes(value as NonNullable<ListProcedureObservationClustersOptions["status"]>)) {
    throw new Error(`${key} must be one of: ${procedureObservationClusterStatuses.join(", ")}`);
  }
  return value as NonNullable<ListProcedureObservationClustersOptions["status"]>;
}

export function readOptionalCandidateGenerationDecisionActionQuery(
  url: URL,
  key: string,
): CandidateGenerationDecisionAction | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }
  if (!candidateGenerationDecisionActions.includes(value as CandidateGenerationDecisionAction)) {
    throw new Error(`${key} must be one of: ${candidateGenerationDecisionActions.join(", ")}`);
  }
  return value as CandidateGenerationDecisionAction;
}

export function readOptionalSkillUsageEventKindQuery(url: URL, key: string): ListSkillUsageEventsOptions["kind"] {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }
  if (!skillUsageEventKinds.includes(value as SkillUsageEventKind)) {
    throw new Error(`${key} must be one of: ${skillUsageEventKinds.join(", ")}`);
  }
  return value as SkillUsageEventKind;
}

export function parseSkillInvocationSuggestionRequest(value: unknown): ParsedSkillInvocationSuggestionRequest {
  if (!isRecord(value)) {
    throw new Error("Skill invocation suggestion request must be a JSON object");
  }
  return {
    teammateId: readString(value, "teammateId"),
    channelId: readOptionalString(value, "channelId"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    taskId: readOptionalString(value, "taskId"),
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    requestedSkillId: readOptionalString(value, "requestedSkillId"),
    limit: readOptionalNumber(value, "limit"),
  };
}

export function parseSkillCorrectionRequest(value: unknown): Omit<CreateSkillUsageEventInput, "skillId" | "kind"> {
  if (!isRecord(value)) {
    throw new Error("Skill correction request must be a JSON object");
  }
  return {
    candidateId: readOptionalString(value, "candidateId"),
    runId: readOptionalString(value, "runId"),
    teammateId: readOptionalString(value, "teammateId"),
    channelId: readOptionalString(value, "channelId"),
    reason: readOptionalString(value, "reason"),
  };
}

function readSkillCandidateDraftDefinition(value: unknown): CreateSkillCandidateInput["definition"] {
  if (!isRecord(value)) {
    throw new Error("definition must be an object");
  }
  return {
    positiveTriggers: readRequiredStringArray(value, "positiveTriggers"),
    negativeTriggers: readOptionalStringArray(value, "negativeTriggers") ?? [],
    procedureSteps: readSkillCandidateProcedureSteps(value.procedureSteps),
    validationSteps: readSkillCandidateValidationSteps(value.validationSteps),
    requiredTools: readOptionalStringArray(value, "requiredTools") ?? [],
    requiredProviderCapabilities: readOptionalStringArray(value, "requiredProviderCapabilities") ?? [],
    ...(isRecord(value.skillDefinition) ? { skillDefinition: withoutLegacySkillWorkflowPhase(value.skillDefinition) } : {}),
  };
}

function readSkillCandidateProcedureSteps(value: unknown): CreateSkillCandidateInput["definition"]["procedureSteps"] {
  if (!Array.isArray(value)) {
    throw new Error("definition.procedureSteps must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`definition.procedureSteps[${index}] must be an object`);
    }
    return {
      title: readString(item, "title"),
      instruction: readOptionalString(item, "instruction"),
      requiredTools: readOptionalStringArray(item, "requiredTools"),
    };
  });
}

function readSkillCandidateValidationSteps(value: unknown): CreateSkillCandidateInput["definition"]["validationSteps"] {
  if (!Array.isArray(value)) {
    throw new Error("definition.validationSteps must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`definition.validationSteps[${index}] must be an object`);
    }
    return {
      title: readString(item, "title"),
      commandOrCheck: readOptionalString(item, "commandOrCheck"),
      expectedResult: readOptionalString(item, "expectedResult"),
    };
  });
}

function readProcedureObservationSteps(value: unknown): CreateProcedureObservationInput["procedureSteps"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("procedureSteps must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`procedureSteps[${index}] must be an object`);
    }
    return {
      title: readString(item, "title"),
      instruction: readOptionalString(item, "instruction"),
      requiredTools: readOptionalStringArray(item, "requiredTools"),
      expectedEvidence: readOptionalString(item, "expectedEvidence"),
    };
  });
}

function readProcedureObservationValidationSteps(value: unknown): CreateProcedureObservationInput["validationSteps"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("validationSteps must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`validationSteps[${index}] must be an object`);
    }
    return {
      title: readString(item, "title"),
      commandOrCheck: readOptionalString(item, "commandOrCheck"),
      expectedResult: readOptionalString(item, "expectedResult"),
    };
  });
}

function readProcedureObservationSignals(value: unknown): CreateProcedureObservationInput["signals"] {
  if (!Array.isArray(value)) {
    throw new Error("signals must be an array");
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !procedureObservationSignals.includes(item as CreateProcedureObservationInput["signals"][number])) {
      throw new Error(`signals[${index}] must be one of: ${procedureObservationSignals.join(", ")}`);
    }
    return item as CreateProcedureObservationInput["signals"][number];
  });
}

function readSkillCandidateSourceRefs(value: unknown): readonly SkillCandidateSourceRef[] {
  if (!Array.isArray(value)) {
    throw new Error("sourceRefs must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`sourceRefs[${index}] must be an object`);
    }
    return {
      type: readSkillCandidateSourceRefType(item, "type"),
      id: readString(item, "id"),
      label: readOptionalString(item, "label"),
      url: readOptionalString(item, "url"),
    };
  });
}

function readOptionalSkillDuplicateAnalysis(record: Record<string, unknown>, key: string): SkillDuplicateAnalysis | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return {
    decision: readSkillDuplicateDecision(value, "decision"),
    similarityScore: readNumber(value, "similarityScore"),
    matchedSkillIds: readRequiredStringArray(value, "matchedSkillIds"),
    matchedCandidateIds: readRequiredStringArray(value, "matchedCandidateIds"),
    triggerOverlap: readRequiredStringArray(value, "triggerOverlap"),
    conflictingFields: readRequiredStringArray(value, "conflictingFields"),
    rationale: readString(value, "rationale"),
  };
}

function readOptionalSkillHealthFindings(record: Record<string, unknown>, key: string): readonly SkillHealthFinding[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    return {
      id: readString(item, "id"),
      kind: readSkillHealthFindingKind(item, "kind"),
      severity: readSkillHealthSeverity(item, "severity"),
      skillIds: readRequiredStringArray(item, "skillIds"),
      candidateIds: readRequiredStringArray(item, "candidateIds"),
      title: readString(item, "title"),
      message: readString(item, "message"),
      recommendation: readString(item, "recommendation"),
      recommendedAction: readSkillHealthRecommendedAction(item, "recommendedAction"),
    };
  });
}

function readOptionalSkillCandidateOrigin(record: Record<string, unknown>, key: string): SkillCandidateOrigin | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!skillCandidateOrigins.includes(value as SkillCandidateOrigin)) {
    throw new Error(`${key} must be one of: ${skillCandidateOrigins.join(", ")}`);
  }
  return value as SkillCandidateOrigin;
}

function readOptionalSkillCandidateStatus(record: Record<string, unknown>, key: string): SkillCandidateStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!skillCandidateStatuses.includes(value as SkillCandidateStatus)) {
    throw new Error(`${key} must be one of: ${skillCandidateStatuses.join(", ")}`);
  }
  return value as SkillCandidateStatus;
}

function readOptionalSkillCandidateProposedAction(record: Record<string, unknown>, key: string): SkillCandidateProposedAction | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!skillCandidateProposedActions.includes(value as SkillCandidateProposedAction)) {
    throw new Error(`${key} must be one of: ${skillCandidateProposedActions.join(", ")}`);
  }
  return value as SkillCandidateProposedAction;
}

function readSkillCandidateReviewAction(record: Record<string, unknown>, key: string): SkillCandidateReviewAction {
  const value = readString(record, key);
  if (!skillCandidateReviewActions.includes(value as SkillCandidateReviewAction)) {
    throw new Error(`${key} must be one of: ${skillCandidateReviewActions.join(", ")}`);
  }
  return value as SkillCandidateReviewAction;
}

function readSkillCandidateSourceRefType(record: Record<string, unknown>, key: string): SkillCandidateSourceRef["type"] {
  const value = readString(record, key);
  if (!skillCandidateSourceRefTypes.includes(value as SkillCandidateSourceRef["type"])) {
    throw new Error(`${key} must be one of: ${skillCandidateSourceRefTypes.join(", ")}`);
  }
  return value as SkillCandidateSourceRef["type"];
}

function readProcedureObservationSource(record: Record<string, unknown>, key: string): CreateProcedureObservationInput["source"] {
  const value = readString(record, key);
  if (!procedureObservationSources.includes(value as CreateProcedureObservationInput["source"])) {
    throw new Error(`${key} must be one of: ${procedureObservationSources.join(", ")}`);
  }
  return value as CreateProcedureObservationInput["source"];
}

function readOptionalProcedureObservationConfidence(record: Record<string, unknown>, key: string): CreateProcedureObservationInput["confidence"] {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!procedureObservationConfidences.includes(value as NonNullable<CreateProcedureObservationInput["confidence"]>)) {
    throw new Error(`${key} must be one of: ${procedureObservationConfidences.join(", ")}`);
  }
  return value as NonNullable<CreateProcedureObservationInput["confidence"]>;
}

function readSkillDuplicateDecision(record: Record<string, unknown>, key: string): SkillDuplicateAnalysis["decision"] {
  const value = readString(record, key);
  if (!skillDuplicateDecisions.includes(value as SkillDuplicateAnalysis["decision"])) {
    throw new Error(`${key} must be one of: ${skillDuplicateDecisions.join(", ")}`);
  }
  return value as SkillDuplicateAnalysis["decision"];
}

function readSkillHealthFindingKind(record: Record<string, unknown>, key: string): SkillHealthFinding["kind"] {
  const value = readString(record, key);
  if (!skillHealthFindingKinds.includes(value as SkillHealthFinding["kind"])) {
    throw new Error(`${key} must be one of: ${skillHealthFindingKinds.join(", ")}`);
  }
  return value as SkillHealthFinding["kind"];
}

function readSkillHealthSeverity(record: Record<string, unknown>, key: string): SkillHealthFinding["severity"] {
  const value = readString(record, key);
  if (!skillHealthSeverities.includes(value as SkillHealthFinding["severity"])) {
    throw new Error(`${key} must be one of: ${skillHealthSeverities.join(", ")}`);
  }
  return value as SkillHealthFinding["severity"];
}

function readSkillHealthRecommendedAction(record: Record<string, unknown>, key: string): SkillHealthFinding["recommendedAction"] {
  const value = readString(record, key);
  if (!skillHealthRecommendedActions.includes(value as SkillHealthFinding["recommendedAction"])) {
    throw new Error(`${key} must be one of: ${skillHealthRecommendedActions.join(", ")}`);
  }
  return value as SkillHealthFinding["recommendedAction"];
}

function readRequiredStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  return readOptionalStringArray(record, key) ?? (() => {
    throw new Error(`${key} must be an array`);
  })();
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function readOptionalProcedureObservationJobTerminalStatus(
  record: Record<string, unknown>,
  key: string,
): ProcedureObservationJobInput["terminalStatus"] {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!procedureObservationJobTerminalStatuses.includes(value as ProcedureObservationJobTerminalStatus)) {
    throw new Error(`${key} must be one of: ${procedureObservationJobTerminalStatuses.join(", ")}`);
  }
  return value as ProcedureObservationJobTerminalStatus;
}

function readOptionalDestinationHint(
  record: Record<string, unknown>,
  key: string,
): ProcedureObservationJobInput["destinationHint"] {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!procedureObservationDestinationHints.includes(value as NonNullable<ProcedureObservationJobInput["destinationHint"]>)) {
    throw new Error(`${key} must be one of: ${procedureObservationDestinationHints.join(", ")}`);
  }
  return value as NonNullable<ProcedureObservationJobInput["destinationHint"]>;
}

const skillCandidateOrigins = ["ling-generated", "recording", "manual-draft", "import-overlay"] as const;
const skillCandidateStatuses = ["pending", "needs_edit", "approved_for_draft", "published", "rejected", "quarantined", "superseded", "expired"] as const;
const skillCandidateProposedActions = ["create", "update_existing", "wrap_external", "supersede"] as const;
const skillCandidateReviewActions = ["keep_pending", "request_changes", "approve_for_draft", "reject", "quarantine", "supersede"] as const;
const skillCandidateSourceRefTypes = ["skill", "manual", "message", "decision", "run", "run-event", "artifact", "import", "observation-job"] as const;
const procedureObservationSources = ["explicit_user_request", "user_correction", "successful_tool_chain", "repeated_pattern", "workflow_step_output", "multi_agent_handoff", "manual_recording"] as const;
const procedureObservationSignals = ["save_as_skill", "next_time_instruction", "correction_phrase", "long_successful_sequence", "same_sequence_repeated", "handoff_stabilized", "user_approved_recording"] as const;
const procedureObservationConfidences = ["low", "medium", "high"] as const;
const procedureObservationJobTerminalStatuses = ["succeeded", "failed", "cancelled"] as const;
const procedureObservationDestinationHints = ["skill", "channel_protocol", "playbook", "automation", "memory"] as const;
const candidateRouteKinds = ["memory", "channel_protocol", "playbook", "automation", "skill", "approval_policy_review", "reject"] as const;
const procedureObservationClusterStatuses = ["collecting", "ready_for_review", "blocked", "routed_elsewhere"] as const;
const candidateGenerationDecisionActions = [
  "append_evidence",
  "create_skill_candidate",
  "create_channel_protocol_candidate",
  "create_playbook_candidate",
  "create_memory_candidate",
  "create_automation_candidate",
  "policy_review",
  "reject",
] as const;
const skillDuplicateDecisions = ["no_overlap", "append_evidence", "update_existing", "conflict_review", "reject_duplicate"] as const;
const skillHealthFindingKinds = [
  "duplicate_clusters",
  "conflicting_triggers",
  "shadowed_skill",
  "never_used_skill",
  "stale_candidate",
  "high_failure_rate_skill",
  "high_user_correction_skill",
  "external_overlap_generated_skill",
  "superseded_but_active",
  "missing_validation_steps",
  "missing_negative_triggers",
] as const;
const skillHealthSeverities = ["info", "warning", "critical"] as const;
const skillHealthRecommendedActions = [
  "review",
  "merge",
  "supersede",
  "disable",
  "archive",
  "add_validation",
  "add_negative_triggers",
  "reject_candidate",
] as const;
const skillUsageEventKinds = ["selected", "started", "succeeded", "failed", "cancelled", "user_corrected", "draft_created", "published", "superseded"] as const;
const skillOptimizationModes = ["no_operation", "report_only", "preview_on_demand", "auto_safe", "auto_runtime_experimental"] as const;

export function parseSkillImportDraftRequest(
  value: unknown,
  existingSkills: readonly SkillRegistryEntry[],
): CreateSkillImportDraftInput {
  if (!isRecord(value)) {
    throw new Error("Skill import draft request must be a JSON object");
  }
  const content = readString(value, "content");
  const sourcePath = readOptionalString(value, "sourcePath");
  const source = readOptionalSkillPackSource(value, "source") ?? inferSkillImportSource(sourcePath, content);
  const requestedName = readOptionalString(value, "name");
  const knownSkillIds = new Set(existingSkills.map((skill) => skill.id));
  const parsed = parseSkillImportContent(content, sourcePath, requestedName);
  const seenDraftSkillIds = new Set<string>();
  const definitions = parsed.definitions.map((item) => {
    const warnings = [...(item.warnings ?? [])];
    if (knownSkillIds.has(item.definition.id) || seenDraftSkillIds.has(item.definition.id)) {
      warnings.push({
        code: "duplicate_skill_id",
        severity: "error",
        message: `Skill id already exists or appears more than once: ${item.definition.id}`,
      });
    }
    seenDraftSkillIds.add(item.definition.id);
    return { ...item, warnings };
  });
  const warnings: SkillImportWarning[] = [
    ...parsed.warnings,
    ...(definitions.length === 0 ? [{
      code: "missing_metadata" as const,
      severity: "error" as const,
      message: "No skill definitions could be parsed from the import source.",
    }] : []),
  ];
  return {
    source,
    sourcePath,
    packId: parsed.packId,
    name: requestedName ?? parsed.name,
    version: parsed.version,
    description: parsed.description,
    definitions,
    warnings,
  };
}

export function buildSkillImportPreview(input: CreateSkillImportDraftInput): SkillImportPreview {
  return {
    source: input.source,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.packId ? { packId: input.packId } : {}),
    name: input.name,
    ...(input.version ? { version: input.version } : {}),
    description: input.description,
    definitions: input.definitions,
    warnings: input.warnings ?? [],
  };
}

export function parseSkillImportDraftOptimizationPreviewRequest(
  value: unknown,
  existingSkills: readonly SkillRegistryEntry[],
): ParsedSkillImportDraftOptimizationPreviewRequest {
  if (!isRecord(value)) {
    throw new Error("Skill import draft optimization preview request must be a JSON object");
  }
  const content = readString(value, "content");
  const mode = readOptionalString(value, "mode");
  if (mode !== undefined && !skillOptimizationModes.includes(mode as SkillOptimizationMode)) {
    throw new Error(`mode must be one of: ${skillOptimizationModes.join(", ")}`);
  }
  return {
    draftInput: parseSkillImportDraftRequest(value, existingSkills),
    content,
    mode: mode as SkillOptimizationMode | undefined,
  };
}

export function parseSkillSourceSyncRequest(value: unknown): ParsedSkillSourceSyncRequest {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Skill source sync request must be a JSON object");
  }
  const maxSourceBytes = readOptionalNumber(value, "maxSourceBytes");
  if (maxSourceBytes !== undefined && (!Number.isInteger(maxSourceBytes) || maxSourceBytes < 1)) {
    throw new Error("maxSourceBytes must be a positive integer");
  }
  return {
    roots: readOptionalSkillSourceScanRoots(value.roots),
    skillRoots: readOptionalStringArray(value, "skillRoots"),
    gstackRepoRoots: readOptionalStringArray(value, "gstackRepoRoots"),
    codexSkillRoots: readOptionalStringArray(value, "codexSkillRoots"),
    includeDetectedRoots: readOptionalBoolean(value, "includeDetectedRoots"),
    includeSkillIds: readOptionalStringArray(value, "includeSkillIds"),
    excludeSkillIds: readOptionalStringArray(value, "excludeSkillIds"),
    maxSourceBytes,
  };
}

export function parseSkillSourceSyncPublishRequest(value: unknown): ParsedSkillSourceSyncPublishRequest {
  if (!isRecord(value)) {
    throw new Error("Skill source sync publish request must be a JSON object");
  }
  const selectedSkillIds = readRequiredStringArray(value, "selectedSkillIds");
  if (selectedSkillIds.length === 0) {
    throw new Error("selectedSkillIds must include at least one skill id");
  }
  return {
    ...parseSkillSourceSyncRequest(value),
    selectedSkillIds,
    allowNewSkills: readOptionalBoolean(value, "allowNewSkills") ?? false,
    publishArtifacts: readOptionalBoolean(value, "publishArtifacts") ?? true,
  };
}

export function parseSkillSourceUpgradePolicyUpdateRequest(value: unknown): ParsedSkillSourceUpgradePolicyUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Skill source upgrade policy request must be a JSON object");
  }
  const mode = readOptionalString(value, "mode");
  if (mode !== undefined && !["manual", "prompt", "auto-safe"].includes(mode)) {
    throw new Error("mode must be manual, prompt, or auto-safe");
  }
  return {
    mode: mode as SkillSourceUpgradeMode | undefined,
    approvedRootIds: readOptionalStringArray(value, "approvedRootIds"),
    allowNewSkills: readOptionalBoolean(value, "allowNewSkills"),
  };
}

export function parseSkillSourceSnapshotRollbackRequest(value: unknown): ParsedSkillSourceSnapshotRollbackRequest {
  if (!isRecord(value)) {
    throw new Error("Skill source rollback request must be a JSON object");
  }
  const snapshotId = readString(value, "snapshotId").trim();
  if (!snapshotId) {
    throw new Error("snapshotId is required");
  }
  return { snapshotId };
}

export function parseSkillOptimizationPreviewRequest(value: unknown): ParsedSkillOptimizationPreviewRequest {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Skill optimization preview request must be a JSON object");
  }
  const mode = readOptionalString(value, "mode");
  if (mode !== undefined && !skillOptimizationModes.includes(mode as SkillOptimizationMode)) {
    throw new Error(`mode must be one of: ${skillOptimizationModes.join(", ")}`);
  }
  return {
    mode: mode as SkillOptimizationMode | undefined,
  };
}

function parseSkillImportContent(
  content: string,
  sourcePath: string | undefined,
  requestedName: string | undefined,
): Pick<CreateSkillImportDraftInput, "packId" | "name" | "version" | "description" | "definitions"> & { readonly warnings: SkillImportWarning[] } {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      name: requestedName ?? "Imported skills",
      description: "",
      definitions: [],
      warnings: [{ code: "missing_metadata", severity: "error", message: "Import content is empty." }],
    };
  }
  if (trimmed.startsWith("{")) {
    return parseJsonSkillImport(trimmed, requestedName);
  }
  return parseMarkdownSkillImport(trimmed, sourcePath, requestedName);
}

function parseJsonSkillImport(content: string, requestedName: string | undefined): ReturnType<typeof parseSkillImportContent> {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Skill import JSON must be an object");
  }
  const rawSkills = Array.isArray(parsed.skills) ? parsed.skills : [parsed];
  const definitions = rawSkills
    .filter(isRecord)
    .map((raw, index) => normalizeJsonSkillDefinition(raw, `skills[${index}]`));
  const name = requestedName ?? readOptionalString(parsed, "name") ?? "Imported skill pack";
  return {
    packId: readOptionalString(parsed, "id"),
    name,
    version: readOptionalString(parsed, "version"),
    description: readOptionalString(parsed, "description") ?? `Draft imported from ${name}.`,
    definitions,
    warnings: skillPermissionWarnings(content),
  };
}

function normalizeJsonSkillDefinition(
  raw: Record<string, unknown>,
  location: string,
): { readonly definition: SkillDefinition; readonly warnings: readonly SkillImportWarning[] } {
  const warnings: SkillImportWarning[] = [];
  const id = readOptionalString(raw, "id") ?? slugSkillId(readOptionalString(raw, "name") ?? "custom-skill");
  const name = readOptionalString(raw, "name") ?? id;
  if (!raw.name || !raw.summary) {
    warnings.push({
      code: "missing_metadata",
      severity: "warning",
      message: "Skill definition is missing name or summary metadata.",
      location,
    });
  }
  const requiredTools = readStringArrayWithWarnings(raw, "requiredTools", supportedRunToolNames(), "unknown_tool", warnings, location) ?? [...readOnlyRunTools];
  const requiredProviderCapabilities = readStringArrayWithWarnings(
    raw,
    "requiredProviderCapabilities",
    [...providerCapabilities],
    "unknown_provider_capability",
    warnings,
    location,
  ) ?? ["chat", "reasoning"];
  return {
    definition: {
      id,
      name,
      summary: readOptionalString(raw, "summary") ?? `Custom skill ${name}.`,
      roleAffinity: readStringArrayWithWarnings(raw, "roleAffinity", supportedRoleKeys(), "unsupported_section", warnings, location) ?? ["custom"],
      promptFragments: readOptionalStringArray(raw, "promptFragments") ?? [readOptionalString(raw, "prompt") ?? readOptionalString(raw, "description") ?? ""].filter(Boolean),
      requiredTools,
      requiredProviderCapabilities,
      approvalProfile: isRecord(raw.approvalProfile) ? parseApprovalProfileObject(raw.approvalProfile, `${location}.approvalProfile`) : { mode: "none" },
      stateEffects: readStringArrayWithWarnings(raw, "stateEffects", supportedSkillStateEffects(), "unsupported_section", warnings, location) ?? [],
    },
    warnings: [...warnings, ...skillPermissionWarnings(JSON.stringify(raw)).map((warning) => ({ ...warning, location }))],
  };
}

function parseMarkdownSkillImport(
  content: string,
  sourcePath: string | undefined,
  requestedName: string | undefined,
): ReturnType<typeof parseSkillImportContent> {
  const frontmatter = parseMarkdownFrontmatter(content);
  const title = extractMarkdownTitle(content) ?? frontmatter.name ?? requestedName ?? (sourcePath ? basename(sourcePath, extname(sourcePath)) : "Custom Skill");
  const name = requestedName ?? title;
  const summary = frontmatter.description ?? firstMarkdownParagraph(content) ?? `Draft imported from ${sourcePath ?? "markdown"}.`;
  const id = slugSkillId(frontmatter.id ?? frontmatter.name ?? title);
  const warnings: SkillImportWarning[] = [
    ...skillPermissionWarnings(content),
    ...(!frontmatter.name && !extractMarkdownTitle(content) ? [{
      code: "missing_metadata" as const,
      severity: "warning" as const,
      message: "Markdown did not include a title or name; generated a skill name from the source.",
    }] : []),
  ];
  return {
    name,
    description: summary,
    definitions: [{
      definition: {
        id,
        name,
        summary,
        roleAffinity: ["custom"],
        promptFragments: [content.slice(0, 12_000)],
        requiredTools: [...readOnlyRunTools],
        requiredProviderCapabilities: ["chat", "reasoning"],
        approvalProfile: { mode: "none" },
        stateEffects: [],
      },
      warnings,
    }],
    warnings: [{
      code: "unsupported_section",
      severity: "info",
      message: "Markdown imports are treated as workflow prompt drafts; tool and approval claims are ignored.",
    }],
  };
}

function readOptionalSkillPackSource(record: Record<string, unknown>, key: string): SkillPackSource | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!["builtin", "gstack", "workspace", "skill-directory", "agents-md", "custom"].includes(value)) {
    throw new Error(`${key} must be a supported skill source`);
  }
  return value as SkillPackSource;
}

function readOptionalSkillSourceScanRoots(value: unknown): SkillSourceScanRoot[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("roots must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`roots[${index}] must be an object`);
    }
    return {
      id: readOptionalString(item, "id"),
      rootPath: readString(item, "rootPath"),
      sourceKind: readSkillSourceKind(item, "sourceKind"),
      label: readOptionalString(item, "label"),
      upstreamName: readOptionalString(item, "upstreamName"),
      upstreamVersion: readOptionalString(item, "upstreamVersion"),
    };
  });
}

function readSkillSourceKind(record: Record<string, unknown>, key: string): SkillSourceKind {
  const value = readString(record, key);
  if (!["gstack-skill-directory", "codex-skill-directory", "workspace-skill-directory", "manual-markdown"].includes(value)) {
    throw new Error(`${key} must be a supported skill source kind`);
  }
  return value as SkillSourceKind;
}

function inferSkillImportSource(sourcePath: string | undefined, content: string): SkillPackSource {
  const name = sourcePath ? basename(sourcePath).toLowerCase() : "";
  if (name === "agents.md" || name === "agent.md") {
    return "agents-md";
  }
  if (name === "skill.md" || content.includes("---\nname:")) {
    return "skill-directory";
  }
  return "custom";
}

function readStringArrayWithWarnings<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  warningCode: SkillImportWarning["code"],
  warnings: SkillImportWarning[],
  location: string,
): T[] | undefined {
  const values = readOptionalStringArray(record, key);
  if (!values) {
    return undefined;
  }
  const allowedSet = new Set<string>(allowed);
  const accepted: T[] = [];
  for (const value of values) {
    if (allowedSet.has(value)) {
      accepted.push(value as T);
    } else {
      warnings.push({
        code: warningCode,
        severity: "error",
        message: `${key} contains unsupported value: ${value}`,
        location,
      });
    }
  }
  return accepted;
}

export function skillPermissionWarnings(content: string): SkillImportWarning[] {
  const lower = content.toLowerCase();
  const warnings: SkillImportWarning[] = [];
  if (/\b(grant|enable|allow|bypass).*\b(tool|tools|bash|write|edit|approval|permission|permissions)\b/.test(lower)) {
    warnings.push({
      code: "permission_like_instruction",
      severity: "warning",
      message: "Import mentions granting tools, permissions, or approvals; those claims are ignored.",
    });
  }
  if (/\b(secret|secrets|token|api key|credential|credentials)\b/.test(lower)) {
    warnings.push({
      code: "secret_reference",
      severity: "warning",
      message: "Import mentions secrets or credentials; secret access must be configured separately.",
    });
  }
  if (/\b(external-send|send externally|slack|github comment|deploy|push)\b/.test(lower)) {
    warnings.push({
      code: "external_send_claim",
      severity: "warning",
      message: "Import mentions external sends, deploys, or pushes; side effects still require policy and approvals.",
    });
  }
  return warnings;
}

function slugSkillId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `custom-skill-${randomUUID().slice(0, 8)}`;
}

function supportedRunToolNames(): readonly RunTool[] {
  return [...readOnlyRunTools, "bash", "edit", "write"] as const;
}

function supportedRoleKeys(): readonly SkillDefinition["roleAffinity"][number][] {
  return ["product", "architect", "engineer", "designer", "qa", "security", "release", "docs", "custom"];
}

function supportedSkillStateEffects(): readonly SkillDefinition["stateEffects"][number][] {
  return ["creates_plan", "updates_plan", "creates_task", "updates_task", "starts_run", "requests_approval", "creates_artifact", "updates_docs", "prepares_release"];
}

function withoutLegacySkillWorkflowPhase(value: Record<string, unknown>): SkillDefinition {
  const { workflowPhase: _legacyWorkflowPhase, ...definition } = value;
  return definition as unknown as SkillDefinition;
}
