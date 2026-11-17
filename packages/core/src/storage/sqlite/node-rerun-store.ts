import { createHash, randomUUID } from "node:crypto";
import type { RunStore } from "../../run-types.js";
import type { NodeRerunSubmission, NodeRerunSubmissionStore } from "../../node-rerun-types.js";
import { workflowStepNewStartMetadata } from "../../workflow-pre-gate.js";
import type { ChannelWorkflowStepMetadata } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { withSqliteSnapshotParentTransaction } from "./read-snapshot.js";

const adapters = new WeakMap<RunStore, NodeRerunSubmissionStore>();
export function createSqliteNodeRerunStore(store: RunStore): NodeRerunSubmissionStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("node_rerun_store_unavailable");
  return adapter;
}
export function registerSqliteNodeRerunStore(store: RunStore, context: SqliteStoreContext): void {
  const db = context.database;
  const read = (column: "idempotency_key" | "successor_workflow_id" | "source_snapshot_digest" | "intent_id" | "source_workflow_id", value: string): NodeRerunSubmission | undefined => {
    const row = db.prepare(`SELECT submission_json FROM node_rerun_submissions WHERE ${column}=?`).get(value);
    return row ? JSON.parse(String(row.submission_json)) as NodeRerunSubmission : undefined;
  };
  adapters.set(store, {
    getByKey: key => read("idempotency_key", key),
    getBySource: id => read("source_workflow_id", id),
    getBySuccessor: id => read("successor_workflow_id", id),
    listPending(limit = 100) {
      return db.prepare(`SELECT submission_json FROM node_rerun_submissions s JOIN channel_workflows w ON w.id=s.successor_workflow_id
        WHERE w.status IN ('ready','running','waiting_for_approval','blocked') ORDER BY s.rowid LIMIT ?`)
        .all(Math.max(1, Math.min(100, limit))).map(row => JSON.parse(String(row.submission_json)) as NodeRerunSubmission);
    },
    submit(input) {
      if (db.isTransaction || Object.prototype.toString.call(input.authorize) === "[object AsyncFunction]") throw new Error("node_rerun_transaction_invalid");
      const { intent } = input;
      const requestDigest = createHash("sha256").update(JSON.stringify({ intent, planFingerprint: input.planFingerprint })).digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = read("idempotency_key", intent.idempotencyKey) ?? read("intent_id", intent.intentId);
        if (prior) {
          if (prior.requestDigest !== requestDigest) throw new Error("node_rerun_idempotency_conflict");
          db.exec("COMMIT"); return { submission: prior, duplicate: true };
        }
        if (read("source_snapshot_digest", intent.source.sourceSnapshotDigest)) throw new Error("node_rerun_source_already_submitted");
        const prepared = withSqliteSnapshotParentTransaction(db, input.authorize);
        const { workflow, steps } = prepared, graph = workflow.metadata?.workflowGraph;
        if (!graph || steps.length !== graph.nodes.length || steps.length > 128) throw new Error("node_rerun_graph_unavailable");
        if (read("source_workflow_id", workflow.id)) throw new Error("node_rerun_source_already_submitted");
        const invalidated = new Set([intent.source.nodeId, ...intent.source.dependencyClosure.downstreamNodeIds]);
        const successor = store.createChannelWorkflow({ channelId: workflow.channelId, title: workflow.title, objective: workflow.objective,
          status: "ready", createdBy: intent.requestedBy, metadata: { workflowGraph: graph, workflowGraphId: graph.id,
            workflowGraphSchemaVersion: graph.schemaVersion, workflowGraphFingerprint: workflow.metadata?.workflowGraphFingerprint,
            termination: graph.termination, maxParallelSteps: graph.maxParallelSteps } }, input.now);
        const created = new Map<string, string>();
        const mapping: NodeRerunSubmission["steps"][number][] = [];
        for (const source of steps) {
          const nodeId = source.metadata?.graphNodeId;
          if (!nodeId) throw new Error("node_rerun_node_missing");
          const reused = !invalidated.has(nodeId);
          const { preStepApprovalId, preStepApprovalMarker, activeGateStage, safetyPlan, isolationScopePlan,
            executionPlan, executionOperationIds, delegatedRequirement, templateCompilationPin,
            selectorDecisionIds, handoffIntentIds, sourceProposalId, sourceMessageId, proposalStepSources,
            ...definition } = workflowStepNewStartMetadata(source.metadata);
          const metadata: ChannelWorkflowStepMetadata = { ...definition, autoStart: true, dependsOnStepIds: [],
            ...(reused ? { contextArtifactId: source.metadata?.contextArtifactId, outputArtifactId: source.metadata?.outputArtifactId,
              outputArtifactIds: source.metadata?.outputArtifactIds } : {}) };
          const step = store.createChannelWorkflowStep({ workflowId: successor.id, position: source.position, title: source.title,
            prompt: source.prompt, toParticipantId: source.toParticipantId, toParticipantLabel: source.toParticipantLabel,
            participantAuthority: source.participantAuthority, status: reused ? source.status : "queued", metadata }, input.now);
          created.set(source.id, step.id);
          if (reused && source.resultSummary) store.updateChannelWorkflowStep(step.id, { resultSummary: source.resultSummary }, input.now);
          const artifactIds = [...new Set([source.metadata?.contextArtifactId, source.metadata?.outputArtifactId,
            ...(source.metadata?.outputArtifactIds ?? [])].filter((id): id is string => Boolean(id)))];
          mapping.push({ nodeId, sourceStepId: source.id, successorStepId: step.id, reused,
            sourceStepDigest: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
            artifactPins: reused ? artifactIds.map(id => {
              const artifact = store.getArtifact(id);
              if (!artifact?.contentSha256) throw new Error("node_rerun_reuse_artifact_unpinned");
              return { id, sha256: artifact.contentSha256 };
            }) : [] });
        }
        for (const source of steps) {
          const targetId = created.get(source.id)!;
          const target = store.getChannelWorkflowStep(targetId)!;
          const deps = (source.metadata?.dependsOnStepIds ?? []).map(id => {
            const mapped = created.get(id); if (!mapped) throw new Error("node_rerun_dependency_missing"); return mapped;
          });
          store.updateChannelWorkflowStep(targetId, { metadata: { ...target.metadata, dependsOnStepIds: deps } }, input.now);
        }
        const submission: NodeRerunSubmission = { id: `nrs_${randomUUID()}`, intentId: intent.intentId, idempotencyKey: intent.idempotencyKey,
          requestDigest, sourceRunId: intent.source.runId, sourceWorkflowId: workflow.id, sourceSnapshotDigest: intent.source.sourceSnapshotDigest,
          planFingerprint: input.planFingerprint, successorWorkflowId: successor.id, invalidatedNodeIds: [...invalidated].sort(), steps: mapping, createdAt: input.now };
        db.prepare(`INSERT INTO node_rerun_submissions(id,intent_id,idempotency_key,source_snapshot_digest,source_workflow_id,successor_workflow_id,submission_json)
          VALUES(?,?,?,?,?,?,?)`).run(submission.id, submission.intentId, submission.idempotencyKey, submission.sourceSnapshotDigest,
            workflow.id, successor.id, JSON.stringify(submission));
        db.exec("COMMIT"); return { submission, duplicate: false };
      } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
    },
  });
}
