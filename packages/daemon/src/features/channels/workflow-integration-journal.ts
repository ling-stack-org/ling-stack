import { createHash } from "node:crypto";
import { createSqliteWorkflowIsolationStore, workflowIsolationDigest,
  type RunStore, type WorkflowIntegrationCoordinatorStore, type WorkflowIntegrationCoordinatorEffect,
  type WorkflowIntegrationCoordinatorEffectEvidenceV1, type WorkflowIntegrationCoordinatorReceiptEvidenceV1,
  type WorkflowIntegrationCoordinatorAuthority, type WorkflowIsolationGitIdentity, type WorkflowIsolationMutationResult,
  type WorkflowIsolationReceipt } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { workflowGitPacketJson, type WorkflowGitRefEffect } from "./workflow-branch-result.js";
import type { WorkflowIntegrationGitJournal } from "./workflow-integration-candidate.js";

type Authority = Extract<WorkflowIntegrationCoordinatorAuthority, { readonly status: "authorized" }>;
type EffectKind = WorkflowIntegrationCoordinatorEffectEvidenceV1["effectKind"];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class WorkflowIntegrationCoordinatorError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}
export const requireIntegration: (condition: unknown, code: string) => asserts condition = (condition, code) => {
  if (!condition) throw new WorkflowIntegrationCoordinatorError(code);
};
export function integrationValue<T>(result: WorkflowIsolationMutationResult<T>): T {
  if ("value" in result) return result.value;
  throw new WorkflowIntegrationCoordinatorError(result.code);
}

export function readIntegrationArtifact(store: RunStore, id: string, runId: string): Readonly<Record<string, unknown>> {
  const artifact = store.getArtifact(id);
  requireIntegration(artifact?.runId === runId && artifact.sealedPayloadState !== "pruned" && isRecord(artifact.sealedPayload)
    && artifact.contentSha256 === sha256(JSON.stringify(artifact.sealedPayload)), "workflow_integration.artifact_unverified");
  return artifact.sealedPayload;
}

export function retainIntegrationArtifact(store: RunStore, runId: string, payload: Readonly<Record<string, unknown>>,
  title: string, now: string): string {
  const id = workflowIsolationDigest(payload, "wica_");
  if (store.getArtifact(id)) {
    requireIntegration(workflowGitPacketJson(readIntegrationArtifact(store, id, runId)) === workflowGitPacketJson(payload),
      "workflow_integration.artifact_changed");
  } else {
    store.createArtifact({ id, runId, type: "json", path: `sqlite:${id}`, title, contentType: "application/json",
      sealedPayload: payload, createdAt: now });
  }
  return id;
}

/** Durable terminal-round effects. A duplicate is observation-only, never permission to repeat Git. */
export function createWorkflowIntegrationJournal(input: { readonly store: RunStore; readonly coordinator: WorkflowIntegrationCoordinatorStore;
  readonly authority: Authority; readonly identity: WorkflowIsolationGitIdentity; readonly now: () => string }) {
  const { store, coordinator, authority, now } = input, isolation = createSqliteWorkflowIsolationStore(store);
  const runId = authority.participants.find(participant => participant.binding.bindingId === authority.writer.bindingId)!.binding.runId;
  const current = (): Authority => {
    const read = coordinator.assertAuthority({ roundId: authority.round.roundId, generation: authority.round.generation, now: now() });
    if (read.status !== "authorized") throw new WorkflowIntegrationCoordinatorError(read.code);
    requireIntegration(read.authorityDigest === authority.authorityDigest, "workflow_integration.authority_changed");
    return read;
  };
  const effects = () => coordinator.listEffects({ roundId: authority.round.roundId, generation: authority.round.generation });
  const record = (effectKey: string, kind: EffectKind, before: WorkflowIsolationGitIdentity, after: WorkflowIsolationGitIdentity,
    effect: Readonly<Record<string, unknown>>): WorkflowIntegrationCoordinatorEffect => {
    const read = current();
    const payload: WorkflowIntegrationCoordinatorEffectEvidenceV1 = { schemaVersion: 1, kind: "workflow_integration_coordinator_effect",
      roundId: read.round.roundId, generation: read.round.generation, authorityDigest: read.authorityDigest,
      effectKey, effectKind: kind, before, after, effect };
    const payloadArtifactId = retainIntegrationArtifact(store, runId, { ...payload }, "Workflow integration effect intent", now());
    const result = coordinator.recordIntent({ roundId: read.round.roundId, generation: read.round.generation,
      expectedRevision: read.round.revision, authorityDigest: read.authorityDigest, effectKey, kind, before, after, payloadArtifactId, now: now() });
    const value = integrationValue(result);
    requireIntegration(result.status === "created", "workflow_integration.effect_requires_observation");
    return value;
  };
  const receipt = (intentId: string, outcome: WorkflowIsolationReceipt["outcome"], observed: WorkflowIsolationGitIdentity,
    evidence: Readonly<Record<string, unknown>>): WorkflowIsolationReceipt => {
    const effect = effects().find(item => item.intentId === intentId);
    requireIntegration(effect, "workflow_integration.effect_missing");
    const round = isolation.getIntegrationRound(authority.round.roundId);
    requireIntegration(round && round.generation === authority.round.generation, "workflow_integration.generation_changed");
    const payload: WorkflowIntegrationCoordinatorReceiptEvidenceV1 = { schemaVersion: 1, kind: "workflow_integration_coordinator_receipt",
      intentId, effectKey: effect.effectKey, outcome, observed, evidence };
    const artifactId = retainIntegrationArtifact(store, runId, { ...payload }, "Workflow integration effect receipt", now());
    return integrationValue(coordinator.recordReceipt({ intentId, expectedRevision: round.revision,
      authorityDigest: authority.authorityDigest, outcome, observed, artifactId, now: now() }));
  };
  const refIdentity = (effect: WorkflowGitRefEffect, commit: string | null): WorkflowIsolationGitIdentity => ({ ...input.identity,
    exists: commit !== null, headCommit: commit, ...(commit === effect.afterCommit ? { tree: effect.tree } : { tree: undefined }) });
  const journal: WorkflowIntegrationGitJournal = {
    recordIntent: async effect => record(`ref:${effect.ref}`, "integration_create", refIdentity(effect, null),
      refIdentity(effect, effect.afterCommit), { ...effect }).intentId,
    recordReceipt: async observation => {
      receipt(observation.intentId, observation.outcome, refIdentity(observation.effect, observation.observedCommit), { ...observation });
    },
    recordMergeIntent: async effect => record(`merge:${effect.sequence}`, "integrate_branch", input.identity, input.identity, { ...effect }).intentId,
    recordMergeReceipt: async observation => {
      receipt(observation.intentId, observation.outcome, input.identity, { ...observation });
    },
  };
  return { current, effects, record, receipt, journal, runId };
}

export type WorkflowIntegrationJournal = ReturnType<typeof createWorkflowIntegrationJournal>;
