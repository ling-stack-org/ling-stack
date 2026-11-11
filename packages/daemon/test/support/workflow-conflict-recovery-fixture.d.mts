import type { TestContext, TestOptions } from "node:test";
import type { ChannelWorkflow, ChannelWorkflowStep, RunSession, RuntimeAttemptFenceV1,
  WorkflowIsolationScopePlanV1 } from "@ling-stack/core";
import type { WorkflowAdmissionFixture } from "../../../core/test/support/workflow-step-admission-fixture.mjs";
import type { RunnerRegistry } from "../../dist/runtime/runners.js";

export const recoveryHost: TestOptions;
export function now(): string;

export interface WorkflowConflictRound {
  readonly id: string;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly plans: readonly WorkflowIsolationScopePlanV1[];
}

export interface WorkflowConflictAttempt {
  readonly run: RunSession;
  readonly fence: RuntimeAttemptFenceV1;
  write(content: string, path?: string): Promise<{ readonly approvalId: string }>;
}

export interface WorkflowConflictRecoveryFixture extends WorkflowAdmissionFixture {
  readonly runners: RunnerRegistry;
  create(): Promise<WorkflowConflictRound>;
  start(round: WorkflowConflictRound, index: number): Promise<WorkflowConflictAttempt>;
  finish(item: WorkflowConflictAttempt): Promise<unknown>;
}

export function workflowConflictRecoveryFixture(t: TestContext): Promise<WorkflowConflictRecoveryFixture>;
