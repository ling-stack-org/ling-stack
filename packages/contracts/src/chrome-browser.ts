export const CHROME_BROWSER_PLUGIN_ID = "built-in:chrome";
export const CHROME_BROWSER_MCP_SERVER_ID = "mcp_chrome_browser";
export const CHROME_BROWSER_PROTOCOL = "ling.chrome.v1";
export const CHROME_BROWSER_NATIVE_PROTOCOL = "ling.chrome.native.v1";
export const CHROME_BROWSER_NATIVE_HOST_NAME = "com.lingstack.browser";
export const CHROME_BROWSER_NATIVE_HOST_VERSION = "0.1.1";
export const CHROME_BROWSER_MINIMUM_NATIVE_EXTENSION_VERSION = "0.1.1";
export const CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA = "ling.browser-host.runtime.v1";
export const CHROME_BROWSER_PRODUCTION_EXTENSION_ID = "mbmlnnfhebclljonhedpjghbhibfapei";
export const CHROME_BROWSER_LEGACY_DEVELOPMENT_EXTENSION_ID = "ggmhibjboaedlnidbemkefonahjgcapc";
export const CHROME_BROWSER_DEFAULT_EXTENSION_IDS = [
  CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
  CHROME_BROWSER_LEGACY_DEVELOPMENT_EXTENSION_ID,
] as const;
export const CHROME_BROWSER_MAX_MESSAGE_BYTES = 1024 * 1024;
export const CHROME_BROWSER_PAIRING_CODE_MAX_LENGTH = 128;
export const CHROME_BROWSER_CREDENTIAL_MAX_LENGTH = 256;

export const chromeBrowserMethods = [
  "chrome_tabs",
  "chrome_snapshot",
  "chrome_navigate",
  "chrome_click",
  "chrome_type",
  "chrome_screenshot",
] as const;

export type ChromeBrowserMethod = (typeof chromeBrowserMethods)[number];

export type ChromeBrowserSetupState =
  | "extension_required"
  | "waiting_for_chrome"
  | "ready"
  | "incompatible"
  | "host_missing"
  | "ling_unavailable"
  | "paused";

export type ChromeBrowserTransportKind = "legacy_websocket" | "native_messaging";
export type ChromeBrowserHostState = "ready" | "missing" | "incompatible";
export type ChromeBrowserExtensionState =
  | "not_detected"
  | "connected"
  | "paused"
  | "ling_unavailable"
  | "incompatible";

export interface ChromeBrowserNativeExtensionHello {
  readonly protocol: typeof CHROME_BROWSER_NATIVE_PROTOCOL;
  readonly type: "hello";
  readonly extensionVersion: string;
  readonly browserVersion?: string;
  readonly paused: boolean;
}

export interface ChromeBrowserNativeBrokerHello extends ChromeBrowserNativeExtensionHello {
  readonly token: string;
  readonly origin: string;
  readonly hostVersion: string;
}

export interface ChromeBrowserRuntimeDescriptorV1 {
  readonly schema: typeof CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA;
  readonly protocol: typeof CHROME_BROWSER_NATIVE_PROTOCOL;
  readonly hostVersion: string;
  readonly port: number;
  readonly token: string;
  readonly generation: string;
  readonly daemonPid: number;
  readonly expiresAtEpochMs: number;
}

export interface ChromeBrowserNativeReadyMessage {
  readonly protocol: typeof CHROME_BROWSER_NATIVE_PROTOCOL;
  readonly type: "ready";
  readonly connected: boolean;
  readonly migratedLegacyCredential: boolean;
}

export interface ChromeBrowserNativeErrorMessage {
  readonly protocol: typeof CHROME_BROWSER_NATIVE_PROTOCOL;
  readonly type: "error";
  readonly code:
    | "host_missing"
    | "ling_unavailable"
    | "descriptor_invalid"
    | "origin_forbidden"
    | "plugin_disabled"
    | "version_incompatible"
    | "native_protocol_invalid";
}

export type ChromeBrowserNativeControlMessage =
  | ChromeBrowserNativeReadyMessage
  | ChromeBrowserNativeErrorMessage;

export interface ChromeBrowserPairingRequest {
  readonly protocol: typeof CHROME_BROWSER_PROTOCOL;
  readonly pairingCode: string;
  readonly extensionVersion: string;
  readonly browserVersion?: string;
}

export interface ChromeBrowserPairingResponse {
  readonly protocol: typeof CHROME_BROWSER_PROTOCOL;
  readonly credential: string;
  readonly workspaceCwd: string;
}

