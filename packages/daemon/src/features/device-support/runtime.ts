import { randomUUID } from "node:crypto";

import type {
  DeviceCapabilitySnapshotV1, DeviceFleetHealthProjectionV1, DeviceLifecycleStatusV1, DevicePlannerProviderHandoffV1,
  DeviceProfileV1, JsonValue,
} from "@ling-stack/contracts";
import {
  type DevicePlaybookV1,
  buildOwnedDevicePlanningInput,
  createHomeAssistantOfflinePlaybook,
  createLinuxWifiDiagnosisPlaybook,
  createPcSoftwareDiagnosisPlaybook,
  DEFAULT_WORKSPACE_ID,
  DeviceBrokerError,
  devicePlaybookNodeId,
  DeviceAccessManager,
  DeviceCapabilityBroker,
  DeviceRunnerPlanningBridge,
  DeviceDeveloperSessionCoordinator,
  DeviceCollaborationCoordinator,
  DeviceFleetProjection,
  EdgeRuntimeJournal,
  EdgeRuntimeRegistry,
  HardwareProtocolWorkbench,
  HardwareProtocolTransportRegistry,
  type HardwareProtocolLiveTransport,
  HardwareProtocolProfileRegistry,
  modbusRtuRegisterCodec,
  runDeviceReadOnlyPlaybook,
  SqliteDeviceDeveloperStore,
  SqliteDeviceFabricStore,
  SqliteDeviceProtocolStore,
  SqliteDeviceSupportStore,
  type DevicePlaybookRunResultV1,
} from "@ling-stack/core";
import { createRemoteDeviceFacade, type RemoteDeviceFacade } from "../remote-access/device-facade.js";
import type { ExternalDeviceAdapter } from "./adapters/external-process.js";
import { HomeAssistantAdapter, homeAssistantAdapterManifest, type HomeAssistantAdapterOptions } from "./adapters/home-assistant.js";
import { assertHomeAssistantCatalogQuery, homeAssistantCatalogCapabilities, type HomeAssistantCatalogQuery } from "./adapters/home-assistant-catalog.js";
import { LinuxSshAdapter, linuxSshDeviceId } from "./adapters/linux-ssh.js";
import { LocalPcTargetExecutor, type LocalProcessRunner } from "./adapters/local-pc-executor.js";
import { PcAdapter } from "./adapters/pc.js";
import { bindLinuxSshTargets, type BoundLinuxSshTarget, type ConfiguredLinuxSshTarget } from "./linux-ssh-targets.js";
import { DEVICE_DIAGNOSIS_MODEL_TIMEOUT_MS, type DeviceDiagnosisPlanner, type DeviceDiagnosisRequest } from "./diagnosis-planner.js";
import type { DeviceResourceTrustPolicy } from "./resource-trust.js";

interface LinuxSshTargetSummary {
  readonly connectionId: string;
  readonly deviceId: string;
  readonly status: "candidate" | DeviceLifecycleStatusV1;
  readonly displayName?: string;
}

