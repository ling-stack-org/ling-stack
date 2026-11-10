import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiRunnerRunOptions } from "../types.js";

/** One schema selection for preparation and execution; explicit false wins over callback presence. */
export function isUserInputToolSurfaceEnabled(options: Pick<PiRunnerRunOptions, "initialToolSurface" | "onUserInputRequest">): boolean {
  return options.initialToolSurface?.userInput ?? Boolean(options.onUserInputRequest);
}

/** Schema preparation carries no callback authority. Actual execution requires the live Host chain. */
export function assertUserInputExecutionHandler(options: Pick<PiRunnerRunOptions, "initialToolSurface" | "onUserInputRequest">): void {
  if (isUserInputToolSurfaceEnabled(options) && typeof options.onUserInputRequest !== "function") {
    throw new Error("user_input_host_handler_missing");
  }
}

/** Internal opt-in only: registering a schema does not establish a durable safe pause. */
export function createLingStackUserInputExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    if (!isUserInputToolSurfaceEnabled(options)) return;
    pi.registerTool({
      name: "request_user_input",
      label: "request_user_input",
      description: "Ask the user up to three structured questions. Required input pauses this attempt; it is not permission approval or task completion.",
      executionMode: "sequential",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          schemaVersion: { type: "integer", const: 1 },
          waitMode: { type: "string", enum: ["optional", "required"] },
          questions: { type: "array", minItems: 1, maxItems: 3, items: {
            type: "object", additionalProperties: false,
            properties: {
              questionId: { type: "string", minLength: 1, maxLength: 128 },
              prompt: { type: "string", minLength: 1, maxLength: 4000 },
              required: { type: "boolean" }, allowFreeText: { type: "boolean" },
              options: { type: "array", maxItems: 4, items: {
                type: "object", additionalProperties: false,
                properties: { optionId: { type: "string", minLength: 1, maxLength: 128 },
                  label: { type: "string", minLength: 1, maxLength: 500 } },
                required: ["optionId", "label"],
              } },
            }, required: ["questionId", "prompt", "required", "allowFreeText", "options"],
          } },
        }, required: ["schemaVersion", "waitMode", "questions"],
      } as ToolDefinition["parameters"],
      async execute(toolCallId, input) {
        assertUserInputExecutionHandler(options);
        const receipt = await options.onUserInputRequest!({ toolCallId, input });
        return { content: [{ type: "text", text: receipt.kind === "user_input_required"
          ? "Question saved. This attempt must pause for user input."
          : "Question saved. Execution may continue while awaiting user input." }], details: receipt };
      },
    });
  };
}
