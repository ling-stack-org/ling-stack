import { isAbsolute } from "node:path";
import { isExternalExecutionEngineId, kimiProviderTypes, type ExecutionEngineProfileConfiguration, type ExecutionEngineProfileErrorCode } from "@ling-stack/contracts";
import { normalizeOpenClawAgentId } from "./native-openclaw-session.js";
import { isSupportedSecretRef } from "./secrets.js";

export { isExternalExecutionEngineId } from "@ling-stack/contracts";

export class ExecutionEngineProfileError extends Error {
  constructor(readonly code: ExecutionEngineProfileErrorCode, readonly field?: string) {
    super(field ? `${code}: ${field}` : code);
  }
}

export function parseExecutionEngineProfileConfiguration(input: unknown): ExecutionEngineProfileConfiguration {
  if (!isRecord(input)) fail("configuration");
  onlyKeys(input, ["engineId", "executablePath", "authProfileId", "secretRef", "openclaw", "kimi", "kimiLoginRegion"]);
  if (!isExternalExecutionEngineId(input.engineId)) fail("engineId");
  const executablePath = text(input.executablePath, "executablePath", 4096);
  if (!isAbsolute(executablePath)) fail("executablePath");
  const authProfileId = text(input.authProfileId, "authProfileId", 96);
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(authProfileId)) fail("authProfileId");
  const secretRef = input.secretRef === undefined ? undefined : text(input.secretRef, "secretRef", 512);
  if (secretRef && !isSupportedSecretRef(secretRef)) fail("secretRef");
  const kimiLoginRegion = input.kimiLoginRegion;
  if (kimiLoginRegion !== undefined && (input.engineId !== "kimi-acp" || secretRef
    || (kimiLoginRegion !== "mainland-cn" && kimiLoginRegion !== "global"))) fail("kimiLoginRegion");
  let kimi: ExecutionEngineProfileConfiguration["kimi"];
  if (input.kimi !== undefined) {
    if (input.engineId !== "kimi-acp" || !secretRef || !isRecord(input.kimi)) fail("kimi");
    onlyKeys(input.kimi, ["providerType", "baseUrl", "modelId", "maxContextSize"]);
    const requestedProvider = input.kimi.providerType;
    const providerType = kimiProviderTypes.find(value => value === requestedProvider);
    if (!providerType) fail("kimi.providerType");
    const baseUrl = text(input.kimi.baseUrl, "kimi.baseUrl", 2048);
    let url: URL;
    try { url = new URL(baseUrl); } catch { fail("kimi.baseUrl"); }
    if (baseUrl.trim() !== baseUrl || !["https:", "http:"].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.search || url.hash) fail("kimi.baseUrl");
    const modelId = text(input.kimi.modelId, "kimi.modelId", 512);
    if (modelId.trim() !== modelId) fail("kimi.modelId");
    const maxContextSize = input.kimi.maxContextSize;
    if (typeof maxContextSize !== "number" || !Number.isSafeInteger(maxContextSize) || maxContextSize < 1) fail("kimi.maxContextSize");
    kimi = { providerType, baseUrl, modelId, maxContextSize };
  }
  let openclaw: ExecutionEngineProfileConfiguration["openclaw"];
  if (input.engineId === "openclaw-acp") {
    if (!isRecord(input.openclaw)) fail("openclaw");
    onlyKeys(input.openclaw, ["gatewayUrl", "agentId", "credentialType"]);
    const gatewayUrl = text(input.openclaw.gatewayUrl, "gatewayUrl", 2048);
    let url: URL;
    try {
      url = new URL(gatewayUrl);
    } catch {
      fail("gatewayUrl");
    }
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) fail("gatewayUrl");
    if (url.username || url.password || url.search || url.hash) fail("gatewayUrl");
    let agentId: string;
    try {
      agentId = normalizeOpenClawAgentId(text(input.openclaw.agentId, "agentId", 64));
    } catch {
      fail("agentId");
    }
    const credentialType = input.openclaw.credentialType;
    if (credentialType !== undefined && credentialType !== "token" && credentialType !== "password") fail("openclaw.credentialType");
    openclaw = { gatewayUrl, agentId, ...(credentialType ? { credentialType } : {}) };
  } else if (input.openclaw !== undefined) {
    fail("openclaw");
  }
  return {
    engineId: input.engineId,
    executablePath,
    authProfileId,
    ...(secretRef ? { secretRef } : {}),
    ...(kimi ? { kimi } : {}),
    ...(kimiLoginRegion === "mainland-cn" || kimiLoginRegion === "global" ? { kimiLoginRegion } : {}),
    ...(openclaw ? { openclaw } : {}),
  };
}

export function assertProfileRevision(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("expectedRevision");
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) fail(field);
  return value;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("configuration");
}

function fail(field: string): never {
  // Do not echo submitted values: validation may have rejected a pasted credential.
  throw new ExecutionEngineProfileError("profile_invalid", field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
