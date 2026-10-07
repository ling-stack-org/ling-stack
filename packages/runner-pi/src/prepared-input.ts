import { createHash } from "node:crypto";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiRunnerRunOptions, PiRunnerTask } from "./types.js";
import { boundModelToolResults, MODEL_TOOL_CONTEXT_BYTES } from "./model-context-budget.js";
import { formatTaskPrompt, isRecord } from "./utils.js";

type PreparedModel = Pick<Model<Api>, "id" | "provider" | "api" | "baseUrl" | "reasoning" | "input" | "contextWindow" | "maxTokens" | "compat" | "thinkingLevelMap">;

/** Immutable model-visible input. Credentials, transport IDs and handlers are excluded. */
export interface PiRunnerPreparedInput {
  readonly schemaVersion: 1;
  readonly boundary: "pi-model-context";
  readonly taskId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly model: PreparedModel;
  readonly thinkingLevel: string;
  readonly tools: readonly Tool[];
  readonly fingerprint: string;
}

/** Capture the SDK's actual assembly, not a second approximation of its prompt builder. */
export function capturePreparedPiInput(session: AgentSession, options: PiRunnerRunOptions): PiRunnerPreparedInput {
  if (!session.model || !session.isIdle || session.messages.length !== 0) throw new Error("Pi prepared input requires an idle empty session");
  const body = json({ schemaVersion: 1, boundary: "pi-model-context", taskId: options.task.id,
    systemPrompt: session.systemPrompt, userPrompt: formatTaskPrompt(options.task), model: modelDescriptor(session.model),
    thinkingLevel: session.thinkingLevel, tools: toolDescriptors(session.state.tools) });
  return readPreparedPiInput({ ...body, fingerprint: hash(body) });
}

/** Fit the transport-only tool view to the remaining model capacity on every request. */
export function assertPiModelContextCapacity(model: Model<Api>, context: Context): Context {
  // The SDK can report a context-hook failure and continue. Enforce the
  // projection's fail-closed marker budget again at the provider boundary.
  const budget = modelInputBudget(model);
  const fixedTokens = estimatePreparedTokens(context.systemPrompt ?? "")
    + estimatePreparedTokens(JSON.stringify(context.tools ?? []));
  const projected = boundModelToolResults(context.messages);
  const inputTokens = (messages: readonly unknown[]): number => fixedTokens + estimatePreparedTokens(JSON.stringify(messages));
  if (inputTokens(projected.messages) <= budget) {
    return { ...context, messages: projected.messages as Context["messages"] };
  }
  if (projected.originalBytes === 0) {
    throw modelCapacityError(inputTokens(projected.messages), budget);
  }

  // A fixed tool cap may still exceed a small model's available context. Find
  // the largest transport-only result view that fits, reserving explicit
  // omission markers for every result. Invalid marker budgets never pass.
  let low = 0;
  let high = Math.min(MODEL_TOOL_CONTEXT_BYTES, projected.modelBytes);
  let fitting: Context["messages"] | undefined;
  let minimumInput = inputTokens(projected.messages);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let candidate;
    try {
      candidate = boundModelToolResults(context.messages, { totalBytes: middle });
    } catch (error) {
      if (!(error instanceof Error) || !/marker.*budget/u.test(error.message)) throw error;
      low = middle + 1;
      continue;
    }
    const estimated = inputTokens(candidate.messages);
    minimumInput = Math.min(minimumInput, estimated);
    if (estimated <= budget) {
      fitting = candidate.messages as Context["messages"];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!fitting) throw modelCapacityError(minimumInput, budget);
  return { ...context, messages: fitting };
}

function modelInputBudget(model: Pick<Model<Api>, "contextWindow" | "maxTokens">): number {
  const window = model.contextWindow;
  const output = model.maxTokens;
  if (!Number.isSafeInteger(window) || window < 1 || !Number.isSafeInteger(output) || output < 1) {
    throw new Error("Pi prepared input model context capacity is unknown");
  }
  const runtimeOverhead = 512;
  const inputBudget = window - output - runtimeOverhead;
  if (inputBudget < 1) throw modelCapacityError(0, inputBudget);
  return inputBudget;
}

