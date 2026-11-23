import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { dirname, resolve } from "node:path";

import { isRecord } from "../../shared/validation.js";
import type { LingServerControlPlaneOptions } from "./control-plane.js";

export function readLingServerConfiguration(configPath: string): {
  readonly control: LingServerControlPlaneOptions;
  readonly coturnConfig?: string;
} {
  const folder = readString(dirname(resolve(configPath)), "configuration directory");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("Could not read the Ling Server JSON configuration");
  }
  const config = readRecord(raw, ["host", "port", "adminPort", "databasePath", "authTokenFile", "applicationIdentityKeyFile", "tls", "transport"], "configuration");
  const host = config.host === undefined ? "127.0.0.1" : readString(config.host, "host");
  const authToken = readSecret(folder, config.authTokenFile, "authTokenFile");
  const databasePath = resolve(folder, readString(config.databasePath, "databasePath"));
  const tls = config.tls === undefined ? undefined : readTls(folder, config.tls);
  if (!tls && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("A non-loopback Ling Server listener requires TLS");
  }
  if (!tls && config.adminPort !== undefined) throw new Error("Ling Server adminPort requires a TLS peer listener");
  const port = readPort(config.port, tls ? 443 : 17894);
  const transport = config.transport === undefined ? undefined : readTransport(folder, config.transport);
  const coturn = transport?.coturn;
  if (coturn && (!tls || config.applicationIdentityKeyFile === undefined)) {
    throw new Error("Managed coturn requires Ling Server TLS and an application identity key");
  }
  if (coturn?.tlsPort === port && [coturn.bindAddress, "0.0.0.0", "::"].includes(host)) {
    throw new Error("Ling Server and coturn TLS listeners require distinct addresses or ports");
  }
  const control: LingServerControlPlaneOptions = {
    host, port, authToken, databasePath, tls,
    ...(tls ? { adminPort: readPort(config.adminPort, 17894) } : {}),
    ...(config.applicationIdentityKeyFile !== undefined ? {
      applicationIdentityPrivateKeyPem: readFileSync(resolve(folder, readString(config.applicationIdentityKeyFile, "applicationIdentityKeyFile")), "utf8"),
    } : {}),
    ...(transport ? { transport: transport.options } : {}),
  };
  return { control, coturnConfig: coturn?.content };
}

function readPort(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("Invalid Ling Server port");
  }
  return value;
}

function readTls(folder: string, input: unknown): NonNullable<LingServerControlPlaneOptions["tls"]> {
  const { certFile, keyFile } = readTlsPaths(folder, input);
  return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
}

function readTlsPaths(folder: string, input: unknown) {
  const tls = readRecord(input, ["certFile", "keyFile"], "TLS configuration");
  return {
    certFile: resolve(folder, readString(tls.certFile, "certFile")),
    keyFile: resolve(folder, readString(tls.keyFile, "keyFile")),
  };
}

function readTransport(folder: string, input: unknown) {
  const value = readRecord(input, ["stunUrls", "turnUrls", "relaySharedSecretFile", "coturn"], "transport configuration");
  const relaySharedSecret = value.relaySharedSecretFile === undefined ? undefined
    : readSecret(folder, value.relaySharedSecretFile, "relaySharedSecretFile");
  if (value.coturn !== undefined && value.turnUrls !== undefined) {
    throw new Error("Choose one source for the advertised TURN endpoints");
  }
  const coturn = value.coturn === undefined ? undefined : readCoturn(folder, value.coturn, relaySharedSecret);
  return {
    coturn,
    options: {
      stunUrls: coturn && value.stunUrls === undefined ? coturn.stunUrls : readUrls(value.stunUrls, "stun"),
      turnUrls: coturn?.turnUrls ?? readUrls(value.turnUrls, "turn"),
      ...(relaySharedSecret !== undefined ? { relaySharedSecret } : {}),
    } satisfies LingServerControlPlaneOptions["transport"],
  };
}

