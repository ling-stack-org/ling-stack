import { randomUUID } from "node:crypto";

import {
  buildOwnedDevicePlanningInput,
  createPcSoftwareDiagnosisPlaybook,
  DEFAULT_WORKSPACE_ID,
  DeviceCapabilityBroker,
  DeviceRunnerPlanningBridge,
  DeviceDeveloperSessionCoordinator,
  HardwareProtocolWorkbench,
  modbusRtuRegisterCodec,
  runDeviceReadOnlyPlaybook,
  SqliteDeviceDeveloperStore,
  SqliteDeviceFabricStore,
  SqliteDeviceProtocolStore,
  SqliteDeviceSupportStore,
  type DevicePlaybookRunResultV1,
} from "@ling-stack/core";
import { createRemoteDeviceFacade, type RemoteDeviceFacade } from "../remote-access/device-facade.js";
import { LocalPcTargetExecutor } from "./adapters/local-pc-executor.js";
import { PcAdapter } from "./adapters/pc.js";

export interface DeviceSupportRuntime {
  readonly store: SqliteDeviceSupportStore;
  readonly fabricStore: SqliteDeviceFabricStore;
  readonly developerStore: SqliteDeviceDeveloperStore;
  readonly protocolStore: SqliteDeviceProtocolStore;
  readonly protocolWorkbench: HardwareProtocolWorkbench;
  readonly developerSessions: DeviceDeveloperSessionCoordinator;
  readonly broker: DeviceCapabilityBroker;
  readonly remoteFacade: RemoteDeviceFacade;
  diagnoseLocalPc(): Promise<DevicePlaybookRunResultV1>;
  close(): void;
}

export function createDeviceSupportRuntime(options: { readonly databasePath: string; readonly now?: () => string }): DeviceSupportRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new SqliteDeviceSupportStore({ databasePath: options.databasePath });
  try {
    store.recoverAfterRestart(now());
  } catch (error) {
    store.close();
    throw error;
  }
  const fabricStore = new SqliteDeviceFabricStore({ databasePath: options.databasePath });
  const developerStore = new SqliteDeviceDeveloperStore({ databasePath: options.databasePath });
  const protocolStore = new SqliteDeviceProtocolStore({ databasePath: options.databasePath });
  const protocolWorkbench = new HardwareProtocolWorkbench();
  try {
    protocolStore.registerCodec(modbusRtuRegisterCodec.manifest);
    protocolWorkbench.registerCodec(modbusRtuRegisterCodec);
  } catch (error) {
    protocolStore.close();
    developerStore.close();
    fabricStore.close();
    store.close();
    throw error;
  }
  const broker = new DeviceCapabilityBroker({ store, now });
  const adapter = new PcAdapter({ executor: new LocalPcTargetExecutor(), now });
  broker.registerAdapter(adapter);
  const remoteFacade = createRemoteDeviceFacade({ store, broker, now });
  const planner = new DeviceRunnerPlanningBridge();
  const developerSessions = new DeviceDeveloperSessionCoordinator({ store: developerStore });
  let localDiagnosis: Promise<DevicePlaybookRunResultV1> | undefined;
  const diagnose = async (): Promise<DevicePlaybookRunResultV1> => {
    const registered = store.listDevices().find(profile => profile.device.ownerScope === DEFAULT_WORKSPACE_ID
      && profile.adapterId === adapter.manifest.adapterId && profile.transports.includes("local_process"));
    const target = registered
      ?? await broker.discover(adapter.manifest.adapterId, { ownerId: DEFAULT_WORKSPACE_ID, connectionRef: "local_process" });
    const current = store.getCurrentCapabilitySnapshot(target.device.id);
    const snapshot = current && Date.parse(current.freshnessUntil) > Date.parse(now()) ? current
      : await broker.refreshCapabilities(target.device.id, target.device.profileRevision);
    const timestamp = now();
    const task = broker.createTask({
      id: `device_task_${randomUUID()}`,
      ownerKind: "daemon",
      ownerId: target.device.id,
      targetDeviceIds: [target.device.id],
      status: "planning",
      capabilitySnapshotIds: [snapshot.snapshotId],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const playbook = createPcSoftwareDiagnosisPlaybook();
    const planningInput = buildOwnedDevicePlanningInput({
      store, taskId: task.id, ownerId: task.ownerId, workspaceId: DEFAULT_WORKSPACE_ID,
      contextId: `device_context_${randomUUID()}`, maxBytes: 32 * 1024, now: timestamp,
    });
    const plan = await planner.plan({
      ...planningInput,
      localPlaybook: {
        playbook, targetDeviceId: target.device.id, ownerKind: task.ownerKind, ownerId: task.ownerId,
        capabilitySnapshotId: snapshot.snapshotId,
      },
      now: timestamp,
    });
    store.recordPlanningAcceptance(plan.acceptance, plan.source);
    return await runDeviceReadOnlyPlaybook({
      broker, task, targetDeviceId: target.device.id, capabilitySnapshotId: snapshot.snapshotId,
      playbook,
    });
  };
  return {
    store,
    fabricStore,
    developerStore,
    protocolStore,
    protocolWorkbench,
    developerSessions,
    broker,
    remoteFacade,
    diagnoseLocalPc: () => {
      localDiagnosis ??= diagnose().finally(() => { localDiagnosis = undefined; });
      return localDiagnosis;
    },
    close: () => {
      fabricStore.close();
      developerStore.close();
      protocolStore.close();
      store.close();
    },
  };
}
