import {
  REMOTE_DEVICE_ARTIFACT_MAX_BYTES, isAndroidApkFileName, isAndroidPackageId, isAndroidVersionCode,
  type AndroidApkIdentityV1, type DeviceTaskV1, type RemotePhoneTaskProjectionV1,
} from "@ling-stack/contracts";
import { canonicalJsonBytes, canonicalizeJson, encodeBase64Url, phoneTaskProjectionDigest, sha256 } from "@ling-stack/remote-protocol";
import { digestDeviceRequest, type MobileDeviceExecution, type MobileDeviceJournal } from "./execution.ts";
import type { MobileTaskEvidence } from "./journal.ts";
import type { OpenPhoneTaskArtifactFile, SavedPhoneTaskArtifact } from "./phone-task-artifacts.ts";
import { createMobilePlaybookAction, runMobileReadOnlyPlaybook, runMobileSetupPlaybook } from "./playbook.ts";
import {
  prepareUsbAndroidDevice, readAndroidDeployment, usbAndroidIdentifyPlaybook, usbAndroidInstallPlaybook,
  type AndroidApkSelection, type UsbAndroidBridge, type UsbAndroidDevice, type UsbAndroidSession,
} from "./usb-android.ts";

type UsbTarget = { readonly target: UsbAndroidDevice; readonly signal?: AbortSignal };

export interface PhoneUsbAndroidReview {
  readonly diagnosisTaskId: string;
  readonly targetDeviceId: string;
  readonly profileRevision: string;
  readonly selection: AndroidApkSelection;
  readonly fileName: string;
  readonly digest: string;
  readonly identity: AndroidApkIdentityV1;
}

