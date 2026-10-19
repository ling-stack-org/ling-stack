import type { HarnessFeatureSnapshotV1 } from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";

export function createHarnessFeatureSnapshot(config: Pick<ResolvedDaemonConfig, "harness">): HarnessFeatureSnapshotV1 {
  return {
    schemaVersion: 1,
    continuations: config.harness.continuations.mode,
    toolBroker: config.harness.toolBroker.mode,
    evaluations: config.harness.evaluations.mode,
    evaluationModelGate: config.harness.evaluations.modelGate,
    delegations: config.harness.delegations.mode,
    delegationMaxDepth: config.harness.delegations.maxDepth,
  };
}

export * from "./continuations/native-handle.js";
export * from "./continuations/coordinator.js";
export * from "./continuations/daemon-recovery-coordinator.js";
export * from "./continuations/reconstruction.js";
export * from "./continuations/replay-package.js";
export * from "./tool-execution/broker.js";
export * from "./evaluations/rule-grader.js";
export * from "./evaluations/scheduler.js";
export * from "./evaluations/task-worker.js";
export { createRunEvaluationQaModelConfiguration, runEvaluationQaModelConfigurationFacts,
  runEvaluationQaModelConfigurationSnapshot } from "./evaluations/qa-model-preparation.js";
export type { RunEvaluationQaModelConfiguration, RunEvaluationQaModelConfigurationInput,
  RunEvaluationQaModelConfigurationFacts } from "./evaluations/qa-model-preparation.js";
export { createRunEvaluationQaModelHostAdapter } from "./evaluations/qa-model-coordinator.js";
export {
  reconcileRunEvaluationTasksAtStartup,
  RunEvaluationTaskWorkerComposition,
  type RunEvaluationQaTaskWorkerActivation,
  type RunEvaluationTaskStartupRecoveryResult,
  type RunEvaluationTaskWorkerCompositionOptions,
} from "./evaluations/task-worker-composition.js";
export { createRunEvaluationQaOwnedModelBatch, runEvaluationQaOwnedModelBatchFacts,
  createRunEvaluationQaProviderCurrentness } from "./evaluations/qa-model-owned-batch.js";
export type { RunEvaluationQaOwnedModelBatch } from "./evaluations/qa-model-owned-batch.js";
