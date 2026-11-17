import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RunSession } from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";

export const rerunDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const rerunRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Core verifies the only permitted SDK delta independently of the Host's SDK parser. */
export function readReboundNodeRerunExecution(source: RunSession, taskId: string, value: unknown): {
  readonly task: { readonly id: string; readonly title: string; readonly prompt: string; readonly channelId?: string };
  readonly runnerExecutionInput: Record<string, unknown>;
  readonly effectivePolicySnapshot: Record<string, unknown>;
} | undefined {
  const request = source.requestSnapshot, sourceTask = source.taskSnapshot;
  if (!rerunRecord(request) || !rerunRecord(sourceTask) || !rerunRecord(request.effectivePolicySnapshot)
    || sourceTask.id !== source.taskId || sourceTask.channelId !== source.channelId || !taskId || taskId === source.taskId
    || typeof sourceTask.title !== "string" || !sourceTask.title.trim() || typeof sourceTask.prompt !== "string") return undefined;
  const original = request.runnerExecutionInput;
  if (!rerunRecord(original) || !rerunRecord(original.input) || !rerunRecord(original.preparedInput)
    || original.schemaVersion !== 1 || original.runnerId !== "pi" || original.input.cwd !== source.cwd
    || !rerunRecord(original.input.provider) || original.input.provider.provider !== source.providerName
    || original.input.provider.model !== source.providerModel
    || !isDeepStrictEqual(redactSecrets(original), original)) return undefined;
  const task = { id: taskId, title: sourceTask.title, prompt: sourceTask.prompt,
    ...(source.channelId ? { channelId: source.channelId } : {}) };
  if (!isDeepStrictEqual(original.input.task, { ...task, id: source.taskId })
    || original.preparedInput.taskId !== source.taskId || typeof original.preparedInput.fingerprint !== "string") return undefined;
  const { fingerprint: originalFingerprint, ...body } = original.preparedInput;
  if (originalFingerprint !== rerunDigest(body)) return undefined;
  const rebound = { ...body, taskId };
  const expected = { ...original, input: { ...original.input, task },
    preparedInput: { ...rebound, fingerprint: rerunDigest(rebound) } };
  if (!isDeepStrictEqual(expected, value) || !isDeepStrictEqual(redactSecrets(value), value)) return undefined;
  return { task, runnerExecutionInput: expected, effectivePolicySnapshot: request.effectivePolicySnapshot };
}
