import type { DeviceErrorCodeV1, DeviceTaskV1, LinuxNetworkFacts } from "@ling-stack/contracts";

import { MobileDeviceExecution, type MobileDeviceJournal } from "./execution.ts";
import { entityIdFromRequest, homeAssistantAvailability, prepareHomeAssistantDiagnosis, type HomeAssistantAvailability, type HomeAssistantFetch } from "./home-assistant.ts";
import { createAsyncStorageMobileDeviceJournal, type MobileStorageLike } from "./journal.ts";
import {
  linuxSshPlaybookId, prepareLinuxSshDiagnosis,
  type LinuxSshTarget, type LinuxSshTargetInput, type OpenLinuxSshConnection,
} from "./linux-ssh.ts";
import { runMobileReadOnlyPlaybook } from "./playbook.ts";

const ownerKey = "ling:standalone-device-owner:v1";
const homeAssistantPlaybookId = "home-assistant-offline-diagnosis@1.0.0";
const recentRunLimit = 8;

export interface PhoneHomeAssistantRun {
  readonly taskId: string;
  readonly updatedAt: string;
  readonly taskStatus: DeviceTaskV1["status"];
  readonly entityId: string;
  readonly availability?: HomeAssistantAvailability;
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
  readonly now?: () => string;
}) {
  const persistedOwner = await options.storage.getItem(ownerKey);
  const ownerId = persistedOwner ?? await options.randomId("phone_owner");
  if (!/^phone_owner_[A-Za-z0-9_-]{16,64}$/u.test(ownerId)) throw new Error("Invalid phone device task owner");
  if (persistedOwner === null) await options.storage.setItem(ownerKey, ownerId);
  const journal = createAsyncStorageMobileDeviceJournal(options.storage, ownerId);
  const now = options.now ?? (() => new Date().toISOString());
  const execution = new MobileDeviceExecution({ ownerId, journal, now });
  execution.setForeground(false);
  let foreground = false;
  let recovery = Promise.resolve();
  let targetWrites = Promise.resolve();
  const linuxTargetsKey = "ling:standalone-linux-targets:v1:" + ownerId;
  const activeLinux = new Set<AbortController>();

  return {
    linuxSshAvailable: options.openLinuxSsh !== undefined,
    setForeground(active: boolean): Promise<void> {
      if (active === foreground) return recovery;
      foreground = active;
      execution.setForeground(active);
      if (active) recovery = recovery.catch(() => undefined).then(async () => { await execution.recoverAfterResume(); });
      else for (const operation of activeLinux) operation.abort();
      return recovery;
    },

    async diagnoseHomeAssistant(input: {
      readonly origin: string;
      readonly token: string;
      readonly entityId: string;
      readonly signal?: AbortSignal;
    }): Promise<PhoneHomeAssistantRun> {
      const expectedRecovery = recovery;
      await expectedRecovery;
      const taskId = await options.randomId("device_task");
      const connectionRevision = await options.randomId("ha_connection");
      if (!foreground || expectedRecovery !== recovery || input.signal?.aborted) throw new Error("请在手机界面保持打开时运行诊断。");
      const { profile, snapshot, transport, step } = prepareHomeAssistantDiagnosis({
        ...input, ownerId, connectionRevision, now, fetch: options.fetch,
      });
      const task: DeviceTaskV1 = {
        id: taskId, ownerKind: "mobile", ownerId, targetDeviceIds: [profile.device.id], status: "planning",
        capabilitySnapshotIds: [snapshot.snapshotId], createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt,
      };
      await runMobileReadOnlyPlaybook({
        playbookId: homeAssistantPlaybookId, steps: [step], task, profile, snapshot, transport, execution, signal: input.signal,
      });
      const recorded = await journal.getTask(task.id);
      const run = recorded && await readHomeAssistantRun(journal, recorded);
      if (!run) throw new Error("手机未能读取本次诊断记录。");
      return run;
    },

    async listHomeAssistantRuns(): Promise<readonly PhoneHomeAssistantRun[]> {
      await recovery;
      return listRecentRuns(journal, ownerId, readHomeAssistantRun);
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
      return listRecentRuns(journal, ownerId, readLinuxSshRun);
    },

    async listLinuxSshTargets(): Promise<readonly LinuxSshTarget[]> {
      await targetWrites;
      return readLinuxTargets(await options.storage.getItem(linuxTargetsKey));
    },
  };
}

export type StandaloneDeviceRuntime = Awaited<ReturnType<typeof createStandaloneDeviceRuntime>>;

async function listRecentRuns<Run>(
  journal: MobileDeviceJournal, ownerId: string, read: (journal: MobileDeviceJournal, task: DeviceTaskV1) => Promise<Run | undefined>,
): Promise<readonly Run[]> {
  const tasks = (await journal.listTasks()).filter(task => task.ownerKind === "mobile" && task.ownerId === ownerId);
  const recent = [...tasks].reverse().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const runs: Run[] = [];
  for (const task of recent) {
    const run = await read(journal, task);
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
  const record = (await journal.listAttempts(task.id)).find(item => item.request.actionId.startsWith(linuxSshPlaybookId + ":"));
  if (!record) return undefined;
  const deviceId = record.request.targetDeviceId;
  const receipt = record.attempt.receipt;
  const observation = receipt && (await journal.listObservations(task.id)).find(item =>
    receipt.observationIds.includes(item.id) && item.subjectId === deviceId && item.source === "linux.wifi" && item.provenance.includes(deviceId));
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
  return { taskId: task.id, updatedAt: task.updatedAt, taskStatus: task.status, deviceId, facts, errorCode: receipt?.errorCode };
}

async function readHomeAssistantRun(journal: MobileDeviceJournal, task: DeviceTaskV1): Promise<PhoneHomeAssistantRun | undefined> {
  const record = (await journal.listAttempts(task.id)).find(item =>
    item.request.actionId.startsWith(`${homeAssistantPlaybookId}:`));
  const entityId = record && entityIdFromRequest(record.request);
  if (!record || !entityId) return undefined;
  const receipt = record.attempt.receipt;
  const observation = receipt && (await journal.listObservations(task.id)).find(item =>
    receipt.observationIds.includes(item.id) && item.subjectId === entityId && item.provenance.includes(record.request.targetDeviceId));
  return {
    taskId: task.id, updatedAt: task.updatedAt, taskStatus: task.status, entityId,
    availability: observation && homeAssistantAvailability(observation),
    errorCode: receipt?.errorCode,
  };
}
