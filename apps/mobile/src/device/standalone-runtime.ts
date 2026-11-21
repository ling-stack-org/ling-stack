import type { DeviceErrorCodeV1, DeviceTaskV1 } from "@ling-stack/contracts";

import { MobileDeviceExecution, type MobileDeviceJournal } from "./execution.ts";
import { entityIdFromRequest, homeAssistantAvailability, prepareHomeAssistantDiagnosis, type HomeAssistantAvailability, type HomeAssistantFetch } from "./home-assistant.ts";
import { createAsyncStorageMobileDeviceJournal, type MobileStorageLike } from "./journal.ts";
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

export async function createStandaloneDeviceRuntime(options: {
  readonly storage: MobileStorageLike;
  readonly randomId: (prefix: string) => string | Promise<string>;
  readonly fetch: HomeAssistantFetch;
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

  return {
    setForeground(active: boolean): Promise<void> {
      if (active === foreground) return recovery;
      foreground = active;
      execution.setForeground(active);
      if (active) recovery = recovery.catch(() => undefined).then(async () => { await execution.recoverAfterResume(); });
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
      const tasks = (await journal.listTasks()).filter(task => task.ownerKind === "mobile" && task.ownerId === ownerId);
      const recent = [...tasks].reverse().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const runs: PhoneHomeAssistantRun[] = [];
      for (const task of recent) {
        const run = await readHomeAssistantRun(journal, task);
        if (run) runs.push(run);
        if (runs.length >= recentRunLimit) break;
      }
      return runs;
    },
  };
}

export type StandaloneDeviceRuntime = Awaited<ReturnType<typeof createStandaloneDeviceRuntime>>;

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
