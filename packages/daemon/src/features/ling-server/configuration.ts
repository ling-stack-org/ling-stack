import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { isRecord } from "../../shared/validation.js";
import type { LingServerControlPlaneOptions } from "./control-plane.js";

export function readLingServerConfiguration(configPath: string): LingServerControlPlaneOptions {
  const folder = dirname(resolve(configPath));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("Could not read the Ling Server JSON configuration");
  }
  const config = readRecord(raw, ["host", "port", "adminPort", "databasePath", "authTokenFile", "tls", "transport"], "configuration");
  const host = config.host === undefined ? "127.0.0.1" : readString(config.host, "host");
  const authToken = readSecret(folder, config.authTokenFile, "authTokenFile");
  const databasePath = resolve(folder, readString(config.databasePath, "databasePath"));
  const tls = config.tls === undefined ? undefined : readTls(folder, config.tls);
  if (!tls && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("A non-loopback Ling Server listener requires TLS");
  }
  if (!tls && config.adminPort !== undefined) throw new Error("Ling Server adminPort requires a TLS peer listener");
  return {
    host, port: readPort(config.port, tls ? 443 : 17894), authToken, databasePath, tls,
    ...(tls ? { adminPort: readPort(config.adminPort, 17894) } : {}),
    ...(config.transport !== undefined ? { transport: readTransport(folder, config.transport) } : {}),
  };
}

function readPort(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("Invalid Ling Server port");
  }
  return value;
}

function readTls(folder: string, input: unknown): NonNullable<LingServerControlPlaneOptions["tls"]> {
  const tls = readRecord(input, ["certFile", "keyFile"], "TLS configuration");
  return {
    cert: readFileSync(resolve(folder, readString(tls.certFile, "certFile"))),
    key: readFileSync(resolve(folder, readString(tls.keyFile, "keyFile"))),
  };
}

function readTransport(folder: string, input: unknown): LingServerControlPlaneOptions["transport"] {
  const value = readRecord(input, ["stunUrls", "turnUrls", "relaySharedSecretFile"], "transport configuration");
  return {
    stunUrls: readUrls(value.stunUrls, "stun"),
    turnUrls: readUrls(value.turnUrls, "turn"),
    ...(value.relaySharedSecretFile !== undefined ? { relaySharedSecret: readSecret(folder, value.relaySharedSecretFile, "relaySharedSecretFile") } : {}),
  };
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
