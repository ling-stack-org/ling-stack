import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import {
  redactSecrets,
  type ApprovalRequest,
  type ArtifactType,
  type RunArtifact,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import { normalizeArtifactPath } from "../../shared/path.js";
import { isRecord } from "../../shared/validation.js";
import { buildGitCommandPreview } from "./action-classifier.js";

export function createExecutionActionPreviewArtifacts(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly now: string;
  readonly extraSecrets?: readonly (string | undefined)[];
}): readonly RunArtifact[] {
  const preview = buildPreviewArtifact(input);
  if (!preview) {
    return [];
  }
  return [
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
    }),
  ];
}

export function previewArtifactIdsForApproval(store: RunStore, approval: ApprovalRequest): string[] {
  if (!approval.runId) {
    return [];
  }
  return store
    .listArtifacts(approval.runId)
    .filter((artifact) => artifact.path.includes(`/actions/${approval.id}/preview.`))
    .map((artifact) => artifact.id);
}

export function resultArtifactIdsForApproval(store: RunStore, approval: ApprovalRequest): string[] {
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
  readonly appendAndMaybeStream: (type: "artifact_created", data: unknown) => RunEventEnvelope | undefined;
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

function buildPreviewArtifact(input: {
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly extraSecrets?: readonly (string | undefined)[];
}): {
  readonly filename: string;
  readonly type: ArtifactType;
  readonly title: string;
  readonly contentType: string;
  readonly content: string;
} | undefined {
  const redactedPayload = redactSecrets(input.approval.payload, input.extraSecrets ?? []);
  const redactedArgs = redactSecrets(input.toolArgs, input.extraSecrets ?? []);
  if (input.approval.payload.type === "file_edit") {
    return {
      filename: "preview.diff",
      type: "diff",
      title: `Action preview: edit ${input.approval.payload.path}`,
      contentType: "text/x-diff",
      content: input.approval.payload.diffPreview || JSON.stringify({ payload: redactedPayload, args: redactedArgs }, null, 2),
    };
  }
  const gitPreview = input.approval.payload.type === "bash"
    ? buildGitCommandPreview(input.approval.payload.cwd || input.run.cwd, input.approval.payload.command)
    : undefined;
  return {
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
  };
}

function writeActionArtifact(input: {
  readonly store: RunStore;
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
