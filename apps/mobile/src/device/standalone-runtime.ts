import type {
  DeviceApprovalBindingV1, DeviceDispatchStopV1, DeviceErrorCodeV1, DeviceTaskV1, LinuxNetworkFacts, RemotePhoneTaskProjectionV1,
} from "@ling-stack/contracts";

import { digestDeviceRequest, MobileDeviceExecution, type MobileDeviceJournal } from "./execution.ts";
import {
  automationIdentityFromRequest, entityIdFromRequest, HomeAssistantInputError, homeAssistantEntityState, prepareHomeAssistantDevice,
  type HomeAssistantAvailability, type HomeAssistantDeviceInput, type HomeAssistantFetch,
} from "./home-assistant.ts";
import { createAsyncStorageMobileDeviceJournal, type MobileStorageLike, type MobileTaskEvidence } from "./journal.ts";
import {
  linuxSshPlaybookId, prepareLinuxSshDiagnosis,
  type LinuxSshTarget, type LinuxSshTargetInput, type OpenLinuxSshConnection,
} from "./linux-ssh.ts";
import { createMobilePlaybookAction, runMobileReadOnlyPlaybook, runMobileSetupPlaybook } from "./playbook.ts";
import { projectMobileDeviceTaskTrace } from "./trace.ts";
import { projectMobileTaskEvidenceExport } from "./conformance.ts";
import { createPhoneTaskCollaboration } from "./phone-task-collaboration.ts";
import { createPhoneTaskArtifactReceiver, type OpenPhoneTaskArtifactFile } from "./phone-task-artifacts.ts";

const ownerKey = "ling:standalone-device-owner:v1";
const homeAssistantPlaybookId = "home-assistant-offline-diagnosis@1.0.0";
const homeAssistantRecoveryPlaybookId = "home-assistant-enable-automation@1.0.0";
const policyRevision = "device-policy-v1";
const recentRunLimit = 8;

export interface PhoneHomeAssistantRun {
  readonly taskId: string;
  readonly deviceId: string;
  readonly updatedAt: string;
  readonly taskStatus: DeviceTaskV1["status"];
  readonly entityId: string;
  readonly operation: "diagnosis" | "enable_automation";
  readonly availability?: HomeAssistantAvailability;
  readonly automationEnabled?: boolean;
  readonly canEnableAutomation?: boolean;
  readonly dispatchStop?: DeviceDispatchStopV1;
  readonly errorCode?: DeviceErrorCodeV1;
}

export interface PhoneLinuxSshRun {
  readonly taskId: string;
  readonly deviceId: string;
  readonly updatedAt: string;
  readonly taskStatus: DeviceTaskV1["status"];
  readonly facts?: LinuxNetworkFacts;
  readonly errorCode?: DeviceErrorCodeV1;
}

