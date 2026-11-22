import {
  isLinuxDnsProbeHostname, readLinuxDnsLookup, readLinuxIpv4Evidence, readLinuxWifiLink, selectLinuxWifiInterface,
  type CapabilityDescriptorV1, type DeviceActionResultV1, type DeviceCapabilitySnapshotV1,
  type DeviceProfileV1, type LinuxNetworkFacts, type LinuxSshReadOperation, type LinuxSshReadResult,
} from "@ling-stack/contracts";
import { canonicalJsonBytes, decodeBase64Url, encodeBase64Url, sha256 } from "@ling-stack/remote-protocol";
import type { MobileDeviceExecutionResult, MobileDeviceTransport } from "./execution.ts";

export const linuxSshPlaybookId = "linux-wifi-diagnosis@1.0.0";

export interface LinuxSshTargetInput {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly fingerprint: string;
  readonly dnsProbeHostname?: string;
}

export interface LinuxSshTarget extends LinuxSshTargetInput {
  readonly deviceId: string;
}

export interface LinuxSshConnection {
  read(operation: LinuxSshReadOperation, argument?: string): Promise<LinuxSshReadResult>;
  close(): void;
}

export type OpenLinuxSshConnection = (
  target: LinuxSshTargetInput,
  fingerprintHex: string,
  password: string,
  signal?: AbortSignal,
) => Promise<LinuxSshConnection>;

export class LinuxSshInputError extends Error {}

const adapterId = "linux-ssh-mobile";
const adapterVersion = "1.0.0";
const capability: CapabilityDescriptorV1 = {
  id: "linux.inspect.wifi",
  schemaVersion: "1.0",
  semanticVerb: "inspect.wifi",
  inputSchema: { type: "object" },
  outputSchema: { type: "object", required: ["connected"] },
  sideEffect: "read_only",
  approvalClass: "allow",
  requiredPermissions: ["ssh.read"],
  prerequisites: [],
  timeoutMs: 15_000,
  responseBytesLimit: 128 * 1024,
  idempotency: "request",
  supportedDeviceKinds: ["linux"],
  supportedTransports: ["ssh"],
};

function checkTarget(input: LinuxSshTargetInput): { target: LinuxSshTargetInput; fingerprint: Uint8Array } {
  const host = input.host.trim();
  const username = input.username.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,252}$/iu.test(host) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new LinuxSshInputError("请填写 Linux 设备的 IPv4 地址或主机名，以及有效 SSH 端口。");
  }
  if (!/^[a-z0-9_][a-z0-9_.@-]{0,63}$/iu.test(username)) throw new LinuxSshInputError("请填写 SSH 用户名。");
  const pin = input.fingerprint.trim();
  if (!/^SHA256:[a-z0-9+/]{43}$/iu.test(pin)) throw new LinuxSshInputError("请填写独立核验过的 SSH 主机 SHA256 指纹。");
  const base64url = pin.slice("SHA256:".length).replaceAll("+", "-").replaceAll("/", "_");
  let fingerprint: Uint8Array;
  try {
    fingerprint = decodeBase64Url(base64url);
  } catch {
    throw new LinuxSshInputError("SSH 主机指纹格式无效。");
  }
  if (fingerprint.length !== 32 || encodeBase64Url(fingerprint) !== base64url) {
    throw new LinuxSshInputError("SSH 主机指纹格式无效。");
  }
  const dnsProbeHostname = input.dnsProbeHostname?.trim() || undefined;
  if (dnsProbeHostname && !isLinuxDnsProbeHostname(dnsProbeHostname)) {
    throw new LinuxSshInputError("请填写可选 DNS 测试域名。");
  }
  return { target: { host, port: input.port, username, fingerprint: pin, ...(dnsProbeHostname ? { dnsProbeHostname } : {}) }, fingerprint };
}

