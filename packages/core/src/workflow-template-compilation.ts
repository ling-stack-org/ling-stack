import { createHash } from "node:crypto";
import { parseWorkflowTemplate, type WorkflowTemplateCompilationV1, type WorkflowTemplateCompilationStepPinV1 } from "@ling-stack/contracts";
import { workflowTemplateDigest } from "./workflow-template-registry-validation.js";

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, sort(entry)])) : item;
  return JSON.stringify(sort(value));
}

export function workflowTemplateReferenceDigest(value: unknown): string {
  return `wtr1_${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function workflowTemplateCompilationFingerprint(value: Omit<WorkflowTemplateCompilationV1, "graphFingerprint">): string {
  return `wtc1_${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function parseWorkflowTemplateCompilationPin(value: unknown): WorkflowTemplateCompilationStepPinV1 {
  const pin = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!pin || Object.keys(pin).some(key => !["id", "version", "digest", "graphFingerprint"].includes(key))
    || typeof pin.id !== "string" || !pin.id || typeof pin.version !== "string" || !pin.version
    || typeof pin.digest !== "string" || !/^wt1_[a-f0-9]{64}$/u.test(pin.digest)
    || typeof pin.graphFingerprint !== "string" || !/^wtc1_[a-f0-9]{64}$/u.test(pin.graphFingerprint)) {
    throw new Error("workflow_template_compilation.invalid_pin");
  }
  return pin as unknown as WorkflowTemplateCompilationStepPinV1;
}

/** Persisted malformed pins must not be silently downgraded to an unpinned legacy workflow. */
export function parseWorkflowTemplateCompilation(value: unknown): WorkflowTemplateCompilationV1 {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as WorkflowTemplateCompilationV1 : undefined;
  if (!input || input.schemaVersion !== 1 || !["inline", "registry"].includes(input.source)
    || typeof input.objective !== "string" || !input.objective.trim()
    || Object.keys(input).some(key => !["schemaVersion", "source", "templatePin", "template", "objective", "steps", "graphFingerprint"].includes(key))) {
    throw new Error("workflow_template_compilation.invalid_snapshot");
  }
  const template = parseWorkflowTemplate(input.template);
  parseWorkflowTemplateCompilationPin({ ...input.templatePin, graphFingerprint: input.graphFingerprint });
  if (template.id !== input.templatePin.id || workflowTemplateDigest(template) !== input.templatePin.digest
    || !Array.isArray(input.steps) || input.steps.length !== template.steps.length
    || input.steps.some((step, index) => !step || step.templateStepId !== template.steps[index]?.id
      || typeof step.toParticipantId !== "string" || !step.toParticipantId || typeof step.toParticipantLabel !== "string"
      || typeof step.title !== "string" || typeof step.prompt !== "string" || typeof step.autoStart !== "boolean" || !step.policy
      || typeof step.participantDigest !== "string" || !/^wtr1_[a-f0-9]{64}$/u.test(step.participantDigest)
      || typeof step.runnerId !== "string" || !step.runnerId || !Array.isArray(step.requiredTools) || !Array.isArray(step.dependsOn)
      || step.skillId !== undefined && (typeof step.skillId !== "string" || typeof step.skillDigest !== "string")
      || step.providerDigest !== undefined && (typeof step.providerPresetId !== "string" || !/^wtr1_[a-f0-9]{64}$/u.test(step.providerDigest)))) {
    throw new Error("workflow_template_compilation.invalid_snapshot");
  }
  const { graphFingerprint, ...basis } = input;
  if (workflowTemplateCompilationFingerprint(basis) !== graphFingerprint) throw new Error("workflow_template_compilation.digest_mismatch");
  return input;
}
