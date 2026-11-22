import { createHash } from "node:crypto";
import { isSupportedSecretRef } from "./secrets.js";
import type { PutAutomationEventSource } from "./automation-event-types.js";

const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("automation_event_configuration_invalid");
  return value as Record<string, unknown>;
}
export function parseAutomationEventSource(value: unknown): PutAutomationEventSource {
  const source = object(value, ["id", "label", "adapter", "enabled", "secretRefs", "repository", "rules"]);
  if (!identifier(source.id) || typeof source.label !== "string" || !source.label.trim() || source.label.length > 200
    || !["webhook", "github", "business"].includes(String(source.adapter)) || typeof source.enabled !== "boolean"
    || !Array.isArray(source.secretRefs) || !source.secretRefs.length || source.secretRefs.length > 2
    || source.secretRefs.some(ref => typeof ref !== "string" || ref.length > 256 || !isSupportedSecretRef(ref))
    || source.repository !== undefined && (typeof source.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(source.repository))
    || source.adapter === "github" && source.repository === undefined
    || !Array.isArray(source.rules) || !source.rules.length && source.adapter !== "github"
    || source.rules.length > 32) throw new Error("automation_event_configuration_invalid");
  const ids = new Set<string>();
  for (const value of source.rules) {
    const rule = object(value, ["automationId", "types", "predicates", "destinationIds"]);
    if (!identifier(rule.automationId) || ids.has(rule.automationId) || !Array.isArray(rule.types) || !rule.types.length || rule.types.length > 32
      || rule.types.some(type => !identifier(type)) || rule.destinationIds !== undefined && (!Array.isArray(rule.destinationIds)
        || rule.destinationIds.length > 8 || rule.destinationIds.some(id => !identifier(id))
        || new Set(rule.destinationIds).size !== rule.destinationIds.length)
      || rule.predicates !== undefined && (!Array.isArray(rule.predicates) || rule.predicates.length > 16)) throw new Error("automation_event_rule_invalid");
    for (const value of rule.predicates ?? []) {
      const predicate = object(value, ["path", "equals"]);
      if (typeof predicate.path !== "string" || !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){0,7}$/.test(predicate.path)
        || predicate.path.split(".").some(key => ["__proto__", "constructor", "prototype"].includes(key))
        || !(predicate.equals === null || typeof predicate.equals === "boolean" || typeof predicate.equals === "number" && Number.isFinite(predicate.equals)
          || typeof predicate.equals === "string" && predicate.equals.length <= 1000)) throw new Error("automation_event_predicate_invalid");
    }
    ids.add(rule.automationId);
  }
  return structuredClone(source) as unknown as PutAutomationEventSource;
}
export const automationEventDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function automationEventMatches(payload: Readonly<Record<string, unknown>>, predicates: readonly { path: string; equals: unknown }[] = []): boolean {
  return predicates.every(predicate => {
    let current: unknown = payload;
    for (const key of predicate.path.split(".")) {
      if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return false;
      current = (current as Record<string, unknown>)[key];
    }
    return current === predicate.equals;
  });
}