export function createPhoneUsbAndroidRuntime(options: {
  readonly bridge: UsbAndroidBridge;
  readonly ownerId: string;
  readonly policyRevision: string;
  readonly randomId: (prefix: string) => string | Promise<string>;
  readonly now: () => string;
  readonly journal: MobileDeviceJournal & { readTaskEvidence(taskId: string): Promise<MobileTaskEvidence> };
  readonly execution: MobileDeviceExecution;
  readonly openFile: OpenPhoneTaskArtifactFile;
  readonly listSaved: (taskId: string) => Promise<readonly SavedPhoneTaskArtifact[]>;
  readonly readProjection: (taskId: string) => Promise<RemotePhoneTaskProjectionV1 | undefined>;
  readonly waitForForeground: () => Promise<void>;
  readonly foregroundOperations: Set<AbortController>;
}) {
  const { bridge, ownerId, policyRevision, now, journal, execution } = options;
  const installing = new Set<string>();
  const installActionId = usbAndroidInstallPlaybook + ":install";

  async function diagnosis(taskId: string) {
    const record = readUsbAndroidDiagnosis(await journal.readTaskEvidence(taskId));
    if (!record) throw new Error("adb_target_identity_unavailable");
    return record;
  }

  async function loadApk(taskId: string, selection: AndroidApkSelection) {
    const saved = selection.source === "paired_pc"
      ? (await options.listSaved(taskId)).find(item => item.fileId === selection.fileId)
      : undefined;
    const manifest = saved?.offer.manifest;
    if (selection.source === "paired_pc") {
      const projection = await options.readProjection(taskId);
      if (!manifest?.androidApk || !projection || manifest.projectionDigest !== phoneTaskProjectionDigest(projection)) {
        throw new Error("phone_task_artifact_binding_changed");
      }
    }
    const name = selection.source === "phone_file" ? selection.name : manifest?.name;
    if (!name || !isAndroidApkFileName(name)) throw new Error("adb_invalid_apk");
    const file = options.openFile(selection.fileId, name);
    const size = await file.size();
    if (!Number.isSafeInteger(size) || size < 1 || size > REMOTE_DEVICE_ARTIFACT_MAX_BYTES
      || (manifest && size !== manifest.sizeBytes) || !file.inspectAndroidApk) {
      throw new Error("adb_invalid_apk");
    }
    const apkUri = file.uri?.();
    if (!apkUri) throw new Error("adb_invalid_apk");
    const digest = await file.digest();
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest) || (manifest && manifest.digest !== digest)) {
      throw new Error("phone_task_artifact_digest_mismatch");
    }
    const identity = await file.inspectAndroidApk();
    if (!isAndroidPackageId(identity.packageId) || !isAndroidVersionCode(identity.versionCode)
      || !identity.signerCertificateSha256.length || !identity.signerCertificateSha256.every(digest => /^[a-f0-9]{64}$/u.test(digest))
      || (manifest?.androidApk && canonicalizeJson(identity) !== canonicalizeJson(manifest.androidApk))) {
      throw new Error("phone_task_apk_identity_mismatch");
    }
    return { file, identity, digest, name, uri: apkUri };
  }

  async function inForeground<T>(signal: AbortSignal | undefined, run: (foregroundSignal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    options.foregroundOperations.add(controller);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    try {
      await options.waitForForeground();
      controller.signal.throwIfAborted();
      return await run(controller.signal);
    } finally {
      signal?.removeEventListener("abort", stop);
      options.foregroundOperations.delete(controller);
    }
  }

  async function usingTarget<T>(target: UsbAndroidDevice, signal: AbortSignal, run: (session: UsbAndroidSession, revision: string) => Promise<T>) {
    const revision = await options.randomId("usb_android_connection");
    signal.throwIfAborted();
    const session = await bridge.open(target, signal);
    try {
      signal.throwIfAborted();
      return await run(session, revision);
    } finally {
      session.close();
    }
  }

  async function recordedInstall(taskId: string) {
    const run = projectUsbAndroidInstall(await journal.readTaskEvidence(taskId));
    if (!run) throw new Error("adb_install_record_unavailable");
    return run;
  }

  return {
    listTargets: () => bridge.list(),
    async authorize(target: UsbAndroidDevice) {
      await options.waitForForeground();
      await bridge.authorize(target);
    },
    identify(input: UsbTarget) {
      return inForeground(input.signal, signal => usingTarget(input.target, signal, async (session, connectionRevision) => {
        const { profile, snapshot, transport, identityStep } = prepareUsbAndroidDevice({ session, ownerId, connectionRevision, now });
        const task: DeviceTaskV1 = {
          id: await options.randomId("device_task"), ownerKind: "mobile", ownerId, targetDeviceIds: [profile.device.id],
          status: "planning", capabilitySnapshotIds: [snapshot.snapshotId], createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt,
        };
        await runMobileReadOnlyPlaybook({ playbookId: usbAndroidIdentifyPlaybook, profile, snapshot, transport, task, execution, signal, steps: [identityStep] });
        return (await diagnosis(task.id)).identity;
      }));
    },
    async review(taskId: string, selection: AndroidApkSelection): Promise<PhoneUsbAndroidReview> {
      const { identity, profileRevision } = await diagnosis(taskId);
      const apk = await loadApk(taskId, selection);
      return {
        diagnosisTaskId: taskId, targetDeviceId: identity.targetDeviceId, profileRevision,
        selection, fileName: apk.name, digest: apk.digest, identity: apk.identity,
      };
    },
    install(input: UsbTarget & { readonly review: PhoneUsbAndroidReview }) {
      return inForeground(input.signal, async signal => {
        const { review } = input;
        const baseline = await diagnosis(review.diagnosisTaskId);
        if (baseline.identity.targetDeviceId !== review.targetDeviceId || baseline.profileRevision !== review.profileRevision) {
          throw new Error("usb_target_changed");
        }
        const taskId = "device_task_" + encodeBase64Url(sha256(canonicalJsonBytes([review.diagnosisTaskId, review.digest])));
        if (await journal.getTask(taskId)) return recordedInstall(taskId);
        const apk = await loadApk(review.diagnosisTaskId, review.selection);
        if (apk.name !== review.fileName || apk.digest !== review.digest || canonicalizeJson(apk.identity) !== canonicalizeJson(review.identity)) {
          throw new Error("phone_task_artifact_binding_changed");
        }
        return usingTarget(input.target, signal, async (session, connectionRevision) => {
          const deployment = {
            packageId: apk.identity.packageId, versionCode: apk.identity.versionCode, artifactDigest: apk.digest,
            diagnosisTaskId: review.diagnosisTaskId, source: review.selection.source,
          };
          const { profile, snapshot, transport, installStep } = prepareUsbAndroidDevice({
            session, ownerId, connectionRevision, now, deployment, apkUri: apk.uri,
          });
          const deviceId = profile.device.id;
          if (deviceId !== review.targetDeviceId || profile.profileRevision !== review.profileRevision) throw new Error("usb_target_changed");
          if (!installStep || installing.has(deviceId)) throw new Error("usb_target_busy");
          installing.add(deviceId);
          try {
            if (await journal.getTask(taskId)) return await recordedInstall(taskId);
            const pending = (await journal.listTasks()).some(task =>
              task.currentActionId === installActionId && task.targetDeviceIds.includes(deviceId)
              && ["executing", "verifying", "unknown"].includes(task.status));
            if (pending) throw new Error("adb_install_pending_readback");
            const task: DeviceTaskV1 = {
              id: taskId, ownerKind: "mobile", ownerId, targetDeviceIds: [deviceId], status: "awaiting_approval", policyRevision,
              capabilitySnapshotIds: [snapshot.snapshotId], createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt,
            };
            const context = { playbookId: usbAndroidInstallPlaybook, profile, snapshot, task, transport, execution, signal };
            const request = createMobilePlaybookAction(context, installStep);
            const approval = {
              approvalId: await options.randomId("device_approval"), taskId, actionId: request.actionId, targetDeviceId: deviceId,
              capabilitySnapshotId: snapshot.snapshotId, connectionRevision, policyRevision,
              normalizedInputDigest: digestDeviceRequest(request), expiresAt: snapshot.freshnessUntil,
            };
            await runMobileSetupPlaybook({ ...context, steps: [{ ...installStep, approval }] });
            return await recordedInstall(taskId);
          } finally {
            installing.delete(deviceId);
          }
        });
      });
    },
    readback(input: UsbTarget & { readonly taskId: string }) {
      return inForeground(input.signal, async signal => {
        const evidence = await journal.readTaskEvidence(input.taskId);
        const original = readUsbAndroidInstall(evidence);
        if (!original || !evidence.task) throw new Error("adb_install_record_unavailable");
        if (evidence.task.status !== "unknown") return recordedInstall(input.taskId);
        return usingTarget(input.target, signal, async (session, connectionRevision) => {
          const { profile, snapshot, transport } = prepareUsbAndroidDevice({
            session, ownerId, connectionRevision, now, deployment: original.deployment,
          });
          if (profile.device.id !== original.record.request.targetDeviceId
            || profile.profileRevision !== original.record.attempt.adapterBinding?.profileRevision) throw new Error("usb_target_changed");
          await execution.reconcile({
            taskId: input.taskId, attemptId: original.record.attempt.attemptId,
            reconciliationId: await options.randomId("device_reconciliation"), profile, snapshot, transport, signal,
          });
          return recordedInstall(input.taskId);
        });
      });
    },
    async listDiagnoses() {
      await options.waitForForeground();
      return recent(journal, evidence => readUsbAndroidDiagnosis(evidence)?.identity);
    },
    async listInstalls() {
      await options.waitForForeground();
      return recent(journal, projectUsbAndroidInstall);
    },
  };
}

