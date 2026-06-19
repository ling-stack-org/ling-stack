import {
  DEFAULT_WORKSPACE_ID,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderStoreFacet,
  type RunExecutionStoreFacet,
  type SecretResolver,
} from "@ling-stack/core";
import type { StartupStateRegistry } from "../../startup/state.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import { checkProviderPreset } from "./preflight.js";
import { providerSecretStatus } from "./secrets.js";

const STARTUP_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type ProviderStartupRefreshStore = ProviderStoreFacet & RunExecutionStoreFacet;

export class ProviderStartupRefreshService {
  private readonly refreshesByCwd = new Map<string, Promise<readonly ProviderCheckResult[]>>();

  constructor(
    private readonly dependencies: {
      readonly secretResolver: SecretResolver;
      readonly controlPlaneEvents: ControlPlaneEventHub;
      readonly startupState?: StartupStateRegistry;
    },
  ) {}

  start(cwd: string, store: ProviderStartupRefreshStore, options: { readonly force?: boolean } = {}): Promise<readonly ProviderCheckResult[]> {
    const existing = this.refreshesByCwd.get(cwd);
    if (existing && !options.force) {
      this.markWarming(cwd);
      void existing.then((results) => this.markFinished(cwd, results));
      return existing;
    }
    this.markWarming(cwd);
    const refresh = refreshProvidersOnStartup({
      cwd,
      store,
      secretResolver: this.dependencies.secretResolver,
      controlPlaneEvents: this.dependencies.controlPlaneEvents,
    })
      .then((results) => {
        this.markFinished(cwd, results);
        return results;
      })
      .catch((error) => {
        // Startup refresh is best-effort. Individual provider failures are recorded as
        // check results; unexpected service errors must not block daemon startup.
        this.markUnexpectedError(cwd, error);
        return [];
      });
    this.refreshesByCwd.set(cwd, refresh);
    return refresh;
  }

  async refreshBeforeRun(input: {
    readonly cwd: string;
    readonly store: ProviderStartupRefreshStore;
    readonly providerPresetId?: string;
  }): Promise<void> {
    if (!input.providerPresetId) {
      return;
    }
    const provider = input.store.getProviderPreset(input.providerPresetId);
    if (!provider || !shouldRefreshProviderOnStartup(input.store, provider, this.dependencies.secretResolver)) {
      return;
    }
    await this.start(input.cwd, input.store, { force: true });
  }

  private markWarming(cwd: string): void {
    this.dependencies.startupState?.setPhase(cwd, "provider_warmup", "warming");
  }

  private markFinished(cwd: string, results: readonly ProviderCheckResult[]): void {
    const failures = results.filter((result) => !result.ok);
    if (failures.length === 0) {
      this.dependencies.startupState?.setPhase(cwd, "provider_warmup", "ready");
      return;
    }
    this.dependencies.startupState?.setPhase(cwd, "provider_warmup", "degraded");
    this.dependencies.startupState?.addDiagnostic(cwd, {
      level: "warning",
      code: "provider_startup_check_failed",
      phase: "provider_warmup",
      message: `${failures.length} provider startup check(s) failed.`,
      nextAction: "Open Model Workbench and run Check on failed providers.",
    });
  }

  private markUnexpectedError(cwd: string, error: unknown): void {
    this.dependencies.startupState?.setPhase(cwd, "provider_warmup", "degraded");
    this.dependencies.startupState?.addDiagnostic(cwd, {
      level: "warning",
      code: "provider_startup_refresh_failed",
      phase: "provider_warmup",
      message: error instanceof Error ? error.message : String(error),
      nextAction: "Open Model Workbench and run Check manually.",
    });
  }
}

export async function refreshProvidersOnStartup(input: {
  readonly cwd: string;
  readonly store: ProviderStartupRefreshStore;
  readonly secretResolver: SecretResolver;
  readonly controlPlaneEvents: ControlPlaneEventHub;
}): Promise<readonly ProviderCheckResult[]> {
  const candidates = input.store
    .listProviderPresets()
    .filter((provider) => shouldRefreshProviderOnStartup(input.store, provider, input.secretResolver));
  const results: ProviderCheckResult[] = [];
  for (const provider of candidates) {
    const result = withStartupRefreshMessage(await checkProviderPreset(input.store, provider, input.secretResolver));
    input.store.recordProviderCheckResult(provider.id, result);
    appendControlPlaneEvent(input.store, input.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd: input.cwd,
      domain: "providers",
      entityType: "provider",
      entityId: provider.id,
      action: "provider.preflight_checked",
      data: {
        providerId: provider.id,
        ok: result.ok,
        code: result.code ?? (result.ok ? "ok" : "failed"),
        checkedAt: result.checkedAt,
        source: "startup",
      },
    });
    results.push(result);
  }
  return results;
}

function withStartupRefreshMessage(result: ProviderCheckResult): ProviderCheckResult {
  if (result.ok) {
    return {
      ...result,
      message: "Provider was automatically rechecked after daemon restart.",
    };
  }
  return {
    ...result,
    message: "Provider automatic startup check failed. Run Check again from Model Workbench if needed.",
  };
}

export function shouldRefreshProviderOnStartup(
  store: ProviderStoreFacet,
  provider: ProviderPreset,
  secretResolver: SecretResolver,
  nowMs = Date.now(),
): boolean {
  if (!provider.enabled || provider.api === "media-job" || !provider.capabilities.includes("chat")) {
    return false;
  }
  if (!providerSecretCanBeChecked(store, provider, secretResolver)) {
    return false;
  }
  if (!provider.lastCheck) {
    return true;
  }
  if (!provider.lastCheck.ok) {
    return true;
  }
  const checkedAtMs = Date.parse(provider.lastCheck.checkedAt);
  return !Number.isFinite(checkedAtMs) || nowMs - checkedAtMs > STARTUP_CHECK_MAX_AGE_MS;
}

function providerSecretCanBeChecked(store: ProviderStoreFacet, provider: ProviderPreset, secretResolver: SecretResolver): boolean {
  const needsSecret = provider.api === "anthropic-messages" || provider.authHeader !== false;
  if (provider.apiKeyRef) {
    return providerSecretStatus(store, provider, secretResolver).configured === true;
  }
  return !needsSecret;
}
