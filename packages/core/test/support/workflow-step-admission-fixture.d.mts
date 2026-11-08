import type { SQLOutputValue } from "node:sqlite";
import type { TestContext } from "node:test";
import type { AcquireRuntimeSemaphoreSlotInput, BeginChannelWorkflowStepStartInput, ChannelWorkflow,
  ChannelWorkflowStep, ResourceLease, RuntimeAttemptFenceV1, RunSession,
  SqliteRunStore, Task, WorkflowStepAdmissionEntry, WorkflowStepAdmissionPlan, WorkflowStepStartOwnerV1,
  WorkUnit, WorkUnitAttempt } from "../../dist/index.js";

export const admissionParticipant: string;
export type AdmissionPlan = { entries: WorkflowStepAdmissionEntry[]; resourceKeys: string[] };
export type AdmissionScope = { workflow: ChannelWorkflow; step: ChannelWorkflowStep; plan: AdmissionPlan };
export type AdmissionGeneration = { task: Task; owner: WorkflowStepStartOwnerV1; input: BeginChannelWorkflowStepStartInput; status: "begun" };
export type AdmissionOwner = { unit: WorkUnit; attempt: WorkUnitAttempt; fence: RuntimeAttemptFenceV1 };
export type AdmissionPreparedRun = AdmissionOwner & { run: RunSession };
type Snapshot = Record<string, Record<string, SQLOutputValue>[]>;
type Input<M extends keyof SqliteRunStore> = SqliteRunStore[M] extends (input: infer I, ...args: never[]) => unknown ? I : never;
type Result<M extends keyof SqliteRunStore> = SqliteRunStore[M] extends (...args: never[]) => infer R ? R : never;

export interface WorkflowAdmissionFixture {
  root: string;
  cwd: string;
  paths: SqliteRunStore["paths"];
  at(tick: number): string;
  store: SqliteRunStore;
  peer: SqliteRunStore;
  channel: ReturnType<SqliteRunStore["createChannel"]>;
  plan(overrides?: Partial<WorkflowStepAdmissionPlan>): AdmissionPlan;
  scope(name: string, options?: { plan?: WorkflowStepAdmissionPlan; metadata?: NonNullable<ChannelWorkflowStep["metadata"]> }): AdmissionScope;
  current(scope: AdmissionScope): ChannelWorkflowStep;
  expected(scope: AdmissionScope): BeginChannelWorkflowStepStartInput["expected"];
  lease(scope: AdmissionScope, now?: string, store?: SqliteRunStore): ResourceLease;
  input(scope: AdmissionScope, lease?: ResourceLease, overrides?: Partial<BeginChannelWorkflowStepStartInput>): BeginChannelWorkflowStepStartInput;
  begin(scope: AdmissionScope, input?: BeginChannelWorkflowStepStartInput, store?: SqliteRunStore): AdmissionGeneration;
  prepare(scope: AdmissionScope, generation: Pick<AdmissionGeneration, "task"> & Partial<Pick<AdmissionGeneration, "owner">>, name?: string,
    options?: { claim?: boolean; runnerId?: string; threadId?: string; turnId?: string }): AdmissionPreparedRun;
  outsider(name: string): AdmissionOwner;
  slotInput(current: Pick<AdmissionOwner, "attempt" | "fence">, entry: Pick<AcquireRuntimeSemaphoreSlotInput, "resourceType" | "resourceKey" | "limit">,
    overrides?: Partial<AcquireRuntimeSemaphoreSlotInput>): AcquireRuntimeSemaphoreSlotInput;
  transferInput(scope: AdmissionScope, generation: AdmissionGeneration, prepared: AdmissionPreparedRun,
    overrides?: Partial<Input<"transferChannelWorkflowStepStartAdmission">>): Input<"transferChannelWorkflowStepStartAdmission">;
  transfer(scope: AdmissionScope, generation: AdmissionGeneration, prepared: AdmissionPreparedRun,
    overrides?: Partial<Input<"transferChannelWorkflowStepStartAdmission">>, store?: SqliteRunStore): Result<"transferChannelWorkflowStepStartAdmission">;
  ready(scope: AdmissionScope, generation: AdmissionGeneration, prepared: AdmissionPreparedRun,
    overrides?: Partial<Input<"commitChannelWorkflowStepRunReady">>): Result<"commitChannelWorkflowStepRunReady">;
  release(scope: AdmissionScope, generation: AdmissionGeneration, prepared?: AdmissionPreparedRun,
    overrides?: Partial<Input<"releaseChannelWorkflowStepStartAdmission">>, store?: SqliteRunStore): Result<"releaseChannelWorkflowStepStartAdmission">;
  settle(scope: AdmissionScope, generation: AdmissionGeneration,
    overrides?: Partial<Input<"settleChannelWorkflowStepStartFailure">>): Result<"settleChannelWorkflowStepStartFailure">;
  admission(scope: AdmissionScope, generation: AdmissionGeneration, store?: SqliteRunStore): Result<"getChannelWorkflowStepStartAdmission">;
  snapshot(): Snapshot;
  count(table: string): number;
  reopen(which?: "store" | "peer"): SqliteRunStore;
}

export function admissionSnapshot(store: object): Snapshot;
export function workflowAdmissionFixture(t: TestContext, options?: {
  runtimeHostCapacityBinding?: import("../../dist/runtime-host-capacity-store-bridge.js").RuntimeHostCapacityStoreBinding;
}): Promise<WorkflowAdmissionFixture>;
export function workflowResumeAdmissionFixture(t: TestContext, options?: { retainSourceSlots?: boolean }): Promise<WorkflowAdmissionFixture & {
  scopeResume: AdmissionScope;
  generation: AdmissionGeneration;
  source: AdmissionPreparedRun;
  target: NonNullable<ReturnType<SqliteRunStore["prepareContinuationAndAttempt"]>>;
  resumeInput(overrides?: Partial<Input<"resumeChannelWorkflowStepStartAdmission">>): Input<"resumeChannelWorkflowStepStartAdmission">;
  resume(overrides?: Partial<Input<"resumeChannelWorkflowStepStartAdmission">>, store?: SqliteRunStore): Result<"resumeChannelWorkflowStepStartAdmission">;
}>;

type RaceMethod = "beginChannelWorkflowStepStart" | "acquireRuntimeSemaphoreSlot" | "acquireRuntimeSemaphoreSlots"
  | "transferChannelWorkflowStepStartAdmission" | "resumeChannelWorkflowStepStartAdmission"
  | "enqueueRuntimeRun" | "claimNextRuntimeRun" | "dispatchRuntimeQueuedRun";
export function admissionRace<M extends RaceMethod>(t: TestContext, fixture: Pick<WorkflowAdmissionFixture, "cwd" | "paths">,
  operations: { method: M; input: Parameters<SqliteRunStore[M]>[0] }[]): Promise<ReturnType<SqliteRunStore[M]>[]>;
