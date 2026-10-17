import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import type { SaveUserInputContinuationPreparation, UserInputContinuationPreparation, UserInputContinuationExecutionPlan,
  UserInputPreparationStage } from "../../user-input-host-continuation-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteUserInputDeliveryStore } from "./user-input-delivery-store.js";
import type { UserInputSeedPorts } from "./user-input-continuation-records.js";
import { readUserInputDelivery } from "./user-input-delivery-records.js";
import { readUserInputContinuationSeed } from "./user-input-continuation-store.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { assertNonSensitiveUserInput, userInputHash, userInputTimestamp } from "./user-input-records.js";
import { makeUserInputContinuationRecord, readUserInputContinuationRecord, insertUserInputContinuationRecord,
  userInputContinuationRef as ref, sameUserInputValue as same, isUserInputRecord as record,
  requireUserInputRecordKeys, userInputEnvelopeKeys } from "./user-input-continuation-envelope.js";
import { normalizeStoredRunnerId } from "./runtime-work-mappers.js";

/** Owns preparation only. No Run/Attempt creation, models, permission or applied writes. */
export class SqliteUserInputPreparationStore {
  constructor(private readonly context: SqliteStoreContext, private readonly deliveries: SqliteUserInputDeliveryStore,
    private readonly ports: UserInputSeedPorts) {}

  seedWithinTransaction(threadId: string, deliveryId: string): UserInputContinuationSeed | undefined {
    const bound = readUserInputDelivery(this.context, this.ports, threadId, deliveryId);
    return bound ? readUserInputContinuationSeed(this.context, this.ports, bound) : undefined;
  }

  get(threadId: string, deliveryId: string, stage: UserInputPreparationStage): UserInputContinuationPreparation | undefined {
    assertStage(stage);
    return readSqliteSnapshot(this.context.database, () => {
      const seed = this.seedWithinTransaction(threadId, deliveryId);
      return seed ? this.readWithinTransaction(seed, stage) : undefined;
    });
  }

  save(input: SaveUserInputContinuationPreparation, now: string): { snapshot: UserInputContinuationPreparation; idempotentReplay: boolean } {
    userInputTimestamp(now);
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const saved = readSqliteWithinTransaction(this.context.database, () => {
        // Capture identity once while arbitrary input getters cannot mutate the claim.
        const captured = JSON.parse(JSON.stringify(input)) as SaveUserInputContinuationPreparation;
        assertStage(captured.stage);
        this.deliveries.assertContinuationClaim(captured, now);
        const seed = this.seedWithinTransaction(captured.threadId, captured.deliveryId);
        if (!seed) throw new UserInputStoreError("invalid_record");
        const parent = captured.stage === "request" ? seed : this.readWithinTransaction(seed, "request");
        if (!parent || !same(captured.parentRef, ref(parent))) throw new UserInputStoreError("source_conflict");
        const prior = this.readWithinTransaction(seed, captured.stage);
        if (prior) return { seed, snapshot: prior, idempotentReplay: true };
        if (captured.stage === "request") assertRequest(captured.payload, seed);
        else assertUserInputExecutionPlan(captured.payload, seed, (parent as UserInputContinuationPreparation).payload);
        assertNonSensitiveUserInput(captured.payload);
        const snapshot = makeUserInputContinuationRecord<UserInputContinuationPreparation>(this.context, seed, captured.stage,
          { stage: captured.stage, parentRef: ref(parent), payload: captured.payload }, now);
        return { seed, snapshot, idempotentReplay: false };
      });
      if (!saved.idempotentReplay) insertUserInputContinuationRecord(this.context, saved.seed, saved.snapshot);
      this.context.database.exec("COMMIT");
      return { snapshot: saved.snapshot, idempotentReplay: saved.idempotentReplay };
    } catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }

  readWithinTransaction(seed: UserInputContinuationSeed, stage: UserInputPreparationStage): UserInputContinuationPreparation | undefined {
    assertStage(stage);
    const value = readUserInputContinuationRecord<UserInputContinuationPreparation>(this.context, seed, stage);
    if (!value) return undefined;
    const parent = stage === "request" ? seed : this.readWithinTransaction(seed, "request");
    try {
      requireUserInputRecordKeys(value, [...userInputEnvelopeKeys, "stage", "parentRef", "payload"]);
      if (value.stage !== stage || !parent || !same(value.parentRef, ref(parent))
        || userInputTimestamp(value.createdAt) < userInputTimestamp(parent.createdAt)) throw new Error("parent");
      if (stage === "request") assertRequest(value.payload, seed);
      else assertUserInputExecutionPlan(value.payload, seed, (parent as UserInputContinuationPreparation).payload);
      assertNonSensitiveUserInput(value.payload);
      return value;
    } catch { throw new UserInputStoreError("invalid_record"); }
  }
}