export interface ChromeBrowserPairingStartResponse {
  readonly pluginId: typeof CHROME_BROWSER_PLUGIN_ID;
  readonly pairingCode: string;
  readonly expiresAt: string;
  readonly storeUrl?: string;
}

export interface ChromeBrowserHelloMessage {
  readonly protocol: typeof CHROME_BROWSER_PROTOCOL;
  readonly type: "hello";
  readonly credential: string;
  readonly extensionVersion: string;
  readonly browserVersion?: string;
}

export interface ChromeBrowserHeartbeatMessage {
  readonly protocol: typeof CHROME_BROWSER_PROTOCOL;
  readonly type: "heartbeat";
  readonly sentAt: string;
}

export interface ChromeBrowserResultMessage {
  readonly protocol: typeof CHROME_BROWSER_PROTOCOL;
  readonly type: "result";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export type ChromeBrowserExtensionMessage =
  | ChromeBrowserHelloMessage
  | ChromeBrowserHeartbeatMessage
  | ChromeBrowserResultMessage;

export interface ChromeBrowserCommand {
  readonly protocol: typeof CHROME_BROWSER_PROTOCOL;
  readonly type: "command";
  readonly id: string;
  readonly method: ChromeBrowserMethod;
  readonly params: unknown;
  readonly deadlineAt: string;
}

export function isChromeBrowserMethod(value: unknown): value is ChromeBrowserMethod {
  return typeof value === "string" && (chromeBrowserMethods as readonly string[]).includes(value);
}

export function parseChromeBrowserNativeExtensionHello(value: unknown): ChromeBrowserNativeExtensionHello {
  const record = readRecord(value, "Chrome native extension hello");
  assertExactKeys(record, ["protocol", "type", "extensionVersion", "browserVersion", "paused"]);
  if (record.protocol !== CHROME_BROWSER_NATIVE_PROTOCOL || record.type !== "hello") {
    throw new Error("Unsupported Chrome native transport protocol.");
  }
  if (typeof record.paused !== "boolean") {
    throw new Error("Invalid paused state.");
  }
  return {
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    type: "hello",
    extensionVersion: readBoundedString(record.extensionVersion, "extensionVersion", 64),
    ...(record.browserVersion === undefined
      ? {}
      : { browserVersion: readBoundedString(record.browserVersion, "browserVersion", 128) }),
    paused: record.paused,
  };
}

export function parseChromeBrowserNativeBrokerHello(value: unknown): ChromeBrowserNativeBrokerHello {
  const record = readRecord(value, "Chrome native broker hello");
  assertExactKeys(record, [
    "protocol",
    "type",
    "extensionVersion",
    "browserVersion",
    "paused",
    "token",
    "origin",
    "hostVersion",
  ]);
  const extension = parseChromeBrowserNativeExtensionHello({
    protocol: record.protocol,
    type: record.type,
    extensionVersion: record.extensionVersion,
    ...(record.browserVersion === undefined ? {} : { browserVersion: record.browserVersion }),
    paused: record.paused,
  });
  return {
    ...extension,
    token: readBoundedString(record.token, "token", 256),
    origin: readBoundedString(record.origin, "origin", 256),
    hostVersion: readBoundedString(record.hostVersion, "hostVersion", 64),
  };
}

export function parseChromeBrowserRuntimeDescriptorV1(value: unknown): ChromeBrowserRuntimeDescriptorV1 {
  const record = readRecord(value, "Chrome browser runtime descriptor");
  assertExactKeys(record, [
    "schema",
    "protocol",
    "hostVersion",
    "port",
    "token",
    "generation",
    "daemonPid",
    "expiresAtEpochMs",
  ]);
  if (record.schema !== CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA
    || record.protocol !== CHROME_BROWSER_NATIVE_PROTOCOL) {
    throw new Error("Unsupported Chrome browser runtime descriptor.");
  }
  return {
    schema: CHROME_BROWSER_RUNTIME_DESCRIPTOR_SCHEMA,
    protocol: CHROME_BROWSER_NATIVE_PROTOCOL,
    hostVersion: readBoundedString(record.hostVersion, "hostVersion", 64),
    port: readIntegerInRange(record.port, "port", 1, 65_535),
    token: readBoundedString(record.token, "token", 256),
    generation: readBoundedString(record.generation, "generation", 128),
    daemonPid: readIntegerInRange(record.daemonPid, "daemonPid", 1, 2_147_483_647),
    expiresAtEpochMs: readIntegerInRange(record.expiresAtEpochMs, "expiresAtEpochMs", 1, Number.MAX_SAFE_INTEGER),
  };
}

export function isCompatibleChromeBrowserNativeVersion(value: string, minimum = CHROME_BROWSER_MINIMUM_NATIVE_EXTENSION_VERSION): boolean {
  const version = parseSemverTriplet(value);
  const required = parseSemverTriplet(minimum);
  if (!version || !required) return false;
  for (let index = 0; index < required.length; index += 1) {
    if (version[index]! > required[index]!) return true;
    if (version[index]! < required[index]!) return false;
  }
  return true;
}

export function parseChromeBrowserPairingRequest(value: unknown): ChromeBrowserPairingRequest {
  const record = readRecord(value, "Chrome pairing request");
  assertExactKeys(record, ["protocol", "pairingCode", "extensionVersion", "browserVersion"]);
  if (record.protocol !== CHROME_BROWSER_PROTOCOL) {
    throw new Error("Unsupported Chrome browser protocol.");
  }
  return {
    protocol: CHROME_BROWSER_PROTOCOL,
    pairingCode: readBoundedString(record.pairingCode, "pairingCode", CHROME_BROWSER_PAIRING_CODE_MAX_LENGTH),
    extensionVersion: readBoundedString(record.extensionVersion, "extensionVersion", 64),
    ...(record.browserVersion === undefined
      ? {}
      : { browserVersion: readBoundedString(record.browserVersion, "browserVersion", 128) }),
  };
}

export function parseChromeBrowserExtensionMessage(value: unknown): ChromeBrowserExtensionMessage {
  const record = readRecord(value, "Chrome extension message");
  if (record.protocol !== CHROME_BROWSER_PROTOCOL) {
    throw new Error("Unsupported Chrome browser protocol.");
  }
  if (record.type === "hello") {
    assertExactKeys(record, ["protocol", "type", "credential", "extensionVersion", "browserVersion"]);
    return {
      protocol: CHROME_BROWSER_PROTOCOL,
      type: "hello",
      credential: readBoundedString(record.credential, "credential", CHROME_BROWSER_CREDENTIAL_MAX_LENGTH),
      extensionVersion: readBoundedString(record.extensionVersion, "extensionVersion", 64),
      ...(record.browserVersion === undefined
        ? {}
        : { browserVersion: readBoundedString(record.browserVersion, "browserVersion", 128) }),
    };
  }
  if (record.type === "heartbeat") {
    assertExactKeys(record, ["protocol", "type", "sentAt"]);
    return {
      protocol: CHROME_BROWSER_PROTOCOL,
      type: "heartbeat",
      sentAt: readIsoTimestamp(record.sentAt, "sentAt"),
    };
  }
  if (record.type === "result") {
    assertExactKeys(record, ["protocol", "type", "id", "ok", "result", "error"]);
    if (typeof record.ok !== "boolean") {
      throw new Error("Chrome result ok must be a boolean.");
    }
    const error = record.error === undefined ? undefined : parseResultError(record.error);
    if (record.ok && error) {
      throw new Error("Successful Chrome results cannot include an error.");
    }
    if (!record.ok && !error) {
      throw new Error("Failed Chrome results must include an error.");
    }
    return {
      protocol: CHROME_BROWSER_PROTOCOL,
      type: "result",
      id: readBoundedString(record.id, "id", 128),
      ok: record.ok,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(error ? { error } : {}),
    };
  }
  throw new Error("Unsupported Chrome extension message type.");
}

function parseResultError(value: unknown): { readonly code: string; readonly message: string } {
  const record = readRecord(value, "Chrome result error");
  assertExactKeys(record, ["code", "message"]);
  return {
    code: readBoundedString(record.code, "error.code", 96),
    message: readBoundedString(record.message, "error.message", 512),
  };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters.`);
  }
  return value;
}

function readIsoTimestamp(value: unknown, field: string): string {
  const text = readBoundedString(value, field, 64);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return text;
}

function readIntegerInRange(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function parseSemverTriplet(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim());
  if (!match) return undefined;
  const parts = match.slice(1, 4).map(Number);
  return parts.every((part) => Number.isSafeInteger(part) && part >= 0)
    ? [parts[0]!, parts[1]!, parts[2]!]
    : undefined;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) {
    throw new Error(`Unknown Chrome browser field: ${unknown}`);
  }
}
