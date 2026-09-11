import { isDeepStrictEqual } from "node:util";
import { type RunStore, type SkillSourceRuntimeContext } from "@ling-stack/core";
import { type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../../context.js";
import { HttpError } from "../../errors.js";
import type { RunRequest } from "../runs/schemas.js";
import { readNormalConversationPreparedRequest } from "./normal-conversation-prepared-request.js";

import { capturePreparedRunnerInput, readPreparedRunnerInput, assertPreparedRunnerMemoryCurrent,
  type PreparedRunnerInput } from "../runs/prepared-runner-input.js";
export { restorePreparedRunnerOptions as restoreNormalConversationExecutionOptions,
  assertPreparedRunnerMemoryCurrent as assertPreparedExecutionMemoryCurrent } from "../runs/prepared-runner-input.js";
export type NormalConversationExecutionPayload = PreparedRunnerInput;

export interface NormalConversationPreparedExecution {
  readonly ref: { readonly id: string; readonly fingerprint: string };
  readonly payload: NormalConversationExecutionPayload;
}

/** Read before resolving Memory/Skill source/tools. The winning request is the sole parent. */
export function readNormalConversationPreparedExecution(store: RunStore, request: RunRequest): NormalConversationPreparedExecution | undefined {
  if (!request.normalConversationPreparedRequestRef) {
    if (request.normalConversationPreparedExecutionRef) throw new Error("Prepared execution has no request parent");
    return undefined;
  }
  const sourceId = validateParent(store, request);
  const snapshot = store.getConversationPreparedInput(sourceId, "execution");
  if (!snapshot) {
    if (request.normalConversationPreparedExecutionRef) throw new Error("Prepared execution required by Run is missing");
    return undefined;
  }
  const ref = { id: snapshot.id, fingerprint: snapshot.fingerprint };
  if (request.normalConversationPreparedExecutionRef && !isDeepStrictEqual(request.normalConversationPreparedExecutionRef, ref)) {
    throw new Error("Prepared execution and Run reference mismatch");
  }
  if (snapshot.parentSnapshotId !== request.normalConversationPreparedRequestRef.id ||
    snapshot.parentFingerprint !== request.normalConversationPreparedRequestRef.fingerprint) throw new Error("Prepared execution parent mismatch");
  return { ref, payload: readPreparedRunnerInput(snapshot.payload, request) };
}

/** No SQL transaction crosses SDK preparation. Only the store decides the concurrent winner. */
export async function prepareNormalConversationExecution(input: {
  readonly store: RunStore;
  readonly request: RunRequest;
  readonly runnerId: string;
  readonly adapter: RunnerAdapter;
  readonly options: PiRunnerRunOptions;
  readonly usedMemory?: RunRequest["preselectedMemoryUse"];
  readonly skillSourceContext?: SkillSourceRuntimeContext;
  readonly assertCurrent: () => void;
}): Promise<NormalConversationPreparedExecution | undefined> {
  if (!input.request.normalConversationPreparedRequestRef) return undefined;
  const existing = readNormalConversationPreparedExecution(input.store, input.request);
  if (existing) { input.assertCurrent(); return existing; }
  if (!input.adapter.prepareTaskInput) throw new HttpError(409, "runner_input_preparation_unavailable",
    "This runner does not expose a verified input preparation boundary.");
  input.assertCurrent();
  const preparedInput = await input.adapter.prepareTaskInput(input.options);
  input.assertCurrent();
  const payload = capturePreparedRunnerInput({ ...input, preparedInput });
  const sourceItemId = validateParent(input.store, input.request);
  assertPreparedRunnerMemoryCurrent(input.store, input.request, payload);
  input.store.saveConversationPreparedInput({ sourceItemId, stage: "execution",
    parentSnapshotId: input.request.normalConversationPreparedRequestRef.id,
    parentFingerprint: input.request.normalConversationPreparedRequestRef.fingerprint, payload }, new Date().toISOString());
  return readNormalConversationPreparedExecution(input.store, input.request)!;
}

function validateParent(store: RunStore, request: RunRequest): string {
  const sourceId = request.normalConversationContext?.hydration.source.itemId;
  if (!sourceId || !readNormalConversationPreparedRequest(store, sourceId, request)) throw new Error("Prepared execution request parent is missing");
  return sourceId;
}
