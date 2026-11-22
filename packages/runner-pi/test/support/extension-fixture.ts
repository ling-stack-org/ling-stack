import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface FieldSchema {
  type?: string;
  minLength?: number;
  description: string;
  maxItems?: number;
  minItems?: number;
  const?: unknown;
  anyOf?: unknown[];
  required: string[];
  items: FieldSchema;
  additionalProperties?: boolean;
  properties: Record<string, FieldSchema>;
}

export type FixtureTool = Omit<ToolDefinition, "execute" | "parameters"> & {
  parameters: FieldSchema;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): ReturnType<ToolDefinition["execute"]>;
};

export function extensionAPI(tools: FixtureTool[], on?: ExtensionAPI["on"]): ExtensionAPI {
  // Direct calls in these tests omit the SDK UI context and update callback.
  const api: Pick<ExtensionAPI, "registerTool" | "on"> = {
    registerTool(tool) { tools.push(tool as unknown as FixtureTool); },
    on: on ?? (() => () => undefined),
  };
  return api as ExtensionAPI;
}