export interface DeviceSupportRuntime {
  readonly store: SqliteDeviceSupportStore;
  readonly fabricStore: SqliteDeviceFabricStore;
  readonly developerStore: SqliteDeviceDeveloperStore;
  readonly protocolStore: SqliteDeviceProtocolStore;
  readonly protocolWorkbench: HardwareProtocolWorkbench;
  readonly protocolTransports: HardwareProtocolTransportRegistry;
  readonly protocolProfiles: HardwareProtocolProfileRegistry;
  readonly developerSessions: DeviceDeveloperSessionCoordinator;
  readonly collaboration: DeviceCollaborationCoordinator;
  readonly edgeRuntimes: EdgeRuntimeRegistry;
  readonly edgeJournal: EdgeRuntimeJournal;
  readonly access: DeviceAccessManager;
  readonly resourceTrustConfigured: boolean;
  readonly broker: DeviceCapabilityBroker;
  readonly remoteFacade: RemoteDeviceFacade;
  diagnoseLocalPc(request?: DeviceDiagnosisRequest): Promise<DevicePlaybookRunResultV1>;
  diagnoseHomeAssistant(entityId: string, request?: DeviceDiagnosisRequest): Promise<DevicePlaybookRunResultV1>;
  readHomeAssistantCatalog(query: HomeAssistantCatalogQuery): Promise<{ readonly taskId: string; readonly deviceId: string; readonly catalog: JsonValue }>;
  listLinuxSshTargets(): readonly LinuxSshTargetSummary[];
  enrollLinuxSshTarget(connectionId: string): Promise<DeviceProfileV1>;
  diagnoseLinuxSshTarget(deviceId: string, request?: DeviceDiagnosisRequest): Promise<DevicePlaybookRunResultV1>;
  fleetHealth(workspaceId?: string): DeviceFleetHealthProjectionV1;
  close(): void;
}

