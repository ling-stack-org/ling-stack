import { isDeepStrictEqual } from "node:util";
import { toRuntimeAttemptFence, type RunSession, type RunStore, type UserInputContinuationSeed } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { readPreparedRunnerInput, type PreparedRunnerInput } from "./prepared-runner-input.js";

/**
 * Read the exact source execution, not a fresh selection or a restored grant.
 * The enclosing request builder already owns a SQLite read snapshot. Missing
 * SDK evidence has no raw-request fallback; old Runs are never recaptured.
 */
export function readUserInputSourceExecution(
  store: Pick<RunStore, "getWorkUnitAttempt">, source: RunSession, seed: UserInputContinuationSeed,
): PreparedRunnerInput {
  const binding = seed.source;
  if (source.id !== binding.runId || source.workUnitId !== binding.fence.workUnitId
    || source.threadId !== binding.threadId || source.taskId !== binding.taskBinding.taskId
    || source.channelId !== binding.channelId || source.cwd !== binding.cwd
    || (source.teammateId ?? "ling_agent") !== binding.participantId || source.workflowStepId !== binding.workflowStepId) throw invalid();
  const attempt = store.getWorkUnitAttempt(binding.fence.attemptId);
  if (!attempt || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), binding.fence)) throw invalid();
  const value = isRecord(source.requestSnapshot) ? source.requestSnapshot.runnerExecutionInput : undefined;
  if (!isRecord(value) || !isRecord(value.input) || !isRecord(value.input.task)) throw invalid();
  const task = value.input.task;
  if (task.id !== source.taskId || typeof task.title !== "string" || !task.title.trim()
    || typeof task.prompt !== "string" || !task.prompt.trim() || task.channelId !== source.channelId) throw invalid();
  let execution: PreparedRunnerInput;
  try {
    execution = readPreparedRunnerInput(value, {
      cwd: source.cwd,
      task: task as unknown as PreparedRunnerInput["input"]["task"],
    });
  } catch { throw invalid(); }
  if (execution.runnerId !== attempt.effectiveRunnerId
    || execution.input.provider.provider !== source.providerName || execution.input.provider.model !== source.providerModel
    || execution.preparedInput.model.provider !== source.providerName || execution.preparedInput.model.id !== source.providerModel) throw invalid();
  return execution;
}
function invalid(): HttpError {
  return new HttpError(409, "user_input_source_request_invalid", "The source Run has no valid, owned SDK execution input; continuation was not rebuilt from an older request.");
}
