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
export const lingPluginPackageSourceKinds = ["bundled", "trusted-local"] as const;
export const lingPluginPackageTrustLevels = ["internal", "internal-isolated", "trusted-local-preset"] as const;
export const lingPluginPackageContributionKinds = [
  "mcp-server",
  "skill-pack",
  "runner",
  "provider",
  "ui-feature",
] as const;
export const supportedLingPluginInterfaceVersions = ["1"] as const;

export type LingExtensionKind = (typeof lingExtensionKinds)[number];
export type ExtensionTrustLevel = (typeof extensionTrustLevels)[number];
export type ApprovalRequirementDecision = (typeof approvalRequirementDecisions)[number];
export type ApprovalRequirementRisk = (typeof approvalRequirementRisks)[number];
export type LingPluginPackageSourceKind = (typeof lingPluginPackageSourceKinds)[number];
export type LingPluginPackageTrustLevel = (typeof lingPluginPackageTrustLevels)[number];
export type LingPluginPackageContributionKind = (typeof lingPluginPackageContributionKinds)[number];
export type SupportedLingPluginInterfaceVersion = (typeof supportedLingPluginInterfaceVersions)[number];

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

export interface LingPluginPackageSecretRequirement {
  readonly ref: string;
  readonly label: string;
  readonly purpose?: string;
  readonly required?: boolean;
}

export interface LingPluginPackageApprovalDefault {
  readonly contributionId: string;
  readonly decision: "allow" | "ask" | "deny";
  readonly reason?: string;
}

export interface LingPluginPackageHealthCheck {
  readonly id: string;
  readonly label: string;
  readonly kind: "descriptor" | "binary" | "mcp";
}

export interface LingPluginPackageContribution {
  readonly kind: LingPluginPackageContributionKind;
  readonly id: string;
  readonly path: string;
}

export interface LingPluginPackageManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly lingInterfaceVersion: SupportedLingPluginInterfaceVersion | string;
  readonly sourceKind: LingPluginPackageSourceKind;
  readonly trustLevel: LingPluginPackageTrustLevel;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly trustSummary: string;
  readonly platforms?: readonly ("darwin" | "linux" | "win32")[];
  readonly contributions: readonly LingPluginPackageContribution[];
  readonly requiredSecrets?: readonly LingPluginPackageSecretRequirement[];
  readonly defaultApprovals?: readonly LingPluginPackageApprovalDefault[];
  readonly healthChecks?: readonly LingPluginPackageHealthCheck[];
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

export function validateLingPluginPackageManifest(manifest: LingPluginPackageManifest): void {
  assertNoSecretValues(manifest);
  assertNonEmptyString(manifest.id, "manifest.id");
  assertNonEmptyString(manifest.displayName, "manifest.displayName");
  assertNonEmptyString(manifest.trustSummary, "manifest.trustSummary");
  assertSemverCompatible(manifest.version, "manifest.version");

  if (!(supportedLingPluginInterfaceVersions as readonly string[]).includes(manifest.lingInterfaceVersion)) {
    throw new Error(`Unsupported plugin interface version: ${String(manifest.lingInterfaceVersion)}`);
  }
  if (!(lingPluginPackageSourceKinds as readonly string[]).includes(manifest.sourceKind)) {
    throw new Error(`Invalid plugin source kind for ${manifest.id}: ${String(manifest.sourceKind)}`);
  }
  if (!(lingPluginPackageTrustLevels as readonly string[]).includes(manifest.trustLevel)) {
    throw new Error(`Invalid plugin trust level for ${manifest.id}: ${String(manifest.trustLevel)}`);
  }
  if (manifest.description !== undefined) {
    assertString(manifest.description, "manifest.description");
  }
  if (manifest.homepageUrl !== undefined) {
    assertString(manifest.homepageUrl, "manifest.homepageUrl");
  }
  if (manifest.platforms !== undefined) {
    assertStringArray(manifest.platforms, "manifest.platforms");
    for (const platform of manifest.platforms) {
      if (!["darwin", "linux", "win32"].includes(platform)) {
        throw new Error(`Invalid plugin platform for ${manifest.id}: ${platform}`);
      }
    }
  }
  validatePackageContributions(manifest);
  validatePackageSecretRequirements(manifest);
  validatePackageApprovalDefaults(manifest);
  validatePackageHealthChecks(manifest);
}

export function isLingExtensionKind(value: unknown): value is LingExtensionKind {
  return typeof value === "string" && (lingExtensionKinds as readonly string[]).includes(value);
}

export function isExtensionTrustLevel(value: unknown): value is ExtensionTrustLevel {
  return typeof value === "string" && (extensionTrustLevels as readonly string[]).includes(value);
}

export function isLingPluginPackageContributionKind(value: unknown): value is LingPluginPackageContributionKind {
  return typeof value === "string" && (lingPluginPackageContributionKinds as readonly string[]).includes(value);
}

