import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type {
  BundledCuaDriverDistributionLockV2,
  BundledCuaDriverPlatform,
  DarwinBundledCuaDriverLockV1,
  WindowsBundledCuaDriverLockV1,
} from "@ling-stack/contracts";
import {
  CuaDriverProviderLockContractError,
  validateCuaDriverProviderLockContract,
} from "../../shared/cua-driver-provider-lock-contract.mjs";

/** Maximum size accepted for a provider lock. A lock is metadata, never a payload. */
export const CUA_DRIVER_PROVIDER_LOCK_MAX_BYTES = 256 * 1024;

export type CuaDriverLockPlatform = Exclude<BundledCuaDriverPlatform, "unsupported">;

export class CuaDriverArtifactLockError extends Error {
  readonly code = "cua_driver_artifact_lock_invalid" as const;

  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "CuaDriverArtifactLockError";
  }
}

export interface CuaDriverProviderLockValidationOptions {
  readonly platform: CuaDriverLockPlatform;
  readonly architecture?: "arm64" | "x86_64";
  /** Development fixtures may omit release-only evidence; packaged gates do not. */
  readonly requireReleaseEvidence?: boolean;
}

export interface CuaDriverProviderLockReadOptions extends CuaDriverProviderLockValidationOptions {
  readonly maxBytes?: number;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Utf8(canonicalJson(value));
}

/**
 * Read the lock as untrusted package input. JSON parsing is deliberately bounded
 * before validation so a corrupt package cannot consume unbounded memory.
 */
export async function readCuaDriverProviderLock(
  filePath: string,
  options: CuaDriverProviderLockReadOptions,
): Promise<BundledCuaDriverDistributionLockV2> {
  const maxBytes = options.maxBytes ?? CUA_DRIVER_PROVIDER_LOCK_MAX_BYTES;
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new CuaDriverArtifactLockError("provider_lock_oversized", filePath);
  }
  const bytes = await readFile(filePath);
  if (bytes.byteLength > maxBytes) {
    throw new CuaDriverArtifactLockError("provider_lock_oversized", filePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new CuaDriverArtifactLockError("provider_lock_json_invalid", filePath);
  }
  try {
    return validateCuaDriverProviderLock(parsed, options);
  } catch (error) {
    if (error instanceof CuaDriverArtifactLockError) {
      throw new CuaDriverArtifactLockError(error.message, filePath);
    }
    throw error;
  }
}

/** Validate the cross-platform lock without trusting candidate-manifest metadata. */
export function validateCuaDriverProviderLock(
  value: unknown,
  options: CuaDriverProviderLockValidationOptions,
): BundledCuaDriverDistributionLockV2 {
  try {
    return validateCuaDriverProviderLockContract(value, options);
  } catch (error) {
    if (error instanceof CuaDriverProviderLockContractError) {
      throw new CuaDriverArtifactLockError(error.code);
    }
    throw error;
  }
}

export function platformLockFor(
  lock: BundledCuaDriverDistributionLockV2,
  platform: CuaDriverLockPlatform,
): DarwinBundledCuaDriverLockV1 | WindowsBundledCuaDriverLockV1 {
  const record = platform === "darwin" ? lock.platforms.darwin : lock.platforms.win32X64;
  if (!record) {
    throw new CuaDriverArtifactLockError("provider_lock_platform_record_missing");
  }
  return record;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
