import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DeviceDeveloperJobV1, DeviceDeveloperSessionV1, HardwareProtocolCaptureV1 } from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, DeviceFabricError } from "@ling-stack/core";
import { canonicalJsonBytes } from "@ling-stack/remote-protocol";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import type { DeviceSupportRuntime } from "./runtime.js";

const protocolPath = "/v1/device-support/protocol";
const sessionReplayPath = /^\/v1\/device-support\/protocol\/sessions\/([A-Za-z0-9_-]+)\/replay$/u;
type ReplaySession = DeviceDeveloperSessionV1 & Required<Pick<DeviceDeveloperSessionV1, "protocolReplay">>;

export async function handleDeviceProtocolRoute(
  url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const profiles = url.pathname === `${protocolPath}/profiles`;
  const createSession = url.pathname === `${protocolPath}/sessions`;
  const sessionId = sessionReplayPath.exec(url.pathname)?.[1];
  if (!profiles && !createSession && !sessionId) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  const method = request.method;
  if (profiles ? method !== "GET" : createSession ? method !== "POST" : method !== "GET" && method !== "POST") {
    response.setHeader("Allow", profiles ? "GET" : createSession ? "POST" : "GET, POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    if (profiles) {
      writePrivateJson(response, 200, { profiles: runtime.protocolProfiles.list() });
      return true;
    }
    if (createSession) {
      const body = await readJsonBody(request, 4096).catch(() => undefined);
      if (!isRecord(body) || Object.keys(body).length !== 2 || !isProtocolId(body.profileId) || !isProtocolId(body.targetDeviceId)) {
        writePrivateJson(response, 400, { error: "invalid_protocol_session" });
        return true;
      }
      const profile = runtime.store.getDevice(body.targetDeviceId);
      if (profile && profile.device.ownerScope !== DEFAULT_WORKSPACE_ID) {
        throw new DeviceFabricError("target_missing", "protocol target is outside the current workspace");
      }
      const protocol = runtime.protocolProfiles.resolve({
        profileId: body.profileId, deviceKind: profile?.device.kind ?? "hardware",
        model: profile?.device.model, firmwareVersion: profile?.device.firmwareVersion,
      });
      const codec = runtime.protocolWorkbench.getCodecManifest(protocol.codecId);
      if (!codec) throw new DeviceFabricError("target_missing", "protocol codec is unavailable");
      const now = new Date().toISOString();
      const session = runtime.developerSessions.createSession({
        sessionId: `protocol_replay_${randomUUID()}`, workspaceId: DEFAULT_WORKSPACE_ID,
        ownerKind: "daemon", ownerId: DEFAULT_WORKSPACE_ID, targetDeviceId: body.targetDeviceId,
        targetKind: profile?.device.kind ?? "hardware", mode: "developer", status: "authorized",
        authorizationRevision: randomUUID(), revision: 1, createdAt: now, updatedAt: now,
        protocolReplay: { profileId: protocol.profileId, profileVersion: protocol.version, codecId: codec.codecId, codecVersion: codec.version },
      });
      writePrivateJson(response, 201, { session });
      return true;
    }
    const session = requireReplaySession(runtime, sessionId!);
    const jobId = `workbench:${session.sessionId}`;
    if (method === "GET") {
      const job = runtime.developerSessions.getJob(jobId);
      writePrivateJson(response, 200, readCompletedReplay(runtime, session, job));
      return true;
    }

    const body = await readJsonBody(request, 1024 * 1024).catch(() => undefined);
    if (!isRecord(body) || Object.keys(body).length !== 2 || typeof body.authorizationRevision !== "string" || !isImportedCapture(body.capture)) {
      writePrivateJson(response, 400, { error: "invalid_protocol_capture" });
      return true;
    }
    const active = requireReplaySession(runtime, session.sessionId);
    if (body.authorizationRevision !== active.authorizationRevision) {
      throw new DeviceFabricError("safety_denied", "protocol replay session authorization changed");
    }
    const capture = { ...body.capture, captureId: `${session.sessionId}:${body.capture.captureId}` };
    const replay = decodeReplay(runtime, active, capture);
    const artifactDigest = captureDigest(capture);
    const now = new Date().toISOString();
    const started = runtime.developerSessions.startJob({
      jobId, sessionId: active.sessionId, kind: "workbench", status: "running", targetDeviceId: active.targetDeviceId,
      taskStatus: "executing", artifactDigest, revision: 1, updatedAt: now,
    });
    if (started.status === "completed" && started.outputRef === capture.captureId) {
      writePrivateJson(response, 200, readCompletedReplay(runtime, active, started));
      return true;
    }
    if (started.status !== "running") throw new DeviceFabricError("revision_conflict", "protocol replay job already has an outcome");
    runtime.protocolStore.saveCapture(capture);
    const job = runtime.developerSessions.settleJob(jobId, "completed", capture.captureId, now, "succeeded");
    writePrivateJson(response, 201, { job, replay });
  } catch (error) {
    if (error instanceof DeviceFabricError) {
      const status = error.code === "target_missing" ? 404 : error.code === "safety_denied" ? 403 : 409;
      writePrivateJson(response, status, { error: error.code });
    } else {
      writePrivateJson(response, 503, { error: "service_unavailable" });
    }
  }
  return true;
}

