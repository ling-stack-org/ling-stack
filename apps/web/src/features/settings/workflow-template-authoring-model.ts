import {
  parseWorkflowTemplate,
  type CustomWorkflowTemplate,
  type CustomWorkflowTemplateStep,
  type WorkflowStepGate,
  type WorkflowStepParallelPolicy,
  type WorkflowTemplatePin,
  type WorkflowTemplatePreviewResponse,
  type WorkflowTemplateRegistryEntry,
  type WorkflowTemplateVersion,
} from "@ling-stack/contracts";

export interface WorkflowTemplateDraft {
  readonly version: string;
  readonly template: CustomWorkflowTemplate;
}

export interface WorkflowTemplateEditorSession {
  readonly draft: WorkflowTemplateDraft;
  readonly baseline: WorkflowTemplateDraft;
  readonly entry?: WorkflowTemplateRegistryEntry;
  readonly savedVersion?: WorkflowTemplateVersion;
  readonly conflict: boolean;
}

export interface WorkflowTemplatePreviewSnapshot {
  readonly key: string;
  readonly result: WorkflowTemplatePreviewResponse;
}

export function newWorkflowTemplateSession(id: string): WorkflowTemplateEditorSession {
  const draft: WorkflowTemplateDraft = {
    version: "1",
    template: { schemaVersion: 1, id, name: "", autoStartDefault: false, steps: [newWorkflowTemplateStep([])] },
  };
  return { draft, baseline: draft, conflict: false };
}

export function workflowTemplateSessionFromVersion(
  entry: WorkflowTemplateRegistryEntry,
  version: WorkflowTemplateVersion,
): WorkflowTemplateEditorSession {
  const draft = { version: nextWorkflowTemplateVersion(version.version, entry.revision), template: parseWorkflowTemplate(version.template) };
  return { draft, baseline: draft, entry, savedVersion: version, conflict: false };
}

export function importedWorkflowTemplateSession(content: string): WorkflowTemplateEditorSession {
  if (content.length > 1_048_576) throw new Error("Template JSON exceeds 1 MiB.");
  const template = parseWorkflowTemplate(JSON.parse(content));
  const session = newWorkflowTemplateSession(template.id);
  return { ...session, draft: { version: "1", template } };
}

export function workflowTemplateDraftDirty(session: WorkflowTemplateEditorSession | undefined): boolean {
  return Boolean(session && JSON.stringify(session.draft) !== JSON.stringify(session.baseline));
}

