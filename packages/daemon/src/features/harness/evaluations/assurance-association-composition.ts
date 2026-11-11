import type { FrameworkAssuranceEvidenceResponse } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../../runtime/store-registry.js";
import { readRunAssuranceEvidence } from "../../runs/assurance-evidence.js";
import { associationFailure, projectAssuranceEvaluationAssociation } from "./assurance-association.js";
import type { AssuranceEvaluationAssociationRequest, AssuranceEvaluationAssociationResult,
  AssuranceEvaluationReadPorts, HostAssociationSource } from "./assurance-association-contract.js";
import { AssociationRefusal, validateAssociationRequest } from "./assurance-association-validation.js";

/** Internal composition over one already-open Store and its synchronous read snapshot. */
export function projectInitializedAssuranceEvaluationAssociation(input: {
  readonly registry: Pick<RunStoreRegistry, "findInitializedStoreForRun">;
  readonly activeRuns: ActiveRunRegistry;
  readonly cwd: string;
  readonly request: AssuranceEvaluationAssociationRequest;
  readonly getFrozenInput: AssuranceEvaluationReadPorts["getFrozenInput"];
}): AssuranceEvaluationAssociationResult {
  try {
    validateAssociationRequest(input.request);
    if (typeof input.cwd !== "string" || !input.cwd.length || typeof input.getFrozenInput !== "function")
      return associationFailure("association.invalid_request");
  } catch (error) {
    return associationFailure(error instanceof AssociationRefusal ? error.code : "association.invalid_request");
  }
  const { request, cwd, activeRuns } = input;
  try {
    const store = input.registry.findInitializedStoreForRun(request.source.execution.runId, cwd);
    if (!store) return associationFailure("association.workspace_uninitialized", request.observation.observationId, request.mappingDigest);
    return store.readSnapshot(() => projectAssuranceEvaluationAssociation({
      getRun(id) {
        const run = store.getRun(id);
        return run ? { id: run.id, status: run.status, ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }) } : undefined;
      },
      getRunEvaluation: id => store.getRunEvaluation(id),
      getRunEvaluationGrade: id => store.getRunEvaluationGrade(id),
      getArtifact: id => store.getArtifact(id),
      getCurrentHostSource: id => hostAssociationSource(readRunAssuranceEvidence(store, activeRuns, id)),
      getFrozenInput: key => input.getFrozenInput(key),
    }, request));
  } catch {
    return associationFailure("association.read_failed", request.observation.observationId, request.mappingDigest);
  }
}

/** Exclude wall-clock observation time from the Host snapshot identity. */
export function hostAssociationSource(source: FrameworkAssuranceEvidenceResponse): HostAssociationSource {
  return structuredClone({ comparison: source.comparison, execution: source.execution,
    snapshots: source.snapshots, artifacts: source.artifacts });
}
