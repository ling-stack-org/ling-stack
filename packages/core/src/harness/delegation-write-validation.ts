import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import type { DelegationBudgetV1 } from "@ling-stack/contracts";
import type { RuntimeAttemptFenceV1 } from "../runtime-supervisor-types.js";
import { resolveDelegationPriceForBudget, type DelegationPriceScope } from "./delegation-authority.js";
import {
  DelegationWriteError,
  type DelegationAuthorityCapture,
  type DelegationExecutionAuthority,
  type DelegationWriteErrorCode,
} from "./delegation-write-types.js";

export function delegationWriteFail(code: DelegationWriteErrorCode): never { throw new DelegationWriteError(code); }

/** Copy data descriptors, not getters, inherited fields, proxies or toJSON hooks. */
export function delegationRecord(value: unknown, allowed: readonly string[], code: DelegationWriteErrorCode = "delegation.invalid_input"): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return delegationWriteFail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return delegationWriteFail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      if (typeof key !== "string" || !allowed.includes(key) || !descriptor || !("value" in descriptor)) return delegationWriteFail(code);
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) { if (error instanceof DelegationWriteError) throw error; return delegationWriteFail(code); }
}

export function delegationId(value: unknown, code: DelegationWriteErrorCode = "delegation.invalid_input"): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > 65_536) return delegationWriteFail(code);
  return value;
}
export function delegationInteger(value: unknown, code: DelegationWriteErrorCode = "delegation.invalid_input"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return delegationWriteFail(code);
  return value;
}
export function delegationTimestamp(value: unknown, code: DelegationWriteErrorCode = "delegation.invalid_input"): string {
  if (typeof value !== "string") return delegationWriteFail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return delegationWriteFail(code);
  return value;
}
export function delegationFence(value: unknown): RuntimeAttemptFenceV1 {
  const row = delegationRecord(value, ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]);
  return Object.freeze({ workUnitId: delegationId(row.workUnitId), attemptId: delegationId(row.attemptId),
    runtimeInstanceId: delegationId(row.runtimeInstanceId), fencingToken: delegationId(row.fencingToken) });
}
export function delegationBudget(value: unknown): DelegationBudgetV1 {
  const row = delegationRecord(value, ["tokenBudget", "costBudgetMicros", "wallTimeBudgetMs"]);
  return Object.freeze(Object.fromEntries(Object.entries(row).filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, delegationInteger(entry)])));
}
function dataArray<T>(value: unknown, map: (entry: unknown) => T, code: DelegationWriteErrorCode): readonly T[] {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000) return delegationWriteFail(code);
    // Capture descriptors first; neither a sparse slot nor an accessor is data.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1) return delegationWriteFail(code);
    return Object.freeze(Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return delegationWriteFail(code);
      return map(descriptor.value);
    }));
  } catch (error) { if (error instanceof DelegationWriteError) throw error; return delegationWriteFail(code); }
}
function strings(value: unknown): readonly string[] {
  const entries = dataArray(value, entry => delegationId(entry, "delegation.authority_invalid"), "delegation.authority_invalid");
  if (new Set(entries).size !== entries.length) return delegationWriteFail("delegation.authority_invalid");
  return Object.freeze(entries);
}
export function delegationProvider(value: unknown): DelegationPriceScope {
  const row = delegationRecord(value, ["providerId", "baseUrl", "api", "model"], "delegation.authority_invalid");
  const baseUrl = delegationId(row.baseUrl, "delegation.authority_invalid");
  let url: URL;
  try { url = new URL(baseUrl); } catch { return delegationWriteFail("delegation.authority_invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return delegationWriteFail("delegation.authority_invalid");
  return Object.freeze({ providerId: delegationId(row.providerId, "delegation.authority_invalid"), baseUrl,
    api: delegationId(row.api, "delegation.authority_invalid"), model: delegationId(row.model, "delegation.authority_invalid") });
}
export function delegationAuthority(value: unknown): DelegationExecutionAuthority {
  const code = "delegation.authority_invalid";
  const row = delegationRecord(value, ["schemaVersion", "authoritySetId", "sourceRevision", "workspaceId", "channelId", "workflowId", "workflowStepId", "participantId", "participantIds", "runnerIds", "maxDepth", "sandbox", "mayEscalate", "tools", "toolDecisions", "workspaceRoots", "providers", "networkScopes", "secretRefs"], code);
  if (row.schemaVersion !== 1 || !["read_only", "workspace_write", "full_access"].includes(row.sandbox as string)
    || typeof row.mayEscalate !== "boolean") return delegationWriteFail(code);
  const tools = strings(row.tools);
  const decisions = delegationRecord(row.toolDecisions, tools, code);
  if (Object.keys(decisions).length !== tools.length || tools.some(tool => !["deny", "ask", "allow"].includes(decisions[tool] as string))) return delegationWriteFail(code);
  const roots = dataArray(row.workspaceRoots, value => {
    const root = delegationRecord(value, ["path", "access"], code);
    const path = delegationId(root.path, code);
    if (!isAbsolute(path) || resolve(path) !== path || !["read", "write"].includes(root.access as string)) return delegationWriteFail(code);
    return Object.freeze({ path, access: root.access as "read" | "write" });
  }, code);
  if (!roots.length) return delegationWriteFail(code);
  if (new Set(roots.map(root => root.path)).size !== roots.length) return delegationWriteFail(code);
  const providers = dataArray(row.providers, delegationProvider, code);
  if (!providers.length) return delegationWriteFail(code);
  if (new Set(providers.map(providerKey)).size !== providers.length) return delegationWriteFail(code);
  const secretRefs = strings(row.secretRefs);
  if (secretRefs.some(ref => !/^(?:env|keychain|managed):[A-Za-z0-9_./-]+$/u.test(ref))) return delegationWriteFail(code);
  const optional: Record<string, string> = {};
  for (const key of ["channelId", "workflowId", "workflowStepId", "participantId"]) {
    if (row[key] !== undefined) optional[key] = delegationId(row[key], code);
  }
  if (optional.workflowStepId && !optional.workflowId) return delegationWriteFail(code);
  const participantIds = strings(row.participantIds);
  if (optional.participantId && !participantIds.includes(optional.participantId)) return delegationWriteFail(code);
  const maxDepth = delegationInteger(row.maxDepth, code);
  if (maxDepth < 1 || maxDepth > 16) return delegationWriteFail(code);
  return Object.freeze({ schemaVersion: 1, authoritySetId: delegationId(row.authoritySetId, code),
    sourceRevision: delegationId(row.sourceRevision, code), workspaceId: delegationId(row.workspaceId, code), ...optional,
    participantIds, runnerIds: strings(row.runnerIds), maxDepth, sandbox: row.sandbox as DelegationExecutionAuthority["sandbox"],
    mayEscalate: row.mayEscalate, tools, toolDecisions: Object.freeze(decisions as Record<string, "deny" | "ask" | "allow">),
    workspaceRoots: Object.freeze(roots), providers: Object.freeze(providers), networkScopes: strings(row.networkScopes), secretRefs });
}

/** Explicit permission order: deny < ask < allow and read-only < workspace-write < full-access. */
export function assertDelegationAuthoritySubset(parent: DelegationExecutionAuthority, child: DelegationExecutionAuthority): void {
  const fail = (): never => delegationWriteFail("delegation.capability_escalation");
  for (const key of ["workspaceId", "channelId", "workflowId", "workflowStepId"] as const) if (parent[key] !== child[key]) fail();
  const sandbox = { read_only: 0, workspace_write: 1, full_access: 2 };
  const decisions = { deny: 0, ask: 1, allow: 2 };
  if (sandbox[child.sandbox] > sandbox[parent.sandbox] || child.mayEscalate && !parent.mayEscalate) fail();
  if (child.maxDepth > parent.maxDepth) fail();
  for (const key of ["tools", "networkScopes", "secretRefs", "participantIds", "runnerIds"] as const) if (child[key].some(value => !parent[key].includes(value))) fail();
  if (child.tools.some(tool => parent.toolDecisions[tool] === undefined || decisions[child.toolDecisions[tool]] > decisions[parent.toolDecisions[tool]])) fail();
  if (child.providers.some(provider => !parent.providers.some(allowed => providerKey(allowed) === providerKey(provider)))) fail();
  for (const root of child.workspaceRoots) {
    if (!parent.workspaceRoots.some(allowed => {
      const tail = relative(allowed.path, root.path);
      return (tail === "" || tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
        && (allowed.access === "write" || root.access === "read");
    })) fail();
  }
}

export function delegationCapture(value: unknown): DelegationAuthorityCapture {
  const code = "delegation.authority_invalid";
  const row = delegationRecord(value, ["rootRunId", "runId", "sourceFence", "authority", "budget", "price", "currency", "provider", "runnerId"], code);
  const authority = delegationAuthority(row.authority);
  const provider = delegationProvider(row.provider);
  const runnerId = delegationId(row.runnerId, code);
  if (!authority.runnerIds.includes(runnerId) || !authority.providers.some(value => providerKey(value) === providerKey(provider))) return delegationWriteFail(code);
  const currency = delegationId(row.currency, code);
  if (!/^[A-Z]{3}$/u.test(currency)) return delegationWriteFail(code);
  const budget = row.budget === undefined ? undefined : delegationBudget(row.budget);
  const price = resolveDelegationPriceForBudget({ costBudgetMicros: budget?.costBudgetMicros, currency, scope: provider, price: row.price as DelegationAuthorityCapture["price"] });
  return Object.freeze({ rootRunId: delegationId(row.rootRunId, code), runId: delegationId(row.runId, code),
    sourceFence: delegationFence(row.sourceFence), authority, ...(budget ? { budget } : {}), ...(price ? { price } : {}), currency, provider, runnerId });
}

export function providerKey(scope: DelegationPriceScope): string { return JSON.stringify([scope.providerId, scope.baseUrl, scope.api, scope.model]); }
export function delegationJson(value: unknown): string {
  function sort(entry: unknown): unknown {
    if (entry === undefined || entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") { if (!Number.isFinite(entry)) return delegationWriteFail("delegation.invalid_input"); return entry; }
    if (Array.isArray(entry)) return dataArray(entry, sort, "delegation.invalid_input");
    if (!entry || typeof entry !== "object" || types.isProxy(entry)) return delegationWriteFail("delegation.invalid_input");
    const row = delegationRecord(entry, Object.keys(entry));
    return Object.fromEntries(Object.keys(row).sort().filter(key => row[key] !== undefined).map(key => [key, sort(row[key])]));
  }
  return JSON.stringify(sort(value));
}
export function delegationDigest(value: unknown): string { return createHash("sha256").update(delegationJson(value), "utf8").digest("hex"); }

/**
 * Only for delegation.execution.v1: Pi fingerprints the SDK's JSON property
 * order. Validate the same strict data-only contract without replacing those
 * bytes with the sorted ledger representation. Never recompute an SDK hash.
 */
export function delegationPreparedExecutionJson(value: unknown): string {
  delegationJson(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return delegationWriteFail("delegation.invalid_input");
  return serialized;
}
export function delegationPreparedExecutionDigest(value: unknown): string {
  return createHash("sha256").update(delegationPreparedExecutionJson(value), "utf8").digest("hex");
}
