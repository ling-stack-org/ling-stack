import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiRunnerDelegationToolName, PiRunnerDelegationToolResult, PiRunnerRunOptions } from "../types.js";

export const DELEGATION_TOOL_NAMES = ["spawn_agent", "send_message", "wait_agent", "interrupt_agent", "resume_agent"] as const;

/** Explicit Host preparation selection only. Callback presence cannot change a frozen schema. */
export function isDelegationToolSurfaceEnabled(options: Pick<PiRunnerRunOptions, "initialToolSurface">): boolean {
  return options.initialToolSurface?.delegation === true;
}
export function assertDelegationExecutionHandler(options: Pick<PiRunnerRunOptions, "initialToolSurface" | "onDelegationToolCall">): void {
  if (isDelegationToolSurfaceEnabled(options) && typeof options.onDelegationToolCall !== "function") {
    throw new Error("delegation_host_handler_missing");
  }
}

const id = { type: "string", minLength: 1, maxLength: 1024 };
const definitions: Readonly<Record<PiRunnerDelegationToolName, { description: string; properties: Record<string, unknown>; required: string[] }>> = {
  spawn_agent: {
    description: "Delegate a bounded objective within this Run's frozen workspace, permissions, budget and deadline. Queued or started is not completion; inspect atomic child evidence with wait_agent.",
    properties: { objective: { type: "string", minLength: 1, maxLength: 16000 }, required: { type: "boolean" },
      participantId: id, requestedBudget: { type: "object", additionalProperties: false,
        properties: { tokenBudget: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          costBudgetMicros: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          wallTimeBudgetMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } } },
    required: ["objective", "required", "requestedBudget"],
  },
  send_message: { description: "Queue an instruction for this Run's own child. Durable queued does not mean received or executed.",
    properties: { reservationId: id, text: { type: "string", minLength: 1, maxLength: 16000 } }, required: ["reservationId", "text"] },
  wait_agent: { description: "Observe this Run's own child's durable state. Observation timeout is not cancellation, failure, success or resource release.",
    properties: { reservationId: id, timeoutMs: { type: "integer", minimum: 0, maximum: 60000 } }, required: ["reservationId", "timeoutMs"] },
  interrupt_agent: { description: "Request this Run's own child to stop at its original Host boundary. A request alone does not prove the process or tools drained.",
    properties: { reservationId: id }, required: ["reservationId"] },
  resume_agent: { description: "Resume this Run's interrupted child with its sealed context and a new Attempt. Never replay the initial prompt or unknown effects.",
    properties: { reservationId: id, expectedStepRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    required: ["reservationId", "expectedStepRevision"] },
};

/** Plain closed receipts only: never serialize a Store, custody object, private Run or raw result artifact. */
function readResult(value: PiRunnerDelegationToolResult): PiRunnerDelegationToolResult {
  const textKeys = ["status", "reservationId", "childRunId", "stepId", "code", "state", "messageId"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.status !== "string" || !value.status ||
    Object.keys(value).some(key => !textKeys.includes(key) && key !== "timedOut" && key !== "stepRevision") ||
    textKeys.some(key => value[key] !== undefined && (typeof value[key] !== "string" || !(value[key] as string).length || (value[key] as string).length > 1024)) ||
    value.timedOut !== undefined && typeof value.timedOut !== "boolean" ||
    value.stepRevision !== undefined && (!Number.isSafeInteger(value.stepRevision) || value.stepRevision < 1)) {
    throw new Error("delegation_host_result_invalid");
  }
  return Object.freeze({ ...value });
}

export function createLingStackDelegationExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    if (!isDelegationToolSurfaceEnabled(options)) return;
    for (const name of DELEGATION_TOOL_NAMES) {
      const definition = definitions[name];
      pi.registerTool({ name, label: name, description: definition.description, executionMode: "sequential",
        parameters: { type: "object", additionalProperties: false, properties: definition.properties,
          required: definition.required } as ToolDefinition["parameters"],
        async execute(toolCallId, input) {
          assertDelegationExecutionHandler(options);
          const result = readResult(await options.onDelegationToolCall!({ toolName: name, toolCallId, input }));
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
  };
}
