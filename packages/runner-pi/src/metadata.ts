import type { RunnerExtensionMetadata } from "@ling-stack/plugin-sdk";
import { DEFAULT_TOOLS, SUPPORTED_PROVIDER_APIS } from "./constants.js";

export const PI_RUNNER_EXTENSION_ID = "runner:pi";

export function getPiRunnerExtension(): RunnerExtensionMetadata {
  return {
    manifest: {
      id: PI_RUNNER_EXTENSION_ID,
      name: "Pi Runner",
      version: "0.1.0",
      kind: "runner",
      trustLevel: "internal",
      capabilities: [
        "runner:pi",
        ...DEFAULT_TOOLS.map((tool) => `tool:${tool}`),
        ...SUPPORTED_PROVIDER_APIS.map((api) => `provider-api:${api}`),
      ],
      requiredApprovals: [
        {
          decision: "ask",
          risk: "medium",
          tools: ["bash", "edit", "write"],
          reason: "Pi runner can invoke local tools; risky tools remain gated by approval policy.",
        },
      ],
    },
    runnerId: "pi",
    supportedTools: [...DEFAULT_TOOLS],
    supportedProviderApis: [...SUPPORTED_PROVIDER_APIS],
    eventTypes: [
      "run_start",
      "turn_start",
      "turn_end",
      "assistant_text_delta",
      "assistant_thinking_delta",
      "tool_start",
      "tool_update",
      "tool_end",
      "message_end",
      "run_end",
      "run_error",
    ],
  };
}
