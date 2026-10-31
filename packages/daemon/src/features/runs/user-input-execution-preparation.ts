import { isDeepStrictEqual } from "node:util";
import type { RunSession, RunStore, UserInputContinuationClaim, UserInputContinuationExecutionPlan,
  UserInputSnapshotRef } from "@ling-stack/core";
import { PiRunnerAdapter, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../../context.js";
import { HttpError } from "../../errors.js";
import { restorePackagedSkillContext } from "../skills/packaged-runtime.js";
import { assertPreparedRunnerMemoryCurrent, capturePreparedRunnerInput, readPreparedRunnerInput,
  restorePreparedRunnerOptions, type PreparedRunnerInput } from "./prepared-runner-input.js";
import { prepareUserInputContinuationRequest, readUserInputContinuationPreparedRequest } from "./user-input-prepared-request.js";
import { readUserInputSourceExecution } from "./user-input-source-execution.js";
import type { RunRequest } from "./schemas.js";

export interface UserInputExecutionPreparationFacts {
  readonly request: RunRequest;
  readonly source: RunSession;
  readonly sourceExecution: PreparedRunnerInput;
}

export interface UserInputPreparedExecution {
  readonly ref: UserInputSnapshotRef;
  readonly request: RunRequest;
  readonly execution: PreparedRunnerInput;
}

const coreTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** Prepare only. The Host still owns current admission, successor dispatch and receiver ACK. */
export async function prepareUserInputContinuationExecution(input: {
  readonly store: RunStore;
  readonly claim: UserInputContinuationClaim;
  readonly runnerId: string;
  readonly adapter: RunnerAdapter;
  readonly currentOptions: PiRunnerRunOptions;
  readonly now: () => string;
  readonly assertCurrent: (facts: UserInputExecutionPreparationFacts) => void;
}): Promise<UserInputPreparedExecution> {
  if (!(input.adapter instanceof PiRunnerAdapter) || input.runnerId !== "pi") {
    throw new HttpError(409, "user_input_receiver_unverified", "Continuation preparation requires the verified Pi adapter.");
  }
  const { store, adapter } = input;
  const claim = freeze(structuredClone(input.claim));
  const request = prepareUserInputContinuationRequest(store, claim, input.now());
  const facts = store.readSnapshot(() => {
    const seed = store.getUserInputContinuationSeed(claim.threadId, claim.deliveryId);
    const source = seed && store.getRun(seed.source.runId);
    if (!seed || !source) throw changedSource();
    return freeze({ request: request.request, source, sourceExecution: readUserInputSourceExecution(store, source, seed) });
  });

  const checkCurrent = (): PiRunnerRunOptions => {
    input.currentOptions.signal?.throwIfAborted();
    const currentRequest = readUserInputContinuationPreparedRequest(store, claim.threadId, claim.deliveryId);
    if (!currentRequest || !isDeepStrictEqual(currentRequest, request)
      || facts.sourceExecution.runnerId !== input.runnerId
      || input.currentOptions.cwd !== facts.sourceExecution.input.cwd
      || input.currentOptions.task.id !== request.request.task.id
      || input.currentOptions.task.channelId !== request.request.task.channelId) throw changedSource();
    for (const tool of facts.sourceExecution.preparedInput.tools) {
      if (coreTools.has(tool.name) && !input.currentOptions.tools?.some(name => name === tool.name)) {
        throw new HttpError(409, "user_input_core_tool_revoked", "A core tool from the original execution is no longer admitted.");
      }
    }
    const restored = restorePreparedRunnerOptions(facts.sourceExecution, input.currentOptions);
    assertPreparedRunnerMemoryCurrent(store, request.request, facts.sourceExecution);
    restorePackagedSkillContext(facts.sourceExecution.skillSourceContext, facts.source.selectedSkillId);
    const checked: unknown = input.assertCurrent(facts);
    if (checked && typeof (checked as { then?: unknown }).then === "function") {
      throw new HttpError(409, "user_input_policy_check_not_synchronous", "Continuation policy checks must complete before publishing execution input.");
    }
    return { ...restored, task: request.request.task, preparedInput: undefined };
  };

  const options = checkCurrent();
  const preparedInput = await adapter.prepareTaskInput(options);
  const current = checkCurrent();
  const { userPrompt: _oldPrompt, fingerprint: _oldFingerprint, ...sourceSurface } = facts.sourceExecution.preparedInput;
  const { userPrompt: _newPrompt, fingerprint: _newFingerprint, ...preparedSurface } = preparedInput;
  if (!isDeepStrictEqual(sourceSurface, preparedSurface)) {
    throw new HttpError(409, "user_input_execution_surface_changed", "The actual SDK system, model or tool input changed; continuation was not silently rebuilt.");
  }
  const execution = capturePreparedRunnerInput({ runnerId: input.runnerId,
    options: { ...current, mcpTools: facts.sourceExecution.input.mcpTools }, preparedInput,
    usedMemory: facts.sourceExecution.usedMemory, skillSourceContext: facts.sourceExecution.skillSourceContext });
  const runRequestSnapshot = json({ ...request.request, runnerExecutionInput: execution });
  const plan = json({ schemaVersion: 1, runnerId: input.runnerId,
    providerName: execution.input.provider.provider, providerModel: execution.input.provider.model,
    providerPresetId: facts.source.providerPresetId, selectedSkillId: facts.source.selectedSkillId,
    taskSnapshot: execution.input.task, providerSnapshot: execution.input.provider, requestSnapshot: request.request,
    runRequestSnapshot, preparedInput, preparedInputFingerprint: preparedInput.fingerprint, runnerExecutionInput: execution });
  const saved = store.saveUserInputContinuationPreparation({ ...claim, stage: "execution",
    parentRef: request.ref, payload: plan }, input.now()).snapshot;
  if (!isDeepStrictEqual(saved.payload, plan)) {
    throw new HttpError(409, "user_input_execution_preparation_changed", "The first prepared execution differs; it was not overwritten.");
  }
  const stored = saved.payload as UserInputContinuationExecutionPlan;
  return freeze({ ref: { id: saved.id, fingerprint: saved.fingerprint }, request: request.request,
    execution: readPreparedRunnerInput(stored.runnerExecutionInput, { cwd: request.request.cwd, task: request.request.task }) });
}

function changedSource(): HttpError {
  return new HttpError(409, "user_input_execution_source_changed", "Continuation no longer matches its original task, workspace or Runner.");
}

function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
