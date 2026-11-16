import { approvalActionTypes } from "./approvals.js";
import type { SkillPackSource, SkillRegistryReviewStatus, SkillVisibility } from "./skills.js";
import type { CustomWorkflowTemplate, CustomWorkflowTemplateStep } from "./workflows.js";
import { parseWorkflowStepExecutionSafety } from "./workflow-safety.js";

export interface WorkflowTemplatePin {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

/** A library entry, not an executable SkillDefinition or permission grant. */
export interface WorkflowTemplateRegistryEntry {
  readonly kind: "workflow_template";
  readonly id: string;
  readonly workspaceId: string;
  readonly source: SkillPackSource;
  readonly sourcePath?: string;
  readonly visibility: SkillVisibility;
  readonly reviewStatus: SkillRegistryReviewStatus;
  readonly latestVersion: string;
  readonly publishedVersion?: WorkflowTemplatePin;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowTemplateVersion extends WorkflowTemplatePin {
  readonly kind: "workflow_template";
  readonly workspaceId: string;
  readonly template: CustomWorkflowTemplate;
  readonly createdAt: string;
}

export const WORKFLOW_TEMPLATE_MAX_STEPS = 128;
export const WORKFLOW_TEMPLATE_MAX_JSON_CHARACTERS = 1_048_576;

export class WorkflowTemplateValidationError extends Error {
  readonly code = "workflow_template_invalid";
  constructor(message: string) { super(message); this.name = "WorkflowTemplateValidationError"; }
}

function invalid(message: string): never { throw new WorkflowTemplateValidationError(message); }
function object(value: unknown, keys: readonly string[], path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key))) invalid(`${path}: expected only known JSON fields`);
}
function text(value: unknown, path: string, max = 256, identifier = false): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")
    || identifier && (value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) invalid(`${path}: invalid bounded string`);
}
function integer(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > WORKFLOW_TEMPLATE_MAX_STEPS) invalid(`${path}: expected an integer from 1 to 128`);
}
function boolean(value: unknown, path: string): void { if (typeof value !== "boolean") invalid(`${path}: expected boolean`); }
function choice(value: unknown, values: readonly string[], path: string): void {
  if (typeof value !== "string" || !values.includes(value)) invalid(`${path}: unknown value`);
}
function strings(value: unknown, path: string, max: number, values?: readonly string[]): void {
  if (!Array.isArray(value) || value.length > max) invalid(`${path}: invalid bounded list`);
  const seen = new Set<string>();
  for (const entry of value) {
    text(entry, path, 256, true);
    if (seen.has(entry) || values && !values.includes(entry)) invalid(`${path}: duplicate or unknown value`);
    seen.add(entry);
  }
}

/** Copy only bounded, plain JSON. Never invoke getters, toJSON, scripts or runtime resolvers. */
function jsonCopy(value: unknown): unknown {
  let characters = 0, nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 30_000 || depth > 12) invalid("template: JSON exceeds structural bounds");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      characters += item.length;
      if (characters > WORKFLOW_TEMPLATE_MAX_JSON_CHARACTERS) invalid("template: JSON exceeds character bound");
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || !Array.isArray(item)
      && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid("template: expected pure JSON");
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(item);
    if (Array.isArray(item)) {
      if (item.length > WORKFLOW_TEMPLATE_MAX_STEPS || keys.length !== item.length + 1) invalid("template: invalid JSON array");
      return Array.from({ length: item.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor)) invalid("template: expected JSON array values");
        return visit(descriptor.value, depth + 1);
      });
    }
    if (keys.length > 32) invalid("template: too many JSON fields");
    return Object.fromEntries(keys.map(key => {
      if (typeof key !== "string") invalid("template: JSON cannot contain symbol fields");
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) invalid("template: expected JSON data fields");
      characters += key.length;
      return [key, visit(descriptor.value, depth + 1)];
    }));
  };
  return visit(value, 0);
}

