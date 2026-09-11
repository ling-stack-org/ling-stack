import { createHash } from "node:crypto";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiRunnerRunOptions, PiRunnerTask } from "./types.js";
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
  if (!options.preparedInput) return;
  const expected = readPreparedPiInput(options.preparedInput);
  if (capturePreparedPiInput(session, options).fingerprint !== expected.fingerprint) throw new Error("Pi prepared input changed during session initialization");
}

/** The first converted model Context must still match after SDK/extension assembly. */
export function assertPreparedPiModelContext(prepared: PiRunnerPreparedInput, model: Model<Api>, context: Context): void {
  const expected = readPreparedPiInput(prepared);
  const first = context.messages[0];
  const text = first?.role === "user" ? (typeof first.content === "string" ? first.content :
    first.content.every((block) => block.type === "text") ? first.content.map((block) => block.type === "text" ? block.text : "").join("") : undefined) : undefined;
  if (context.messages.length !== 1 || text !== expected.userPrompt || (context.systemPrompt ?? "") !== expected.systemPrompt ||
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
