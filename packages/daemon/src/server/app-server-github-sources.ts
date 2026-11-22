import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { LingAppServerGitHubIntakePolicy, LingGitHubRequiredCheck } from "@ling-stack/contracts";
import { isRecord } from "../shared/validation.js";

export interface AppServerGitHubDeliveryPolicy {
  readonly baseRef: string;
  /**
   * Each named workflow must test the GitHub-attested check subject and must
   * source its acceptance configuration from the trusted CI environment.
   */
  readonly requiredChecks: readonly LingGitHubRequiredCheck[];
}

export interface AppServerGitHubSourceConfig {
  readonly workspaceRoot: string;
  readonly repository: string;
  readonly repositoryId: string;
  readonly secretRef?: string;
  readonly deliveryPolicies?: readonly AppServerGitHubDeliveryPolicy[];
  readonly intake?: LingAppServerGitHubIntakePolicy;
}

export const githubRepositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/u;

export function resolveAppServerGitHubSources(
  configured: readonly AppServerGitHubSourceConfig[] | undefined,
): readonly AppServerGitHubSourceConfig[] {
  const configPath = process.env.LING_STACK_APP_SERVER_GITHUB_SOURCES_FILE;
  let sources = configured;
  if (sources === undefined && configPath) {
    try { sources = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { throw new Error("The App Server GitHub source file must contain valid JSON."); }
  }
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.length > 64) throw new Error("App Server GitHub sources must be a bounded array.");
  const seen = new Set<string>();
  return sources.map((config: AppServerGitHubSourceConfig) => {
    if (!config || typeof config.repository !== "string" || !githubRepositoryPattern.test(config.repository)
      || typeof config.repositoryId !== "string" || !/^[1-9]\d{0,19}$/u.test(config.repositoryId)
      || typeof config.workspaceRoot !== "string" || !isAbsolute(config.workspaceRoot)
      || config.secretRef !== undefined && (typeof config.secretRef !== "string" || !config.secretRef.trim() || config.secretRef.length > 256)) {
      throw new Error("Invalid App Server GitHub source configuration.");
    }
    const workspaceRoot = realpathSync(config.workspaceRoot);
    const repository = config.repository.toLowerCase();
    const key = JSON.stringify([workspaceRoot, repository]);
    if (seen.has(key)) throw new Error("Duplicate App Server GitHub source for a workspace.");
    seen.add(key);
    return {
      workspaceRoot, repository, repositoryId: config.repositoryId, secretRef: config.secretRef,
      deliveryPolicies: resolveDeliveryPolicies(config.deliveryPolicies),
      intake: resolveIntakePolicy(config.intake),
    };
  });
}

function resolveIntakePolicy(policy: unknown): LingAppServerGitHubIntakePolicy | undefined {
  if (policy === undefined) return undefined;
  if (!isRecord(policy) || policy.mode !== "manual" && policy.mode !== "suggest" || typeof policy.enabled !== "boolean"
    || policy.requiredLabel !== undefined && (typeof policy.requiredLabel !== "string" || !policy.requiredLabel.trim()
      || policy.requiredLabel.length > 50 || /[,\r\n\0]/u.test(policy.requiredLabel))
    || policy.webhookSourceId !== undefined && (typeof policy.webhookSourceId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(policy.webhookSourceId))
    || policy.priority !== undefined && policy.priority !== "low" && policy.priority !== "normal"
      && policy.priority !== "high" && policy.priority !== "urgent") {
    throw new Error("Invalid App Server GitHub intake policy.");
  }
  return { mode: policy.mode, enabled: policy.enabled, requiredLabel: policy.requiredLabel,
    webhookSourceId: policy.webhookSourceId, priority: policy.priority };
}

function resolveDeliveryPolicies(policies: readonly AppServerGitHubDeliveryPolicy[] | undefined): readonly AppServerGitHubDeliveryPolicy[] {
  if (policies === undefined) return [];
  if (!Array.isArray(policies) || policies.length > 32) throw new Error("GitHub delivery policies must be a bounded array.");
  const baseRefs = new Set<string>();
  return policies.map((policy: AppServerGitHubDeliveryPolicy) => {
    if (!policy || typeof policy.baseRef !== "string" || !policy.baseRef.trim() || baseRefs.has(policy.baseRef)
      || !Array.isArray(policy.requiredChecks) || !policy.requiredChecks.length || policy.requiredChecks.length > 32) {
      throw new Error("Invalid App Server GitHub delivery policy.");
    }
    baseRefs.add(policy.baseRef);
    const names = new Set<string>();
    const requiredChecks = policy.requiredChecks.map((check: LingGitHubRequiredCheck) => {
      if (!check || typeof check.name !== "string" || !check.name.trim() || check.name.length > 160
        || names.has(check.name) || !Number.isSafeInteger(check.appId) || check.appId < 1
        || !Number.isSafeInteger(check.workflowId) || check.workflowId < 1
        || typeof check.workflowPath !== "string" || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(check.workflowPath)
        || typeof check.workflowSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(check.workflowSha256)
        || !["head", "integration", "merge_group"].includes(check.basis)
        || !Array.isArray(check.coverageRefs) || !check.coverageRefs.length || check.coverageRefs.length > 8
        || check.coverageRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 160)) {
        throw new Error("Invalid trusted GitHub check.");
      }
      names.add(check.name);
      return { name: check.name, appId: check.appId, workflowId: check.workflowId, workflowPath: check.workflowPath,
        workflowSha256: check.workflowSha256, basis: check.basis, coverageRefs: [...check.coverageRefs] };
    });
    return { baseRef: policy.baseRef, requiredChecks };
  });
}