function assertStage(value: unknown): asserts value is UserInputPreparationStage {
  if (value !== "request" && value !== "execution") throw new UserInputStoreError("invalid_input");
}
function assertRequest(value: unknown, seed: UserInputContinuationSeed): asserts value is Readonly<Record<string, unknown>> {
  const s = seed.source;
  if (!record(value) || !record(value.task) || value.task.id !== s.taskBinding.taskId || value.task.channelId !== s.channelId
    || value.cwd !== s.cwd || value.threadId !== s.threadId || value.turnId !== s.turnId || value.teammateId !== s.participantId
    || value.workflowStepId !== s.workflowStepId || value.parentRunId !== s.runId || value.continuationReason !== "user_input_answer") {
    throw new UserInputStoreError("source_conflict");
  }
}
/** Storage validates immutable identity; the selected adapter still validates its exact SDK DTO before dispatch. */
export function assertUserInputExecutionPlan(value: unknown, seed: UserInputContinuationSeed, request: unknown): asserts value is UserInputContinuationExecutionPlan {
  const keys = ["schemaVersion", "runnerId", "providerName", "providerModel", "providerPresetId", "selectedSkillId",
    "taskSnapshot", "providerSnapshot", "requestSnapshot", "runRequestSnapshot", "preparedInput", "preparedInputFingerprint", "runnerExecutionInput"];
  if (!record(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !keys.includes(key))
    || !["runnerId", "providerName", "providerModel", "preparedInputFingerprint"].every(key => typeof value[key] === "string" && value[key])
    || normalizeStoredRunnerId(value.runnerId as string) !== value.runnerId
    || !["providerPresetId", "selectedSkillId"].every(key => value[key] === undefined || typeof value[key] === "string" && value[key])
    || !record(value.taskSnapshot) || !record(value.providerSnapshot) || !record(value.requestSnapshot)
    || !record(value.runRequestSnapshot) || !record(value.preparedInput)
    || !same(value.requestSnapshot, request) || !same(value.taskSnapshot, value.requestSnapshot.task)
    || !same(value.taskSnapshot, value.runRequestSnapshot.task)
    || value.providerSnapshot.provider !== value.providerName || value.providerSnapshot.model !== value.providerModel
    || !same(value.runRequestSnapshot.runnerExecutionInput, value.runnerExecutionInput)
    || value.preparedInput.taskId !== seed.source.taskBinding.taskId || value.preparedInput.fingerprint !== value.preparedInputFingerprint) {
    throw new UserInputStoreError("source_conflict");
  }
  assertRequest(value.requestSnapshot, seed);
  assertRequest(value.runRequestSnapshot, seed);
  // The Core boundary validates shared identities, not Pi prompt/tool semantics.
  // A fingerprint-only plan cannot become the source of a second continuation.
  const execution = value.runnerExecutionInput;
  if (!record(execution) || execution.schemaVersion !== 1 || execution.runnerId !== value.runnerId
    || typeof execution.toolHydrationEnabled !== "boolean" || !record(execution.input)
    || execution.input.cwd !== seed.source.cwd || !same(execution.input.task, value.taskSnapshot)
    || !same(execution.input.provider, value.providerSnapshot) || !same(execution.preparedInput, value.preparedInput)) {
    throw new UserInputStoreError("source_conflict");
  }
  const { fingerprint, ...body } = value.preparedInput;
  if (fingerprint !== userInputHash(body)) throw new UserInputStoreError("source_conflict");
}
