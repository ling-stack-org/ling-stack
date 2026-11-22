import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DeviceDeveloperJobV1, DeviceDeveloperSessionV1 } from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, DeviceBrokerError, DeviceFabricError, requireWorkspaceDeviceTask } from "@ling-stack/core";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody, readOptionalJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import { androidAdbAdapterId, androidAdbInstallCapability, androidAdbLogCapability } from "./adapters/android-adb.js";
import { assertDeveloperTargetActive, requireCurrentDeveloperTarget } from "./developer-jobs.js";
import type { DeviceSupportRuntime } from "./runtime.js";

const developerPath = "/v1/device-support/developer/sessions";
const sessionPath = /^\/v1\/device-support\/developer\/sessions\/([^/]+)(?:\/(authorize|jobs|artifact)(?:\/([^/]+)(?:\/(logcat|readback))?)?)?$/u;
const jobKinds = ["build", "deploy", "launch", "logs", "test", "retest"] as const satisfies readonly DeviceDeveloperJobV1["kind"][];
const jobFields = new Set(["jobId", "kind", "artifactDigest", "authorizationRevision", "expectedSessionRevision"]);

export async function handleDeviceDeveloperRoute(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const match = sessionPath.exec(url.pathname);
  if (!match && url.pathname !== developerPath) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  const [sessionId, operation, jobId, projection] = match?.slice(1) ?? [];
  if (jobId && operation !== "jobs") return false;
  const write = !sessionId || (operation !== undefined && !jobId) || projection === "readback";
  const methods = operation === "artifact" ? ["GET", "POST"] : [write ? "POST" : "GET"];
  if (!methods.includes(request.method ?? "")) {
    response.setHeader("Allow", methods.join(", "));
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    if (!sessionId) {
      await createSession(request, response, runtime);
      return true;
    }
    if (operation === "authorize") {
      await authorizeSession(sessionId, request, response, runtime);
      return true;
    }
    if (operation === "artifact") {
      await handleAndroidArtifact(url, request, response, runtime, sessionId);
      return true;
    }
    if (operation === "jobs" && !jobId) {
      await createJob(request, response, runtime, sessionId);
      return true;
    }
    const session = requireSession(runtime, sessionId);
    if (!jobId) {
      writePrivateJson(response, 200, { session });
      return true;
    }
    const job = runtime.developerSessions.getJob(readReference(jobId));
    if (!job || job.sessionId !== session.sessionId || job.targetDeviceId !== session.targetDeviceId) {
      throw new DeviceBrokerError("missing_target", "developer job is unavailable");
    }
    if (projection === "readback") {
      const body = await readOptionalJsonBody(request, 2048).catch(() => null);
      if (body !== undefined && (!isRecord(body) || Object.keys(body).length !== 0)) {
        throw new DeviceBrokerError("invalid_request", "readback uses the recorded developer job");
      }
      const result = await reconcileAndroidDeployment(runtime, session, job);
      if (!response.destroyed) writePrivateJson(response, 200, result);
    } else writePrivateJson(response, 200, projection === "logcat" ? readDeveloperLogcat(runtime, session, job) : { job });
  } catch (error) {
    if (!response.destroyed) writeDeveloperError(response, error);
  }
  return true;
}

async function reconcileAndroidDeployment(runtime: DeviceSupportRuntime, session: DeviceDeveloperSessionV1, job: DeviceDeveloperJobV1) {
  const taskId = `developer-deploy:${job.jobId}`;
  if (session.mode !== "developer" || job.kind !== "deploy" || (job.status !== "unknown" && job.status !== "completed") || job.outputRef !== taskId) {
    throw new DeviceBrokerError("missing_target", "Android deployment readback is unavailable");
  }
  const { store, broker } = runtime;
  const task = requireWorkspaceDeviceTask(store, taskId, session.workspaceId);
  const attempt = store.listAttempts(taskId).find(record => record.request.capabilityId === androidAdbInstallCapability
    && record.attempt.targetDeviceId === session.targetDeviceId && record.attempt.ownerId === session.targetDeviceId
    && isRecord(record.request.normalizedInput) && record.request.normalizedInput.artifactDigest === job.artifactDigest);
  if (task.ownerId !== session.targetDeviceId || !attempt) {
    throw new DeviceBrokerError("missing_target", "Android deployment attempt is unavailable");
  }
  if (task.status === "succeeded") return { job, taskStatus: task.status, status: "verified" };
  if (session.status === "revoked") throw new DeviceBrokerError("permission_denied", "developer session is revoked");
  const target = runtime.listAndroidAdbTargets().find(item => item.deviceId === session.targetDeviceId);
  if (task.status !== "unknown" || !target) throw new DeviceBrokerError("target_changed", "Android deployment lacks a current readback target");
  const profile = await runtime.enrollAndroidAdbTarget(target.connectionId);
  const signal = AbortSignal.timeout(30_000);
  const snapshot = await broker.refreshCapabilities(profile.device.id, profile.profileRevision, signal);
  const reconciliation = await broker.reconcileTask({
    taskId, attemptId: attempt.attempt.attemptId, capabilitySnapshotId: snapshot.snapshotId, signal,
  });
  return { job, taskStatus: store.getTask(taskId)?.status, status: reconciliation.status, reconciliation };
}