function modelCapacityError(estimatedInput: number, budget: number): Error {
  return new Error(`Pi model context exceeds selected model budget (${estimatedInput}/${Math.max(0, budget)} estimated input tokens)`);
}

function estimatePreparedTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.6);
}

/** Validate serialized evidence before using it as a comparison baseline. */
export function readPreparedPiInput(value: unknown): PiRunnerPreparedInput {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !==
    ["schemaVersion", "boundary", "taskId", "systemPrompt", "userPrompt", "model", "thinkingLevel", "tools", "fingerprint"].sort().join(",") ||
    value.schemaVersion !== 1 || value.boundary !== "pi-model-context" ||
    !["taskId", "systemPrompt", "userPrompt", "thinkingLevel", "fingerprint"].every((key) => typeof value[key] === "string") ||
    !isRecord(value.model) || typeof value.model.id !== "string" || typeof value.model.provider !== "string" ||
    Object.keys(value.model).some((key) => !["id", "provider", "api", "baseUrl", "reasoning", "input", "contextWindow", "maxTokens", "compat", "thinkingLevelMap"].includes(key)) ||
    !Array.isArray(value.tools) || value.tools.some((tool) => !isRecord(tool) || typeof tool.name !== "string" ||
      typeof tool.description !== "string" || !isRecord(tool.parameters) || Object.keys(tool).some((key) =>
        !["name", "description", "parameters", "constrainedSampling"].includes(key))) ||
    new Set(value.tools.map((tool) => tool.name)).size !== value.tools.length) throw new Error("Invalid Pi prepared input");
  const { fingerprint, ...body } = value;
  if (fingerprint !== hash(body)) throw new Error("Pi prepared input fingerprint mismatch");
  return freeze(json(value)) as unknown as PiRunnerPreparedInput;
}

/** Match decoded model evidence to the Host task without duplicating SDK prompt formatting in consumers. */
export function assertPreparedPiTaskInput(prepared: PiRunnerPreparedInput, task: PiRunnerTask): void {
  if (prepared.taskId !== task.id || prepared.userPrompt !== formatTaskPrompt(task)) {
    throw new Error("Prepared execution task prompt mismatch");
  }
}

/** Fail before prompting if initialization cannot reproduce the persisted input. */
export function assertPreparedPiSession(session: AgentSession, options: PiRunnerRunOptions): void {
  const actual = capturePreparedPiInput(session, options);
  if (!options.preparedInput) return;
  const expected = readPreparedPiInput(options.preparedInput);
  if (actual.fingerprint !== expected.fingerprint) throw new Error("Pi prepared input changed during session initialization");
}

/** The first converted model Context must still match after SDK/extension assembly. */
export function assertPreparedPiModelContext(
  prepared: PiRunnerPreparedInput,
  model: Model<Api>,
  context: Context,
  options: { readonly allowRestoredMessages?: boolean } = {},
): void {
  const expected = readPreparedPiInput(prepared);
  const first = context.messages[0];
  const text = first?.role === "user" ? (typeof first.content === "string" ? first.content :
    first.content.every((block) => block.type === "text") ? first.content.map((block) => block.type === "text" ? block.text : "").join("") : undefined) : undefined;
  const messagesMatch = options.allowRestoredMessages
    ? context.messages.length > 0
    : context.messages.length === 1 && text === expected.userPrompt;
  if (!messagesMatch || (!options.allowRestoredMessages && text !== expected.userPrompt) || (context.systemPrompt ?? "") !== expected.systemPrompt ||
    hash(modelDescriptor(model)) !== hash(expected.model) || hash(toolDescriptors(context.tools ?? [])) !== hash(expected.tools)) {
    throw new Error("Pi prepared input changed before the first model request");
  }
}

function modelDescriptor(model: Model<Api>): PreparedModel {
  return json({ id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl, reasoning: model.reasoning,
    input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens, compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap });
}
function toolDescriptors(tools: readonly Tool[]): Tool[] {
  return tools.map(({ name, description, parameters, constrainedSampling }) => json({ name, description, parameters,
    ...(constrainedSampling !== undefined ? { constrainedSampling } : {}) }));
}
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
