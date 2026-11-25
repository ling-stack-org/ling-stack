import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  LING_APP_SERVER_DECISION_MATERIALITIES,
  LING_APP_SERVER_DELIBERATION_CHECKPOINTS,
  LING_APP_SERVER_DELIBERATION_DECISION_KINDS,
} from "@ling-stack/contracts";
import { z } from "zod";

const id = z.string().trim().min(1).max(200).regex(/^[^\r\n\0]+$/u);
const selectors = {
  workspaceRoot: z.string().refine(isAbsolute),
  channelId: id,
};
const policyConfig = z.discriminatedUnion("mode", [
  z.strictObject({ ...selectors, mode: z.literal("manual") }),
  z.strictObject({ ...selectors, mode: z.literal("suggest") }),
  z.strictObject({
    ...selectors,
    mode: z.literal("auto_start"),
    allowedTriggers: z.array(z.enum(LING_APP_SERVER_DELIBERATION_CHECKPOINTS))
      .min(1).max(LING_APP_SERVER_DELIBERATION_CHECKPOINTS.length),
    allowedDecisionKinds: z.array(z.enum(LING_APP_SERVER_DELIBERATION_DECISION_KINDS))
      .min(1).max(LING_APP_SERVER_DELIBERATION_DECISION_KINDS.length),
    minimumViableOptions: z.number().int().min(2).max(12),
    minimumParticipants: z.number().int().min(2).max(12),
    requiredRoleIds: z.array(z.enum(["product", "architect", "engineer", "designer", "qa", "security", "release", "docs", "custom"]))
      .min(1).max(9),
    minDecisionMateriality: z.enum(LING_APP_SERVER_DECISION_MATERIALITIES),
    maxEvidenceAgeMs: z.number().int().positive().max(30 * 24 * 60 * 60_000).optional(),
    cooldownMs: z.number().int().positive().max(24 * 60 * 60_000),
    ballotMode: z.enum(["disabled", "when_unresolved"]),
    decisionOwner: z.strictObject({ kind: z.literal("user") }),
    budget: z.strictObject({
      maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      maxDurationMs: z.number().int().positive().max(15 * 60_000),
    }),
  }),
]);

type ReadonlyFields<T> = T extends readonly (infer Item)[] ? readonly Item[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyFields<T[Key]> } : T;

export type AppServerDeliberationPolicyConfig = ReadonlyFields<z.input<typeof policyConfig>>;
export type AppServerDeliberationPolicy = AppServerDeliberationPolicyConfig & { readonly revision: string };
export type AutomaticDeliberationPolicy = Extract<AppServerDeliberationPolicy, { readonly mode: "auto_start" }>;

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
    const policy = entry.mode === "auto_start" ? {
      ...entry, workspaceRoot, allowedTriggers: uniqueSorted(entry.allowedTriggers),
      allowedDecisionKinds: uniqueSorted(entry.allowedDecisionKinds), requiredRoleIds: uniqueSorted(entry.requiredRoleIds),
      budget: Object.freeze(entry.budget), decisionOwner: Object.freeze(entry.decisionOwner),
    } : { ...entry, workspaceRoot };
    return Object.freeze({ ...policy, revision: createHash("sha256").update(JSON.stringify(policy)).digest("hex") });
  }));
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  if (new Set(values).size !== values.length) throw new Error("Deliberation policy allowlists must contain unique entries.");
  return Object.freeze([...values].sort());
}
