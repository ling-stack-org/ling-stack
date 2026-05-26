export const lingExtensionKinds = [
  "provider",
  "runner",
  "channel-source",
  "skill-pack",
  "tool",
  "memory",
  "automation",
] as const;

export const extensionTrustLevels = ["internal", "internal-isolated"] as const;
export const approvalRequirementDecisions = ["ask", "deny"] as const;
export const approvalRequirementRisks = ["low", "medium", "high", "critical"] as const;

export type LingExtensionKind = (typeof lingExtensionKinds)[number];
export type ExtensionTrustLevel = (typeof extensionTrustLevels)[number];
export type ApprovalRequirementDecision = (typeof approvalRequirementDecisions)[number];
export type ApprovalRequirementRisk = (typeof approvalRequirementRisks)[number];

export interface ApprovalRequirement {
  readonly decision: ApprovalRequirementDecision;
  readonly risk: ApprovalRequirementRisk;
  readonly tools?: readonly string[];
  readonly actions?: readonly string[];
  readonly reason?: string;
}

export interface LingExtensionManifest<K extends LingExtensionKind = LingExtensionKind> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: K;
  readonly trustLevel: ExtensionTrustLevel;
  readonly capabilities: readonly string[];
  readonly requiredSecrets?: readonly string[];
  readonly requiredApprovals?: readonly ApprovalRequirement[];
}

export function validateLingExtensionManifest(
  manifest: LingExtensionManifest,
  expectedKind?: LingExtensionKind,
): void {
  assertNonEmptyString(manifest.id, "manifest.id");
  assertNonEmptyString(manifest.name, "manifest.name");
  assertNonEmptyString(manifest.version, "manifest.version");

  if (!isLingExtensionKind(manifest.kind)) {
    throw new Error(`Invalid extension kind: ${String(manifest.kind)}`);
  }
  if (expectedKind !== undefined && manifest.kind !== expectedKind) {
    throw new Error(`Extension ${manifest.id} has kind ${manifest.kind}, expected ${expectedKind}.`);
  }
  if (!isExtensionTrustLevel(manifest.trustLevel)) {
    throw new Error(`Invalid extension trust level for ${manifest.id}: ${String(manifest.trustLevel)}`);
  }
  assertStringArray(manifest.capabilities, "manifest.capabilities");
  if (manifest.requiredSecrets !== undefined) {
    assertStringArray(manifest.requiredSecrets, "manifest.requiredSecrets");
  }
  if (manifest.requiredApprovals !== undefined) {
    for (const approval of manifest.requiredApprovals) {
      validateApprovalRequirement(manifest.id, approval);
    }
  }
}

export function isLingExtensionKind(value: unknown): value is LingExtensionKind {
  return typeof value === "string" && (lingExtensionKinds as readonly string[]).includes(value);
}

export function isExtensionTrustLevel(value: unknown): value is ExtensionTrustLevel {
  return typeof value === "string" && (extensionTrustLevels as readonly string[]).includes(value);
}

function validateApprovalRequirement(extensionId: string, approval: ApprovalRequirement): void {
  if (!(approvalRequirementDecisions as readonly string[]).includes(approval.decision)) {
    throw new Error(`Invalid approval decision for ${extensionId}: ${String(approval.decision)}`);
  }
  if (!(approvalRequirementRisks as readonly string[]).includes(approval.risk)) {
    throw new Error(`Invalid approval risk for ${extensionId}: ${String(approval.risk)}`);
  }
  if (approval.tools !== undefined) {
    assertStringArray(approval.tools, "approval.tools");
  }
  if (approval.actions !== undefined) {
    assertStringArray(approval.actions, "approval.actions");
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function assertStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
}
