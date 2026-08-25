import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeHandledToolResult } from "../content.js";
import type {
  PiRunnerMediaGenerationToolCallRequest,
  PiRunnerMediaGenerationToolDefinition,
  PiRunnerMediaGenerationToolName,
  PiRunnerRunOptions,
} from "../types.js";
import { isRecord } from "../utils.js";

export function createLingStackMediaGenerationExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    if (!options.runId || !options.onMediaGenerationToolCall) {
      return;
    }
    for (const definition of dedupeDefinitions(options.mediaGenerationTools ?? [])) {
      pi.registerTool(createToolDefinition(options, definition));
    }
  };
}

function createToolDefinition(
  options: PiRunnerRunOptions,
  definition: PiRunnerMediaGenerationToolDefinition,
): ToolDefinition {
  const mediaKind = definition.name === "image_generate" ? "image" : "video";
  const targetSummary = definition.targets
    .map((target) => `${target.displayName} (${target.id}; ${targetCapabilities(target)})`)
    .join(", ");
  return {
    name: definition.name,
    label: definition.name,
    description: [
      `Generate a ${mediaKind} using a generation target configured in Ling Stack.`,
      "Use this tool when the user asks for generated media in natural language.",
      "If the user explicitly names a target, pass that name or id in target; otherwise omit target and let Ling Stack apply the workspace routing policy.",
      `Available targets: ${targetSummary}.`,
      "The tool accepts the job for background execution and does not wait for long-running generation to finish.",
    ].join(" "),
    promptSnippet: `Generate a ${mediaKind} with a Ling Stack media target`,
    parameters: createParameters(definition),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      if (!options.runId || !options.onMediaGenerationToolCall) {
        throw new Error(`Ling Stack ${definition.name} is not connected for this run.`);
      }
      const request = parseToolRequest(options, definition.name, toolCallId, params, signal);
      signal?.throwIfAborted();
      const result = await options.onMediaGenerationToolCall(request);
      signal?.throwIfAborted();
      return normalizeHandledToolResult(result);
    },
  };
}

function targetCapabilities(target: PiRunnerMediaGenerationToolDefinition["targets"][number]): string {
  const capabilities = ["prompt"];
  if (target.supportsAspectRatio) {
    capabilities.push(target.aspectRatios?.length
      ? `aspectRatio=${target.aspectRatios.join("|")}`
      : "aspectRatio");
  }
  if (target.supportsDurationSeconds) {
    capabilities.push(target.durationsSeconds?.length
      ? `durationSeconds=${target.durationsSeconds.join("|")}`
      : "durationSeconds");
  }
  if (target.supportsCount) capabilities.push("count=1..4");
  return capabilities.join(", ");
}

function createParameters(definition: PiRunnerMediaGenerationToolDefinition): ToolDefinition["parameters"] {
  const properties: Record<string, unknown> = {
    prompt: {
      type: "string",
      description: "The complete user-facing prompt for the generated media.",
      minLength: 1,
    },
    target: {
      type: "string",
      description: "Optional exact target display name or stable id explicitly requested by the user.",
      minLength: 1,
    },
  };
  if (definition.targets.some((target) => target.supportsAspectRatio)) {
    properties.aspectRatio = {
      type: "string",
      description: "Optional aspect ratio such as 1:1, 16:9, or 9:16.",
      minLength: 3,
    };
  }
  if (definition.name === "image_generate" && definition.targets.some((target) => target.supportsCount)) {
    properties.count = {
      type: "integer",
      description: "Optional number of images. Defaults to one.",
      minimum: 1,
      maximum: 4,
    };
  } else if (definition.name === "video_generate" && definition.targets.some((target) => target.supportsDurationSeconds)) {
    properties.durationSeconds = {
      type: "number",
      description: "Optional requested video duration in seconds.",
      exclusiveMinimum: 0,
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["prompt"],
  } as ToolDefinition["parameters"];
}

function parseToolRequest(
  options: PiRunnerRunOptions,
  toolName: PiRunnerMediaGenerationToolName,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
): PiRunnerMediaGenerationToolCallRequest {
  if (!isRecord(params)) {
    throw new Error(`${toolName} parameters must be an object.`);
  }
  const prompt = readRequiredString(params.prompt, "prompt");
  const target = readOptionalString(params.target, "target");
  const aspectRatio = readOptionalString(params.aspectRatio, "aspectRatio");
  const count = toolName === "image_generate" ? readOptionalNumber(params.count, "count", true) : undefined;
  const durationSeconds = toolName === "video_generate"
    ? readOptionalNumber(params.durationSeconds, "durationSeconds", false)
    : undefined;
  if (count !== undefined && (count < 1 || count > 4)) {
    throw new Error("count must be between 1 and 4.");
  }
  if (durationSeconds !== undefined && durationSeconds <= 0) {
    throw new Error("durationSeconds must be greater than 0.");
  }
  return {
    toolCallId,
    toolName,
    runId: options.runId!,
    prompt,
    target,
    aspectRatio,
    durationSeconds,
    count,
    task: options.task,
    cwd: options.cwd,
    signal,
  };
}

function readRequiredString(value: unknown, key: string): string {
  const result = readOptionalString(value, key);
  if (!result) {
    throw new Error(`${key} is required.`);
  }
  return result;
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalNumber(value: unknown, key: string, integer: boolean): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`${key} must be ${integer ? "an integer" : "a finite number"}.`);
  }
  return value;
}

function dedupeDefinitions(
  definitions: readonly PiRunnerMediaGenerationToolDefinition[],
): PiRunnerMediaGenerationToolDefinition[] {
  const byName = new Map<PiRunnerMediaGenerationToolName, PiRunnerMediaGenerationToolDefinition>();
  for (const definition of definitions) {
    if (definition.targets.length > 0) {
      byName.set(definition.name, definition);
    }
  }
  return [...byName.values()];
}
