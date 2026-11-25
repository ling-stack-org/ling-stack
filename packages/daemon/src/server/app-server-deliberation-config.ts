import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  LING_APP_SERVER_DECISION_MATERIALITIES,
  LING_APP_SERVER_DELIBERATION_CHECKPOINTS,
  LING_APP_SERVER_DELIBERATION_DECISION_KINDS,
  type UpdateWorkspaceDeliberationPolicyRequest,
  type WorkspaceDeliberationPolicy,
  type WorkspaceDeliberationPolicyResponse,
} from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import { z } from "zod";
import { HttpError } from "../errors.js";

export const deliberationChannelId = z.string().trim().min(1).max(200).regex(/^[^\r\n\0]+$/u);
const selectors = {
  workspaceRoot: z.string().refine(isAbsolute),
  channelId: deliberationChannelId,
};
const manual = { mode: z.literal("manual") };
const suggest = { mode: z.literal("suggest") };
const automatic = {
  mode: z.literal("auto_start"),
  allowedTriggers: z.array(z.enum(LING_APP_SERVER_DELIBERATION_CHECKPOINTS))
    .min(1).max(LING_APP_SERVER_DELIBERATION_CHECKPOINTS.length).refine(containsUniqueEntries),
  allowedDecisionKinds: z.array(z.enum(LING_APP_SERVER_DELIBERATION_DECISION_KINDS))
    .min(1).max(LING_APP_SERVER_DELIBERATION_DECISION_KINDS.length).refine(containsUniqueEntries),
  minimumViableOptions: z.number().int().min(2).max(12),
  minimumParticipants: z.number().int().min(2).max(12),
  requiredRoleIds: z.array(z.enum(["product", "architect", "engineer", "designer", "qa", "security", "release", "docs", "custom"]))
    .min(1).max(9).refine(containsUniqueEntries),
  minDecisionMateriality: z.enum(LING_APP_SERVER_DECISION_MATERIALITIES),
  maxEvidenceAgeMs: z.number().int().positive().max(30 * 24 * 60 * 60_000).optional(),
  cooldownMs: z.number().int().positive().max(24 * 60 * 60_000),
  ballotMode: z.enum(["disabled", "when_unresolved"]),
  decisionOwner: z.strictObject({ kind: z.literal("user") }),
  budget: z.strictObject({
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxDurationMs: z.number().int().positive().max(15 * 60_000),
  }),
};
const policyConfig = z.discriminatedUnion("mode", [
  z.strictObject({ ...selectors, ...manual }),
  z.strictObject({ ...selectors, ...suggest }),
  z.strictObject({ ...selectors, ...automatic }),
]);
const workspacePolicy = z.discriminatedUnion("mode", [
  z.strictObject(manual),
  z.strictObject(suggest),
  z.strictObject(automatic),
]).nullable() satisfies z.ZodType<WorkspaceDeliberationPolicy | null>;

export const workspaceDeliberationPolicyUpdate = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  policy: workspacePolicy,
}) satisfies z.ZodType<UpdateWorkspaceDeliberationPolicyRequest>;

export type AppServerDeliberationPolicyConfig = WorkspaceDeliberationPolicy & { readonly workspaceRoot: string; readonly channelId: string };
export type AppServerDeliberationPolicy = AppServerDeliberationPolicyConfig & { readonly revision: string };
export type AutomaticDeliberationPolicy = Extract<WorkspaceDeliberationPolicy, { readonly mode: "auto_start" }>
  & { readonly channelId: string; readonly revision: string };

export const defaultDeliberationPolicyRevision = "checkpoint-suggestions:1";
const defaultPolicy = Object.freeze({ mode: "suggest" } as const);
const policyStateKind = "work_item_deliberation_policy";

export function resolveAppServerDeliberationPolicies(configured: readonly AppServerDeliberationPolicyConfig[] | undefined):
  readonly AppServerDeliberationPolicy[] {
  const file = process.env.LING_STACK_APP_SERVER_DELIBERATION_POLICY_FILE;
  const input: unknown = configured ?? (file ? JSON.parse(readFileSync(file, "utf8")) : []);
  const parsed = z.array(policyConfig).max(128).parse(input);
  const seen = new Set<string>();
  return Object.freeze(parsed.map(entry => {
    const workspaceRoot = realpathSync(entry.workspaceRoot);
    const scope = JSON.stringify([workspaceRoot, entry.channelId]);
    if (seen.has(scope)) throw new Error("Duplicate App Server deliberation policy for a workspace channel.");
    seen.add(scope);
    const policy = normalizePolicy({ ...entry, workspaceRoot });
    return Object.freeze({ ...policy, revision: digest(policy) });
  }));
}

