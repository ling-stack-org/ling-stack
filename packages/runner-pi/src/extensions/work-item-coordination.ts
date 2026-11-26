import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeHandledToolResult } from "../content.js";
import type { PiRunnerRunOptions } from "../types.js";

export const WORK_ITEM_COORDINATION_TOOL = "work_item_coordination";

const id = { type: "string", minLength: 1, maxLength: 200 } as const;
const references = { type: "array", items: id, maxItems: 12 } as const;
const coordinatorParameters = {
  type: "object", additionalProperties: false, required: ["action"],
  properties: {
    action: { type: "string", enum: ["read_checkpoints", "submit_decision"] },
    workItemId: id,
    stageOffset: { type: "integer", minimum: 0 },
    afterEvidenceSequence: { type: "integer", minimum: 0 },
    decision: {
      type: "object", additionalProperties: false,
      required: ["roundId", "expectedWorkItemRevision", "subject", "decisionKey", "decisionKind", "materiality", "question",
        "participantIds", "optionRefs", "evidenceRefs"],
      properties: {
        roundId: id, expectedWorkItemRevision: { type: "integer", minimum: 1 },
        subject: {
          type: "object", additionalProperties: false, required: ["kind", "workflowStepId", "planRevision"],
          properties: { kind: { type: "string", enum: ["workflow_stage"] }, workflowStepId: id, planRevision: id },
        },
        decisionKey: id, decisionKind: { type: "string", enum: ["plan_or_contract", "implementation_tradeoff", "recovery_tradeoff", "review_disposition"] },
        materiality: { type: "string", enum: ["low", "medium", "high"] }, question: { type: "string", minLength: 1, maxLength: 1200 },
        participantIds: references, optionRefs: references, evidenceRefs: references,
        decisionStepId: id, candidateDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        unresolved: { type: "string", enum: ["intent", "fact", "handoff"] },
      },
    },
  },
} as ToolDefinition["parameters"];

export function createWorkItemCoordinationExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    if (options.initialToolSurface?.workItemCoordination !== true) return;
    const coordinator = options.initialToolSurface.workItemCoordinator === true;
    pi.registerTool({
      name: WORK_ITEM_COORDINATION_TOOL,
      label: "Work Item coordination",
      description: coordinator
        ? "Read open checkpoints, stages and evidence for the Work Items coordinated in this conversation. If a checkpoint has a concrete open decision, submit it with its current Plan, viable options, evidence and participants. A registered decision will be evaluated at close."
        : "Read the accepted Plan's stages and questions assigned to you. Send a stage a message, ask a question, or reply to an assigned question. A queued receipt means the request was recorded. Continue any independent work while awaiting the next model input.",
      executionMode: "sequential",
      parameters: coordinator ? coordinatorParameters : {
        type: "object", additionalProperties: false, required: ["action"],
        properties: {
          action: { enum: ["read", "send", "ask", "reply"], type: "string" },
          targetStepId: { type: "string", minLength: 1, maxLength: 256, description: "Receiving step for send or ask." },
          questionId: { type: "string", minLength: 1, maxLength: 256, description: "Assigned question for reply." },
          text: { type: "string", minLength: 1, maxLength: 1200, description: "Message, question or answer." },
          stageOffset: { type: "integer", minimum: 0, description: "Next stage offset from a read result." },
        },
      } as ToolDefinition["parameters"],
      async execute(toolCallId, input) {
        if (!options.onWorkItemCoordinationCall) throw new Error("work_item_coordination_host_missing");
        const result = await options.onWorkItemCoordinationCall({ toolCallId, input });
        return normalizeHandledToolResult(result);
      },
    });
  };
}
