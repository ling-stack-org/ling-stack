import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeHandledToolResult } from "../content.js";
import type { PiRunnerRunOptions } from "../types.js";

export const WORK_ITEM_COORDINATION_TOOL = "work_item_coordination";

export function createWorkItemCoordinationExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    if (options.initialToolSurface?.workItemCoordination !== true) return;
    pi.registerTool({
      name: WORK_ITEM_COORDINATION_TOOL,
      label: "Work Item coordination",
      description: "Read the accepted Plan's stages and questions assigned to you. Send a stage a message, ask a question, or reply to an assigned question. A queued receipt means the request was recorded. Continue any independent work while awaiting the next model input.",
      executionMode: "sequential",
      parameters: {
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
