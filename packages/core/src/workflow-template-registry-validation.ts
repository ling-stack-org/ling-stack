import { createHash } from "node:crypto";
import { workflowTemplateCanonicalJson, type SkillVisibility } from "@ling-stack/contracts";
import { WorkflowTemplateRegistryError } from "./workflow-template-registry-types.js";

export function workflowTemplateDigest(template: unknown): string {
  return `wt1_${createHash("sha256").update(workflowTemplateCanonicalJson(template)).digest("hex")}`;
}

export function workflowTemplateRegistryString(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function assertWorkflowTemplateRegistry(condition: unknown, code: string): asserts condition {
  if (!condition) throw new WorkflowTemplateRegistryError(`workflow_template_registry.${code}`);
}

export function workflowTemplateVisibility(value: unknown): SkillVisibility {
  assertWorkflowTemplateRegistry(value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), "invalid_visibility");
  const record = value as Record<string, unknown>;
  assertWorkflowTemplateRegistry(Reflect.ownKeys(record).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
    return typeof key === "string" && ["workspaceVisible", "promotableToWorkspace", "ownerTeammateId"].includes(key)
      && descriptor.enumerable && "value" in descriptor;
  })
    && typeof record.workspaceVisible === "boolean" && typeof record.promotableToWorkspace === "boolean"
    && (record.ownerTeammateId === undefined || workflowTemplateRegistryString(record.ownerTeammateId, 256)), "invalid_visibility");
  return { workspaceVisible: record.workspaceVisible, promotableToWorkspace: record.promotableToWorkspace,
    ...(record.ownerTeammateId === undefined ? {} : { ownerTeammateId: record.ownerTeammateId }) };
}

export const workflowTemplateSources = ["builtin", "gstack", "workspace", "skill-directory", "agents-md", "custom"] as const;
export const workflowTemplateReviewStatuses = ["builtin", "draft", "published", "disabled", "archived"] as const;
