import { createHash } from "node:crypto";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { parseWorkflowStepExecutionSafety } from "@ling-stack/contracts";
import type { ChannelWorkflowStep } from "./workspace-types.js";
import type { WorkflowStepAdmissionPlan } from "./workflow-step-admission.js";
import type {
  WorkflowIntegrationCandidate, WorkflowIntegrationRoundInputsV1, WorkflowIntegrationRoundPhase,
  WorkflowIsolationGitIdentity, WorkflowIsolationLocation, WorkflowIsolationRepositoryIdentity,
  WorkflowIsolationSafetyPin, WorkflowIsolationScopePlanV1, WorkflowIsolationTarget, WorkflowIsolationTemplatePin,
} from "./workflow-isolation-types.js";

export const workflowIsolationRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const workflowIsolationIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096 && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
export const workflowIsolationRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const workflowIsolationTime = (value: unknown): value is string => typeof value === "string"
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function workflowIsolationCanonicalJson(value: unknown): string {
  function canonical(item: unknown, depth: number): unknown {
    if (depth > 32) throw new Error("workflow_isolation.value_too_deep");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(entry => canonical(entry, depth + 1));
    if (workflowIsolationRecord(item)) return Object.fromEntries(Object.keys(item).sort()
      .filter(key => item[key] !== undefined).map(key => [key, canonical(item[key], depth + 1)]));
    throw new Error("workflow_isolation.non_json_value");
  }
  return JSON.stringify(canonical(value, 0));
}

export function workflowIsolationDigest(value: unknown, prefix = "wi1_"): string {
  return `${prefix}${createHash("sha256").update(workflowIsolationCanonicalJson(value)).digest("hex")}`;
}

const path = (value: unknown): value is string => workflowIsolationIdentity(value) && isAbsolute(value)
  && normalize(value) === value && value !== sep && !value.endsWith(sep);
const objectId = (value: unknown, format?: "sha1" | "sha256"): value is string => typeof value === "string"
  && (format === "sha1" ? /^[a-f0-9]{40}$/u : format === "sha256" ? /^[a-f0-9]{64}$/u : /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).test(value);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const array = (value: unknown, max = 128): value is unknown[] => Array.isArray(value) && value.length <= max;

