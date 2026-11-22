import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRunnerAdapter } from "../../dist/adapter.js";
import type { PiRunnerProviderConfig } from "../../dist/types.js";

type RunnerWithProviderRegistration = Pick<PiRunnerAdapter, keyof PiRunnerAdapter> & {
  registerCustomProviderIfNeeded(runtime: ModelRuntime, provider: PiRunnerProviderConfig): void;
};

// The fixture replaces provider transport after the normal registration method runs.
export const FixtureRunnerBase = PiRunnerAdapter as unknown as new () => RunnerWithProviderRegistration;
