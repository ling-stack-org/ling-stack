import { readOnlyRunTools } from "./approval-policy.js";
import type {
  AutomationDraft,
  AutomationDraftConfirmInput,
  AutomationDraftField,
  AutomationDraftWarning,
  AutomationExecutionPolicy,
  AutomationOutputPolicy,
  AutomationPromptTemplate,
  AutomationTarget,
  AutomationTrigger,
} from "./automation-types.js";

const blockingWarningCodes = new Set([
  "project_monitor_not_implemented",
  "monitor_not_implemented",
  "invalid_output_destination",
  "invalid_output_format",
  "invalid_target",
  "invalid_prompt_template",
  "invalid_trigger",
]);

export function validateAutomationDraft(draft: AutomationDraft): AutomationDraft {
  const missingFields: AutomationDraftField[] = [];
  const warnings: AutomationDraftWarning[] = [];

  if (!draft.title?.trim()) {
    missingFields.push("title");
  }
  if (!draft.kind) {
    missingFields.push("kind");
  } else if (draft.kind === "project_monitor") {
    warnings.push({
      code: "project_monitor_not_implemented",
      message: "Project monitor automations are not supported in P1.5.",
      field: "kind",
    });
  }

  if (!draft.trigger) {
    missingFields.push("trigger");
  } else {
    warnings.push(...validateTrigger(draft.trigger));
  }

  if (!draft.target) {
    missingFields.push("target");
  } else {
    warnings.push(...validateTarget(draft.target));
  }

  if (!draft.promptTemplate) {
    missingFields.push("promptTemplate");
  } else {
    warnings.push(...validatePromptTemplate(draft.promptTemplate));
  }

  if (!draft.outputPolicy) {
    missingFields.push("outputPolicy");
  } else {
    warnings.push(...validateOutputPolicy(draft.outputPolicy));
  }

  const uniqueMissingFields = [...new Set(missingFields)];
  const hasBlockingWarning = warnings.some((warning) => blockingWarningCodes.has(warning.code));
  const status = deriveDraftStatus(draft, uniqueMissingFields, hasBlockingWarning);

  return {
    ...draft,
    title: draft.title?.trim() || undefined,
    missingFields: uniqueMissingFields,
    warnings,
    status,
  };
}

export function automationDraftToCreateRequest(draft: AutomationDraft): AutomationDraftConfirmInput {
  const validated = validateAutomationDraft(draft);
  if (validated.status !== "ready_for_confirmation") {
    throw new Error(`Automation draft is not ready for confirmation: ${validated.status}`);
  }
  if (
    !validated.title ||
    !validated.kind ||
    !validated.trigger ||
    !validated.target ||
    !validated.promptTemplate ||
    !validated.outputPolicy
  ) {
    throw new Error("Automation draft is missing required fields");
  }
  return {
    workspaceId: validated.workspaceId,
    channelId: validated.channelId ?? validated.target.channelId,
    title: validated.title,
    description: validated.description,
    kind: validated.kind,
    status: "enabled",
    trigger: validated.trigger,
    rrule: validated.rrule,
    target: validated.target,
    promptTemplate: validated.promptTemplate,
    executionPolicy: validated.executionPolicy ?? defaultDraftExecutionPolicy(),
    outputPolicy: validated.outputPolicy,
  };
}

export function defaultDraftExecutionPolicy(): AutomationExecutionPolicy {
  return {
    allowedTools: [...readOnlyRunTools],
    approvalProfile: { mode: "none" },
  };
}

export function defaultDraftOutputPolicy(): AutomationOutputPolicy {
  return {
    destinations: [{ type: "automation_thread" }, { type: "markdown_artifact" }],
    artifactFormat: "markdown",
  };
}

function deriveDraftStatus(
  draft: AutomationDraft,
  missingFields: readonly AutomationDraftField[],
  hasBlockingWarning: boolean,
): AutomationDraft["status"] {
  if (draft.discardedAt || draft.status === "discarded") {
    return "discarded";
  }
  if (draft.confirmedAutomationId || draft.status === "confirmed") {
    return "confirmed";
  }
  return missingFields.length === 0 && !hasBlockingWarning ? "ready_for_confirmation" : "needs_user_input";
}

function validateTrigger(trigger: AutomationTrigger): AutomationDraftWarning[] {
  if (trigger.type === "monitor") {
    return [{
      code: "monitor_not_implemented",
      message: "Monitor triggers are not supported in P1.5.",
      field: "trigger",
    }];
  }
  if (trigger.type === "schedule") {
    if (!trigger.timezone.trim()) {
      return [{
        code: "invalid_trigger",
        message: "Scheduled automations require a timezone.",
        field: "trigger",
      }];
    }
    if (trigger.schedule.cadence === "daily" || trigger.schedule.cadence === "weekly") {
      if (!/^\d{2}:\d{2}$/.test(trigger.schedule.timeOfDay)) {
        return [{
          code: "invalid_trigger",
          message: "Scheduled automations require HH:mm time.",
          field: "trigger",
        }];
      }
    }
    if (trigger.schedule.cadence === "interval" && trigger.schedule.everyMs < 1000) {
      return [{
        code: "invalid_trigger",
        message: "Interval automations must run no more frequently than once per second.",
        field: "trigger",
      }];
    }
  }
  return [];
}

function validateTarget(target: AutomationTarget): AutomationDraftWarning[] {
  if (!target.workspaceId.trim()) {
    return [{
      code: "invalid_target",
      message: "Automation target requires a workspace id.",
      field: "target",
    }];
  }
  if (target.scope === "channel" && !target.channelId) {
    return [{
      code: "invalid_target",
      message: "Channel automations require a channel target.",
      field: "target",
    }];
  }
  return [];
}

function validatePromptTemplate(promptTemplate: AutomationPromptTemplate): AutomationDraftWarning[] {
  if (!promptTemplate.promptMarkdown.trim()) {
    return [{
      code: "invalid_prompt_template",
      message: "Automation prompt cannot be empty.",
      field: "promptTemplate",
    }];
  }
  if (!Array.isArray(promptTemplate.contextSelectors)) {
    return [{
      code: "invalid_prompt_template",
      message: "Automation prompt requires context selectors.",
      field: "promptTemplate",
    }];
  }
  return [];
}

function validateOutputPolicy(outputPolicy: AutomationOutputPolicy): AutomationDraftWarning[] {
  const warnings: AutomationDraftWarning[] = [];
  if (outputPolicy.artifactFormat !== "markdown") {
    warnings.push({
      code: "invalid_output_format",
      message: "P1.5 automations only support markdown artifacts.",
      field: "outputPolicy",
    });
  }
  for (const destination of outputPolicy.destinations) {
    const destinationType = (destination as { readonly type?: string }).type;
    if (destinationType !== "automation_thread" && destinationType !== "markdown_artifact") {
      warnings.push({
        code: "invalid_output_destination",
        message: `Unsupported automation output destination: ${destinationType ?? "unknown"}`,
        field: "outputPolicy",
      });
    }
  }
  return warnings;
}