export async function createStandaloneDeviceRuntime(options: {
  readonly storage: MobileStorageLike;
  readonly randomId: (prefix: string) => string | Promise<string>;
  readonly fetch: HomeAssistantFetch;
  readonly openLinuxSsh?: OpenLinuxSshConnection;
  readonly openArtifactFile?: OpenPhoneTaskArtifactFile;
  readonly now?: () => string;
}) {
  const persistedOwner = await options.storage.getItem(ownerKey);
  const ownerId = persistedOwner ?? await options.randomId("phone_owner");
  if (!/^phone_owner_[A-Za-z0-9_-]{16,64}$/u.test(ownerId)) throw new Error("Invalid phone device task owner");
  if (persistedOwner === null) await options.storage.setItem(ownerKey, ownerId);
  const journal = createAsyncStorageMobileDeviceJournal(options.storage, ownerId);
  const now = options.now ?? (() => new Date().toISOString());
  const execution = new MobileDeviceExecution({ ownerId, journal, now, policyRevision, dispatchStops: journal });
  execution.setForeground(false);
  let foreground = false;
  let recovery = Promise.resolve();
  const readProjection = async (taskId: string) => {
    await recovery;
    return projectPhoneTask(await journal.readTaskEvidence(taskId), ownerId);
  };
  const collaborate = createPhoneTaskCollaboration({ storage: options.storage, ownerId, now, randomId: options.randomId, readProjection });
  const artifacts = options.openArtifactFile ? createPhoneTaskArtifactReceiver({
    storage: options.storage, ownerId, now, readProjection, openFile: options.openArtifactFile, foreground: () => foreground,
  }) : undefined;
  let targetWrites = Promise.resolve();
  const linuxTargetsKey = "ling:standalone-linux-targets:v1:" + ownerId;
  const activeLinux = new Set<AbortController>();

  async function projectHomeRun(evidence: MobileTaskEvidence): Promise<PhoneHomeAssistantRun | undefined> {
    const run = projectHomeAssistantRun(evidence);
    if (!run) return undefined;
    const stop = await journal.getDispatchStop(run.deviceId);
    return stop.revision > 0 ? { ...run, dispatchStop: stop } : run;
  }

  return {
    collaborate,
    artifacts,
    linuxSshAvailable: options.openLinuxSsh !== undefined,
    setForeground(active: boolean): Promise<void> {
      if (active === foreground) return recovery;
      foreground = active;
      execution.setForeground(active);
      if (active) recovery = recovery.catch(() => undefined).then(async () => { await execution.recoverAfterResume(); });
      else for (const operation of activeLinux) operation.abort();
      return recovery;
    },

    async diagnoseHomeAssistant(input: HomeAssistantDeviceInput & { readonly signal?: AbortSignal }): Promise<PhoneHomeAssistantRun> {
      const expectedRecovery = recovery;
      await expectedRecovery;
      const taskId = await options.randomId("device_task");
      const connectionRevision = await options.randomId("ha_connection");
      if (!foreground || expectedRecovery !== recovery || input.signal?.aborted) throw new Error("请在手机界面保持打开时运行诊断。");
      const { profile, snapshot, transport, step } = prepareHomeAssistantDevice({
        ...input, ownerId, connectionRevision, now, fetch: options.fetch,
      });
      const task: DeviceTaskV1 = {
        id: taskId, ownerKind: "mobile", ownerId, targetDeviceIds: [profile.device.id], status: "planning",
        capabilitySnapshotIds: [snapshot.snapshotId], createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt,
      };
      await runMobileReadOnlyPlaybook({
        playbookId: homeAssistantPlaybookId, steps: [step], task, profile, snapshot, transport, execution, signal: input.signal,
      });
      const run = await projectHomeRun(await journal.readTaskEvidence(task.id));
      if (!run) throw new Error("手机未能读取本次诊断记录。");
      return run;
    },

    async enableHomeAssistantAutomation(input: HomeAssistantDeviceInput & {
      readonly diagnosisTaskId: string;
      readonly signal?: AbortSignal;
    }): Promise<PhoneHomeAssistantRun> {
      const expectedRecovery = recovery;
      await expectedRecovery;
      const baseline = await journal.readTaskEvidence(input.diagnosisTaskId);
      const diagnosis = readHomeAssistantAttempt(baseline);
      if (baseline.task?.status !== "succeeded" || diagnosis?.operation !== "diagnosis"
        || diagnosis.state?.automationEnabled !== false || !diagnosis.state.automationIdentity || !diagnosis.observation) {
        throw new HomeAssistantInputError("先读取已停用的 Home Assistant 自动化。");
      }
      const connectionRevision = await options.randomId("ha_connection");
      const approvalId = await options.randomId("device_approval");
      const { profile, snapshot, transport, entityId, recoveryStep } = prepareHomeAssistantDevice({
        ...input, ownerId, connectionRevision, now, fetch: options.fetch, automationIdentity: diagnosis.state.automationIdentity,
      });
      if (entityId !== diagnosis.entityId || profile.device.id !== diagnosis.record.request.targetDeviceId || !recoveryStep) {
        throw new HomeAssistantInputError("Home Assistant 地址或自动化已更改，请重新读取状态。");
      }
      const taskId = `${input.diagnosisTaskId}:enable-automation`;
      const prior = await journal.readTaskEvidence(taskId);
      if (prior.task) {
        return await projectHomeRun(prior) ?? {
          taskId, deviceId: profile.device.id, entityId, operation: "enable_automation", taskStatus: prior.task.status, updatedAt: prior.task.updatedAt,
        };
      }
      const expiresAt = diagnosis.observation.freshnessUntil;
      if (Date.parse(expiresAt) <= Date.parse(now())) throw new HomeAssistantInputError("自动化状态已过期，请重新读取状态。");
      if ((await journal.getDispatchStop(profile.device.id)).active) throw new HomeAssistantInputError("设备写入已暂停。");
      if (!foreground || expectedRecovery !== recovery || input.signal?.aborted) throw new HomeAssistantInputError("请在手机前台重新确认恢复。");
      const task: DeviceTaskV1 = {
        id: taskId, ownerKind: "mobile", ownerId, targetDeviceIds: [profile.device.id], status: "awaiting_approval",
        capabilitySnapshotIds: [snapshot.snapshotId], policyRevision, createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt,
      };
      const context = { playbookId: homeAssistantRecoveryPlaybookId, profile, snapshot, task, transport, execution, signal: input.signal };
      const request = createMobilePlaybookAction(context, recoveryStep);
      const approval: DeviceApprovalBindingV1 = {
        approvalId, taskId, actionId: request.actionId, targetDeviceId: request.targetDeviceId,
        capabilitySnapshotId: snapshot.snapshotId, connectionRevision, policyRevision,
        expiresAt, normalizedInputDigest: digestDeviceRequest(request),
      };
      await runMobileSetupPlaybook({ ...context, steps: [{ ...recoveryStep, approval }] });
      const run = await projectHomeRun(await journal.readTaskEvidence(taskId));
      if (!run) throw new Error("手机未能读取本次恢复记录。");
      return run;
    },

    async verifyHomeAssistantRecovery(input: HomeAssistantDeviceInput & {
      readonly recoveryTaskId: string;
      readonly signal?: AbortSignal;
    }): Promise<PhoneHomeAssistantRun> {
      const expectedRecovery = recovery;
      await expectedRecovery;
      const evidence = await journal.readTaskEvidence(input.recoveryTaskId);
      const original = readHomeAssistantAttempt(evidence);
      const automationIdentity = original && automationIdentityFromRequest(original.record.request);
      if (original?.operation !== "enable_automation" || !automationIdentity) {
        throw new HomeAssistantInputError("找不到这次自动化恢复的记录。");
      }
      const connectionRevision = await options.randomId("ha_connection");
      const reconciliationId = await options.randomId("device_reconciliation");
      const { profile, snapshot, transport, entityId } = prepareHomeAssistantDevice({
        ...input, ownerId, connectionRevision, now, fetch: options.fetch, automationIdentity,
      });
      if (profile.device.id !== original.record.request.targetDeviceId || entityId !== original.entityId) {
        throw new HomeAssistantInputError("填写恢复记录中的 Home Assistant 地址和自动化实体。");
      }
      if (!foreground || expectedRecovery !== recovery || input.signal?.aborted) {
        throw new HomeAssistantInputError("请在手机前台读取恢复结果。");
      }
      await execution.reconcile({
        taskId: input.recoveryTaskId, attemptId: original.record.attempt.attemptId, reconciliationId,
        profile, snapshot, transport, signal: input.signal,
      });
      const run = await projectHomeRun(await journal.readTaskEvidence(input.recoveryTaskId));
      if (!run) throw new Error("手机未能读取本次恢复记录。");
      return run;
    },

    async listHomeAssistantRuns(): Promise<readonly PhoneHomeAssistantRun[]> {
      await recovery;
      return listRecentRuns(journal, ownerId, async task => projectHomeRun(await journal.readTaskEvidence(task.id)));
    },

    async setHomeAssistantDispatchStop(input: { readonly taskId: string; readonly active: boolean; readonly expectedRevision: number }) {
      await recovery;
      const evidence = await journal.readTaskEvidence(input.taskId);
      const deviceId = readHomeAssistantAttempt(evidence)?.record.request.targetDeviceId;
      if (!deviceId || !evidence.task?.targetDeviceIds.includes(deviceId)) {
        throw new HomeAssistantInputError("手机上的 Home Assistant 设备记录不可用。");
      }
      return execution.setDispatchStop({ deviceId, active: input.active, expectedRevision: input.expectedRevision });
    },

    async readTaskTrace(taskId: string) {
      await recovery;
      return projectMobileDeviceTaskTrace(await journal.readTaskEvidence(taskId), ownerId);
    },

    async readTaskEvidenceExport(taskId: string) {
      await recovery;
      return projectMobileTaskEvidenceExport(await journal.readTaskEvidence(taskId), ownerId);
    },

    async diagnoseLinuxSsh(input: {
      readonly target: LinuxSshTargetInput;
      readonly password: string;
      readonly signal?: AbortSignal;
    }): Promise<PhoneLinuxSshRun> {
      const open = options.openLinuxSsh;
      if (!open) throw new Error("当前手机构建无法运行 Linux SSH 诊断。");
      const expectedRecovery = recovery;
      await expectedRecovery;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      activeLinux.add(controller);
      input.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const taskId = await options.randomId("device_task");
        const connectionRevision = await options.randomId("ssh_connection");
        if (!foreground || expectedRecovery !== recovery || input.signal?.aborted || controller.signal.aborted) {
          throw new Error("请在手机界面保持打开时运行诊断。");
        }
        const { profile, snapshot, transport, step, target } = prepareLinuxSshDiagnosis({
          target: input.target, password: input.password, open, ownerId, connectionRevision, now,
        });
        const task: DeviceTaskV1 = {
          id: taskId, ownerKind: "mobile", ownerId, targetDeviceIds: [profile.device.id], status: "planning",
          capabilitySnapshotIds: [snapshot.snapshotId], createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt,
        };
        await runMobileReadOnlyPlaybook({
          playbookId: linuxSshPlaybookId, steps: [step], task, profile, snapshot, transport, execution, signal: controller.signal,
        });
        const recorded = await journal.getTask(task.id);
        const run = recorded && await readLinuxSshRun(journal, recorded);
        if (!run) throw new Error("手机未能读取本次 Linux 诊断记录。");
        if (run.taskStatus === "succeeded") {
          const save = targetWrites.then(async () => {
            const previous = readLinuxTargets(await options.storage.getItem(linuxTargetsKey));
            await options.storage.setItem(linuxTargetsKey, JSON.stringify([target, ...previous.filter(item => item.deviceId !== target.deviceId)]));
          });
          targetWrites = save.catch(() => undefined);
          await save;
        }
        return run;
      } finally {
        activeLinux.delete(controller);
        input.signal?.removeEventListener("abort", cancel);
      }
    },

    async listLinuxSshRuns(): Promise<readonly PhoneLinuxSshRun[]> {
      await recovery;
      return listRecentRuns(journal, ownerId, task => readLinuxSshRun(journal, task));
    },

    async listLinuxSshTargets(): Promise<readonly LinuxSshTarget[]> {
      await targetWrites;
      return readLinuxTargets(await options.storage.getItem(linuxTargetsKey));
    },
  };
}

