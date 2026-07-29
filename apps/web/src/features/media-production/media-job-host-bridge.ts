import type {
  MediaJob,
  MediaWorkflowConnection,
  MediaWorkflowDefinitionDetail,
  RunArtifact,
} from "../../types.js";
import {
  type MediaJobDisplayContext,
  type MediaJobDisplayContextMap,
  type MediaJobHostActions,
} from "../media/media-job-display-context.js";
import type { MediaProductionProjectDetail } from "./media-production-types.js";
import type { MediaWorkflowLibraryTab } from "./workflows/media-workflow-types.js";

export function uniqueMediaImageArtifacts(artifacts: readonly RunArtifact[]): RunArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => artifact.type === "image" && !seen.has(artifact.id) && Boolean(seen.add(artifact.id)));
}

export function buildMediaProductionJobSignature(
  project: MediaProductionProjectDetail | undefined,
  jobs: readonly MediaJob[],
  artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>,
): string {
  if (!project) return "";
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  return project.sceneRuns.map((run) => {
    const job = jobsById.get(run.mediaJobId);
    const artifactIds = (artifactsByJob[run.mediaJobId] ?? []).map((artifact) => artifact.id).join(",");
    return `${run.mediaJobId}:${job?.status ?? "missing"}:${job?.artifactIds.join(",") ?? ""}:${artifactIds}`;
  }).join("|");
}

export interface MediaJobHostBridge {
  readonly context: MediaJobDisplayContextMap;
  readonly actions: MediaJobHostActions;
}

export function buildMediaJobHostBridge(input: {
  readonly project?: MediaProductionProjectDetail;
  readonly jobs: readonly MediaJob[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly connections: readonly MediaWorkflowConnection[];
  readonly selectWorkflow: (workflowDefinitionId: string) => void;
  readonly selectConnection: (connectionId: string) => void;
  readonly setLibraryTab: (tab: MediaWorkflowLibraryTab) => void;
  readonly setLibraryOpen: (open: boolean) => void;
}): MediaJobHostBridge {
  const contexts: Record<string, MediaJobDisplayContext> = {};
  if (input.project) {
    const scenesById = new Map(input.project.scenes.map((scene) => [scene.id, scene]));
    for (const run of input.project.sceneRuns) {
      const scene = scenesById.get(run.sceneId);
      if (scene) contexts[run.mediaJobId] = { projectName: input.project.mediaProject.name, sceneName: scene.title };
    }
  }
  for (const job of input.jobs) {
    const workflowVersionId = job.executionSource?.kind === "workflow"
      ? job.executionSource.workflowVersionId
      : job.workflowVersionId;
    if (!workflowVersionId) continue;
    contexts[job.id] = {
      ...contexts[job.id],
      source: workflowSource(workflowVersionId, input.workflows, input.connections),
    };
  }
  return {
    context: contexts,
    actions: {
      openWorkflow: (workflowDefinitionId) => {
        if (workflowDefinitionId) input.selectWorkflow(workflowDefinitionId);
        input.setLibraryTab("workflows");
        input.setLibraryOpen(true);
      },
      openWorkflowConnection: (connectionId) => {
        if (connectionId) input.selectConnection(connectionId);
        input.setLibraryTab("connections");
        input.setLibraryOpen(true);
      },
    },
  };
}

function workflowSource(
  versionId: string,
  workflows: readonly MediaWorkflowDefinitionDetail[],
  connections: readonly MediaWorkflowConnection[],
): NonNullable<MediaJobDisplayContext["source"]> {
  const workflow = workflows.find((item) => item.versions.some((version) => version.id === versionId));
  const version = workflow?.versions.find((item) => item.id === versionId);
  if (!workflow || !version) return { kind: "workflow_missing", versionId, reason: "version_missing" };
  const connection = connections.find((item) => item.id === workflow.definition.connectionId);
  return {
    kind: "workflow",
    versionId,
    definitionId: workflow.definition.id,
    name: `${workflow.definition.name} v${version.version}`,
    status: workflow.definition.status,
    connection: connection
      ? { kind: "available", id: connection.id, status: connection.status }
      : { kind: "missing", id: workflow.definition.connectionId },
  };
}
