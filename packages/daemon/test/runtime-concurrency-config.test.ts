import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../dist/config.js";
import { resolveRuntimeConcurrencyPolicy, type ResolvedRuntimeConcurrencyPolicy,
  type RuntimeConcurrencyFeatureConfig } from "../dist/runtime/concurrency-policy.js";

const defaults = {
  enabled: false,
  maxConcurrentRuns: 4,
  maxReadOnlyRuns: 4,
  maxWorkspaceWriteRuns: 2,
  maxRunsPerProvider: 4,
  maxRunsPerRunner: 4,
  isolatedWriteMaxConcurrentSteps: 2,
};
const bounds: readonly [Exclude<keyof ResolvedRuntimeConcurrencyPolicy, "enabled">, number, number][] = [
  ["maxConcurrentRuns", 1, 64],
  ["maxReadOnlyRuns", 1, 64],
  ["maxWorkspaceWriteRuns", 1, 4],
  ["maxRunsPerProvider", 1, 64],
  ["maxRunsPerRunner", 1, 64],
  ["isolatedWriteMaxConcurrentSteps", 2, 4],
];
// Host-boundary cases deliberately include values outside the startup config type.
const resolvers: readonly [string, (input: unknown) => ResolvedRuntimeConcurrencyPolicy][] = [
  ["policy", input => resolveRuntimeConcurrencyPolicy(input as RuntimeConcurrencyFeatureConfig | undefined)],
  ["daemon", input => resolveConfig({ concurrency: input as RuntimeConcurrencyFeatureConfig | undefined }).concurrency],
];

test("missing Host concurrency configuration resolves to frozen limits with enforcement disabled", () => {
  assert.deepEqual(resolveConfig({}).concurrency, defaults);
  for (const [, resolve] of resolvers) {
    for (const input of [undefined, {}]) {
      const policy = resolve(input);
      assert.deepEqual(policy, defaults);
      assert.ok(Object.isFrozen(policy));
      assert.equal(policy.enabled, false);
      assert.ok(bounds.every(([field]) => typeof policy[field] === "number"));
    }
  }
});

for (const [field, minimum, maximum] of bounds) {
  test(`${field} accepts both inclusive bounds without changing other defaults`, () => {
    for (const [name, resolve] of resolvers) {
      for (const value of [minimum, maximum]) {
        const policy = resolve({ [field]: value });
        assert.deepEqual(policy, { ...defaults, [field]: value }, name);
        assert.ok(Object.isFrozen(policy));
      }
    }
  });

  test(`${field} rejects explicit invalid values instead of coercing, defaulting or clamping`, () => {
    for (const [name, resolve] of resolvers) {
      for (const value of [undefined, null, NaN, Infinity, -Infinity, 0, -1, minimum - 1,
        maximum + 1, 2.5, Number.MAX_SAFE_INTEGER + 1, "2", "", true, false, {}, [], 2n]) {
        assert.throws(() => resolve({ [field]: value }),
          { name: "RangeError", message: `concurrency.${field} must be an integer from ${minimum} to ${maximum}` },
          `${name}: ${field}=${String(value)}`);
      }
    }
  });
}

test("classification, provider and runner limits remain independent of the total limit", () => {
  const input = { maxConcurrentRuns: 1, maxReadOnlyRuns: 64, maxWorkspaceWriteRuns: 4,
    maxRunsPerProvider: 64, maxRunsPerRunner: 64, isolatedWriteMaxConcurrentSteps: 4 };
  for (const [, resolve] of resolvers) assert.deepEqual(resolve(input), { ...defaults, ...input });
  assert.deepEqual(resolveConfig({ concurrency: { maxConcurrentRuns: 64 } }).concurrency,
    { ...defaults, maxConcurrentRuns: 64 });
});