export type StandaloneDeviceRuntime = Awaited<ReturnType<typeof createStandaloneDeviceRuntime>>;

async function listRecentRuns<Run>(
  journal: MobileDeviceJournal, ownerId: string, read: (task: DeviceTaskV1) => Promise<Run | undefined>,
): Promise<readonly Run[]> {
  const tasks = (await journal.listTasks()).filter(task => task.ownerKind === "mobile" && task.ownerId === ownerId);
  const recent = [...tasks].reverse().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const runs: Run[] = [];
  for (const task of recent) {
    const run = await read(task);
    if (run) runs.push(run);
    if (runs.length >= recentRunLimit) break;
  }
  return runs;
}

function readLinuxTargets(json: string | null): readonly LinuxSshTarget[] {
  const value: unknown = json === null ? [] : JSON.parse(json);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is LinuxSshTarget => item && typeof item.deviceId === "string"
    && typeof item.host === "string" && Number.isInteger(item.port) && typeof item.username === "string"
    && typeof item.fingerprint === "string" && (item.dnsProbeHostname === undefined || typeof item.dnsProbeHostname === "string"));
}

async function readLinuxSshRun(journal: MobileDeviceJournal, task: DeviceTaskV1): Promise<PhoneLinuxSshRun | undefined> {
  const result = readLinuxSshAttempt({ attempts: await journal.listAttempts(task.id), observations: await journal.listObservations(task.id) });
  if (!result) return undefined;
  const { record, facts } = result;
  return {
    taskId: task.id, updatedAt: task.updatedAt, taskStatus: task.status, deviceId: record.request.targetDeviceId, facts,
    errorCode: record.attempt.receipt?.errorCode,
  };
}

