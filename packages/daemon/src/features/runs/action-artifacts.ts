import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import {
  redactSecrets,
  type ApprovalRequest,
  type ArtifactType,
  type RunExecutionStoreFacet,
  type RunArtifact,
  type RunEventEnvelope,
  type RunEventEmitter,
  type RunStorePathsFacet,
  type RunSession,
} from "@ling-stack/core";
import { normalizeArtifactPath } from "../../shared/path.js";
import { isRecord } from "../../shared/validation.js";
import { buildGitCommandPreview } from "./action-classifier.js";

type ActionArtifactStore = RunStorePathsFacet & RunExecutionStoreFacet;

export function createExecutionActionPreviewArtifacts(input: {
  readonly store: ActionArtifactStore;
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly now: string;
  readonly extraSecrets?: readonly (string | undefined)[];
}): readonly RunArtifact[] {
  const previews = buildPreviewArtifacts(input);
  if (previews.length === 0) {
    return [];
  }
  return previews.map((preview) =>
    writeActionArtifact({
      store: input.store,
      run: input.run,
      approval: input.approval,
      role: "preview",
      filename: preview.filename,
      type: preview.type,
      title: preview.title,
      content: preview.content,
      contentType: preview.contentType,
      now: input.now,
    })
  );
}

export function createExecutionActionResultArtifact(input: {
  readonly store: ActionArtifactStore;
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly filename: string;
  readonly type: ArtifactType;
  readonly title: string;
  readonly contentType: string;
  readonly content: string;
  readonly now: string;
}): RunArtifact {
  return writeActionArtifact({
    store: input.store,
    run: input.run,
    approval: input.approval,
    role: "result",
    filename: input.filename,
    type: input.type,
    title: input.title,
    content: input.content,
    contentType: input.contentType,
    now: input.now,
  });
}

export function previewArtifactIdsForApproval(store: RunExecutionStoreFacet, approval: ApprovalRequest): string[] {
  if (!approval.runId) {
    return [];
  }
  return store
    .listArtifacts(approval.runId)
    .filter((artifact) => isPreviewArtifactPath(artifact.path, approval.id))
    .map((artifact) => artifact.id);
}

export function resultArtifactIdsForApproval(store: RunExecutionStoreFacet, approval: ApprovalRequest): string[] {
  if (!approval.runId || !approval.toolCallId) {
    return [];
  }
  return store
    .listEvents(approval.runId, { limit: 500 })
    .filter((event) => event.type === "artifact_created" && artifactEventToolCallId(event) === approval.toolCallId)
    .filter((event) => artifactEventRole(event) !== "preview")
    .map((event) => artifactEventId(event))
    .filter((artifactId): artifactId is string => Boolean(artifactId));
}

export function appendExecutionActionArtifactEvents(input: {
  readonly artifacts: readonly RunArtifact[];
  readonly approval: ApprovalRequest;
  readonly role: "preview" | "result";
  readonly appendAndMaybeStream: RunEventEmitter;
}): void {
  for (const artifact of input.artifacts) {
    input.appendAndMaybeStream("artifact_created", {
      artifact,
      artifactId: artifact.id,
      approvalId: input.approval.id,
      toolCallId: input.approval.toolCallId,
      actionType: input.approval.actionType,
      role: input.role,
    });
  }
}

