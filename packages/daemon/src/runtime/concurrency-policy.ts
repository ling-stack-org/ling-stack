export interface RuntimeConcurrencyFeatureConfig {
  readonly enabled?: boolean;
  readonly maxConcurrentRuns?: number;
  readonly maxReadOnlyRuns?: number;
  readonly maxWorkspaceWriteRuns?: number;
  readonly maxRunsPerProvider?: number;
  readonly maxRunsPerRunner?: number;
  readonly isolatedWriteMaxConcurrentSteps?: number;
}

export interface ResolvedRuntimeConcurrencyPolicy {
  readonly enabled: boolean;
  readonly maxConcurrentRuns: number;
  readonly maxReadOnlyRuns: number;
  readonly maxWorkspaceWriteRuns: number;
  readonly maxRunsPerProvider: number;
  readonly maxRunsPerRunner: number;
  readonly isolatedWriteMaxConcurrentSteps: number;
}

const defaultPolicy: ResolvedRuntimeConcurrencyPolicy = Object.freeze({
  enabled: false,
  maxConcurrentRuns: 4,
  maxReadOnlyRuns: 4,
  maxWorkspaceWriteRuns: 2,
  maxRunsPerProvider: 4,
  maxRunsPerRunner: 4,
  isolatedWriteMaxConcurrentSteps: 2,
});

/** Capture independent admission limits; these values do not grant write authority. */
export function resolveRuntimeConcurrencyPolicy(
  input: RuntimeConcurrencyFeatureConfig | undefined,
): ResolvedRuntimeConcurrencyPolicy {
  const policy = { ...defaultPolicy };
  if (input === undefined) return Object.freeze(policy);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("concurrency must be a plain object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("concurrency must be a plain object");
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !Object.hasOwn(defaultPolicy, key)) {
      throw new TypeError(`concurrency.${String(key)} is not a supported setting`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`concurrency.${key} must be an own enumerable data property`);
    }
    const value: unknown = descriptor.value;
    if (key === "enabled") {
      if (typeof value !== "boolean") throw new TypeError("concurrency.enabled must be a boolean");
      policy.enabled = value;
      continue;
    }
    const field = key as Exclude<keyof ResolvedRuntimeConcurrencyPolicy, "enabled">;
    const minimum = field === "isolatedWriteMaxConcurrentSteps" ? 2 : 1;
    const maximum = field === "maxWorkspaceWriteRuns" || field === "isolatedWriteMaxConcurrentSteps" ? 4 : 64;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`concurrency.${field} must be an integer from ${minimum} to ${maximum}`);
    }
    policy[field] = value;
  }
  return Object.freeze(policy);
}