test("startup policy is copied and frozen without freezing or retaining the Host input", () => {
  for (const [, resolve] of resolvers) {
    const input = { enabled: true, maxConcurrentRuns: 8, maxReadOnlyRuns: 6, maxWorkspaceWriteRuns: 3,
      maxRunsPerProvider: 5, maxRunsPerRunner: 7, isolatedWriteMaxConcurrentSteps: 3 };
    const expected = { ...input }, policy = resolve(input);
    assert.notStrictEqual(policy, input);
    assert.equal(Object.isFrozen(input), false);
    for (const field of Object.keys(input)) (input as Record<string, boolean | number>)[field] = 1;
    assert.deepEqual(policy, expected);
    assert.throws(() => {
      // @ts-expect-error Frozen policy mutation must also fail at runtime.
      (policy as ResolvedRuntimeConcurrencyPolicy).maxConcurrentRuns = 1;
    }, TypeError);
    assert.throws(() => {
      // @ts-expect-error Frozen policy rejects properties outside its declared shape.
      policy.extra = 1;
    }, TypeError);
    assert.notStrictEqual(resolve(undefined), resolve(undefined));
    assert.deepEqual(resolve({}), defaults);
  }
});

test("enforcement requires an explicit boolean and does not follow numeric configuration", () => {
  for (const [, resolve] of resolvers) {
    assert.deepEqual(resolve({ enabled: true }), { ...defaults, enabled: true });
    assert.deepEqual(resolve({ enabled: false, maxConcurrentRuns: 1 }), { ...defaults, maxConcurrentRuns: 1 });
    assert.equal(resolve({ maxConcurrentRuns: 1 }).enabled, false);
    for (const enabled of [undefined, null, 0, 1, "true", "false", [], {}, new Boolean(true)]) {
      assert.throws(() => resolve({ enabled }), { name: "TypeError", message: "concurrency.enabled must be a boolean" });
    }
  }
});

test("known fields reject hidden values and accessors without invoking Host getters", () => {
  for (const [, resolve] of resolvers) {
    for (const key of ["enabled", "maxConcurrentRuns"]) {
      let invoked = false;
      for (const descriptor of [{ value: key === "enabled" ? true : 1 },
        { enumerable: true, get() { invoked = true; return key === "enabled" ? true : 1; } }]) {
        assert.throws(() => resolve(Object.defineProperty({}, key, descriptor)), {
          name: "TypeError", message: `concurrency.${key} must be an own enumerable data property`,
        });
      }
      assert.equal(invoked, false);
    }
  }
});

test("unknown fields, including hidden and symbol keys, fail closed", () => {
  for (const [, resolve] of resolvers) {
    for (const input of [{ maxConcurrentRun: 4 }, { fullAccess: true }, { unknown: undefined },
      { maxConcurrentRuns: 8, limits: { maxReadOnlyRuns: 4 } },
      JSON.parse('{"__proto__": {"maxConcurrentRuns": 8}}'), { constructor: 1 },
      Object.defineProperty({}, "hidden", { value: 1 }), { [Symbol("extra")]: 1 }]) {
      assert.throws(() => resolve(input), /concurrency\..+ is not a supported setting/u);
    }
  }
});

test("malformed concurrency containers cannot silently enable defaults or inherit limits", () => {
  for (const [, resolve] of resolvers) {
    for (const input of [null, false, true, 0, 4, NaN, Infinity, "4", [], [4], new Date(), new Map(),
      () => ({}), Object.create({ maxConcurrentRuns: 64 })]) {
      assert.throws(() => resolve(input), { name: "TypeError", message: "concurrency must be a plain object" });
    }
    const input = Object.assign(Object.create(null), { maxConcurrentRuns: 8 });
    assert.deepEqual(resolve(input), { ...defaults, maxConcurrentRuns: 8 });
    assert.deepEqual(resolve(Object.freeze({ maxReadOnlyRuns: 8 })), { ...defaults, maxReadOnlyRuns: 8 });
  }
});

test("Host concurrency limits do not change sandbox, tool or isolated-write authorization", () => {
  const initial = resolveConfig({});
  const configured = resolveConfig({ concurrency: {
    maxConcurrentRuns: 64, maxReadOnlyRuns: 64, maxWorkspaceWriteRuns: 4,
    maxRunsPerProvider: 64, maxRunsPerRunner: 64, isolatedWriteMaxConcurrentSteps: 4,
  } });
  assert.deepEqual({ ...configured, concurrency: initial.concurrency }, initial);
});
