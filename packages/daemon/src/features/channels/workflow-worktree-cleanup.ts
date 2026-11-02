import { randomUUID } from "node:crypto";
import { createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowWorktreeCleanupStore,
  workflowIsolationCanonicalJson, type RunStore, type WorkflowWorktreeCleanupIntent,
  type WorkflowWorktreeCleanupObservation } from "@ling-stack/core";
import { cleanupWorkflowGitWorktree, observeWorkflowGitCleanup, type WorkflowGitCleanupObservation }
  from "../workspaces/workflow-git-cleanup.js";
import { integrationValue, requireIntegration, retainIntegrationArtifact } from "./workflow-integration-journal.js";
import { runWorkflowIsolationOperation } from "./workflow-isolation-lifecycle.js";

export interface WorkflowWorktreeCleanupResult {
  readonly worktreeId?: string;
  readonly status: "removed" | "retained" | "effect_unknown";
  readonly code?: string;
}
interface Input {
  readonly store: RunStore;
  readonly roundId: string;
  readonly generation: number;
  readonly worktreeId: string;
  readonly workflowId: string;
  readonly observeOnly?: boolean;
  readonly now?: () => string;
}
const same = (a: unknown, b: unknown) => workflowIsolationCanonicalJson(a) === workflowIsolationCanonicalJson(b);

/** Cleanup has its own immutable intent and receipt; it cannot advance or fail the business workflow. */
export async function coordinateWorkflowWorktreeCleanup(input: Input): Promise<WorkflowWorktreeCleanupResult> {
  let intent: WorkflowWorktreeCleanupIntent | undefined;
  try {
    return await runWorkflowIsolationOperation(input.store, input.workflowId,
      `cleanup:${input.roundId}:${input.generation}:${input.worktreeId}`, async () => {
        const { store } = input, cleanup = createSqliteWorkflowWorktreeCleanupStore(store);
        const now = input.now ?? (() => new Date().toISOString());
        const result = (observation: WorkflowWorktreeCleanupObservation): WorkflowWorktreeCleanupResult => ({
          worktreeId: input.worktreeId, status: observation.state === "removed" ? "removed"
            : observation.state === "unknown" ? "effect_unknown" : "retained",
          ...(observation.code ? { code: observation.code } : {}),
        });
        const persist = (physical: WorkflowGitCleanupObservation): WorkflowWorktreeCleanupResult => {
          requireIntegration(intent, "workflow_cleanup.intent_missing");
          // Persist only the Core envelope, not mechanism-specific diagnostics or caller-owned objects.
          const observation: WorkflowWorktreeCleanupObservation = { state: physical.state,
            executionRoot: physical.executionRoot, worktreeId: physical.worktreeId, branchRef: physical.branchRef,
            commonDir: physical.commonDir, retainedRefs: physical.retainedRefs,
            ...(physical.code ? { code: physical.code } : {}) };
          const payload = { schemaVersion: 1, kind: "workflow_worktree_cleanup_observation",
            cleanupId: intent.cleanupId, planDigest: intent.planDigest, observation };
          const artifactId = retainIntegrationArtifact(store, intent.plan.runId, payload, "Workflow worktree cleanup observation", now());
          integrationValue(cleanup.recordObservation({ cleanupId: intent.cleanupId, artifactId, now: now() }));
          return result(observation);
        };
        intent = cleanup.getIntent(input.roundId, input.generation, input.worktreeId);
        if (intent) return persist(await observeWorkflowGitCleanup(intent.plan));
        if (input.observeOnly) return { worktreeId: input.worktreeId, status: "retained", code: "workflow_cleanup.not_started" };
        const inspected = cleanup.inspect({ roundId: input.roundId, generation: input.generation,
          worktreeId: input.worktreeId, now: now() });
        if (inspected.status !== "eligible") return { worktreeId: input.worktreeId, status: "retained", code: inspected.code };
        const plan = inspected.plan, ownerToken = randomUUID();
        requireIntegration(plan.workflowId === input.workflowId, "workflow_cleanup.workflow_mismatch");
        const assertCurrentAuthority = () => {
          const read = intent ? cleanup.assertIntent({ cleanupId: intent.cleanupId, ownerToken, now: now() })
            : cleanup.inspect({ roundId: input.roundId, generation: input.generation, worktreeId: input.worktreeId, now: now() });
          requireIntegration(read.status === "eligible", read.status === "retained" ? read.code : "workflow_cleanup.authority_unverified");
          requireIntegration(same(read.plan, plan), "workflow_cleanup.plan_changed");
        };
        const begin = () => {
          const planArtifactId = retainIntegrationArtifact(store, plan.runId, { ...plan }, "Workflow worktree cleanup plan", now());
          const begun = cleanup.begin({ roundId: input.roundId, generation: input.generation, worktreeId: input.worktreeId,
            ownerToken, planArtifactId, now: now() });
          intent = integrationValue(begun);
          return { created: begun.status === "created", value: intent };
        };
        const removed = await cleanupWorkflowGitWorktree({ ...plan, assertCurrentAuthority,
          beforeRemove: () => requireIntegration(begin().created, "workflow_cleanup.intent_requires_observation"),
          afterRemove: physical => { persist(physical); },
        });
        if (removed.status === "removed") return { worktreeId: input.worktreeId, status: "removed" };
        // Retain a durable reason even if physical preflight refused a dirty or changed directory.
        // This intent is observation-only on every subsequent invocation, never a deferred delete.
        if (!intent) assertCurrentAuthority();
        const pending = intent ?? begin().value;
        return persist(await observeWorkflowGitCleanup(pending.plan));
      });
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code
      : cause instanceof Error && cause.message === "workflow_isolation.runtime_shutting_down" ? cause.message
        : "workflow_cleanup.evidence_unverified";
    return { worktreeId: input.worktreeId, status: intent ? "effect_unknown" : "retained", code };
  }
}

