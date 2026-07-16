import type {
  ComputerUsePreviewDescriptorResolver,
  ResolvedComputerUsePreviewDescriptor,
} from "./descriptor-registry.js";

export class DaemonComputerUsePreviewDescriptorResolver implements ComputerUsePreviewDescriptorResolver {
  constructor(
    private readonly baseUrl: string,
    private readonly cwd: string,
    private readonly bridgeToken: string,
    private readonly sessionIdForDescriptor: (descriptorId: string) => string | undefined,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async resolve(descriptorId: string, revision: number): Promise<ResolvedComputerUsePreviewDescriptor> {
    const sessionId = this.sessionIdForDescriptor(descriptorId);
    if (!sessionId) {
      throw new Error("computer_use_descriptor_session_not_found");
    }
    const url = new URL(`/computer-use/sessions/${encodeURIComponent(sessionId)}/source`, `${this.baseUrl}/`);
    url.searchParams.set("cwd", this.cwd);
    const response = await this.fetchImpl(url, {
      headers: { "X-Ling-Desktop-Bridge-Token": this.bridgeToken },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: unknown };
      throw new Error(typeof body.message === "string" ? body.message : `computer_use_descriptor_http_${response.status}`);
    }
    const descriptor = parseDaemonComputerUsePreviewDescriptor(await response.json());
    if (descriptor.descriptorId !== descriptorId || descriptor.revision !== revision) {
      throw new Error("computer_use_descriptor_response_mismatch");
    }
    return descriptor;
  }
}

/**
 * Validate and copy the private daemon response before it reaches Electron's
 * capture adapter. This boundary is deliberately independent of the daemon's
 * TypeScript type: the response crossed HTTP and must be treated as untrusted
 * JSON at runtime.
 */
export function parseDaemonComputerUsePreviewDescriptor(
  value: unknown,
  now: Date = new Date(),
): ResolvedComputerUsePreviewDescriptor {
  if (!isRecord(value)) {
    throw invalidDescriptorResponse();
  }

  const descriptorId = readNonEmptyString(value.descriptorId);
  const revision = readNonNegativeSafeInteger(value.revision);
  const platform = readPlatform(value.platform);
  const sourceKind = readDaemonSourceKind(value.sourceKind);
  const target = readTarget(value.target, platform, sourceKind);
  const authorization = readAuthorization(value.authorization, now);

  if (
    descriptorId === undefined ||
    revision === undefined ||
    platform === undefined ||
    sourceKind === undefined ||
    target === undefined ||
    authorization === undefined
  ) {
    throw invalidDescriptorResponse();
  }

  // Construct a fresh value field-by-field so unknown response fields and
  // object prototypes never cross into the adapter's trusted descriptor.
  return {
    descriptorId,
    revision,
    platform,
    sourceKind,
    target,
    authorization,
  };
}

function readPlatform(
  value: unknown,
): ResolvedComputerUsePreviewDescriptor["platform"] | undefined {
  return value === "macos" || value === "windows" ? value : undefined;
}

function readDaemonSourceKind(
  value: unknown,
): Exclude<ResolvedComputerUsePreviewDescriptor["sourceKind"], "fake"> | undefined {
  // `fake` is a local test-registry source. It is intentionally not part of
  // the daemon's private HTTP descriptor contract.
  return value === "window" || value === "display" ? value : undefined;
}

function readTarget(
  value: unknown,
  platform: ResolvedComputerUsePreviewDescriptor["platform"] | undefined,
  sourceKind: Exclude<ResolvedComputerUsePreviewDescriptor["sourceKind"], "fake"> | undefined,
): ResolvedComputerUsePreviewDescriptor["target"] | undefined {
  if (!isRecord(value) || platform === undefined || sourceKind === undefined) {
    return undefined;
  }
  const applicationId = readOptionalNonEmptyString(value, "applicationId");
  const processId = readOptionalPositiveSafeInteger(value, "processId");
  const nativeWindowId = readOptionalNonEmptyString(value, "nativeWindowId");
  const electronSourceId = readOptionalNonEmptyString(value, "electronSourceId");
  if (
    applicationId === INVALID_OPTIONAL ||
    processId === INVALID_OPTIONAL ||
    nativeWindowId === INVALID_OPTIONAL ||
    electronSourceId === INVALID_OPTIONAL
  ) {
    return undefined;
  }
  if (
    (sourceKind === "display" && electronSourceId === undefined) ||
    (sourceKind === "window" && nativeWindowId === undefined && electronSourceId === undefined) ||
    (
      platform === "windows" && sourceKind === "window" &&
      (
        processId === undefined ||
        nativeWindowId === undefined ||
        !isCanonicalWindowsHandle(nativeWindowId)
      )
    )
  ) {
    return undefined;
  }

  return {
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(processId === undefined ? {} : { processId }),
    ...(nativeWindowId === undefined ? {} : { nativeWindowId }),
    ...(electronSourceId === undefined ? {} : { electronSourceId }),
  };
}

function isCanonicalWindowsHandle(value: string): boolean {
  return /^[1-9]\d{0,19}$/u.test(value);
}

function readAuthorization(
  value: unknown,
  now: Date,
): ResolvedComputerUsePreviewDescriptor["authorization"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const grantId = readNonEmptyString(value.grantId);
  const expiresAt = readCanonicalIsoTimestamp(value.expiresAt);
  if (grantId === undefined || expiresAt === undefined || Date.parse(expiresAt) <= now.getTime()) {
    return undefined;
  }
  return { grantId, expiresAt };
}

const INVALID_OPTIONAL = Symbol("invalid_optional");

function readOptionalNonEmptyString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined | typeof INVALID_OPTIONAL {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  return readNonEmptyString(record[key]) ?? INVALID_OPTIONAL;
}

function readOptionalPositiveSafeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined | typeof INVALID_OPTIONAL {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : INVALID_OPTIONAL;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readCanonicalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidDescriptorResponse(): Error {
  return new Error("computer_use_descriptor_response_invalid");
}
