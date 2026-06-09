import {
  DEFAULT_WORKSPACE_ID,
  type ProviderCheckResult,
  type ProviderPreset,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import { checkProviderPreset } from "./preflight.js";
import { providerSecretStatus } from "./secrets.js";

const STARTUP_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class ProviderStartupRefreshService {
  private readonly refreshesByCwd = new Map<string, Promise<void>>();

  constructor(
    private readonly dependencies: {
      readonly secretResolver: SecretResolver;
      readonly controlPlaneEvents: ControlPlaneEventHub;
    },
  ) {}

  start(cwd: string, store: RunStore): Promise<void> {
    const existing = this.refreshesByCwd.get(cwd);
    if (existing) {
      return existing;
    }
    const refresh = refreshProvidersOnStartup({
      cwd,
      store,
      secretResolver: this.dependencies.secretResolver,
      controlPlaneEvents: this.dependencies.controlPlaneEvents,
    })
      .then(() => undefined)
      .catch(() => {
        // Startup refresh is best-effort. Individual provider failures are recorded as
        // check results; unexpected service errors must not block daemon startup.
      });
    this.refreshesByCwd.set(cwd, refresh);
    return refresh;
  }

  async refreshBeforeRun(input: {
    readonly cwd: string;
    readonly store: RunStore;
    readonly providerPresetId?: string;
  }): Promise<void> {
    if (!input.providerPresetId) {
      return;
    }
    const provider = input.store.getProviderPreset(input.providerPresetId);
    if (!provider || !shouldRefreshProviderOnStartup(input.store, provider, this.dependencies.secretResolver)) {
      return;
    }
    await this.start(input.cwd, input.store);
  }
}

export async function refreshProvidersOnStartup(input: {
  readonly cwd: string;
  readonly store: RunStore;
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
  store: RunStore,
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

function providerSecretCanBeChecked(store: RunStore, provider: ProviderPreset, secretResolver: SecretResolver): boolean {
  const needsSecret = provider.api === "anthropic-messages" || provider.authHeader !== false;
  if (provider.apiKeyRef) {
    return providerSecretStatus(store, provider, secretResolver).configured === true;
  }
  return !needsSecret;
}