async function handleAndroidArtifact(
  url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime, encodedSession: string,
): Promise<void> {
  const session = requireSession(runtime, encodedSession);
  if (session.mode !== "developer" || session.protocolReplay) {
    throw new DeviceBrokerError("permission_denied", "APK artifacts require an Android developer session");
  }
  if (request.method === "GET") {
    const artifact = session.artifactId ? runtime.developerSessions.getArtifact(session.artifactId) : undefined;
    if (!artifact?.androidApk || artifact.workspaceId !== session.workspaceId || artifact.targetDeviceId !== session.targetDeviceId) {
      throw new DeviceBrokerError("missing_target", "the developer session has no verified APK");
    }
    writePrivateJson(response, 200, { session, artifact });
    return;
  }
  const expectedRevision = Number(url.searchParams.get("expectedRevision"));
  const contentLength = request.headers["content-length"];
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || request.headers["content-type"] !== "application/vnd.android.package-archive"
    || !contentLength || !/^[1-9]\d{0,9}$/u.test(contentLength)) {
    throw new DeviceBrokerError("invalid_request", "upload an APK with its length and the reviewed session revision");
  }
  const { androidApks } = runtime;
  if (!androidApks || !runtime.canDeployAndroid(session.targetDeviceId)) {
    throw new DeviceBrokerError("unsupported_capability", "APK tools are unavailable for this target");
  }
  const authorize = () => {
    const current = requireSession(runtime, encodedSession);
    if (current.status !== "authorized" || current.authorizationRevision !== session.authorizationRevision) {
      throw new DeviceBrokerError("permission_denied", "developer session authorization changed");
    }
    if (current.revision !== expectedRevision) throw new DeviceBrokerError("target_changed", "developer session revision changed");
    requireCurrentDeveloperTarget(runtime.store, current);
  };
  authorize();
  const result = await androidApks.importApk(request, Number(contentLength), authorize, apk => {
    const artifactId = "android-apk:" + createHash("sha256").update(JSON.stringify([session.sessionId, apk.digest])).digest("hex");
    const updated = runtime.developerSessions.bindArtifact(session.sessionId, {
      ...apk, artifactId, workspaceId: session.workspaceId, targetDeviceId: session.targetDeviceId, createdAt: new Date().toISOString(),
    }, expectedRevision);
    return { session: updated, artifact: runtime.developerSessions.getArtifact(artifactId)! };
  });
  if (!response.destroyed) writePrivateJson(response, 201, result);
}

function readDeveloperLogcat(runtime: DeviceSupportRuntime, session: DeviceDeveloperSessionV1, job: DeviceDeveloperJobV1) {
  const { store } = runtime;
  const taskId = `developer-logs:${job.jobId}`;
  if (session.mode !== "developer" || job.kind !== "logs" || job.status !== "completed" || job.outputRef !== taskId) {
    throw new DeviceBrokerError("missing_target", "developer log capture is unavailable");
  }
  const task = requireWorkspaceDeviceTask(store, taskId, session.workspaceId);
  if (task.status !== "succeeded" || task.ownerId !== job.targetDeviceId
    || task.targetDeviceIds.length !== 1 || task.targetDeviceIds[0] !== job.targetDeviceId) {
    throw new DeviceBrokerError("missing_target", "developer log capture is unavailable");
  }
  const record = store.listAttempts(taskId).find(({ attempt, request }) =>
    attempt.targetDeviceId === job.targetDeviceId && attempt.ownerId === task.ownerId && attempt.status === "completed"
    && attempt.adapterBinding?.adapterId === androidAdbAdapterId && request.capabilityId === androidAdbLogCapability);
  const capture = store.listObservations(taskId).find(observation => record?.attempt.receipt?.observationIds.includes(observation.id)
    && observation.subjectId === job.targetDeviceId && observation.source === "android.logcat" && observation.redactionClass === "sensitive");
  const evidence = capture?.value;
  if (!capture || !isRecord(evidence) || typeof evidence.text !== "string") {
    throw new DeviceBrokerError("missing_target", "developer log capture is unavailable");
  }
  return { jobId: job.jobId, taskId, observationId: capture.id, capturedAt: capture.observedAt, text: evidence.text };
}