function requireReplaySession(runtime: DeviceSupportRuntime, sessionId: string): ReplaySession {
  const session = runtime.developerSessions.getSession(sessionId);
  if (!session?.protocolReplay || session.workspaceId !== DEFAULT_WORKSPACE_ID
    || session.ownerKind !== "daemon" || session.mode !== "developer") {
    throw new DeviceFabricError("target_missing", "developer protocol replay session is unavailable");
  }
  if (session.status === "revoked") throw new DeviceFabricError("safety_denied", "developer protocol replay session was revoked");
  return { ...session, protocolReplay: session.protocolReplay };
}

function readCompletedReplay(runtime: DeviceSupportRuntime, session: ReplaySession, job: DeviceDeveloperJobV1 | undefined) {
  if (job?.status !== "completed" || job.sessionId !== session.sessionId || job.kind !== "workbench" || !job.outputRef) {
    throw new DeviceFabricError("target_missing", "protocol replay is unavailable");
  }
  const capture = runtime.protocolStore.getCapture(job.outputRef);
  if (!capture) throw new DeviceFabricError("target_missing", "protocol replay capture is unavailable");
  if (captureDigest(capture) !== job.artifactDigest) throw new DeviceFabricError("revision_conflict", "protocol replay capture digest changed");
  return { job, replay: decodeReplay(runtime, session, capture) };
}

function captureDigest(capture: HardwareProtocolCaptureV1): string {
  return createHash("sha256").update(canonicalJsonBytes(capture)).digest("hex");
}

function decodeReplay(
  runtime: DeviceSupportRuntime, session: ReplaySession,
  capture: HardwareProtocolCaptureV1,
) {
  const binding = session.protocolReplay;
  const profile = runtime.protocolStore.getProfile(binding.profileId);
  const codec = runtime.protocolWorkbench.getCodecManifest(binding.codecId);
  if (!profile || !codec || profile.version !== binding.profileVersion || codec.version !== binding.codecVersion || profile.codecId !== codec.codecId
    || capture.transport !== profile.transport || capture.targetDeviceId !== session.targetDeviceId || capture.source !== "imported") {
    throw new DeviceFabricError("target_changed", "protocol replay target, profile or codec changed");
  }
  const decoded = runtime.protocolWorkbench.decode(capture, codec.codecId);
  return {
    captureId: capture.captureId, targetDeviceId: capture.targetDeviceId, transport: capture.transport,
    createdAt: capture.createdAt, source: capture.source, ...binding, ...(capture.loss ? { loss: capture.loss } : {}),
    frames: decoded.map((frame, index) => ({
      ...frame, capturedAt: capture.frames[index]!.capturedAt, direction: capture.frames[index]!.direction,
      digest: capture.frames[index]!.digest,
    })),
  };
}

function isProtocolId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/u.test(value);
}

function isImportedCapture(value: unknown): value is HardwareProtocolCaptureV1 {
  if (!isRecord(value) || !isProtocolId(value.captureId) || !isProtocolId(value.targetDeviceId)
    || value.source !== "imported" || typeof value.createdAt !== "string" || typeof value.transport !== "string"
    || Object.keys(value).some(key => !["captureId", "targetDeviceId", "createdAt", "source", "transport", "frames", "loss"].includes(key))
    || !Array.isArray(value.frames) || value.frames.length > 2048) return false;
  if (value.loss !== undefined && (!isRecord(value.loss) || typeof value.loss.reason !== "string"
    || Object.keys(value.loss).some(key => key !== "reason" && key !== "droppedFrames"))) return false;
  return value.frames.every(frame => isRecord(frame)
    && Object.keys(frame).length === 5 && typeof frame.sequence === "number" && typeof frame.direction === "string"
    && typeof frame.bytesBase64 === "string" && typeof frame.digest === "string" && typeof frame.capturedAt === "string");
}