export type PhoneUsbAndroidRuntime = ReturnType<typeof createPhoneUsbAndroidRuntime>;

export function readUsbAndroidDiagnosis(evidence: MobileTaskEvidence) {
  const { task } = evidence;
  const record = evidence.attempts.find(item => item.request.actionId === usbAndroidIdentifyPlaybook + ":identify");
  if (task?.status !== "succeeded" || !record?.attempt.adapterBinding || record.attempt.receipt?.status !== "completed") return undefined;
  const targetDeviceId = record.request.targetDeviceId;
  const observation = evidence.observations.find(item => item.subjectId === targetDeviceId && item.redactionClass === "public"
    && item.source === "android.usb.identity" && record.attempt.receipt?.observationIds.includes(item.id));
  const value = observation?.value;
  if (!value || typeof value !== "object" || !("model" in value) || typeof value.model !== "string"
    || !("androidVersion" in value) || typeof value.androidVersion !== "string") return undefined;
  return { record, profileRevision: record.attempt.adapterBinding.profileRevision, identity: {
    taskId: task.id, updatedAt: task.updatedAt, targetDeviceId, model: value.model, androidVersion: value.androidVersion,
  } };
}

export type PhoneUsbAndroidDiagnosis = NonNullable<ReturnType<typeof readUsbAndroidDiagnosis>>["identity"];

export function readUsbAndroidInstall(evidence: MobileTaskEvidence) {
  const record = evidence.attempts.find(item => item.request.actionId === usbAndroidInstallPlaybook + ":install");
  const deployment = record && readAndroidDeployment(record.request.normalizedInput);
  return record && deployment ? { record, deployment } : undefined;
}

function projectUsbAndroidInstall(evidence: MobileTaskEvidence) {
  const original = readUsbAndroidInstall(evidence);
  const { task } = evidence;
  if (!task || !original) return undefined;
  const { record, deployment } = original;
  const verification = record.reconciliations?.find(item => item.reconciliationId === task.lastVerificationId)?.verification ?? record.attempt.verification;
  const value = evidence.observations.find(item => verification?.observationIds.includes(item.id)
    && item.source === "android.usb.package" && item.subjectId === record.request.targetDeviceId)?.value;
  return {
    taskId: task.id, targetDeviceId: record.request.targetDeviceId, updatedAt: task.updatedAt, status: task.status,
    packageId: deployment.packageId, versionCode: deployment.versionCode, source: deployment.source, diagnosisTaskId: deployment.diagnosisTaskId,
    ...(value && typeof value === "object" && "versionCode" in value && typeof value.versionCode === "string"
      ? { installedVersionCode: value.versionCode } : {}),
    ...(value && typeof value === "object" && "artifactDigest" in value && typeof value.artifactDigest === "string"
      ? { installedDigest: value.artifactDigest } : {}),
  };
}

export type PhoneUsbAndroidInstall = NonNullable<ReturnType<typeof projectUsbAndroidInstall>>;

async function recent<T>(
  journal: MobileDeviceJournal & { readTaskEvidence(taskId: string): Promise<MobileTaskEvidence> },
  project: (evidence: MobileTaskEvidence) => T | undefined,
): Promise<readonly T[]> {
  const items: T[] = [];
  const tasks = [...await journal.listTasks()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const task of tasks) {
    if (task.currentActionId !== usbAndroidIdentifyPlaybook + ":identify" && task.currentActionId !== usbAndroidInstallPlaybook + ":install") continue;
    const item = project(await journal.readTaskEvidence(task.id));
    if (item) items.push(item);
    if (items.length === 8) break;
  }
  return items;
}