function readLinuxSshAttempt({ attempts, observations }: Pick<MobileTaskEvidence, "attempts" | "observations">) {
  const record = attempts.find(item => item.request.actionId.startsWith(linuxSshPlaybookId + ":"));
  if (!record) return undefined;
  const deviceId = record.request.targetDeviceId;
  const receipt = record.attempt.receipt;
  const observation = receipt && observations.find(item => item.redactionClass === "public"
    && receipt.observationIds.includes(item.id) && item.subjectId === deviceId && item.source === "linux.wifi" && item.provenance.includes(deviceId));
  const value = observation?.value;
  let facts: LinuxNetworkFacts | undefined;
  if (value !== null && typeof value === "object" && "connected" in value && typeof value.connected === "boolean") {
    const linkError = "linkError" in value ? value.linkError : undefined;
    facts = {
      connected: value.connected,
      ...("routeAvailable" in value && typeof value.routeAvailable === "boolean" ? { routeAvailable: value.routeAvailable } : {}),
      ...("dnsNameResolved" in value && typeof value.dnsNameResolved === "boolean" ? { dnsNameResolved: value.dnsNameResolved } : {}),
      ...("wifiAssociated" in value && typeof value.wifiAssociated === "boolean" ? { wifiAssociated: value.wifiAssociated } : {}),
      ...(linkError === "wireless_tools_unavailable" || linkError === "wireless_interface_not_found" || linkError === "wifi_observation_failed"
        ? { linkError } : {}),
    };
  }
  return { record, facts };
}

