import {
  projectDeviceAttemptChecks, projectDeviceCapabilitySnapshotForTrace,
  type MobileDeviceAttemptConformanceReportV1,
} from "@ling-stack/contracts";
import { canonicalJsonBytes, sha256 } from "@ling-stack/remote-protocol";

import type { MobileTaskEvidence } from "./journal.js";
import { projectMobileDeviceTaskTrace } from "./trace.ts";

export function projectMobileTaskEvidenceExport(evidence: MobileTaskEvidence, ownerId: string) {
  const trace = projectMobileDeviceTaskTrace(evidence, ownerId);
  const task = evidence.task;
  if (!trace || !task) return undefined;
  const traceDigest = digest(trace);
  const conformanceReports = evidence.attempts.flatMap(({ attempt, request, capabilitySnapshots }) => {
    const attemptSpanId = `${trace.traceId}:attempt:${attempt.attemptId}`;
    if (!trace.spans.some(span => span.spanId === attemptSpanId && span.kind === "adapter")) return [];
    const recorded = capabilitySnapshots?.find(item => item.snapshot.deviceId === attempt.targetDeviceId
      && item.snapshot.snapshotId === request.capabilitySnapshotId);
    const snapshot = recorded && projectDeviceCapabilitySnapshotForTrace(recorded.snapshot, recorded.profileRevision);
    const span = trace.spans.findLast(span => span.parentSpanId === attemptSpanId
      && span.kind === "verification" && (span.status === "ok" || span.status === "failed"));
    const metadata = span?.metadata;
    const refs = metadata && typeof metadata === "object" && "evidenceRefs" in metadata ? metadata.evidenceRefs : undefined;
    const evidenceRef = Array.isArray(refs) ? refs[0] : undefined;
    const checks = projectDeviceAttemptChecks({
      attempt, request, attemptSpanId, snapshot,
      readback: span && typeof evidenceRef === "string"
        ? { status: span.status === "ok" ? "verified" : "failed", evidenceRef } : undefined,
    });
    const adapter = attempt.adapterBinding;
    const report: Omit<MobileDeviceAttemptConformanceReportV1, "reportId"> = {
      runtimeId: task.ownerId,
      adapterId: adapter?.adapterId ?? snapshot?.adapterId ?? "unrecorded",
      adapterVersion: adapter?.adapterVersion ?? snapshot?.adapterVersion ?? "unrecorded",
      targetProfile: adapter?.profileRevision ?? snapshot?.profileRevision ?? "unrecorded",
      transport: adapter?.transport ?? "unrecorded",
      checks, generatedAt: task.updatedAt,
      source: {
        ownerKind: "mobile", workspaceId: task.ownerId, taskId: task.id, attemptId: attempt.attemptId,
        deviceId: attempt.targetDeviceId, capabilityId: request.capabilityId, capabilitySnapshotId: request.capabilitySnapshotId,
        traceId: trace.traceId, traceDigest,
        ...(attempt.connectionRevision ? { connectionRevision: attempt.connectionRevision } : {}),
        ...(adapter?.firmwareVersion ? { firmwareVersion: adapter.firmwareVersion } : {}),
      },
    };
    return [{ reportId: `device_conformance_${digest(report)}`, ...report }];
  });
  return { ...trace, conformanceReports };
}

function digest(value: unknown): string {
  return Array.from(sha256(canonicalJsonBytes(value)), byte => byte.toString(16).padStart(2, "0")).join("");
}