/** Persisted intents remain discoverable after pins/authority are revoked. Startup only observes them. */
export async function cleanupWorkflowWorktrees(store: RunStore, workflowId: string, options: {
  readonly observeOnly?: boolean; readonly now?: () => string;
} = {}): Promise<readonly WorkflowWorktreeCleanupResult[]> {
  let coordinator, cleanup;
  try {
    coordinator = createSqliteWorkflowIntegrationCoordinatorStore(store);
    cleanup = createSqliteWorkflowWorktreeCleanupStore(store);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "workflow_integration.store_not_sqlite") return [];
    return [{ status: "retained", code: "workflow_cleanup.inventory_unverified" }];
  }
  const results: WorkflowWorktreeCleanupResult[] = [];
  try {
    const targets = new Map<string, { roundId: string; generation: number; worktreeIds: Set<string> }>();
    const target = (roundId: string, generation: number) => {
      const key = `${roundId}:${generation}`;
      let entry = targets.get(key);
      if (!entry) { entry = { roundId, generation, worktreeIds: new Set() }; targets.set(key, entry); }
      return entry;
    };
    for (const intent of cleanup.listIntents({ workflowId })) {
      target(intent.roundId, intent.generation).worktreeIds.add(intent.worktreeId);
    }
    if (!options.observeOnly) {
      for (const round of coordinator.listRounds(workflowId)) {
        const entry = target(round.roundId, round.generation);
        entry.worktreeIds.add(round.inputs.integration.worktreeId);
        const authority = coordinator.assertAuthority({ roundId: round.roundId, generation: round.generation,
          now: options.now?.() ?? new Date().toISOString() });
        if (authority.status === "authorized") {
          for (const participant of authority.participants) entry.worktreeIds.add(participant.plan.worktreeId);
        }
      }
    }
    for (const { roundId, generation, worktreeIds } of targets.values()) {
      for (const worktreeId of worktreeIds) results.push(await coordinateWorkflowWorktreeCleanup({ store, workflowId,
        roundId, generation, worktreeId, ...options }));
    }
  } catch {
    results.push({ status: "retained", code: "workflow_cleanup.inventory_unverified" });
  }
  return results;
}