function readHomeAssistantAttempt(evidence: MobileTaskEvidence) {
  const record = evidence.attempts.find(item =>
    item.request.actionId.startsWith(`${homeAssistantPlaybookId}:`) || item.request.actionId.startsWith(`${homeAssistantRecoveryPlaybookId}:`));
  const entityId = record && entityIdFromRequest(record.request);
  if (!record || !entityId) return undefined;
  const recovery = record.request.actionId.startsWith(`${homeAssistantRecoveryPlaybookId}:`);
  const targetId = record.request.targetDeviceId;
  const reconciliation = record.reconciliations?.find(item => item.reconciliationId === evidence.task?.lastVerificationId);
  const observationIds = (recovery ? reconciliation?.verification ?? record.attempt.verification : record.attempt.receipt)?.observationIds;
  const observation = evidence.observations.find(item => observationIds?.includes(item.id)
    && (item.subjectId === targetId || (!recovery && item.subjectId === entityId))
    && item.provenance.includes(targetId) && item.provenance.includes(entityId));
  return {
    record, entityId, observation, state: observation && homeAssistantEntityState(observation),
    operation: recovery ? "enable_automation" as const : "diagnosis" as const,
  };
}

function projectHomeAssistantRun(evidence: MobileTaskEvidence): PhoneHomeAssistantRun | undefined {
  const { task } = evidence;
  const result = readHomeAssistantAttempt(evidence);
  if (!task || !result) return undefined;
  const { record, entityId, operation, state } = result;
  const deviceId = record.request.targetDeviceId;
  if (!task.targetDeviceIds.includes(deviceId)) return undefined;
  return {
    taskId: task.id, deviceId, updatedAt: task.updatedAt, taskStatus: task.status, entityId, operation,
    availability: state?.availability,
    automationEnabled: state?.automationEnabled,
    canEnableAutomation: task.status === "succeeded" && operation === "diagnosis"
      && state?.automationEnabled === false && !!state.automationIdentity,
    errorCode: task.status === "succeeded" ? undefined : record.attempt.receipt?.errorCode,
  };
}

function projectPhoneTask(evidence: MobileTaskEvidence, ownerId: string): RemotePhoneTaskProjectionV1 | undefined {
  const { task } = evidence;
  if (!task || task.ownerKind !== "mobile" || task.ownerId !== ownerId || task.targetDeviceIds.length !== 1) return undefined;
  const [targetDeviceId] = task.targetDeviceIds;
  const linux = readLinuxSshAttempt(evidence);
  const home = readHomeAssistantAttempt(evidence);
  const record = linux?.record ?? home?.record;
  if (!record) return undefined;
  const { request, attempt } = record;
  if (!attempt.connectionRevision || attempt.ownerKind !== "mobile" || attempt.ownerId !== ownerId
    || attempt.taskId !== task.id || request.taskId !== task.id || attempt.actionId !== request.actionId
    || attempt.targetDeviceId !== targetDeviceId || request.targetDeviceId !== targetDeviceId) return undefined;
  const trace = projectMobileDeviceTaskTrace(evidence, ownerId);
  const readbackId = task.lastVerificationId ?? `${attempt.actionId}:verification`;
  const readback = trace?.spans.find(span =>
    span.kind === "verification" && span.sourceId === readbackId && span.lineage?.attemptId === attempt.attemptId);
  const verification: RemotePhoneTaskProjectionV1["attempt"]["verification"] = readback?.lineage?.connectionRevision ? {
    evidenceId: readbackId, connectionRevision: readback.lineage.connectionRevision,
    status: readback.status === "ok" ? "verified" : readback.status === "failed" ? "failed" : "not_evaluable",
  } : undefined;
  const homeState = home?.observation?.redactionClass === "public" ? home.state : undefined;
  const facts: RemotePhoneTaskProjectionV1["facts"] = linux?.facts ? { kind: "linux_network", network: linux.facts }
    : homeState ? { kind: "home_assistant", availability: homeState.availability,
      ...(homeState.automationEnabled === undefined ? {} : { automationEnabled: homeState.automationEnabled }) } : undefined;
  return {
    taskId: task.id, ownerId, targetDeviceId, status: task.status, updatedAt: task.updatedAt,
    attempt: {
      attemptId: attempt.attemptId, capabilityId: request.capabilityId,
      connectionRevision: attempt.connectionRevision, status: attempt.status,
      ...(verification ? { verification } : {}),
    },
    ...(facts ? { facts } : {}),
  };
}