async function createJob(request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime, sessionId: string): Promise<void> {
  const body = await readJsonBody(request, 4096).catch(() => undefined);
  const kind = isRecord(body) && jobKinds.find(value => value === body.kind);
  if (!isRecord(body) || !kind || typeof body.jobId !== "string" || !/^[a-z0-9_-]{1,128}$/iu.test(body.jobId)
    || Object.keys(body).some(key => !jobFields.has(key))
    || (body.artifactDigest !== undefined && !boundedReference(body.artifactDigest))
    || (body.expectedSessionRevision !== undefined && (typeof body.expectedSessionRevision !== "number"
      || !Number.isSafeInteger(body.expectedSessionRevision) || body.expectedSessionRevision < 1))
    || !boundedReference(body.authorizationRevision)) {
    throw new DeviceBrokerError("invalid_request", "invalid developer job");
  }
  const { job, admitted } = await runtime.developerJobs.submit(requireSession(runtime, sessionId), {
    jobId: body.jobId, kind, authorizationRevision: body.authorizationRevision,
    ...(body.artifactDigest ? { artifactDigest: body.artifactDigest } : {}),
    ...(typeof body.expectedSessionRevision === "number" ? { expectedSessionRevision: body.expectedSessionRevision } : {}),
  });
  if (!response.destroyed) writePrivateJson(response, admitted ? 201 : 200, { job });
}

async function createSession(request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): Promise<void> {
  const body = await readJsonBody(request, 4096).catch(() => undefined);
  if (!isRecord(body) || Object.keys(body).length !== 2 || !boundedReference(body.targetDeviceId)
    || (body.mode !== "standard" && body.mode !== "developer")) {
    throw new DeviceBrokerError("invalid_request", "invalid device session");
  }
  const target = runtime.store.getDeviceRetirementState(body.targetDeviceId, DEFAULT_WORKSPACE_ID);
  assertDeveloperTargetActive(target.lifecycleStatus);
  const profile = runtime.store.getDevice(target.deviceId)!;
  const now = new Date().toISOString();
  const session = runtime.developerSessions.createSession({
    sessionId: `developer_${randomUUID()}`, workspaceId: DEFAULT_WORKSPACE_ID,
    ownerKind: "daemon", ownerId: DEFAULT_WORKSPACE_ID, targetDeviceId: target.deviceId,
    targetKind: profile.device.kind, mode: body.mode, authorizationRevision: `pending_${randomUUID()}`,
    targetBinding: { profileRevision: target.profileRevision, connectionRevision: target.connectionRevision },
    status: "created", revision: 1, createdAt: now, updatedAt: now,
  });
  writePrivateJson(response, 201, { session });
}

async function authorizeSession(
  encoded: string,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
): Promise<void> {
  const body = await readJsonBody(request, 2048).catch(() => undefined);
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.expectedRevision !== "number"
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
    throw new DeviceBrokerError("invalid_request", "invalid device session authorization");
  }
  const session = requireSession(runtime, encoded);
  if (!session.targetBinding || session.protocolReplay) {
    throw new DeviceBrokerError("permission_denied", "session has a separate authorization flow");
  }
  if (body.expectedRevision !== session.revision || !["created", "completed", "failed"].includes(session.status)) {
    throw new DeviceBrokerError("target_changed", "device session authorization changed");
  }
  requireCurrentDeveloperTarget(runtime.store, session);
  const authorized = runtime.developerSessions.authorize(
    session.sessionId, `auth_${randomUUID()}`, new Date().toISOString(), body.expectedRevision,
  );
  writePrivateJson(response, 200, { session: authorized });
}

function requireSession(runtime: DeviceSupportRuntime, encoded: string): DeviceDeveloperSessionV1 {
  const session = runtime.developerSessions.getSession(readReference(encoded));
  if (!session || session.workspaceId !== DEFAULT_WORKSPACE_ID || session.ownerKind !== "daemon"
    || session.ownerId !== DEFAULT_WORKSPACE_ID
    || runtime.store.getDevice(session.targetDeviceId)?.device.ownerScope !== session.workspaceId) {
    throw new DeviceBrokerError("missing_target", "device session is unavailable");
  }
  return session;
}

function readReference(encoded: string): string {
  const value = decodeURIComponent(encoded);
  if (!boundedReference(value)) throw new DeviceBrokerError("invalid_request", "invalid device session reference");
  return value;
}

function boundedReference(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function writeDeveloperError(response: ServerResponse, error: unknown): void {
  const code = error instanceof DeviceBrokerError || error instanceof DeviceFabricError ? error.code
    : error instanceof URIError ? "invalid_request" : "service_unavailable";
  const status = code === "target_missing" || code === "missing_target" ? 404
    : code === "safety_denied" || code === "permission_denied" ? 403
    : code === "target_changed" || code === "revision_conflict" ? 409
    : code === "unsupported_capability" ? 422 : code === "invalid_request" ? 400 : 503;
  writePrivateJson(response, status, { error: code });
}
