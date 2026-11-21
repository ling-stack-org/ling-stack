import type { DeviceActionResultV1, DeviceTaskAttemptV1, DeviceVerificationResultV1, JsonValue } from "./device.js";

export interface DeviceDiagnosisFactV1 {
  readonly observationId: string;
  readonly source: string;
  readonly observedAt: string;
  readonly freshnessUntil: string;
  readonly value: JsonValue;
}

export interface DeviceDiagnosisHypothesisV1 {
  readonly code: "link_or_address_issue" | "route_issue" | "gateway_issue" | "dns_issue" | "service_issue" | "integration_or_device_issue";
  readonly observationId: string;
}

export interface DeviceDiagnosisActionV1 {
  readonly attemptId: string;
  readonly actionId: string;
  readonly targetDeviceId: string;
  readonly capabilityId: string;
  readonly status: DeviceTaskAttemptV1["status"];
  readonly receiptStatus?: DeviceActionResultV1["status"];
  readonly errorCode?: DeviceActionResultV1["errorCode"];
}

export type DeviceDiagnosisVerificationV1 = Pick<DeviceVerificationResultV1, "actionId" | "status" | "observationIds" | "checkedAt">;

export interface DeviceDiagnosisUncertaintyV1 {
  readonly code: "missing_observation" | "unusable_observation" | "unknown_action_outcome" | "missing_verification" | "step_failed";
  readonly ref: string;
}

export interface DeviceDiagnosisReportV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly playbookId: string;
  readonly playbookVersion: string;
  readonly generatedAt: string;
  readonly facts: readonly DeviceDiagnosisFactV1[];
  readonly hypotheses: readonly DeviceDiagnosisHypothesisV1[];
  readonly actions: readonly DeviceDiagnosisActionV1[];
  readonly verifications: readonly DeviceDiagnosisVerificationV1[];
  readonly remainingUncertainty: readonly DeviceDiagnosisUncertaintyV1[];
  readonly untrustedTextRefs: readonly string[];
}
