import { randomUUID } from "node:crypto";

import type {
  DeviceAccessGrantV1, DeviceActionApprovalPayload, DeviceCapabilitySnapshotV1, DeviceFleetHealthProjectionV1, DeviceLifecycleStatusV1,
  DevicePlannerProviderHandoffV1, DeviceProfileV1, JsonValue,
} from "@ling-stack/contracts";
import {
  type ApprovalRequest,
  type DevicePlaybookV1,
  buildOwnedDevicePlanningInput,
  createHomeAssistantIntegrationDiagnosisPlaybook,
  createHomeAssistantOfflinePlaybook,
  createLinuxWifiDiagnosisPlaybook,
  createPcSoftwareDiagnosisPlaybook,
  DEFAULT_WORKSPACE_ID,
  DeviceBrokerError,
  DeviceFabricError,
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
import { HOME_ASSISTANT_ENABLE_AUTOMATION, HOME_ASSISTANT_RELOAD_CAPABILITY_ID, HomeAssistantAdapter, homeAssistantAdapterManifest, type HomeAssistantAdapterOptions } from "./adapters/home-assistant.js";
import { AndroidAdbAdapter, type AndroidAdbExecutor } from "./adapters/android-adb.js";
import type { BoundAndroidAdbTarget } from "./android-adb-targets.js";
import { assertHomeAssistantCatalogQuery, homeAssistantCatalogCapabilities, type HomeAssistantCatalogQuery } from "./adapters/home-assistant-catalog.js";
import { LinuxSshAdapter, linuxSshDeviceId } from "./adapters/linux-ssh.js";
import { ModbusSerialAdapter, modbusRegisterDiagnosis } from "./adapters/modbus-serial.js";
import { LocalPcTargetExecutor, type LocalProcessRunner } from "./adapters/local-pc-executor.js";
import { PcAdapter } from "./adapters/pc.js";
import { bindLinuxSshTargets, type BoundLinuxSshTarget, type ConfiguredLinuxSshTarget } from "./linux-ssh-targets.js";
import { bindModbusSerialTarget, modbusSerialAdapterId, type ConfiguredModbusSerialTarget } from "./modbus-serial-targets.js";
import { ObdVehicleAdapter, type ObdExecutor } from "./adapters/obd.js";
import { DEVICE_DIAGNOSIS_MODEL_TIMEOUT_MS, type DeviceDiagnosisPlanner, type DeviceDiagnosisRequest } from "./diagnosis-planner.js";
import type { DeviceResourceTrustPolicy } from "./resource-trust.js";
import { createDeviceApprovalQueue } from "./approval-queue.js";
import { createDeviceDeveloperJobs, retainedAndroidDeployResult, type DeviceDeveloperExecutor } from "./developer-jobs.js";
import type { AndroidApkLibrary } from "./android-apks.js";
import type { AndroidProjectBuilds } from "./android-project-builds.js";
import { diagnosisReportedValues } from "./diagnosis-twin.js";

interface ConfiguredDeviceTargetSummary {
  readonly connectionId: string;
  readonly deviceId: string;
  readonly status: "candidate" | DeviceLifecycleStatusV1;
  readonly displayName?: string;
}

const androidDiagnosis: DevicePlaybookV1 = {
  id: "android-adb-diagnosis", version: "1.0.0", displayName: "Android ADB diagnosis",
  supportedDeviceKinds: ["android", "head_unit"], riskClass: "read_only", localFallback: true,
  steps: [
    { id: "inspect-device", capabilityId: "android.inspect.device", input: {} },
    { id: "inspect-packages", capabilityId: "android.inspect.packages", input: {} },
  ],
};

export interface DeviceSupportRuntime {
  readonly store: SqliteDeviceSupportStore;
  readonly fabricStore: SqliteDeviceFabricStore;
  readonly developerStore: SqliteDeviceDeveloperStore;
  readonly protocolStore: SqliteDeviceProtocolStore;
  readonly protocolWorkbench: HardwareProtocolWorkbench;
  readonly protocolTransports: HardwareProtocolTransportRegistry;
  readonly protocolProfiles: HardwareProtocolProfileRegistry;
  readonly developerSessions: DeviceDeveloperSessionCoordinator;
  readonly developerJobs: ReturnType<typeof createDeviceDeveloperJobs>;
  readonly androidApks?: AndroidApkLibrary;
  readonly androidProjectBuilds?: AndroidProjectBuilds;
  canDeployAndroid(deviceId: string): boolean;
  readonly collaboration: DeviceCollaborationCoordinator;
  readonly edgeRuntimes: EdgeRuntimeRegistry;
  readonly edgeJournal: EdgeRuntimeJournal;
  readonly access: DeviceAccessManager;
  readonly resourceTrustConfigured: boolean;
  readonly broker: DeviceCapabilityBroker;
  readonly remoteFacade: RemoteDeviceFacade;
  readonly approvalQueue: ReturnType<typeof createDeviceApprovalQueue>;
  diagnoseLocalPc(request?: DeviceDiagnosisRequest): Promise<DevicePlaybookRunResultV1>;
  diagnoseHomeAssistant(entityId: string, request?: DeviceDiagnosisRequest & { readonly entryId?: string }): Promise<DevicePlaybookRunResultV1>;
  proposeHomeAssistantReload(target: { readonly entryId: string; readonly entityId: string }): Promise<ApprovalRequest>;
  proposeHomeAssistantAutomationEnable(entityId: string): Promise<ApprovalRequest>;
  readHomeAssistantCatalog(query: HomeAssistantCatalogQuery): Promise<{ readonly taskId: string; readonly deviceId: string; readonly catalog: JsonValue }>;
  listLinuxSshTargets(): readonly ConfiguredDeviceTargetSummary[];
  enrollLinuxSshTarget(connectionId: string): Promise<DeviceProfileV1>;
  diagnoseLinuxSshTarget(deviceId: string, request?: DeviceDiagnosisRequest): Promise<DevicePlaybookRunResultV1>;
  diagnoseModbusTarget(deviceId: string, request?: DeviceDiagnosisRequest): Promise<DevicePlaybookRunResultV1>;
  listAndroidAdbTargets(): readonly (ConfiguredDeviceTargetSummary & { readonly kind: BoundAndroidAdbTarget["kind"] })[];
  enrollAndroidAdbTarget(connectionId: string): Promise<DeviceProfileV1>;
  diagnoseAndroidAdbTarget(deviceId: string, request?: DeviceDiagnosisRequest): Promise<DevicePlaybookRunResultV1>;
  discoverAndroidAdb(connectionRef: string): Promise<DeviceProfileV1>;
  discoverObd(connectionRef: string): Promise<DeviceProfileV1>;
  fleetHealth(workspaceId?: string): DeviceFleetHealthProjectionV1;
  getAccessGrant(deviceId: string, grantId: string): DeviceAccessGrantV1;
  saveAccessGrant(input: {
    readonly deviceId: string;
    readonly grantId: string;
    readonly expectedRevision: number;
    readonly principalId: string;
    readonly scope: "read_only" | "developer";
    readonly capabilityIds: readonly string[];
    readonly expiresAt: string;
  }): DeviceAccessGrantV1;
  revokeAccessGrant(input: { readonly deviceId: string; readonly grantId: string; readonly expectedRevision: number }): DeviceAccessGrantV1;
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
  readonly modbusSerialTargets?: readonly ConfiguredModbusSerialTarget[];
  readonly createDiagnosisPlanner?: DeviceDiagnosisPlanner;
  readonly externalAdapters?: readonly ExternalDeviceAdapter[];
  readonly androidAdbExecutor?: AndroidAdbExecutor;
  readonly androidAdbTargets?: readonly BoundAndroidAdbTarget[];
  readonly androidApks?: AndroidApkLibrary;
  readonly androidProjectBuilds?: AndroidProjectBuilds;
  readonly obdExecutor?: ObdExecutor;
  readonly developerExecutor?: DeviceDeveloperExecutor;
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
  const developerSessions = new DeviceDeveloperSessionCoordinator({ store: developerStore });
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
  let obd: ObdVehicleAdapter | undefined;
  const linuxTargets = new Map<string, BoundLinuxSshTarget>();
  const adbTargets = new Map(options.androidAdbTargets?.map(target => [target.deviceId, target]));
  const canDeployAndroid = (deviceId: string) => Boolean(options.androidApks && adbTargets.get(deviceId)?.executor.installArtifact);
  const androidAdb = options.androidAdbExecutor || adbTargets.size > 0
    ? new AndroidAdbAdapter({ executor: options.androidAdbExecutor, targets: [...adbTargets.values()], now }) : undefined;
  const configuredModbusIds = new Set<string>();
  try {
    developerSessions.recoverInterruptedJobs({ ownerKind: "daemon", ownerId: DEFAULT_WORKSPACE_ID }, now(),
      job => retainedAndroidDeployResult(store, job));
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
    const configuredModbus = (options.modbusSerialTargets ?? []).map(target => bindModbusSerialTarget(target));
    for (const { profile, transport } of configuredModbus) {
      protocolTransports.register(transport);
      configuredModbusIds.add(profile.device.id);
    }
    broker.registerAdapter(adapter);
    if (configuredModbus.length > 0) broker.registerAdapter(new ModbusSerialAdapter({
      targets: configuredModbus, transports: protocolTransports, workbench: protocolWorkbench, protocolStore, now,
    }));
    ssh = bindLinuxSshTargets(options.linuxSshTargets ?? [], options.linuxSshRunner);
    linuxAdapter = new LinuxSshAdapter({ now, connections: ssh.targets });
    broker.registerAdapter(linuxAdapter);
    if (options.homeAssistant) {
      homeAssistant = new HomeAssistantAdapter({ ...options.homeAssistant, now });
      broker.registerAdapter(homeAssistant);
    }
    if (androidAdb) broker.registerAdapter(androidAdb);
    if (options.obdExecutor) {
      obd = new ObdVehicleAdapter({ executor: options.obdExecutor, now });
      broker.registerAdapter(obd);
    }
    for (const externalAdapter of options.externalAdapters ?? []) {
      if (broker.adapters.get(externalAdapter.manifest.adapterId)) {
        throw new DeviceBrokerError("invalid_request", "external adapter ID is already in use");
      }
      broker.registerAdapter(externalAdapter);
    }
    for (const target of ssh.targets) linuxTargets.set(linuxSshDeviceId(DEFAULT_WORKSPACE_ID, target.hostKeyFingerprint), target);
    store.withWriteTransaction(() => {
      for (const { profile } of configuredModbus) store.registerDevice(profile, now());
      for (const profile of store.listDevices()) {
        if (profile.device.ownerScope !== DEFAULT_WORKSPACE_ID) continue;
        if (profile.adapterId === adapter.manifest.adapterId && profile.transports.includes("local_process")
          && profile.adapterVersion !== adapter.manifest.adapterVersion
          && profile.device.lifecycleStatus !== "revoked" && profile.device.lifecycleStatus !== "retired") {
          broker.registerDevice(adapter.manifest.adapterId, { ...profile, adapterVersion: adapter.manifest.adapterVersion });
        }
        if ((profile.adapterId === modbusSerialAdapterId && !configuredModbusIds.has(profile.device.id))
          || (profile.adapterId === linuxAdapter.manifest.adapterId && !hasCurrentLinuxConnection(profile))
          || (profile.adapterId === "android-adb" && profile.connectionRefs[0]?.startsWith("adb-target:"))
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
  const approvalQueue = createDeviceApprovalQueue(store, broker, now);
  const planner = new DeviceRunnerPlanningBridge();
  const developerJobs = createDeviceDeveloperJobs({
    broker, sessions: developerSessions, executor: options.developerExecutor, canDeployAndroid, now,
    androidProjectBuilds: options.androidProjectBuilds,
  });
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
    const result = await runDeviceReadOnlyPlaybook({
      broker, task, targetDeviceId: target.device.id, capabilitySnapshotId: snapshot.snapshotId,
      playbook: selectedPlaybook, proposalId,
    });
    const deviceId = target.device.id;
    const values = diagnosisReportedValues(result, store.getCurrentCapabilitySnapshot(deviceId), store);
    if (values.length) fabricStore.recordReportedTwinValues({ deviceId, values, recordedAt: now() });
    return result;
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

  async function withHomeAssistant<T>(run: (profile: DeviceProfileV1, adapter: HomeAssistantAdapter) => Promise<T>): Promise<T> {
    const adapter = homeAssistant;
    if (!adapter) throw new DeviceBrokerError("missing_target", "Home Assistant is not configured on this host");
    return withDeviceTarget(adapter.deviceId, async () => {
      const current = store.getDevice(adapter.deviceId);
      if (current?.device.lifecycleStatus === "revoked" || current?.device.lifecycleStatus === "retired") {
        throw new DeviceBrokerError("permission_denied", "Home Assistant registration is no longer active");
      }
      const snapshot = store.getCurrentCapabilitySnapshot(adapter.deviceId);
      const target = current?.device.ownerScope === DEFAULT_WORKSPACE_ID && snapshot?.adapterVersion === adapter.manifest.adapterVersion
        && Date.parse(snapshot.freshnessUntil) > Date.parse(now()) ? current : await broker.discover(adapter.manifest.adapterId, {
          ownerId: DEFAULT_WORKSPACE_ID, connectionRef: adapter.deviceId, signal: AbortSignal.timeout(10_000),
        });
      return run(target, adapter);
    });
  }

  function queueHomeAssistantAction(payload: DeviceActionApprovalPayload, normalizedInput: JsonValue,
    expectedVerification: JsonValue): ApprovalRequest {
    const { targetDeviceId, capabilityId } = payload;
    const snapshot = store.getCurrentCapabilitySnapshot(targetDeviceId);
    const capability = snapshot?.capabilities.find(item => item.id === capabilityId);
    if (!snapshot || !capability) throw new DeviceBrokerError("stale_snapshot", "Home Assistant snapshot is unavailable");
    const taskId = `device_task_${randomUUID()}`;
    const approvalId = `device_approval_${randomUUID()}`;
    const timestamp = now();
    broker.createTask({
      id: taskId, ownerKind: "daemon", ownerId: targetDeviceId, targetDeviceIds: [targetDeviceId], status: "planning",
      capabilitySnapshotIds: [snapshot.snapshotId], createdAt: timestamp, updatedAt: timestamp,
    });
    try {
      broker.proposeAction({
        taskId, actionId: `${taskId}:${"entryId" in payload ? "reload" : "enable"}`, targetDeviceId,
        capabilityId: capability.id, capabilitySchemaVersion: capability.schemaVersion,
        capabilitySnapshotId: snapshot.snapshotId, idempotencyKey: taskId,
        normalizedInput, expectedVerification,
      }, { approvalId, payload });
    } catch (error) {
      store.stopDaemonTask(taskId, now());
      throw error;
    }
    const approval = approvalQueue.get(approvalId);
    if (!approval) throw new DeviceBrokerError("missing_target", "the queued device approval is unavailable");
    return approval;
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

  async function enrollAdbTarget(target: BoundAndroidAdbTarget): Promise<DeviceProfileV1> {
    if (!androidAdb) throw new DeviceBrokerError("missing_target", "Android ADB is not configured on this host");
    const previous = store.getDevice(target.deviceId);
    if (previous && (previous.device.ownerScope !== DEFAULT_WORKSPACE_ID
      || previous.device.lifecycleStatus === "revoked" || previous.device.lifecycleStatus === "retired")) {
      throw new DeviceBrokerError("permission_denied", "Android device registration is no longer active");
    }
    try {
      return await broker.discover(androidAdb.manifest.adapterId, {
        ownerId: DEFAULT_WORKSPACE_ID, connectionRef: target.connectionRef, signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (store.getDevice(target.deviceId)?.device.ownerScope === DEFAULT_WORKSPACE_ID) store.markDeviceOffline(target.deviceId, now());
      throw error;
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
    developerJobs,
    androidApks: options.androidApks,
    androidProjectBuilds: options.androidProjectBuilds,
    canDeployAndroid,
    collaboration,
    edgeRuntimes,
    edgeJournal,
    access,
    resourceTrustConfigured: options.resourceTrust !== undefined,
    broker,
    remoteFacade,
    approvalQueue,
    async diagnoseLocalPc(request = {}) {
      const key = JSON.stringify([request.providerPresetId, request.fallbackProviderPresetId, request.symptom]);
      if (localDiagnosis && localDiagnosis.key !== key) throw new DeviceBrokerError("target_busy", "PC diagnosis is active");
      localDiagnosis ??= { key, pending: diagnosePc(request).finally(() => { localDiagnosis = undefined; }) };
      return await localDiagnosis.pending;
    },
    async diagnoseHomeAssistant(entityId, request = {}) {
      const playbook = request.entryId === undefined
        ? createHomeAssistantOfflinePlaybook(entityId, { maxReportAgeMs: request.maxReportAgeMs })
        : createHomeAssistantIntegrationDiagnosisPlaybook(request.entryId, entityId);
      return withHomeAssistant(target => runDiagnosis(target, target.device.id, playbook, request));
    },
    async proposeHomeAssistantReload({ entryId, entityId }) {
      return withHomeAssistant(async (target, adapter) => {
        await adapter.assertReloadTarget(target, { entryId, entityId });
        return queueHomeAssistantAction({
          type: "device_action", targetDeviceId: target.device.id, capabilityId: HOME_ASSISTANT_RELOAD_CAPABILITY_ID,
          entryId, entityId, expectedAvailability: "available",
        }, { entryId, entityId }, { availability: "available" });
      });
    },
    async proposeHomeAssistantAutomationEnable(entityId) {
      return withHomeAssistant(async (target, adapter) => {
        const automationRegistryId = await adapter.readAutomationTarget(target, entityId);
        const state = await adapter.readEntity(entityId);
        if (state.automationEnabled !== false) {
          throw new DeviceBrokerError("target_changed", "the selected automation must be available and disabled");
        }
        return queueHomeAssistantAction({
          type: "device_action", targetDeviceId: target.device.id, capabilityId: HOME_ASSISTANT_ENABLE_AUTOMATION,
          entityId, automationRegistryId, expectedAutomationEnabled: true,
        }, { entityId, automationRegistryId }, { automationEnabled: true });
      });
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
    async diagnoseModbusTarget(deviceId, request = {}) {
      const profile = store.getDevice(deviceId);
      if (!profile || !configuredModbusIds.has(deviceId) || profile.device.ownerScope !== DEFAULT_WORKSPACE_ID
        || profile.adapterId !== modbusSerialAdapterId) {
        throw new DeviceBrokerError("missing_target", "Modbus target is not configured on this host");
      }
      if (profile.device.lifecycleStatus === "revoked" || profile.device.lifecycleStatus === "retired") {
        throw new DeviceBrokerError("permission_denied", "Modbus target registration is no longer active");
      }
      return withDeviceTarget(deviceId, () => runDiagnosis(profile, deviceId, modbusRegisterDiagnosis, request));
    },
    listAndroidAdbTargets: () => [...adbTargets.values()].flatMap(({ deviceId, connectionId, kind }) => {
      const profile = store.getDevice(deviceId);
      if (profile && profile.device.ownerScope !== DEFAULT_WORKSPACE_ID) return [];
      return [{ deviceId, connectionId, kind, status: profile?.device.lifecycleStatus ?? "candidate",
        ...(profile ? { displayName: profile.device.displayName } : {}) }];
    }),
    async enrollAndroidAdbTarget(connectionId) {
      const target = [...adbTargets.values()].find(item => item.connectionId === connectionId);
      if (!target) throw new DeviceBrokerError("missing_target", "Android ADB target is not configured");
      return withDeviceTarget(target.deviceId, () => enrollAdbTarget(target));
    },
    async diagnoseAndroidAdbTarget(deviceId, request = {}) {
      const binding = adbTargets.get(deviceId);
      const profile = store.getDevice(deviceId);
      if (!binding || profile?.device.ownerScope !== DEFAULT_WORKSPACE_ID || profile.adapterId !== "android-adb") {
        throw new DeviceBrokerError("missing_target", "Android ADB target is not enrolled");
      }
      return withDeviceTarget(deviceId, async () => {
        const target = await enrollAdbTarget(binding);
        const result = await runDiagnosis(target, deviceId, androidDiagnosis, request);
        if (result.attempts.some(({ attempt }) => ["target_changed", "connection_failed", "authentication_required"].includes(attempt.receipt?.errorCode ?? ""))) {
          store.markDeviceOffline(deviceId, now());
        }
        return result;
      });
    },
    async discoverAndroidAdb(connectionRef) {
      if (!androidAdb) throw new DeviceBrokerError("missing_target", "Android ADB is not configured on this host");
      return broker.discover(androidAdb.manifest.adapterId, {
        ownerId: DEFAULT_WORKSPACE_ID, connectionRef, signal: AbortSignal.timeout(15_000),
      });
    },
    async discoverObd(connectionRef) {
      if (!obd) throw new DeviceBrokerError("missing_target", "OBD is not configured on this host");
      return broker.discover(obd.manifest.adapterId, {
        ownerId: DEFAULT_WORKSPACE_ID, connectionRef, signal: AbortSignal.timeout(15_000),
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
    getAccessGrant(deviceId, grantId) {
      requireLocalAccessTarget(store, deviceId);
      return requireBoundGrant(fabricStore.getAccessGrant(grantId), deviceId);
    },
    saveAccessGrant(input) {
      const profile = requireLocalAccessTarget(store, input.deviceId);
      const current = fabricStore.getAccessGrant(input.grantId);
      if (current) {
        requireBoundGrant(current, input.deviceId);
        if (current.principalId !== input.principalId) {
          throw new DeviceBrokerError("target_changed", "device access grant is bound to another principal");
        }
      }
      const capabilityIds = [...input.capabilityIds].sort();
      const changedAt = now();
      const grant: DeviceAccessGrantV1 = {
        grantId: input.grantId, targetDeviceId: input.deviceId, principalId: input.principalId,
        scope: input.scope, capabilityIds, revision: input.expectedRevision + 1,
        status: "active", expiresAt: input.expiresAt, authority: localGrantAuthority, changedAt,
      };
      if (current && isGrantReplay(current, grant)) return current;
      assertGrantRevision(current, input.expectedRevision);
      if (["revoked", "retired"].includes(profile.device.lifecycleStatus) || current?.status === "revoked" || current?.scope === "owner") {
        throw new DeviceBrokerError("permission_denied", "device access grant is no longer active");
      }
      if (!(Date.parse(input.expiresAt) > Date.parse(changedAt))) {
        throw new DeviceBrokerError("invalid_request", "device access grant must expire in the future");
      }
      if (!capabilityIds.length || new Set(capabilityIds).size !== capabilityIds.length) {
        throw new DeviceBrokerError("invalid_request", "device access grant requires distinct capabilities");
      }
      const snapshot = store.getCurrentCapabilitySnapshot(input.deviceId);
      if (!snapshot || snapshot.adapterId !== profile.adapterId || snapshot.adapterVersion !== profile.adapterVersion
        || !(Date.parse(snapshot.observedAt) <= Date.parse(changedAt) && Date.parse(changedAt) < Date.parse(snapshot.freshnessUntil))) {
        throw new DeviceBrokerError("target_changed", "device access grant requires a current capability snapshot");
      }
      if (capabilityIds.some(id => !snapshot.capabilities.some(capability => capability.id === id
        && (input.scope === "developer" || capability.sideEffect === "read_only")))) {
        throw new DeviceBrokerError("invalid_request", "device access grant contains an unavailable or incompatible capability");
      }
      return persistGrant(access, fabricStore, grant);
    },
    revokeAccessGrant(input) {
      requireLocalAccessTarget(store, input.deviceId);
      const current = requireBoundGrant(fabricStore.getAccessGrant(input.grantId), input.deviceId);
      const grant: DeviceAccessGrantV1 = {
        ...current, revision: input.expectedRevision + 1, status: "revoked", authority: localGrantAuthority, changedAt: now(),
      };
      if (isGrantReplay(current, grant)) return current;
      assertGrantRevision(current, input.expectedRevision);
      if (current.status === "revoked") return current;
      return persistGrant(access, fabricStore, grant);
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

const localGrantAuthority = "local_operator";

function requireLocalAccessTarget(store: SqliteDeviceSupportStore, deviceId: string): DeviceProfileV1 {
  const profile = store.getDevice(deviceId);
  if (profile?.device.ownerScope !== DEFAULT_WORKSPACE_ID) {
    throw new DeviceBrokerError("missing_target", "device is unavailable in this workspace");
  }
  return profile;
}

function requireBoundGrant(grant: DeviceAccessGrantV1 | undefined, deviceId: string): DeviceAccessGrantV1 {
  if (grant?.targetDeviceId !== deviceId) throw new DeviceBrokerError("missing_target", "device access grant is unavailable");
  return grant;
}

function assertGrantRevision(grant: DeviceAccessGrantV1 | undefined, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) {
    throw new DeviceBrokerError("invalid_request", "device access grant revision is invalid");
  }
  if (expectedRevision !== (grant?.revision ?? 0)) {
    throw new DeviceBrokerError("target_changed", "device access grant revision changed");
  }
}

function isGrantReplay(current: DeviceAccessGrantV1 | undefined, grant: DeviceAccessGrantV1): boolean {
  return current !== undefined && current.revision === grant.revision && current.status === grant.status
    && current.authority === grant.authority && current.targetDeviceId === grant.targetDeviceId
    && current.principalId === grant.principalId && current.scope === grant.scope && current.expiresAt === grant.expiresAt
    && current.capabilityIds.length === grant.capabilityIds.length
    && current.capabilityIds.every((id, index) => id === grant.capabilityIds[index]);
}

function persistGrant(access: DeviceAccessManager, store: SqliteDeviceFabricStore, grant: DeviceAccessGrantV1): DeviceAccessGrantV1 {
  try {
    return access.grant(grant);
  } catch (error) {
    if (!(error instanceof DeviceFabricError) || error.code !== "revision_conflict") throw error;
    const current = store.getAccessGrant(grant.grantId);
    if (current && isGrantReplay(current, grant)) return current;
    throw new DeviceBrokerError("target_changed", "device access grant revision changed");
  }
}