function step(value: unknown, path: string): CustomWorkflowTemplateStep {
  object(value, ["id", "name", "prompt", "sideEffectClass", "parallelPolicy", "teammateTemplateId", "teammateId", "councilSlotKey",
    "skillId", "providerPresetId", "requestedRunnerId", "dependsOn", "branchGroupId", "joinGroupId", "dependencyMode",
    "maxParallelSiblings", "policy", "gates", "autoStart"], path);
  text(value.id, `${path}.id`, 128, true); text(value.name, `${path}.name`); text(value.prompt, `${path}.prompt`, 65_536);
  for (const key of ["teammateTemplateId", "teammateId", "councilSlotKey", "skillId", "providerPresetId", "requestedRunnerId", "branchGroupId", "joinGroupId"])
    if (key in value) text(value[key], `${path}.${key}`, 256, true);
  if ("autoStart" in value) boolean(value.autoStart, `${path}.autoStart`);
  if ("maxParallelSiblings" in value) integer(value.maxParallelSiblings, `${path}.maxParallelSiblings`);
  if ("dependsOn" in value) strings(value.dependsOn, `${path}.dependsOn`, WORKFLOW_TEMPLATE_MAX_STEPS);
  if ("dependencyMode" in value) choice(value.dependencyMode, ["all_succeeded", "all_terminal", "any_succeeded"], `${path}.dependencyMode`);
  let safety;
  try { safety = parseWorkflowStepExecutionSafety(value); }
  catch (error) { invalid(`${path}: ${error instanceof Error ? error.message : "invalid safety"}`); }
  if (safety?.parallelPolicy?.maxParallelSiblings !== undefined) integer(safety.parallelPolicy.maxParallelSiblings, `${path}.parallelPolicy.maxParallelSiblings`);
  if (value.maxParallelSiblings !== undefined && safety?.parallelPolicy?.maxParallelSiblings !== undefined
    && value.maxParallelSiblings !== safety.parallelPolicy.maxParallelSiblings) invalid(`${path}: conflicting parallel sibling limits`);
  if ("policy" in value) {
    const policy = value.policy;
    object(policy, ["onRunFailed", "onRunCancelled", "onApprovalDenied", "retryable", "maxRetries"], `${path}.policy`);
    for (const key of ["onRunFailed", "onRunCancelled", "onApprovalDenied"])
      choice(policy[key], ["block_for_user", "fail_workflow", "cancel_workflow", "skip_if_optional"], `${path}.policy.${key}`);
    boolean(policy.retryable, `${path}.policy.retryable`);
    if ("maxRetries" in policy) integer(policy.maxRetries, `${path}.policy.maxRetries`);
  }
  if ("gates" in value) {
    if (!Array.isArray(value.gates) || value.gates.length > 16) invalid(`${path}.gates: expected at most 16 gates`);
    for (const gate of value.gates) {
      object(gate, ["stage", "approvalProfile", "title", "reason", "requiredForStatuses"], `${path}.gates`);
      choice(gate.stage, ["pre", "post"], `${path}.gates.stage`);
      text(gate.title, `${path}.gates.title`); text(gate.reason, `${path}.gates.reason`, 8192);
      object(gate.approvalProfile, ["mode", "risk", "requiredForTools", "requiredForActions"], `${path}.gates.approvalProfile`);
      const profile = gate.approvalProfile;
      choice(profile.mode, ["none", "standard", "strict"], `${path}.gates.approvalProfile.mode`);
      if ("risk" in profile) choice(profile.risk, ["low", "medium", "high", "critical"], `${path}.gates.approvalProfile.risk`);
      if ("requiredForTools" in profile) strings(profile.requiredForTools, `${path}.gates.approvalProfile.requiredForTools`, 7, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
      if ("requiredForActions" in profile) strings(profile.requiredForActions, `${path}.gates.approvalProfile.requiredForActions`, approvalActionTypes.length, approvalActionTypes);
      if ("requiredForStatuses" in gate) strings(gate.requiredForStatuses, `${path}.gates.requiredForStatuses`, 10,
        ["queued", "claimed", "running", "waiting_for_approval", "waiting_for_input", "blocked", "succeeded", "failed", "skipped", "cancelled"]);
    }
  }
  return { ...value, ...safety } as unknown as CustomWorkflowTemplateStep;
}

/** Static format validation only. Participant/skill/provider/runner authority belongs to the daemon compiler. */
export function parseWorkflowTemplate(value: unknown): CustomWorkflowTemplate {
  const input = jsonCopy(value);
  object(input, ["schemaVersion", "id", "name", "description", "maxParallelSteps", "autoStartDefault", "steps"], "template");
  if (input.schemaVersion !== 1) invalid("template.schemaVersion: expected 1");
  text(input.id, "template.id", 128, true); text(input.name, "template.name");
  if ("description" in input && (typeof input.description !== "string" || input.description.length > 8192)) invalid("template.description: invalid string");
  if ("maxParallelSteps" in input) integer(input.maxParallelSteps, "template.maxParallelSteps");
  if ("autoStartDefault" in input) boolean(input.autoStartDefault, "template.autoStartDefault");
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > WORKFLOW_TEMPLATE_MAX_STEPS) invalid("template.steps: expected 1 to 128 steps");
  const steps = input.steps.map((entry, index) => step(entry, `template.steps[${index}]`));
  const byId = new Map(steps.map(entry => [entry.id, entry]));
  if (byId.size !== steps.length) invalid("template.steps: duplicate step id");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid("template.steps: dependency cycle");
    if (visited.has(id)) return;
    const current = byId.get(id);
    if (!current) invalid(`template.steps: missing dependency ${id}`);
    visiting.add(id);
    for (const dependency of current.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return { ...input, autoStartDefault: input.autoStartDefault ?? false, steps } as unknown as CustomWorkflowTemplate;
}

/** Object keys are sorted; declaration and dependency array order remains part of the frozen input. */
export function workflowTemplateCanonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, sort(entry)])) : item;
  const json = JSON.stringify(sort(parseWorkflowTemplate(value)));
  if (json.length > WORKFLOW_TEMPLATE_MAX_JSON_CHARACTERS) invalid("template: canonical JSON exceeds character bound");
  return json;
}