function buildPreviewArtifacts(input: {
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly extraSecrets?: readonly (string | undefined)[];
}): readonly {
  readonly filename: string;
  readonly type: ArtifactType;
  readonly title: string;
  readonly contentType: string;
  readonly content: string;
}[] {
  const redactedPayload = redactSecrets(input.approval.payload, input.extraSecrets ?? []);
  const redactedArgs = redactSecrets(input.toolArgs, input.extraSecrets ?? []);
  if (
    (input.approval.payload.type === "file_edit" || input.approval.payload.type === "file_write") &&
    input.approval.payload.patchFormat
  ) {
    const diffPreview = input.approval.payload.type === "file_edit"
      ? input.approval.payload.diffPreview
      : input.approval.payload.preview;
    return [
      {
        filename: "patch.diff",
        type: "diff",
        title: `Patch preview: ${input.approval.payload.touchedPaths?.join(", ") ?? input.approval.payload.path}`,
        contentType: "text/x-diff",
        content: String(redactSecrets(diffPreview || "", input.extraSecrets ?? [])),
      },
      {
        filename: "patch.json",
        type: "json",
        title: `Patch approval metadata: ${input.toolName}`,
        contentType: "application/json",
        content: `${JSON.stringify({
          approvalId: input.approval.id,
          toolCallId: input.approval.toolCallId,
          actionType: input.approval.actionType,
          risk: input.approval.risk,
          title: redactSecrets(input.approval.title, input.extraSecrets ?? []),
          description: redactSecrets(input.approval.description, input.extraSecrets ?? []),
          patchFormat: input.approval.payload.patchFormat,
          plan: redactSecrets(input.approval.payload.patchPlan ?? null, input.extraSecrets ?? []),
          pathPolicy: {
            allowedPaths: input.approval.payload.touchedPaths ?? [input.approval.payload.path],
            deniedPaths: [],
          },
          payload: redactedPayload,
          args: redactedArgs,
        }, null, 2)}\n`,
      },
    ];
  }
  if (input.approval.payload.type === "file_edit") {
    return [{
      filename: "preview.diff",
      type: "diff",
      title: `Action preview: edit ${input.approval.payload.path}`,
      contentType: "text/x-diff",
      content: input.approval.payload.diffPreview || JSON.stringify({ payload: redactedPayload, args: redactedArgs }, null, 2),
    }];
  }
  const gitPreview = input.approval.payload.type === "bash"
    ? buildGitCommandPreview(input.approval.payload.cwd || input.run.cwd, input.approval.payload.command)
    : undefined;
  return [{
    filename: "preview.json",
    type: "json",
    title: `Action preview: ${input.toolName}`,
    contentType: "application/json",
    content: `${JSON.stringify({
      approvalId: input.approval.id,
      toolCallId: input.approval.toolCallId,
      actionType: input.approval.actionType,
      risk: input.approval.risk,
      title: redactSecrets(input.approval.title, input.extraSecrets ?? []),
      description: redactSecrets(input.approval.description, input.extraSecrets ?? []),
      payload: redactedPayload,
      args: redactedArgs,
      gitPreview,
    }, null, 2)}\n`,
  }];
}

function writeActionArtifact(input: {
  readonly store: ActionArtifactStore;
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly role: "preview" | "result";
  readonly filename: string;
  readonly type: ArtifactType;
  readonly title: string;
  readonly content: string;
  readonly contentType: string;
  readonly now: string;
}): RunArtifact {
  const relativePath = normalizeArtifactPath(`${input.run.id}/actions/${input.approval.id}/${input.filename}`);
  const absolutePath = resolvePath(input.store.paths.artifactsDir, relativePath);
  const relativeToRoot = relative(input.store.paths.artifactsDir, absolutePath);
  if (relativeToRoot.startsWith("..")) {
    throw new Error(`Action artifact path escaped artifact root: ${relativePath}`);
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, input.content, "utf8");
  const stats = statSync(absolutePath);
  return input.store.createArtifact({
    runId: input.run.id,
    type: input.type,
    path: relativePath,
    title: input.title,
    contentType: input.contentType,
    sizeBytes: Number(stats.size),
    createdAt: input.now,
  });
}

function artifactEventToolCallId(event: RunEventEnvelope): string | undefined {
  return isRecord(event.data) && typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
}

function artifactEventRole(event: RunEventEnvelope): string | undefined {
  return isRecord(event.data) && typeof event.data.role === "string" ? event.data.role : undefined;
}

function artifactEventId(event: RunEventEnvelope): string | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }
  if (typeof event.data.artifactId === "string") {
    return event.data.artifactId;
  }
  return isRecord(event.data.artifact) && typeof event.data.artifact.id === "string" ? event.data.artifact.id : undefined;
}

function isPreviewArtifactPath(path: string, approvalId: string): boolean {
  const actionPath = `/actions/${approvalId}/`;
  if (!path.includes(actionPath)) {
    return false;
  }
  return path.endsWith("/preview.diff") || path.endsWith("/preview.json") || path.endsWith("/patch.diff") || path.endsWith("/patch.json");
}
