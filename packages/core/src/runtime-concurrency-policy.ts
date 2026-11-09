export interface RuntimeConcurrencyLimits {
  readonly maxConcurrentRuns: number;
  readonly maxReadOnlyRuns: number;
  readonly maxWorkspaceWriteRuns: number;
  readonly maxRunsPerProvider: number;
  readonly maxRunsPerRunner: number;
}

export interface RuntimeConcurrencyPolicy {
  readonly workspaceId: string;
  readonly runtimeInstanceId: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly limits: RuntimeConcurrencyLimits;
  readonly installedAt: string;
}

export interface InstallRuntimeConcurrencyPolicyInput {
  readonly workspaceId: string;
  readonly runtimeInstanceId: string;
  readonly expectedRevision: number;
  /** Omitted only by legacy Core callers; the trusted Host supplies its activation state. */
  readonly enabled?: boolean;
  readonly limits: RuntimeConcurrencyLimits;
  readonly installedAt: string;
}

export type InstallRuntimeConcurrencyPolicyResult =
  | { readonly status: "installed" | "duplicate"; readonly policy: RuntimeConcurrencyPolicy }
  | { readonly status: "changed" };

const limitNames = [
  "maxConcurrentRuns", "maxReadOnlyRuns", "maxWorkspaceWriteRuns", "maxRunsPerProvider", "maxRunsPerRunner",
] as const;

/** Captures exactly five own, enumerable data properties without invoking accessors. */
export function validateRuntimeConcurrencyLimits(input: unknown): RuntimeConcurrencyLimits {
  if (input === null || typeof input !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new TypeError("Runtime concurrency limits must be a plain object.");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== limitNames.length
    || keys.some(key => typeof key !== "string" || !limitNames.includes(key as typeof limitNames[number]))) {
    throw new TypeError("Runtime concurrency limits must contain exactly the five limit fields.");
  }
  const limits = {} as Record<typeof limitNames[number], number>;
  for (const key of limitNames) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "number") {
      throw new TypeError(`Runtime concurrency limit ${key} must be an own numeric data property.`);
    }
    const maximum = key === "maxWorkspaceWriteRuns" ? 4 : 64;
    if (!Number.isSafeInteger(descriptor.value) || descriptor.value < 1 || descriptor.value > maximum) {
      throw new RangeError(`Runtime concurrency limit ${key} must be a safe integer from 1 to ${maximum}.`);
    }
    limits[key] = descriptor.value;
  }
  return Object.freeze(limits);
}