function readCoturn(folder: string, input: unknown, relaySharedSecret: string | undefined) {
  const value = readRecord(input, [
    "publicHost", "bindAddress", "publicAddress", "udpPort", "tlsPort",
    "allocationPortMin", "allocationPortMax", "stateDirectory", "tls",
  ], "managed coturn configuration");
  if (!relaySharedSecret || !/^[A-Za-z0-9_-]{32,256}$/u.test(relaySharedSecret)) {
    throw new Error("Managed coturn requires a shared secret of 32–256 base64url characters");
  }
  const publicHost = readString(value.publicHost, "coturn.publicHost");
  if (publicHost.length > 253 || publicHost.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))) {
    throw new Error("Invalid coturn public hostname");
  }
  const bindAddress = readCoturnAddress(value.bindAddress, "coturn.bindAddress");
  const publicAddress = readCoturnAddress(value.publicAddress ?? bindAddress, "coturn.publicAddress");
  const udpPort = value.udpPort === null ? undefined : readCoturnPort(value.udpPort, 3478);
  const tlsPort = readCoturnPort(value.tlsPort, 5349);
  const minPort = readCoturnPort(value.allocationPortMin, 49160);
  const maxPort = readCoturnPort(value.allocationPortMax, 49259);
  if (minPort > maxPort || (udpPort !== undefined && udpPort >= minPort && udpPort <= maxPort)) {
    throw new Error("Invalid coturn UDP allocation range");
  }
  const directory = resolve(folder, readString(value.stateDirectory ?? "state/coturn", "coturn.stateDirectory"));
  const { certFile, keyFile } = readTlsPaths(folder, value.tls);
  const content = [
    "listening-ip=" + bindAddress,
    "relay-ip=" + bindAddress,
    ...(publicAddress !== bindAddress ? ["external-ip=" + publicAddress + "/" + bindAddress] : []),
    ...(udpPort === undefined ? ["no-udp"] : ["listening-port=" + udpPort]),
    "tls-listening-port=" + tlsPort,
    "no-tcp",
    "no-tcp-relay",
    "no-cli",
    "no-multicast-peers",
    "realm=" + publicHost,
    "fingerprint",
    "use-auth-secret",
    "static-auth-secret=" + relaySharedSecret,
    "cert=" + certFile,
    "pkey=" + keyFile,
    "userdb=" + resolve(directory, "turn.sqlite"),
    "pidfile=" + resolve(directory, "turn.pid"),
    "min-port=" + minPort,
    "max-port=" + maxPort,
    "user-quota=4",
    "total-quota=" + (maxPort - minPort + 1),
    // Relay routes gather only relay candidates on both peers in a single-node installation.
    "allowed-peer-ip=" + publicAddress,
    "denied-peer-ip=0.0.0.0-255.255.255.255",
    "denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "",
  ].join("\n");
  return {
    bindAddress, tlsPort, content,
    stunUrls: udpPort === undefined ? [] : [`stun:${publicHost}:${udpPort}`],
    turnUrls: [
      ...(udpPort === undefined ? [] : [`turn:${publicHost}:${udpPort}?transport=udp`]),
      `turns:${publicHost}:${tlsPort}?transport=tcp`,
    ],
  };
}

function readCoturnAddress(value: unknown, label: string): string {
  const address = readString(value, label);
  if (!isIPv4(address) || address.startsWith("0.") || Number(address.split(".")[0]) >= 224) {
    throw new Error("Invalid IPv4 address for " + label);
  }
  return address;
}

function readCoturnPort(value: unknown, fallback: number): number {
  const port = readPort(value, fallback);
  if (port < 1) throw new Error("coturn listener and allocation ports must be nonzero");
  return port;
}

function readUrls(value: unknown, scheme: "stun" | "turn"): readonly string[] {
  if (value === undefined) return [];
  const pattern = new RegExp(`^${scheme}s?:[^\\s]+$`, "u");
  if (!Array.isArray(value) || value.length > 16 || value.some(item => typeof item !== "string" || !pattern.test(item))) {
    throw new Error(`Invalid Ling Server ${scheme.toUpperCase()} endpoints`);
  }
  return value;
}

function readSecret(folder: string, path: unknown, label: string): string {
  const value = readFileSync(resolve(folder, readString(path, label)), "utf8").trim();
  if (!value || /[\r\n]/u.test(value)) throw new Error(`Invalid Ling Server ${label}`);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n\u0000]/u.test(value)) throw new Error(`Invalid Ling Server ${label}`);
  return value;
}

function readRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid Ling Server ${label}`);
  return value;
}
