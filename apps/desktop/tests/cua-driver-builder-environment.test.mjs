import assert from "node:assert/strict";
import test from "node:test";

import {
  withCuaDriverBuilderEnvironment,
} from "../scripts/cua-driver-builder-environment.mjs";

const keys = Object.freeze({
  existing: "LING_CUA_BUILDER_ENVIRONMENT_TEST_EXISTING",
  missing: "LING_CUA_BUILDER_ENVIRONMENT_TEST_MISSING",
  removed: "LING_CUA_BUILDER_ENVIRONMENT_TEST_REMOVED",
  absent: "LING_CUA_BUILDER_ENVIRONMENT_TEST_ABSENT",
  unchanged: "LING_CUA_BUILDER_ENVIRONMENT_TEST_UNCHANGED",
  omitted: "LING_CUA_BUILDER_ENVIRONMENT_TEST_OMITTED",
  inherited: "LING_CUA_BUILDER_ENVIRONMENT_TEST_INHERITED",
  hidden: "LING_CUA_BUILDER_ENVIRONMENT_TEST_HIDDEN",
});

function seedEnvironment(t, values) {
  const originals = Object.keys(values).map((key) => ({
    key,
    existed: Object.hasOwn(process.env, key),
    value: process.env[key],
  }));
  t.after(() => {
    for (const { key, existed, value } of originals) {
      if (existed) process.env[key] = value;
      else delete process.env[key];
    }
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("Builder environment scopes supplied values and restores presence and deletion", async (t) => {
  seedEnvironment(t, {
    [keys.existing]: "before",
    [keys.missing]: undefined,
    [keys.removed]: "remove-before",
    [keys.absent]: undefined,
  });
  const environment = Object.freeze({
    [keys.existing]: "during",
    [keys.missing]: "",
    [keys.removed]: undefined,
    [keys.absent]: undefined,
  });
  const result = { completed: true };
  assert.equal(await withCuaDriverBuilderEnvironment(environment, () => {
    assert.equal(process.env[keys.existing], "during");
    assert.equal(process.env[keys.missing], "");
    assert.equal(Object.hasOwn(process.env, keys.removed), false);
    assert.equal(Object.hasOwn(process.env, keys.absent), false);
    return result;
  }), result);
  assert.equal(process.env[keys.existing], "before");
  assert.equal(Object.hasOwn(process.env, keys.missing), false);
  assert.equal(process.env[keys.removed], "remove-before");
  assert.equal(Object.hasOwn(process.env, keys.absent), false);
});

test("Builder environment touches only changed own enumerable keys", async (t) => {
  seedEnvironment(t, {
    [keys.existing]: "before",
    [keys.unchanged]: "same",
    [keys.omitted]: "omitted-before",
    [keys.inherited]: "inherited-before",
    [keys.hidden]: "hidden-before",
  });
  const environment = Object.assign(Object.create({
    [keys.inherited]: "not-applied",
  }), {
    [keys.existing]: "during",
    [keys.unchanged]: "same",
  });
  Object.defineProperty(environment, keys.hidden, { value: "not-applied" });
  await withCuaDriverBuilderEnvironment(environment, () => {
    assert.equal(process.env[keys.inherited], "inherited-before");
    assert.equal(process.env[keys.hidden], "hidden-before");
    assert.equal(process.env[keys.omitted], "omitted-before");
    process.env[keys.existing] = "operation-changed";
    process.env[keys.unchanged] = "operation-owned";
    process.env[keys.omitted] = "operation-owned";
  });
  assert.equal(process.env[keys.existing], "before");
  assert.equal(process.env[keys.unchanged], "operation-owned");
  assert.equal(process.env[keys.omitted], "operation-owned");
  assert.equal(process.env[keys.inherited], "inherited-before");
  assert.equal(process.env[keys.hidden], "hidden-before");
});

test("Builder environment remains visible throughout the awaited operation", async (t) => {
  seedEnvironment(t, { [keys.existing]: "before" });
  let resume;
  const suspended = new Promise((resolve) => { resume = resolve; });
  let entered = false;
  const pending = withCuaDriverBuilderEnvironment({ [keys.existing]: "during" }, async () => {
    entered = true;
    assert.equal(process.env[keys.existing], "during");
    await suspended;
    assert.equal(process.env[keys.existing], "during");
    return "awaited-result";
  });
  let result;
  try {
    assert.equal(entered, true);
    assert.equal(process.env[keys.existing], "during");
    await Promise.resolve();
    assert.equal(process.env[keys.existing], "during");
  } finally {
    resume();
    result = await pending;
  }
  assert.equal(result, "awaited-result");
  assert.equal(process.env[keys.existing], "before");
});

test("Builder environment restores changed keys after a synchronous operation throw", async (t) => {
  seedEnvironment(t, { [keys.existing]: "before", [keys.missing]: undefined });
  const failure = new Error("fixture_sync_operation_failure");
  await assert.rejects(withCuaDriverBuilderEnvironment({
    [keys.existing]: "during",
    [keys.missing]: "temporary",
  }, () => { throw failure; }), (error) => error === failure);
  assert.equal(process.env[keys.existing], "before");
  assert.equal(Object.hasOwn(process.env, keys.missing), false);
  await withCuaDriverBuilderEnvironment({}, () => "guard-released");
});

test("Builder environment restores explicit deletion after asynchronous rejection", async (t) => {
  seedEnvironment(t, { [keys.existing]: "before", [keys.removed]: "remove-before" });
  const failure = new Error("fixture_async_operation_failure");
  await assert.rejects(withCuaDriverBuilderEnvironment({
    [keys.existing]: "during",
    [keys.removed]: undefined,
  }, async () => {
    await Promise.resolve();
    assert.equal(process.env[keys.existing], "during");
    assert.equal(Object.hasOwn(process.env, keys.removed), false);
    throw failure;
  }), (error) => error === failure);
  assert.equal(process.env[keys.existing], "before");
  assert.equal(process.env[keys.removed], "remove-before");
  await withCuaDriverBuilderEnvironment({}, () => "guard-released");
});

test("Builder environment rejects concurrent use before inspecting the second input", async (t) => {
  seedEnvironment(t, { [keys.existing]: "before" });
  let resume;
  const suspended = new Promise((resolve) => { resume = resolve; });
  const pending = withCuaDriverBuilderEnvironment({ [keys.existing]: "outer" }, async () => {
    await suspended;
    assert.equal(process.env[keys.existing], "outer");
  });
  let inspected = false;
  let invoked = false;
  const secondEnvironment = {
    get [keys.existing]() { inspected = true; return "second"; },
  };
  try {
    await assert.rejects(withCuaDriverBuilderEnvironment(secondEnvironment, () => {
      invoked = true;
    }), /cua_driver_builder_environment_busy/u);
    assert.equal(inspected, false);
    assert.equal(invoked, false);
    assert.equal(process.env[keys.existing], "outer");
  } finally {
    resume();
    await pending;
  }
  assert.equal(process.env[keys.existing], "before");
  await withCuaDriverBuilderEnvironment({}, () => "guard-released");
});

test("Builder environment rejects synchronous reentry from the operation", async (t) => {
  seedEnvironment(t, { [keys.existing]: "before" });
  let invoked = false;
  await withCuaDriverBuilderEnvironment({ [keys.existing]: "outer" }, async () => {
    const nested = withCuaDriverBuilderEnvironment({ [keys.existing]: "nested" }, () => {
      invoked = true;
    });
    await assert.rejects(nested, /cua_driver_builder_environment_busy/u);
    assert.equal(process.env[keys.existing], "outer");
  });
  assert.equal(invoked, false);
  assert.equal(process.env[keys.existing], "before");
});

test("Builder environment installs its guard before enumerating input getters", async (t) => {
  seedEnvironment(t, { [keys.existing]: "before" });
  let rejected;
  let invoked = false;
  const environment = {
    get [keys.existing]() {
      rejected = assert.rejects(withCuaDriverBuilderEnvironment({}, () => {
        invoked = true;
      }), /cua_driver_builder_environment_busy/u);
      return "outer";
    },
  };
  await withCuaDriverBuilderEnvironment(environment, () => {
    assert.equal(process.env[keys.existing], "outer");
  });
  await rejected;
  assert.equal(invoked, false);
  assert.equal(process.env[keys.existing], "before");
});

test("Builder environment releases its guard when input enumeration throws", async (t) => {
  seedEnvironment(t, { [keys.existing]: "before" });
  const failure = new Error("fixture_environment_getter_failure");
  let invoked = false;
  const environment = {
    get [keys.existing]() { throw failure; },
  };
  await assert.rejects(withCuaDriverBuilderEnvironment(environment, () => {
    invoked = true;
  }), (error) => error === failure);
  assert.equal(invoked, false);
  assert.equal(process.env[keys.existing], "before");
  await withCuaDriverBuilderEnvironment({ [keys.existing]: "next" }, () => {
    assert.equal(process.env[keys.existing], "next");
  });
  assert.equal(process.env[keys.existing], "before");
});
