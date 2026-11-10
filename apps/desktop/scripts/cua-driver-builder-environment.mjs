let builderEnvironmentBusy = false;

/**
 * Scope the already-derived Cua/build environment to one in-process Builder run.
 *
 * This helper manages process state only: it does not validate the environment or
 * grant package authority. Its production caller must be the fixed wrapper after
 * the existing Cua CLI validation. Office provenance must remain in its private
 * closure, never in this environment or JSON.
 *
 * Only supplied own enumerable keys whose values differ are changed. Undefined
 * deletes a key; omitted keys are untouched. Changed keys are restored after the
 * complete awaited operation, including keys that were originally absent. The
 * private guard rejects overlapping calls, including reentry from input getters.
 * It cannot coordinate unrelated code that writes process.env directly.
 *
 * @template T
 * @param {Record<string, string | undefined>} environment Validated derived env.
 * @param {() => T | PromiseLike<T>} operation Entire config/build/hook operation.
 * @returns {Promise<T>} The operation's result.
 */
export async function withCuaDriverBuilderEnvironment(environment, operation) {
  if (builderEnvironmentBusy) {
    throw new Error("cua_driver_builder_environment_busy");
  }
  // Install the latch before inspecting input or invoking any caller code.
  builderEnvironmentBusy = true;
  const changedKeys = [];
  try {
    for (const [key, value] of Object.entries(environment)) {
      const existed = Object.hasOwn(process.env, key);
      const previousValue = process.env[key];
      if (value === previousValue && (value !== undefined || !existed)) continue;
      changedKeys.push({ key, existed, previousValue });
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await operation();
  } finally {
    try {
      for (const { key, existed, previousValue } of changedKeys.reverse()) {
        if (existed) process.env[key] = previousValue;
        else delete process.env[key];
      }
    } finally {
      builderEnvironmentBusy = false;
    }
  }
}
