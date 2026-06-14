import type { RunStore } from "@ling-stack/core";
import type { AutomationSchedulerRegistry } from "../features/automations/scheduler.js";
import type { ProviderStartupRefreshService } from "../features/providers/startup-refresh.js";
import { listBundledPackageDescriptors } from "../features/plugins/source-index.js";
import type { StartupStateRegistry } from "./state.js";

export interface StartupOptionalWarmupCoordinatorOptions {
  readonly startupState: StartupStateRegistry;
  readonly providerStartupRefresh: ProviderStartupRefreshService;
  readonly automationSchedulers: AutomationSchedulerRegistry;
}

export class StartupOptionalWarmupCoordinator {
  constructor(private readonly options: StartupOptionalWarmupCoordinatorOptions) {}

  start(cwd: string, store: RunStore, startOptions: { readonly forceProviderRefresh?: boolean } = {}): void {
    void this.options.providerStartupRefresh.start(cwd, store, { force: startOptions.forceProviderRefresh });
    try {
      this.options.automationSchedulers.start(cwd);
    } catch {
      // The scheduler records its own degraded startup diagnostic.
    }
    this.markExternalWorkSchedulerReady(cwd);
    this.warmPlugins(cwd);
  }

  private markExternalWorkSchedulerReady(cwd: string): void {
    this.options.startupState.setPhase(cwd, "external_work_scheduler", "ready");
  }

  private warmPlugins(cwd: string): void {
    this.options.startupState.setPhase(cwd, "plugin_warmup", "warming");
    try {
      listBundledPackageDescriptors();
      this.options.startupState.setPhase(cwd, "plugin_warmup", "ready");
    } catch (error) {
      this.options.startupState.setPhase(cwd, "plugin_warmup", "degraded");
      this.options.startupState.addDiagnostic(cwd, {
        level: "warning",
        code: "plugin_warmup_failed",
        phase: "plugin_warmup",
        message: error instanceof Error ? error.message : String(error),
        nextAction: "Open Plugin settings or run plugin diagnostics.",
      });
    }
  }
}