export function validateWorkflowTemplateDraft(draft: WorkflowTemplateDraft): {
  readonly template?: CustomWorkflowTemplate;
  readonly error: string;
} {
  try {
    if (!draft.version || draft.version.length > 128 || draft.version.trim() !== draft.version
      || /[\u0000-\u001f\u007f-\u009f]/u.test(draft.version)) throw new Error("Template version is required (1-128 characters, no surrounding spaces).");
    return { template: parseWorkflowTemplate(draft.template), error: "" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function newWorkflowTemplateStep(steps: readonly CustomWorkflowTemplateStep[]): CustomWorkflowTemplateStep {
  const ids = new Set(steps.map((step) => step.id));
  let index = steps.length + 1;
  while (ids.has(`step-${index}`)) index++;
  return { id: `step-${index}`, name: "", prompt: "", dependsOn: [], sideEffectClass: "analysis_readonly", autoStart: false };
}

export function replaceWorkflowTemplateStep(
  template: CustomWorkflowTemplate,
  id: string,
  next: CustomWorkflowTemplateStep,
): CustomWorkflowTemplate {
  return { ...template, steps: template.steps.map((step) => step.id === id ? next : step) };
}

export function removeWorkflowTemplateStep(template: CustomWorkflowTemplate, id: string): CustomWorkflowTemplate {
  return {
    ...template,
    steps: template.steps.filter((step) => step.id !== id).map((step) => step.dependsOn?.includes(id)
      ? { ...step, dependsOn: step.dependsOn.filter((dependency) => dependency !== id) } : step),
  };
}

export function workflowTemplateDependencyWouldCycle(
  steps: readonly CustomWorkflowTemplateStep[],
  stepId: string,
  dependencyId: string,
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const reachesStep = (id: string): boolean => {
    if (id === stepId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return (byId.get(id)?.dependsOn ?? []).some(reachesStep);
  };
  return reachesStep(dependencyId);
}

export function workflowTemplateMemberValue(step: CustomWorkflowTemplateStep): string {
  if (step.teammateId) return `teammate:${step.teammateId}`;
  if (step.teammateTemplateId) return `template:${step.teammateTemplateId}`;
  if (step.councilSlotKey) return `slot:${step.councilSlotKey}`;
  return "";
}

export function setWorkflowTemplateMember(step: CustomWorkflowTemplateStep, value: string): CustomWorkflowTemplateStep {
  const { teammateId: _teammate, teammateTemplateId: _template, councilSlotKey: _slot, ...rest } = step;
  if (value.startsWith("teammate:")) return { ...rest, teammateId: value.slice("teammate:".length) };
  if (value.startsWith("template:")) return { ...rest, teammateTemplateId: value.slice("template:".length) };
  if (value.startsWith("slot:")) return { ...rest, councilSlotKey: value.slice("slot:".length) };
  return rest;
}

export function setWorkflowTemplateParallelPolicy(
  step: CustomWorkflowTemplateStep,
  patch: Partial<WorkflowStepParallelPolicy>,
): CustomWorkflowTemplateStep {
  const { maxParallelSiblings: legacyLimit, ...rest } = step;
  const policy = Object.fromEntries(Object.entries({
    autoParallel: false,
    ...(legacyLimit === undefined ? {} : { maxParallelSiblings: legacyLimit }),
    ...step.parallelPolicy,
    ...patch,
  }).filter(([, value]) => value !== undefined)) as unknown as WorkflowStepParallelPolicy;
  return {
    ...rest, sideEffectClass: step.sideEffectClass ?? "analysis_readonly", parallelPolicy: policy,
    ...(legacyLimit !== undefined && policy.maxParallelSiblings !== undefined ? { maxParallelSiblings: policy.maxParallelSiblings } : {}),
  };
}

export function newWorkflowTemplateGate(stage: WorkflowStepGate["stage"]): WorkflowStepGate {
  return { stage, approvalProfile: { mode: "standard" }, title: "", reason: "" };
}

export function toggleWorkflowTemplateValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function workflowTemplatePreviewKey(
  session: WorkflowTemplateEditorSession,
  channelId: string,
  objective: string,
): string {
  return JSON.stringify([session.draft, session.entry?.revision, session.entry?.reviewStatus, session.entry?.publishedVersion, channelId, objective.trim()]);
}

export function workflowTemplatePublishedPin(session: WorkflowTemplateEditorSession): WorkflowTemplatePin | undefined {
  const { entry, savedVersion } = session;
  if (workflowTemplateDraftDirty(session) || session.conflict || !entry || !savedVersion
    || !["published", "builtin"].includes(entry.reviewStatus)) return undefined;
  return sameWorkflowTemplatePin(entry.publishedVersion, savedVersion) ? entry.publishedVersion : undefined;
}

export function workflowTemplateHasExplicitAutoStart(template: CustomWorkflowTemplate): boolean {
  return template.autoStartDefault === true || template.steps.some((step) => step.autoStart === true);
}

export function workflowTemplateCreateRequest(
  session: WorkflowTemplateEditorSession,
  channelId: string,
  objective: string,
  preview: WorkflowTemplatePreviewSnapshot | undefined,
): {
  readonly objective: string;
  readonly customTemplateId: string;
  readonly customTemplateVersion: string;
  readonly customTemplateDigest: string;
  readonly autoStart: false;
  readonly confirmUnsafeAutoStart?: true;
} | undefined {
  const pin = workflowTemplatePublishedPin(session);
  const checked = validateWorkflowTemplateDraft(session.draft);
  if (!pin || !channelId || !objective.trim() || !preview
    || !checked.template
    || preview.key !== workflowTemplatePreviewKey(session, channelId, objective)
    || !sameWorkflowTemplatePin(pin, preview.result.templatePin)) return undefined;
  return {
    objective: objective.trim(), customTemplateId: pin.id,
    customTemplateVersion: pin.version, customTemplateDigest: pin.digest, autoStart: false,
    ...(workflowTemplateHasExplicitAutoStart(checked.template) ? { confirmUnsafeAutoStart: true } : {}),
  };
}

export function workflowTemplateIsConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || typeof record.code === "string" && /(?:revision|version|identity|digest|pin)_conflict$/u.test(record.code);
}

export function sameWorkflowTemplatePin(left: WorkflowTemplatePin | null | undefined, right: WorkflowTemplatePin | undefined): boolean {
  return Boolean(left && right && left.id === right.id && left.version === right.version && left.digest === right.digest);
}

function nextWorkflowTemplateVersion(version: string, revision: number): string {
  const segments = version.match(/^v?\d+(?:\.\d+)*$/u) ? version.split(".") : undefined;
  if (segments) {
    const last = segments.at(-1)!;
    const prefix = last.startsWith("v") ? "v" : "";
    const next = Number(last.replace(/^v/u, "")) + 1;
    if (Number.isSafeInteger(next)) return [...segments.slice(0, -1), `${prefix}${next}`].join(".");
  }
  return `${version.slice(0, 100)}-r${revision + 1}`;
}