function branch(value: unknown): value is string {
  return workflowIsolationIdentity(value) && value.startsWith("refs/heads/")
    && !/[\s~^:?*\[\\]/u.test(value) && !value.includes("..") && !value.includes("@{")
    && value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

export function workflowIsolationPathsOverlap(left: string, right: string): boolean {
  const nested = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  return nested(left, right) || nested(right, left);
}

function repository(value: unknown): WorkflowIsolationRepositoryIdentity | undefined {
  if (!workflowIsolationRecord(value) || !path(value.commonDir) || value.objectFormat !== "sha1" && value.objectFormat !== "sha256") return undefined;
  return { commonDir: value.commonDir, objectFormat: value.objectFormat };
}

function location(value: unknown): WorkflowIsolationLocation | undefined {
  if (!workflowIsolationRecord(value) || !path(value.executionRoot) || !workflowIsolationIdentity(value.worktreeId) || !branch(value.branchRef)) return undefined;
  return { executionRoot: value.executionRoot, worktreeId: value.worktreeId, branchRef: value.branchRef };
}

function target(value: unknown, format: "sha1" | "sha256"): WorkflowIsolationTarget | undefined {
  const loc = location(value);
  if (!loc || !workflowIsolationRecord(value) || !objectId(value.expectedHead, format) || !workflowIsolationIdentity(value.cleanStateDigest)
    || value.inputMode !== "clean_checkout" && value.inputMode !== "committed_head_only") return undefined;
  return { ...loc, expectedHead: value.expectedHead, cleanStateDigest: value.cleanStateDigest, inputMode: value.inputMode };
}

function templates(value: unknown): WorkflowIsolationTemplatePin[] | undefined {
  if (!array(value)) return undefined;
  const pins: WorkflowIsolationTemplatePin[] = [];
  for (const pin of value) {
    if (!workflowIsolationRecord(pin) || !workflowIsolationIdentity(pin.templateId) || !workflowIsolationIdentity(pin.version)
      || !workflowIsolationIdentity(pin.digest)) return undefined;
    pins.push({ templateId: pin.templateId, version: pin.version, digest: pin.digest });
  }
  const key = (pin: WorkflowIsolationTemplatePin) => workflowIsolationCanonicalJson([pin.templateId, pin.version]);
  return new Set(pins.map(key)).size === pins.length ? pins.sort((a, b) => compare(key(a), key(b))) : undefined;
}

function resources(value: unknown): WorkflowStepAdmissionPlan | undefined {
  if (!workflowIsolationRecord(value) || !array(value.entries, 64) || value.entries.length === 0 || !array(value.resourceKeys, 64)) return undefined;
  const entries: WorkflowStepAdmissionPlan["entries"][number][] = [];
  for (const entry of value.entries) {
    if (!workflowIsolationRecord(entry) || !["provider", "runner", "channel_parallel", "media_provider"].includes(String(entry.resourceType))
      || !workflowIsolationIdentity(entry.resourceKey) || !workflowIsolationRevision(entry.limit) || entry.limit < 1 || entry.limit > 4) return undefined;
    entries.push({ resourceType: entry.resourceType as WorkflowStepAdmissionPlan["entries"][number]["resourceType"], resourceKey: entry.resourceKey, limit: entry.limit });
  }
  const key = (entry: WorkflowStepAdmissionPlan["entries"][number]) => workflowIsolationCanonicalJson([entry.resourceType, entry.resourceKey]);
  if (new Set(entries.map(key)).size !== entries.length || value.resourceKeys.some(key => !workflowIsolationIdentity(key))
    || new Set(value.resourceKeys).size !== value.resourceKeys.length
    || entries.filter(entry => entry.resourceType === "provider").length !== 1
    || entries.filter(entry => entry.resourceType === "runner").length !== 1) return undefined;
  return { entries: entries.sort((a, b) => compare(key(a), key(b))), resourceKeys: [...value.resourceKeys as string[]].sort(compare) };
}

export function workflowIsolationSafetyFingerprint(pins: readonly WorkflowIsolationSafetyPin[]): string {
  return workflowIsolationDigest([...pins].sort((a, b) => compare(a.workflowStepId, b.workflowStepId)), "wisp1_");
}

export function workflowIsolationStepSafetyFingerprint(step: Pick<ChannelWorkflowStep, "metadata">): string {
  const m = step.metadata;
  return workflowIsolationDigest({ safety: parseWorkflowStepExecutionSafety(m), safetyPlan: m?.safetyPlan,
    requiredTools: m?.requiredTools, requestedRunnerId: m?.requestedRunnerId, gates: m?.gates, approvalGate: m?.approvalGate,
    policy: m?.policy, executionPlan: m?.executionPlan, executionOperationIds: m?.executionOperationIds }, "wiss1_");
}

export function normalizeWorkflowIntegrationRoundInputs(value: unknown): WorkflowIntegrationRoundInputsV1 | undefined {
  if (!workflowIsolationRecord(value) || value.schemaVersion !== 1 || !workflowIsolationIdentity(value.workflowId)
    || !workflowIsolationIdentity(value.canonicalWorkspaceId) || !path(value.canonicalWorkspaceRoot) || !workflowIsolationIdentity(value.graphFingerprint)
    || !array(value.participants) || value.participants.length === 0 || !array(value.mergeOrder) || !array(value.safetyPins)
    || !array(value.validationRequirements) || value.validationRequirements.length === 0
    || value.mode !== "candidate_only" && value.mode !== "apply_to_target"
    || value.optionalFailurePolicy !== "require_success" && value.optionalFailurePolicy !== "exclude_failed_with_evidence") return undefined;
  const repo = repository(value.repositoryIdentity), integration = location(value.integration), pins = templates(value.templatePins);
  const dest = repo && target(value.target, repo.objectFormat);
  if (!repo || !integration || !dest || !pins || !objectId(value.baseCommit, repo.objectFormat) || value.baseCommit !== dest.expectedHead
    || [value.canonicalWorkspaceRoot, repo.commonDir, dest.executionRoot].some(root => workflowIsolationPathsOverlap(root, integration.executionRoot))
    || integration.branchRef === dest.branchRef || integration.worktreeId === dest.worktreeId) return undefined;
  const participants: WorkflowIntegrationRoundInputsV1["participants"][number][] = [];
  const safetyPins: WorkflowIsolationSafetyPin[] = [], validation: WorkflowIntegrationRoundInputsV1["validationRequirements"][number][] = [];
  for (const participant of value.participants) {
    if (!workflowIsolationRecord(participant) || !workflowIsolationIdentity(participant.workflowStepId)
      || !workflowIsolationRevision(participant.position) || typeof participant.required !== "boolean") return undefined;
    participants.push({ workflowStepId: participant.workflowStepId, position: participant.position, required: participant.required });
  }
  participants.sort((a, b) => a.position - b.position || compare(a.workflowStepId, b.workflowStepId));
  const ids = participants.map(participant => participant.workflowStepId);
  if (new Set(ids).size !== ids.length || workflowIsolationCanonicalJson(value.mergeOrder) !== workflowIsolationCanonicalJson(ids)) return undefined;
  for (const pin of value.safetyPins) {
    if (!workflowIsolationRecord(pin) || !workflowIsolationIdentity(pin.workflowStepId) || !workflowIsolationIdentity(pin.fingerprint)) return undefined;
    safetyPins.push({ workflowStepId: pin.workflowStepId, fingerprint: pin.fingerprint });
  }
  safetyPins.sort((a, b) => compare(a.workflowStepId, b.workflowStepId));
  if (safetyPins.length !== ids.length || new Set(safetyPins.map(pin => pin.workflowStepId)).size !== ids.length
    || safetyPins.some(pin => !ids.includes(pin.workflowStepId)) || value.safetyFingerprint !== workflowIsolationSafetyFingerprint(safetyPins)) return undefined;
  for (const requirement of value.validationRequirements) {
    if (!workflowIsolationRecord(requirement) || !workflowIsolationIdentity(requirement.id) || !workflowIsolationIdentity(requirement.fingerprint)) return undefined;
    validation.push({ id: requirement.id, fingerprint: requirement.fingerprint });
  }
  if (new Set(validation.map(requirement => requirement.id)).size !== validation.length) return undefined;
  return { schemaVersion: 1, workflowId: value.workflowId, canonicalWorkspaceId: value.canonicalWorkspaceId,
    canonicalWorkspaceRoot: value.canonicalWorkspaceRoot, repositoryIdentity: repo, target: dest, baseCommit: value.baseCommit,
    integration, graphFingerprint: value.graphFingerprint, safetyFingerprint: value.safetyFingerprint,
    safetyPins, templatePins: pins, participants, mergeOrder: ids, optionalFailurePolicy: value.optionalFailurePolicy,
    validationRequirements: validation.sort((a, b) => compare(a.id, b.id)), mode: value.mode };
}

export function workflowIntegrationRoundInputsDigest(value: WorkflowIntegrationRoundInputsV1): string {
  const normalized = normalizeWorkflowIntegrationRoundInputs(value);
  if (!normalized) throw new Error("workflow_isolation.round_inputs_invalid");
  return workflowIsolationDigest(normalized, "wir1_");
}

function scopeFields(value: unknown): Omit<WorkflowIsolationScopePlanV1, "planDigest"> | undefined {
  if (!workflowIsolationRecord(value) || value.schemaVersion !== 1
    || ![value.planId, value.workflowId, value.workflowStepId, value.canonicalWorkspaceId, value.integrationRoundId,
      value.graphFingerprint, value.safetyFingerprint].every(workflowIsolationIdentity)
    || !path(value.canonicalWorkspaceRoot) || !workflowIsolationRevision(value.generation) || value.generation < 1
    || !workflowIsolationRevision(value.stepGeneration) || value.stepGeneration < 1) return undefined;
  const repo = repository(value.repositoryIdentity), loc = location(value), pins = templates(value.templatePins), resourcePlan = resources(value.resourcePlan);
  const dest = repo && target(value.target, repo.objectFormat);
  if (!repo || !loc || !pins || !resourcePlan || !dest || !objectId(value.baseCommit, repo.objectFormat) || value.baseCommit !== dest.expectedHead
    || [value.canonicalWorkspaceRoot, repo.commonDir, dest.executionRoot].some(root => workflowIsolationPathsOverlap(root, loc.executionRoot))
    || loc.branchRef === dest.branchRef || loc.worktreeId === dest.worktreeId) return undefined;
  return { schemaVersion: 1, planId: value.planId as string, workflowId: value.workflowId as string,
    workflowStepId: value.workflowStepId as string, canonicalWorkspaceId: value.canonicalWorkspaceId as string,
    canonicalWorkspaceRoot: value.canonicalWorkspaceRoot, repositoryIdentity: repo, target: dest,
    integrationRoundId: value.integrationRoundId as string, generation: value.generation, stepGeneration: value.stepGeneration,
    baseCommit: value.baseCommit, ...loc, graphFingerprint: value.graphFingerprint as string, safetyFingerprint: value.safetyFingerprint as string,
    templatePins: pins, resourcePlan };
}

export function workflowIsolationScopePlanDigest(value: Omit<WorkflowIsolationScopePlanV1, "planDigest">): string {
  const normalized = scopeFields(value);
  if (!normalized) throw new Error("workflow_isolation.scope_plan_invalid");
  return workflowIsolationDigest(normalized, "wip1_");
}

export function normalizeWorkflowIsolationScopePlan(value: unknown): WorkflowIsolationScopePlanV1 | undefined {
  const fields = scopeFields(value);
  if (!fields || !workflowIsolationRecord(value) || value.planDigest !== workflowIsolationDigest(fields, "wip1_")) return undefined;
  return { ...fields, planDigest: value.planDigest as string };
}

export function normalizeWorkflowIsolationGitIdentity(value: unknown): WorkflowIsolationGitIdentity | undefined {
  const loc = location(value);
  if (!loc || !workflowIsolationRecord(value) || !path(value.commonDir) || typeof value.exists !== "boolean"
    || value.exists && !objectId(value.headCommit) || !value.exists && value.headCommit !== null
    || value.tree !== undefined && (!value.exists || !objectId(value.tree))
    || value.cleanStateDigest !== undefined && !workflowIsolationIdentity(value.cleanStateDigest)) return undefined;
  return { ...loc, commonDir: value.commonDir, exists: value.exists, headCommit: value.headCommit as string | null,
    ...(value.tree === undefined ? {} : { tree: value.tree as string }),
    ...(value.cleanStateDigest === undefined ? {} : { cleanStateDigest: value.cleanStateDigest as string }) };
}

export function normalizeWorkflowIntegrationCandidate(value: unknown, format: "sha1" | "sha256"): WorkflowIntegrationCandidate | undefined {
  if (!workflowIsolationRecord(value) || !objectId(value.commit, format) || !objectId(value.tree, format)
    || !workflowIsolationIdentity(value.packetDigest) || !workflowIsolationIdentity(value.validationDigest)
    || !array(value.branchResultDigests) || value.branchResultDigests.length === 0 || value.branchResultDigests.some(d => !workflowIsolationIdentity(d))) return undefined;
  return { commit: value.commit, tree: value.tree, packetDigest: value.packetDigest,
    validationDigest: value.validationDigest, branchResultDigests: [...value.branchResultDigests as string[]] };
}

const transitions: Readonly<Record<WorkflowIntegrationRoundPhase, readonly WorkflowIntegrationRoundPhase[]>> = {
  preparing: ["collecting", "failed", "blocked"], collecting: ["integrating", "failed", "blocked"],
  integrating: ["verifying", "conflicted", "failed", "blocked"], verifying: ["awaiting_approval", "failed", "blocked"],
  awaiting_approval: ["applying", "blocked"], applying: ["applied", "blocked"], applied: [], conflicted: ["blocked"], failed: [], blocked: [],
};

export function canTransitionWorkflowIntegrationRound(from: WorkflowIntegrationRoundPhase, to: WorkflowIntegrationRoundPhase): boolean {
  return transitions[from]?.includes(to) ?? false;
}
