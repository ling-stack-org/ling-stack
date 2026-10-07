import { PiRunnerAdapter } from "@ling-stack/runner-pi";

/** Scripted test runners use the real SDK assembler, with explicitly synthetic model registration.
 * This registers no transport and never calls runTask; it does not repair production model config.
 */
class FixturePreparationRunner extends PiRunnerAdapter {
  registerCustomProviderIfNeeded(runtime, provider) {
    super.registerCustomProviderIfNeeded(runtime, { ...provider, baseUrl: provider.baseUrl ?? "https://fixture.invalid/v1" });
  }
}
export function prepareFixtureTaskInput(options) {
  return new FixturePreparationRunner().prepareTaskInput(options);
}