export function prepareLinuxSshDiagnosis(input: {
  readonly target: LinuxSshTargetInput;
  readonly password: string;
  readonly ownerId: string;
  readonly connectionRevision: string;
  readonly open: OpenLinuxSshConnection;
  readonly now: () => string;
}) {
  const { target, fingerprint } = checkTarget(input.target);
  if (!input.password || input.password.length > 1024 || input.password.includes("\0")) throw new LinuxSshInputError("请填写有效的 SSH 密码。");
  const fingerprintHex = Array.from(fingerprint, byte => byte.toString(16).padStart(2, "0")).join("");
  const deviceId = "linux:" + input.ownerId + ":" + encodeBase64Url(fingerprint);
  const profileRevision = encodeBase64Url(sha256(canonicalJsonBytes(target)));
  const observedAt = input.now();
  const profile: DeviceProfileV1 = {
    device: {
      id: deviceId, ownerScope: input.ownerId, runtimeOwnerId: input.ownerId, displayName: target.host,
      kind: "linux", lifecycleStatus: "identified", profileRevision, lastSeenAt: observedAt,
    },
    adapterId, adapterVersion, transports: ["ssh"], connectionRefs: ["ssh:" + profileRevision],
    transportDeployments: [{ transport: "ssh", mode: "none", pairing: "credential_reference", removal: "revoke_credentials" }],
    profileRevision, source: "adapter",
  };
  const snapshot: DeviceCapabilitySnapshotV1 = {
    snapshotId: deviceId + ":" + input.connectionRevision + ":" + adapterVersion,
    deviceId, adapterId, adapterVersion, contractMajor: 1, connectionRevision: input.connectionRevision,
    capabilities: [capability], observedAt, freshnessUntil: new Date(Date.parse(observedAt) + 30_000).toISOString(),
  };
  const transport: MobileDeviceTransport = {
    deviceId,
    connectionRevision: input.connectionRevision,
    permissions: capability.requiredPermissions,
    async execute({ request, signal }) {
      const startedAt = input.now();
      const rejected = (errorCode: NonNullable<DeviceActionResultV1["errorCode"]>): MobileDeviceExecutionResult => ({
        action: { actionId: request.actionId, status: "rejected", errorCode, startedAt, finishedAt: input.now(), observationIds: [] },
      });
      if (request.targetDeviceId !== deviceId || request.capabilitySnapshotId !== snapshot.snapshotId
        || request.capabilityId !== capability.id || request.capabilitySchemaVersion !== capability.schemaVersion) return rejected("invalid_request");
      let connection: LinuxSshConnection | undefined;
      try {
        connection = await input.open(target, fingerprintHex, input.password, signal);
        const facts = await readWifi(connection, target.dnsProbeHostname);
        const finishedAt = input.now();
        const observationId = request.taskId + ":" + request.actionId + ":facts";
        return {
          action: { actionId: request.actionId, status: "completed", startedAt, finishedAt, observationIds: [observationId] },
          observations: [{
            id: observationId, subjectId: deviceId, source: "linux.wifi", value: { ...facts },
            observedAt: finishedAt, receivedAt: finishedAt, freshnessUntil: new Date(Date.parse(finishedAt) + 30_000).toISOString(),
            quality: facts.linkError ? "degraded" : "good", provenance: ["linux.wifi", deviceId], redactionClass: "public",
          }],
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return rejected(mapSshError(error));
      } finally {
        connection?.close();
      }
    },
  };
  return {
    profile, snapshot, transport, target: { ...target, deviceId },
    step: { stepId: "inspect-wifi", capabilityId: capability.id, capabilitySchemaVersion: capability.schemaVersion, normalizedInput: {} },
  };
}

async function readWifi(connection: LinuxSshConnection, dnsProbeHostname?: string): Promise<LinuxNetworkFacts> {
  const kernel = await connection.read("kernel");
  if (kernel.exitCode !== 0 || !kernel.stdout.trim().startsWith("Linux ")) throw new Error("ssh_unsupported_operation");
  const addresses = await connection.read("addresses");
  if (addresses.exitCode !== 0) throw new Error("ssh_unsupported_operation");
  const network = await readLinuxIpv4Evidence(addresses, () => connection.read("route"));
  const wireless = selectLinuxWifiInterface(await connection.read("wifi"), network.interfaceName);
  const wifi = "linkError" in wireless ? { linkError: wireless.linkError }
    : readLinuxWifiLink(await connection.read("link", wireless.interfaceName));
  let dnsNameResolved: boolean | undefined;
  if (dnsProbeHostname) {
    try {
      dnsNameResolved = readLinuxDnsLookup(await connection.read("dns", dnsProbeHostname));
    } catch (error) {
      if (mapSshError(error) !== "timeout") throw error;
    }
  }
  return {
    connected: network.connected,
    ...(network.routeAvailable === undefined ? {} : { routeAvailable: network.routeAvailable }),
    ...(dnsNameResolved === undefined ? {} : { dnsNameResolved }),
    ...(wifi.wifiAssociated === undefined ? {} : { wifiAssociated: wifi.wifiAssociated }),
    ...(wifi.linkError === undefined ? {} : { linkError: wifi.linkError }),
  };
}

function mapSshError(error: unknown): NonNullable<DeviceActionResultV1["errorCode"]> {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("ssh_host_key_mismatch")) return "target_changed";
  if (message.includes("ssh_authentication_failed")) return "permission_denied";
  if (message.includes("ssh_timeout")) return "timeout";
  if (message.includes("ssh_unsupported_operation")) return "unsupported_capability";
  if (message.includes("ssh_output_limit") || message === "Linux ip command returned invalid JSON") return "service_unavailable";
  return "connection_failed";
}
