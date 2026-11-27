import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiRunnerRunOptions } from "../types.js";
import { createHostToolResultAdapter } from "../host-tool-results.js";

export const CONVERSATION_VISUALIZATION_TOOL = "conversation_visualization_create";

export function isConversationVisualizationEnabled(options: PiRunnerRunOptions): boolean {
  return options.initialToolSurface?.conversationVisualization === true
    && !options.isolatedToolsProfile && !options.readonlyToolsProfile;
}

export function createConversationVisualizationExtension(options: PiRunnerRunOptions): ExtensionFactory {
  const frozen = options.preparedInput?.tools.find(tool => tool.name === CONVERSATION_VISUALIZATION_TOOL);
  const required: unknown = frozen && Reflect.get(frozen.parameters, "required");
  const legacy = Array.isArray(required) && required.includes("html");
  return pi => {
    const adapt = createHostToolResultAdapter(pi);
    pi.registerTool({
      name: CONVERSATION_VISUALIZATION_TOOL,
      label: "Create conversation visualization",
      description: "Publish a self-contained HTML visualization in your reply when the user asks for an interactive diagram, interface mockup, or small tool. Use inline styles and native HTML controls for immediate interaction. Put the returned Markdown on its own line between blank lines in your reply. Summarize the visualization in prose as well.",
      parameters: {
        type: "object", additionalProperties: false,
        required: legacy ? ["title", "summary", "html"] : ["title", "summary"],
        ...(legacy ? {} : { oneOf: [{ required: ["html"] }, { required: ["sourceFile"] }] }),
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          html: { type: "string", description: legacy
            ? "Self-contained HTML fragment or document, up to 128 KiB, with embedded styles and optional inline scripts."
            : "Self-contained HTML fragment or document, up to 5,000,000 UTF-8 bytes, with embedded styles and optional inline scripts. Use sourceFile for large documents." },
          ...(legacy ? {} : { sourceFile: { type: "string", description: "Filename of a self-contained .html file in the current run's workspace staging directory. Use the run's file tools or an approved generation command to create it. If the directory is unknown, submit the intended filename first to learn the directory, then create the file and retry." } }),
          layout: { enum: ["standard", "wide"] },
          interaction: { enum: ["native", "script"], description: "Use script when the user should be offered an explicit Run interactive preview action." },
          preferredHeight: { type: "integer", minimum: 160, maximum: legacy ? 480 : 640 },
        },
      } as ToolDefinition["parameters"],
      executionMode: "sequential",
      async execute(toolCallId, input, signal) {
        if (!options.onConversationVisualization || !options.runId || !options.onToolBefore) {
          throw new Error("Conversation visualization publishing is unavailable in this run.");
        }
        const activeSignal = AbortSignal.any([options.signal, signal].filter((value): value is AbortSignal => value !== undefined));
        activeSignal.throwIfAborted();
        const result = await options.onConversationVisualization({ toolCallId, input, signal: activeSignal });
        activeSignal.throwIfAborted();
        return adapt(toolCallId, CONVERSATION_VISUALIZATION_TOOL, result);
      },
    });
  };
}
