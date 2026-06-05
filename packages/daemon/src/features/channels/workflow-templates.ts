import {
  createBuiltinAiTeammateId,
  getBuiltinSkillPack,
  GSTACK_DEFAULT_SKILL_PACK_ID,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunStore,
  type WorkflowStepPolicy,
  type WorkflowStepTemplate,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord, readOptionalBoolean, readOptionalString, readString } from "../../shared/validation.js";

export interface CompileWorkflowTemplateInput {
  readonly channelId: string;
  readonly templateId: string;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
}

export function isWorkflowTemplateCompileRequest(value: unknown): boolean {
  return isRecord(value) && typeof value.templateId === "string";
}

export function parseWorkflowTemplateCompileRequest(value: unknown, channelId: string): CompileWorkflowTemplateInput {
  if (!isRecord(value)) {
    throw new Error("Workflow template request must be a JSON object");
  }
  return {
    channelId,
    templateId: readString(value, "templateId"),
    title: readOptionalString(value, "title"),
    objective: readString(value, "objective"),
    createdBy: readOptionalString(value, "createdBy"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    runnerId: readOptionalString(value, "runnerId"),
    autoStart: readOptionalBoolean(value, "autoStart"),
  };
}

export function compileWorkflowTemplate(store: RunStore, input: CompileWorkflowTemplateInput, now = new Date().toISOString()): {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
} {
  const channel = store.getChannel(input.channelId);
  if (!channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${input.channelId}`);
  }
  const skillPack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
  if (!skillPack) {
    throw new HttpError(500, "builtin_skill_pack_missing", `Builtin skill pack missing: ${GSTACK_DEFAULT_SKILL_PACK_ID}`);
  }
  const template = skillPack.workflowTemplates.find((candidate) => candidate.id === input.templateId);
  if (!template) {
    throw new HttpError(400, "workflow_template_not_found", `Workflow template not found: ${input.templateId}`);
  }
  const teammateTemplates = new Map(skillPack.teammateTemplates.map((teammate) => [teammate.id, teammate]));
  const workflow = store.createChannelWorkflow(
    {
      channelId: channel.id,
      title: input.title ?? template.name,
      objective: input.objective,
      status: "ready",
      createdBy: input.createdBy ?? "local-user",
    },
    now,
  );
  const steps: ChannelWorkflowStep[] = [];
  const byTemplateStepId = new Map<string, ChannelWorkflowStep>();
  for (const [index, templateStep] of template.steps.entries()) {
    const teammateTemplate = teammateTemplates.get(templateStep.teammateTemplateId);
    const teammateId = createBuiltinAiTeammateId(templateStep.teammateTemplateId);
    const step = store.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        position: index + 1,
        title: templateStep.name,
        prompt: renderTemplateStepPrompt(templateStep, input.objective),
        toParticipantId: teammateId,
        toParticipantLabel: teammateTemplate?.name ?? templateStep.teammateTemplateId,
        metadata: {
          workflowTemplateId: template.id,
          templateStepId: templateStep.id,
          teammateTemplateId: templateStep.teammateTemplateId,
          skillId: templateStep.skillId,
          requestedRunnerId: input.runnerId,
          providerPresetId: input.providerPresetId,
          autoStart: input.autoStart ?? true,
          approvalGate: templateStep.approvalGate,
          policy: defaultWorkflowStepPolicy(templateStep),
        },
      },
      now,
    );
    steps.push(step);
    byTemplateStepId.set(templateStep.id, step);
  }

  const updatedSteps = steps.map((step) => {
    const templateStepId = step.metadata?.templateStepId;
    const templateStep = template.steps.find((candidate) => candidate.id === templateStepId);
    const dependsOnStepIds = templateStep?.dependsOn?.map((dependencyId) => byTemplateStepId.get(dependencyId)?.id).filter(isString);
    if (!dependsOnStepIds || dependsOnStepIds.length === 0) {
      return step;
    }
    return store.updateChannelWorkflowStep(
      step.id,
      {
        metadata: {
          ...step.metadata,
          dependsOnStepIds,
        },
      },
      now,
    ) ?? step;
  });

  return {
    workflow,
    workflowSteps: updatedSteps,
  };
}

function defaultWorkflowStepPolicy(templateStep: WorkflowStepTemplate): WorkflowStepPolicy {
  return {
    onRunFailed: templateStep.id === "implementation" || templateStep.id === "ship" ? "fail_workflow" : "block_for_user",
    onRunCancelled: "block_for_user",
    onApprovalDenied: "block_for_user",
    retryable: true,
  };
}

function renderTemplateStepPrompt(templateStep: WorkflowStepTemplate, objective: string): string {
  return [
    `Workflow objective:\n${objective}`,
    `Current step: ${templateStep.name}`,
    `Phase: ${templateStep.phase}`,
    `Skill: ${templateStep.skillId}`,
    "Complete this step only. Do not start or approve later workflow steps.",
    "Return a concise terminal summary and any artifacts or follow-up decisions needed by later steps.",
  ].join("\n\n");
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