export function isSupportedLingPluginInterfaceVersion(value: unknown): value is SupportedLingPluginInterfaceVersion {
  return typeof value === "string" && (supportedLingPluginInterfaceVersions as readonly string[]).includes(value);
}

function validatePackageContributions(manifest: LingPluginPackageManifest): void {
  if (!Array.isArray(manifest.contributions) || manifest.contributions.length === 0) {
    throw new Error("manifest.contributions must be a non-empty array.");
  }
  const contributionIds = new Set<string>();
  for (const contribution of manifest.contributions) {
    if (!isRecord(contribution)) {
      throw new Error("manifest.contributions entries must be objects.");
    }
    if (!isLingPluginPackageContributionKind(contribution.kind)) {
      throw new Error(`Unsupported plugin contribution kind for ${manifest.id}: ${String(contribution.kind)}`);
    }
    assertNonEmptyString(contribution.id, "contribution.id");
    assertSafeRelativePackagePath(contribution.path, "contribution.path");
    if (contributionIds.has(contribution.id)) {
      throw new Error(`Duplicate plugin contribution id for ${manifest.id}: ${contribution.id}`);
    }
    contributionIds.add(contribution.id);
  }
}

function validatePackageSecretRequirements(manifest: LingPluginPackageManifest): void {
  if (manifest.requiredSecrets === undefined) {
    return;
  }
  if (!Array.isArray(manifest.requiredSecrets)) {
    throw new Error("manifest.requiredSecrets must be an array.");
  }
  for (const secret of manifest.requiredSecrets) {
    if (!isRecord(secret)) {
      throw new Error("manifest.requiredSecrets entries must be objects.");
    }
    assertNonEmptyString(secret.ref, "requiredSecret.ref");
    assertNonEmptyString(secret.label, "requiredSecret.label");
    if (secret.purpose !== undefined) {
      assertString(secret.purpose, "requiredSecret.purpose");
    }
    if (secret.required !== undefined && typeof secret.required !== "boolean") {
      throw new Error("requiredSecret.required must be a boolean.");
    }
  }
}

function validatePackageApprovalDefaults(manifest: LingPluginPackageManifest): void {
  if (manifest.defaultApprovals === undefined) {
    return;
  }
  if (!Array.isArray(manifest.defaultApprovals)) {
    throw new Error("manifest.defaultApprovals must be an array.");
  }
  for (const approval of manifest.defaultApprovals) {
    if (!isRecord(approval)) {
      throw new Error("manifest.defaultApprovals entries must be objects.");
    }
    assertNonEmptyString(approval.contributionId, "defaultApproval.contributionId");
    if (!["allow", "ask", "deny"].includes(String(approval.decision))) {
      throw new Error(`Invalid default approval decision for ${manifest.id}: ${String(approval.decision)}`);
    }
    if (approval.reason !== undefined) {
      assertString(approval.reason, "defaultApproval.reason");
    }
  }
}

function validatePackageHealthChecks(manifest: LingPluginPackageManifest): void {
  if (manifest.healthChecks === undefined) {
    return;
  }
  if (!Array.isArray(manifest.healthChecks)) {
    throw new Error("manifest.healthChecks must be an array.");
  }
  const ids = new Set<string>();
  for (const check of manifest.healthChecks) {
    if (!isRecord(check)) {
      throw new Error("manifest.healthChecks entries must be objects.");
    }
    assertNonEmptyString(check.id, "healthCheck.id");
    assertNonEmptyString(check.label, "healthCheck.label");
    if (!["descriptor", "binary", "mcp"].includes(String(check.kind))) {
      throw new Error(`Invalid health check kind for ${manifest.id}: ${String(check.kind)}`);
    }
    if (ids.has(check.id)) {
      throw new Error(`Duplicate health check id for ${manifest.id}: ${check.id}`);
    }
    ids.add(check.id);
  }
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

function assertSemverCompatible(value: unknown, field: string): void {
  assertNonEmptyString(value, field);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${field} must be semver-compatible.`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
}

function assertSafeRelativePackagePath(value: unknown, field: string): void {
  assertNonEmptyString(value, field);
  if (/^(?:\/|\\\\|[A-Za-z]:[\\/])/.test(value)) {
    throw new Error(`${field} must be relative to the plugin package root.`);
  }
  const normalized = value.replace(/^[.][\\/]+/, "");
  const segments = normalized.split(/[\\/]+/);
  if (segments.some((segment) => segment === "" || segment === "..")) {
    throw new Error(`${field} must not contain empty, current, or parent path segments.`);
  }
}

function assertNoSecretValues(value: unknown, path = "manifest"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretValues(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:value|secret|token|apiKey|api_key|privateKey)$/i.test(key) && typeof nested === "string" && nested.trim()) {
      throw new Error(`${path}.${key} must not contain a secret value.`);
    }
    assertNoSecretValues(nested, `${path}.${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
