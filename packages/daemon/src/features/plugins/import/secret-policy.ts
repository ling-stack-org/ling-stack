import { createHash } from "node:crypto";

export interface PendingImportSecret {
  readonly field: string;
  readonly refName: string;
  readonly value: string;
}

export interface ImportSecretFinding {
  readonly field: string;
  readonly masked: string;
  readonly needsInput: boolean;
}

export interface StrippedStdioTransport {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly secretEnvRefs: Readonly<Record<string, string>>;
}

export interface StrippedHttpTransport {
  readonly type: "streamable-http";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly secretHeaderRefs: Readonly<Record<string, string>>;
}

export type StrippedImportTransport = StrippedStdioTransport | StrippedHttpTransport;

export interface SecretPolicyResult {
  readonly transport: StrippedImportTransport;
  readonly findings: readonly ImportSecretFinding[];
  readonly pendingSecrets: readonly PendingImportSecret[];
}

const SECRET_KEY_PATTERN = /(api[-_]?key|apikey|access[-_]?key|key|token|secret|password|passwd|bearer|authorization|credential)/i;
const SUSPICIOUS_VALUE_MIN_LENGTH = 32;
const SECRET_VALUE_MIN_LENGTH = 20;
const MASKED_TAIL_LENGTH = 4;

/**
 * Classifies env/header values from third-party configs and strips secret values out of the
 * transport. Plaintext values only survive in `pendingSecrets`, which apply writes straight
 * into the external secret store; preview drops them before building any response.
 */
export function applySecretPolicyToStdio(input: {
  readonly source: string;
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}): SecretPolicyResult {
  const env: Record<string, string> = {};
  const secretEnvRefs: Record<string, string> = {};
  const findings: ImportSecretFinding[] = [];
  const pendingSecrets: PendingImportSecret[] = [];
  for (const [field, value] of Object.entries(input.env)) {
    const classification = classifySecretValue(field, value);
    if (classification === "plain") {
      env[field] = value;
      continue;
    }
    const refName = importSecretRefName(input.source, input.serverName, field);
    if (classification === "migrate") {
      secretEnvRefs[field] = `keychain:${refName}`;
      pendingSecrets.push({ field, refName, value });
      findings.push({ field, masked: maskSecretValue(value), needsInput: false });
      continue;
    }
    env[field] = "";
    findings.push({ field, masked: "", needsInput: true });
  }
  return {
    transport: {
      type: "stdio",
      command: input.command,
      args: input.args,
      env,
      cwd: input.cwd,
      secretEnvRefs,
    },
    findings,
    pendingSecrets,
  };
}

export function applySecretPolicyToHttp(input: {
  readonly source: string;
  readonly serverName: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}): SecretPolicyResult {
  const headers: Record<string, string> = {};
  const secretHeaderRefs: Record<string, string> = {};
  const findings: ImportSecretFinding[] = [];
  const pendingSecrets: PendingImportSecret[] = [];
  for (const [field, value] of Object.entries(input.headers)) {
    const classification = classifySecretValue(field, value);
    if (classification === "plain") {
      headers[field] = value;
      continue;
    }
    const refName = importSecretRefName(input.source, input.serverName, field);
    if (classification === "migrate") {
      secretHeaderRefs[field] = `keychain:${refName}`;
      pendingSecrets.push({ field, refName, value });
      findings.push({ field, masked: maskSecretValue(value), needsInput: false });
      continue;
    }
    headers[field] = "";
    findings.push({ field, masked: "", needsInput: true });
  }
  return {
    transport: {
      type: "streamable-http",
      url: input.url,
      headers,
      secretHeaderRefs,
    },
    findings,
    pendingSecrets,
  };
}

export function maskSecretValue(value: string): string {
  if (value.length <= MASKED_TAIL_LENGTH * 2) {
    return "…";
  }
  return `…${value.slice(-MASKED_TAIL_LENGTH)}`;
}

type SecretValueClassification = "plain" | "migrate" | "suspect";

function classifySecretValue(field: string, value: string): SecretValueClassification {
  if (value.length === 0) {
    return "plain";
  }
  if (SECRET_KEY_PATTERN.test(field) && value.length >= SECRET_VALUE_MIN_LENGTH) {
    return "migrate";
  }
  if (isHighEntropyValue(value)) {
    return "suspect";
  }
  return "plain";
}

function isHighEntropyValue(value: string): boolean {
  if (value.length < SUSPICIOUS_VALUE_MIN_LENGTH) {
    return false;
  }
  if (value.includes("://") || value.includes("@")) {
    return false;
  }
  const distinct = new Set(value).size;
  return distinct >= 12;
}

export function importSecretRefName(source: string, serverName: string, field: string): string {
  const digest = createHash("sha256").update(`${source}\u0000${serverName}\u0000${field}`).digest("hex").slice(0, 8);
  return sanitizeSecretRefName(`import-${source}-${serverName}-${field}`) + `-${digest}`;
}

function sanitizeSecretRefName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 80) : "item";
}