export function createDeviceSupportRuntime(options: {
  readonly databasePath: string;
  readonly now?: () => string;
  readonly resourceTrust?: DeviceResourceTrustPolicy;
  readonly linuxSshTargets?: readonly ConfiguredLinuxSshTarget[];
  readonly linuxSshRunner?: LocalProcessRunner;
  readonly homeAssistant?: HomeAssistantAdapterOptions;
  readonly protocolTransports?: readonly HardwareProtocolLiveTransport[];
  readonly createDiagnosisPlanner?: DeviceDiagnosisPlanner;
  readonly externalAdapters?: readonly ExternalDeviceAdapter[];
}): DeviceSupportRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new SqliteDeviceSupportStore({ databasePath: options.databasePath });
  try {
    store.recoverAfterRestart(now());
  } catch (error) {
    store.close();
    throw error;
  }
  const fabricStore = new SqliteDeviceFabricStore({
    databasePath: options.databasePath,
    verifyResourceSignature: options.resourceTrust?.verifyManifest,
    allowedResourceLicenses: options.resourceTrust?.allowedLicenses,
  });
  const developerStore = new SqliteDeviceDeveloperStore({ databasePath: options.databasePath });
  const protocolStore = new SqliteDeviceProtocolStore({ databasePath: options.databasePath });
  const protocolWorkbench = new HardwareProtocolWorkbench();
  const protocolTransports = new HardwareProtocolTransportRegistry(protocolWorkbench);
  const protocolProfiles = new HardwareProtocolProfileRegistry(protocolWorkbench);
  const access = new DeviceAccessManager(fabricStore);
  const broker = new DeviceCapabilityBroker({ store, now, accessManager: access });
  const adapter = new PcAdapter({ executor: new LocalPcTargetExecutor(), now });
  let ssh: ReturnType<typeof bindLinuxSshTargets> | undefined;
  let linuxAdapter: LinuxSshAdapter;
  let homeAssistant: HomeAssistantAdapter | undefined;
  const linuxTargets = new Map<string, BoundLinuxSshTarget>();
  try {
    protocolStore.registerCodec(modbusRtuRegisterCodec.manifest);
    protocolWorkbench.registerCodec(modbusRtuRegisterCodec);
    const modbusProfile = protocolProfiles.register({
      profileId: "modbus-rtu-registers",
      version: "1.0.0",
      codecId: modbusRtuRegisterCodec.manifest.codecId,
      transport: modbusRtuRegisterCodec.manifest.transport,
      supportedDeviceKinds: ["hardware", "vehicle", "head_unit"],
      capabilityIds: ["protocol.read_registers"],
      license: modbusRtuRegisterCodec.manifest.license,
    });
    protocolStore.registerProfile(modbusProfile);
    for (const transport of options.protocolTransports ?? []) protocolTransports.register(transport);
    broker.registerAdapter(adapter);
    ssh = bindLinuxSshTargets(options.linuxSshTargets ?? [], options.linuxSshRunner);
    linuxAdapter = new LinuxSshAdapter({ now, connections: ssh.targets });
    broker.registerAdapter(linuxAdapter);
    if (options.homeAssistant) {
      homeAssistant = new HomeAssistantAdapter({ ...options.homeAssistant, now });
      broker.registerAdapter(homeAssistant);
    }
    for (const externalAdapter of options.externalAdapters ?? []) {
      if (broker.adapters.get(externalAdapter.manifest.adapterId)) {
        throw new DeviceBrokerError("invalid_request", "external adapter ID is already in use");
      }
      broker.registerAdapter(externalAdapter);
    }
    for (const target of ssh.targets) linuxTargets.set(linuxSshDeviceId(DEFAULT_WORKSPACE_ID, target.hostKeyFingerprint), target);
    store.withWriteTransaction(() => {
      for (const profile of store.listDevices()) {
        if (profile.device.ownerScope !== DEFAULT_WORKSPACE_ID) continue;
        if (profile.adapterId === adapter.manifest.adapterId && profile.transports.includes("local_process")
          && profile.adapterVersion !== adapter.manifest.adapterVersion
          && profile.device.lifecycleStatus !== "revoked" && profile.device.lifecycleStatus !== "retired") {
          broker.registerDevice(adapter.manifest.adapterId, { ...profile, adapterVersion: adapter.manifest.adapterVersion });
        }
        if ((profile.adapterId === linuxAdapter.manifest.adapterId && !hasCurrentLinuxConnection(profile))
          || (profile.adapterId === homeAssistantAdapterManifest().adapterId && profile.device.id !== homeAssistant?.deviceId)) {
          store.markDeviceOffline(profile.device.id, now());
        }
      }
    });
  } catch (error) {
    for (const externalAdapter of options.externalAdapters ?? []) externalAdapter.close();
    void protocolTransports.close().catch(() => undefined);
    ssh?.close();
    protocolStore.close();
    developerStore.close();
    fabricStore.close();
    store.close();
    throw error;
  }
  const remoteFacade = createRemoteDeviceFacade({ store, broker, now });
  const planner = new DeviceRunnerPlanningBridge();
  const developerSessions = new DeviceDeveloperSessionCoordinator({ store: developerStore });
  const collaboration = new DeviceCollaborationCoordinator({ store: developerStore });
  const edgeRuntimes = new EdgeRuntimeRegistry({ persistence: fabricStore });
  const edgeJournal = new EdgeRuntimeJournal({ persistence: fabricStore });
  const fleetProjection = new DeviceFleetProjection();
  let localDiagnosis: { readonly key: string; readonly pending: Promise<DevicePlaybookRunResultV1> } | undefined;
  const activeTargets = new Set<string>();

  async function diagnosePc(request: DeviceDiagnosisRequest): Promise<DevicePlaybookRunResultV1> {
    const registered = store.listDevices().find(profile => profile.device.ownerScope === DEFAULT_WORKSPACE_ID
      && profile.adapterId === adapter.manifest.adapterId && profile.transports.includes("local_process"));
    const target = registered
      ?? await broker.discover(adapter.manifest.adapterId, { ownerId: DEFAULT_WORKSPACE_ID, connectionRef: "local_process" });
    return runDiagnosis(target, target.device.id, createPcSoftwareDiagnosisPlaybook(), request);
  }

  async function runDiagnosis(
    target: DeviceProfileV1, ownerId: string, playbook: DevicePlaybookV1, request: DeviceDiagnosisRequest,
  ): Promise<DevicePlaybookRunResultV1> {
    const { providerPresetId, fallbackProviderPresetId, symptom } = request;
    if (fallbackProviderPresetId && (!providerPresetId || fallbackProviderPresetId === providerPresetId)) {
      throw new DeviceBrokerError("invalid_request", "fallback diagnosis requires a different primary provider");
    }
    const runner = providerPresetId
      ? options.createDiagnosisPlanner?.({ providerPresetId, symptom }, playbook)
      : undefined;
    const fallbackRunner = fallbackProviderPresetId
      ? options.createDiagnosisPlanner?.({ providerPresetId: fallbackProviderPresetId, symptom }, playbook)
      : undefined;
    if ((providerPresetId && !runner) || (fallbackProviderPresetId && !fallbackRunner)) {
      throw new DeviceBrokerError("service_unavailable", "device diagnosis planner is unavailable");
    }
    const current = store.getCurrentCapabilitySnapshot(target.device.id);
    const planningWindowMs = runner ? DEVICE_DIAGNOSIS_MODEL_TIMEOUT_MS * (fallbackRunner ? 2 : 1) : 0;
    const snapshot = current && Date.parse(current.freshnessUntil) > Date.parse(now()) + planningWindowMs ? current
      : await broker.refreshCapabilities(target.device.id, target.device.profileRevision);
    const timestamp = now();
    const task = broker.createTask({
      id: `device_task_${randomUUID()}`,
      ownerKind: "daemon",
      ownerId,
      targetDeviceIds: [target.device.id],
      status: "planning",
      capabilitySnapshotIds: [snapshot.snapshotId],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    let proposalId: string;
    let selectedPlaybook = playbook;
    try {
      const planningInput = (at: string) => {
        if (store.getTask(task.id)?.status !== "planning") {
          throw new DeviceBrokerError("target_changed", "device diagnosis task stopped during planning");
        }
        return {
          ...buildOwnedDevicePlanningInput({
            store, taskId: task.id, ownerId: task.ownerId, workspaceId: DEFAULT_WORKSPACE_ID,
            contextId: `device_context_${randomUUID()}`, maxBytes: 32 * 1024, now: at,
          }),
          localPlaybook: {
            playbook, targetDeviceId: target.device.id, ownerKind: task.ownerKind, ownerId: task.ownerId,
            capabilitySnapshotId: snapshot.snapshotId,
          },
          nowAtAcceptance: now,
        };
      };
      const initialInput = planningInput(timestamp);
      let plan = await planner.plan(initialInput, runner);
      let providerHandoff: DevicePlannerProviderHandoffV1 | undefined;
      if (plan.fallbackReason === "runner_unavailable" && fallbackRunner && providerPresetId && fallbackProviderPresetId) {
        plan = await planner.plan(planningInput(now()), fallbackRunner);
        providerHandoff = {
          fromProviderPresetId: providerPresetId, toProviderPresetId: fallbackProviderPresetId,
          fromContextId: initialInput.context.contextId, reason: "runner_unavailable",
        };
      }
      if (plan.source === "runner") {
        const stepsByNodeId = new Map(playbook.steps.map(step => [devicePlaybookNodeId(playbook.id, step.id), step]));
        const steps = plan.acceptance.graph.nodes.map(node => {
          const step = stepsByNodeId.get(node.nodeId);
          if (!step || step.capabilityId !== node.capabilityId) throw new DeviceBrokerError("invalid_request", "device plan does not match the diagnosis playbook");
          return step;
        });
        selectedPlaybook = { ...playbook, steps };
      }
      store.recordPlanningAcceptance(plan.acceptance, plan.source, plan.fallbackReason, providerHandoff);
      proposalId = plan.acceptance.proposalId;
    } catch (error) {
      store.withWriteTransaction(() => {
        if (store.getTask(task.id)?.status === "planning") store.transitionTask(task.id, "failed", {}, now());
      });
      throw error;
    }
    return await runDeviceReadOnlyPlaybook({
      broker, task, targetDeviceId: target.device.id, capabilitySnapshotId: snapshot.snapshotId,
      playbook: selectedPlaybook, proposalId,
    });
  }

  function hasCurrentLinuxConnection(profile: DeviceProfileV1): boolean {
    const target = linuxTargets.get(profile.device.id);
    return target !== undefined && profile.adapterVersion === linuxAdapter.manifest.adapterVersion
      && profile.connectionRefs[0] === target.connectionRef;
  }

  async function withDeviceTarget<T>(deviceId: string, run: () => Promise<T>): Promise<T> {
    if (activeTargets.has(deviceId)) throw new DeviceBrokerError("target_busy", "device already has an active operation");
    activeTargets.add(deviceId);
    try {
      return await run();
    } finally {
      activeTargets.delete(deviceId);
    }
  }

  async function withHomeAssistant<T>(run: (profile: DeviceProfileV1) => Promise<T>): Promise<T> {
    const adapter = homeAssistant;
    if (!adapter) throw new DeviceBrokerError("missing_target", "Home Assistant is not configured on this host");
    return withDeviceTarget(adapter.deviceId, async () => {
      const status = store.getDevice(adapter.deviceId)?.device.lifecycleStatus;
      if (status === "revoked" || status === "retired") {
        throw new DeviceBrokerError("permission_denied", "Home Assistant registration is no longer active");
      }
      const target = await broker.discover(adapter.manifest.adapterId, {
        ownerId: DEFAULT_WORKSPACE_ID, connectionRef: adapter.deviceId, signal: AbortSignal.timeout(10_000),
      });
      return run(target);
    });
  }

  async function enrollLinuxTarget(deviceId: string, target: BoundLinuxSshTarget): Promise<DeviceProfileV1> {
    const previous = store.getDevice(deviceId);
    if (previous && (previous.device.lifecycleStatus === "revoked" || previous.device.lifecycleStatus === "retired")) {
      throw new DeviceBrokerError("permission_denied", "Linux device registration was revoked");
    }
    try {
      return await broker.discover(linuxAdapter.manifest.adapterId, {
        ownerId: DEFAULT_WORKSPACE_ID, connectionRef: target.connectionRef, signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (error instanceof DeviceBrokerError && error.code !== "connection_failed") throw error;
      if (previous) store.markDeviceOffline(deviceId, now());
      throw new DeviceBrokerError("connection_failed", "Linux SSH enrollment could not verify the target");
    }
  }

  return {
    store,
    fabricStore,
    developerStore,
    protocolStore,
    protocolWorkbench,
    protocolTransports,
    protocolProfiles,
    developerSessions,
    collaboration,
    edgeRuntimes,
    edgeJournal,
    access,
    resourceTrustConfigured: options.resourceTrust !== undefined,
    broker,
    remoteFacade,
    async diagnoseLocalPc(request = {}) {
      const key = JSON.stringify([request.providerPresetId, request.fallbackProviderPresetId, request.symptom]);
      if (localDiagnosis && localDiagnosis.key !== key) throw new DeviceBrokerError("target_busy", "PC diagnosis is active");
      localDiagnosis ??= { key, pending: diagnosePc(request).finally(() => { localDiagnosis = undefined; }) };
      return await localDiagnosis.pending;
    },
    async diagnoseHomeAssistant(entityId, request = {}) {
      return withHomeAssistant(target => runDiagnosis(target, target.device.id, createHomeAssistantOfflinePlaybook(entityId), request));
    },
    async readHomeAssistantCatalog(query) {
      assertHomeAssistantCatalogQuery(query);
      return withHomeAssistant(async ({ device }) => {
        const deviceId = device.id;
        const snapshot = store.getCurrentCapabilitySnapshot(deviceId);
        if (!snapshot) throw new DeviceBrokerError("stale_snapshot", "Home Assistant capability snapshot is unavailable");
        const taskId = `device_task_${randomUUID()}`;
        const timestamp = now();
        broker.createTask({
          id: taskId, ownerKind: "daemon", ownerId: deviceId, targetDeviceIds: [deviceId], status: "planning",
          capabilitySnapshotIds: [snapshot.snapshotId], createdAt: timestamp, updatedAt: timestamp,
        });
        const { attempt } = await broker.execute({
          taskId, actionId: `${taskId}:catalog`, targetDeviceId: deviceId,
          capabilityId: homeAssistantCatalogCapabilities[query.kind], capabilitySchemaVersion: "1.0",
          capabilitySnapshotId: snapshot.snapshotId, idempotencyKey: taskId,
          normalizedInput: { limit: query.limit, ...(query.after === undefined ? {} : { after: query.after }) },
        }, undefined, { onlyUnattendedReads: true });
        if (attempt.status !== "completed") {
          throw new DeviceBrokerError(attempt.receipt?.errorCode ?? "service_unavailable", "Home Assistant catalog read failed");
        }
        const observationId = attempt.receipt?.observationIds[0];
        const observation = observationId ? store.getObservation(taskId, observationId) : undefined;
        if (!observation || observation.subjectId !== deviceId || observation.redactionClass !== "public") {
          throw new DeviceBrokerError("service_unavailable", "Home Assistant catalog observation is unavailable");
        }
        return { taskId, deviceId, catalog: observation.value };
      });
    },
    listLinuxSshTargets: () => Array.from(linuxTargets, ([deviceId, target]) => {
      const profile = store.getDevice(deviceId);
      return {
        connectionId: target.connectionId, deviceId,
        status: profile?.device.lifecycleStatus ?? "candidate",
        ...(profile ? { displayName: profile.device.displayName } : {}),
      };
    }),
    async enrollLinuxSshTarget(connectionId) {
      for (const [deviceId, target] of linuxTargets) {
        if (target.connectionId === connectionId) return withDeviceTarget(deviceId, () => enrollLinuxTarget(deviceId, target));
      }
      throw new DeviceBrokerError("missing_target", "Linux SSH connection is unavailable");
    },
    async diagnoseLinuxSshTarget(deviceId, request = {}) {
      const sshTarget = linuxTargets.get(deviceId);
      const profile = store.getDevice(deviceId);
      if (!sshTarget || profile?.device.ownerScope !== DEFAULT_WORKSPACE_ID || profile.adapterId !== linuxAdapter.manifest.adapterId) {
        throw new DeviceBrokerError("missing_target", "Linux SSH target is not enrolled");
      }
      return withDeviceTarget(deviceId, async () => {
        const target = hasCurrentLinuxConnection(profile) && profile.device.lifecycleStatus === "healthy"
          ? profile : await enrollLinuxTarget(deviceId, sshTarget);
        const result = await runDiagnosis(target, target.device.runtimeOwnerId!, createLinuxWifiDiagnosisPlaybook(), request);
        if (result.attempts.some(record => record.attempt.receipt?.errorCode === "connection_failed")) {
          store.markDeviceOffline(deviceId, now());
        }
        return result;
      });
    },
    fleetHealth(workspaceId = DEFAULT_WORKSPACE_ID) {
      const profiles = store.listDevices().filter(profile => profile.device.ownerScope === workspaceId);
      const snapshots = new Map<string, DeviceCapabilitySnapshotV1>();
      for (const profile of profiles) {
        const snapshot = store.getCurrentCapabilitySnapshot(profile.device.id);
        if (snapshot) snapshots.set(profile.device.id, snapshot);
      }
      return fleetProjection.build({
        projectionId: `fleet:${workspaceId}`,
        ownerScope: workspaceId,
        generatedAt: now(),
        profiles, snapshots,
        runtimes: edgeRuntimes.list(),
      });
    },
    close: () => {
      for (const externalAdapter of options.externalAdapters ?? []) externalAdapter.close();
      ssh?.close();
      void protocolTransports.close().catch(() => undefined);
      fabricStore.close();
      developerStore.close();
      protocolStore.close();
      store.close();
    },
  };
}