export function readWorkspaceDeliberationPolicy(
  store: RunStore, cwd: string, channelId: string, policies: readonly AppServerDeliberationPolicy[],
): WorkspaceDeliberationPolicyResponse {
  const host = policies.find(policy => policy.workspaceRoot === cwd && policy.channelId === channelId);
  const { workspaceRoot: _workspaceRoot, channelId: _channelId, revision: hostRevision, ...hostSettings } = host ?? {};
  const hostPolicy = host ? hostSettings as WorkspaceDeliberationPolicy : null;
  const stored = store.getAppServerState(policyStateKind, channelId);
  const configured = stored ? workspacePolicy.parse(stored.payload) : null;
  const allowed = !configured || withinHostPolicy(configured, hostPolicy);
  // If the Host policy tightens, keep the configured value visible and defer
  // automatic start until the owner chooses a compatible setting.
  const effective = allowed ? configured ?? hostPolicy ?? defaultPolicy
    : hostPolicy?.mode === "manual" ? hostPolicy : defaultPolicy;
  return {
    cwd, channelId, revision: stored?.revision ?? 0, configured, hostPolicy, effective,
    effectiveRevision: stored ? digest([cwd, channelId, stored.revision, hostRevision, effective])
      : hostRevision ?? defaultDeliberationPolicyRevision,
    ...(!allowed ? { restriction: "host_policy" } : {}),
  };
}

export function updateWorkspaceDeliberationPolicy(
  store: RunStore, cwd: string, channelId: string, policies: readonly AppServerDeliberationPolicy[],
  input: UpdateWorkspaceDeliberationPolicyRequest, now: string,
): WorkspaceDeliberationPolicyResponse {
  const current = readWorkspaceDeliberationPolicy(store, cwd, channelId, policies);
  if (input.policy && !withinHostPolicy(input.policy, current.hostPolicy)) {
    throw new HttpError(409, "deliberation_policy_exceeds_host", "The policy exceeds this channel's trusted Host configuration.");
  }
  const result = store.putAppServerState({ kind: policyStateKind, recordId: channelId,
    expectedRevision: input.expectedRevision, payload: input.policy && normalizePolicy(input.policy) }, now);
  if (!result) throw new HttpError(409, "stale_revision", "Reload the channel's policy before editing it.");
  return readWorkspaceDeliberationPolicy(store, cwd, channelId, policies);
}

function withinHostPolicy(policy: WorkspaceDeliberationPolicy, host: WorkspaceDeliberationPolicy | null): boolean {
  if (host?.mode === "manual") return policy.mode === "manual";
  if (policy.mode !== "auto_start") return true;
  if (host?.mode !== "auto_start") return false;
  return policy.allowedTriggers.every(trigger => host.allowedTriggers.includes(trigger))
    && policy.allowedDecisionKinds.every(kind => host.allowedDecisionKinds.includes(kind))
    && policy.minimumParticipants >= host.minimumParticipants
    && policy.minimumViableOptions >= host.minimumViableOptions
    && host.requiredRoleIds.every(role => policy.requiredRoleIds.includes(role))
    && LING_APP_SERVER_DECISION_MATERIALITIES.indexOf(policy.minDecisionMateriality)
      >= LING_APP_SERVER_DECISION_MATERIALITIES.indexOf(host.minDecisionMateriality)
    && (policy.maxEvidenceAgeMs ?? Infinity) <= (host.maxEvidenceAgeMs ?? Infinity)
    && policy.cooldownMs >= host.cooldownMs
    && (host.ballotMode === "when_unresolved" || policy.ballotMode === "disabled")
    && policy.budget.maxTokens <= host.budget.maxTokens
    && policy.budget.maxDurationMs <= host.budget.maxDurationMs;
}

function normalizePolicy<T extends WorkspaceDeliberationPolicy>(value: T): T {
  if (value.mode !== "auto_start") return value;
  return {
    ...value,
    allowedTriggers: Object.freeze([...value.allowedTriggers].sort()),
    allowedDecisionKinds: Object.freeze([...value.allowedDecisionKinds].sort()),
    requiredRoleIds: Object.freeze([...value.requiredRoleIds].sort()),
    budget: Object.freeze(value.budget),
    decisionOwner: Object.freeze(value.decisionOwner),
  };
}

function containsUniqueEntries(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
