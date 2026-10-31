import {
  type ProviderCheckPublicationStore,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderStoreFacet,
  type RunExecutionStoreFacet,
  type SecretResolver,
} from "@ling-stack/core";
import type { StartupStateRegistry } from "../../startup/state.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { publishProviderCheckResult } from "./check-publication.js";
import { checkProviderPreset } from "./preflight.js";
import { providerSecretStatus } from "./secrets.js";

const STARTUP_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ProviderStartupRefreshStore = ProviderStoreFacet & RunExecutionStoreFacet & ProviderCheckPublicationStore;

export class ProviderStartupRefreshService {
  private readonly refreshesByCwd = new Map<string, Promise<readonly ProviderCheckResult[]>>();
  private readonly refreshGenerationsByCwd = new Map<string, number>();
  private readonly inFlight = new Set<Promise<readonly ProviderCheckResult[]>>();
  private stopped = false;

  constructor(
    private readonly dependencies: {
      readonly secretResolver: SecretResolver;
      readonly controlPlaneEvents: ControlPlaneEventHub;
      readonly startupState?: StartupStateRegistry;
    },
  ) {}

  start(cwd: string, store: ProviderStartupRefreshStore, options: { readonly force?: boolean } = {}): Promise<readonly ProviderCheckResult[]> {
    if (this.stopped) return Promise.resolve([]);
    const existing = this.refreshesByCwd.get(cwd);
    if (existing && !options.force) {
      return existing;
    }
    const generation = (this.refreshGenerationsByCwd.get(cwd) ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("Provider startup refresh generation exhausted.");
    this.refreshGenerationsByCwd.set(cwd, generation);
    const isCurrent = (): boolean => !this.stopped && this.refreshGenerationsByCwd.get(cwd) === generation;
    this.markWarming(cwd);
    const refresh = refreshProvidersOnStartup({
      cwd,
      store,
      secretResolver: this.dependencies.secretResolver,
      controlPlaneEvents: this.dependencies.controlPlaneEvents,
      isCurrent,
    })
      .then((results) => {
        if (isCurrent()) this.markFinished(cwd, store);
        return results;
      })
      .catch(() => {
        // Startup refresh is best-effort. Individual provider failures are recorded as
        // check results; unexpected service errors must not block daemon startup.
        if (isCurrent()) this.markUnexpectedError(cwd);
        return [];
      }).finally(() => this.inFlight.delete(refresh));
    this.refreshesByCwd.set(cwd, refresh);
    this.inFlight.add(refresh);
    return refresh;
  }

  beginShutdown(): void { this.stopped = true; }

  async waitForIdle(): Promise<void> { while (this.inFlight.size) await Promise.allSettled([...this.inFlight]); }

  async refreshBeforeRun(input: {
    readonly cwd: string;
    readonly store: ProviderStartupRefreshStore;
    readonly providerPresetId?: string;
  }): Promise<void> {
    if (!input.providerPresetId) {
      return;
    }
    const provider = input.store.getProviderPreset(input.providerPresetId);
    if (!provider || !shouldRefreshProviderBeforeRun(input.store, provider, this.dependencies.secretResolver)) {
      return;
    }
    await this.start(input.cwd, input.store, { force: true });
  }

  private markWarming(cwd: string): void {
    this.dependencies.startupState?.setPhase(cwd, "provider_warmup", "warming");
  }

  private markFinished(cwd: string, store: ProviderStartupRefreshStore): void {
    // Publication receipts are historical facts. Readiness observes the current
    // configuration instead: a newer check may have replaced those receipts.
    // Missing/in-flight checks are unknown, not known terminal failures; this
    // warmup phase is not a claim that every provider has been verified healthy.
    const failures = store.listProviderPresets({ enabled: true }).filter((provider) =>
      provider.api !== "media-job" && provider.capabilities.includes("chat") &&
      provider.lastCheck?.ok === false && provider.lastCheck.code !== "checking",
    );
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

  private markUnexpectedError(cwd: string): void {
    this.dependencies.startupState?.setPhase(cwd, "provider_warmup", "degraded");
    this.dependencies.startupState?.addDiagnostic(cwd, {
      level: "warning",
      code: "provider_startup_refresh_failed",
      phase: "provider_warmup",
      message: "Provider startup refresh failed unexpectedly. Run Check again from Model Workbench.",
      nextAction: "Open Model Workbench and run Check manually.",
    });
  }
}

export async function refreshProvidersOnStartup(input: {
  readonly cwd: string;
  readonly store: ProviderStartupRefreshStore;
  readonly secretResolver: SecretResolver;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  /** A superseded workspace refresh must not admit its remaining candidates. */
  readonly isCurrent?: () => boolean;
}): Promise<readonly ProviderCheckResult[]> {
  const candidates = input.store
    .listProviderPresets()
    .filter((provider) => shouldRefreshProviderOnStartup(input.store, provider, input.secretResolver));
  const results: ProviderCheckResult[] = [];
  for (const provider of candidates) {
    if (input.isCurrent && !input.isCurrent()) break;
    const current = input.store.getProviderPreset(provider.id);
    if (!current || !shouldRefreshProviderOnStartup(input.store, current, input.secretResolver)) continue;
    const admission = input.store.beginProviderCheckRequest(provider.id, "startup");
    if (!admission) continue;
    const result = withStartupRefreshMessage(await checkProviderPreset(input.store, admission.provider, input.secretResolver));
    const publication = publishProviderCheckResult(input.store, input.controlPlaneEvents, admission.ticket, result, input.cwd);
    if (publication.status === "published" && publication.provider.lastCheck) results.push(publication.provider.lastCheck);
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

export function shouldRefreshProviderBeforeRun(
  store: ProviderStoreFacet,
  provider: ProviderPreset,
  secretResolver: SecretResolver,
): boolean {
  if (!provider.enabled || provider.api === "media-job" || !provider.capabilities.includes("chat")) {
    return false;
  }
  if (!providerSecretCanBeChecked(store, provider, secretResolver)) {
    return false;
  }
  return !provider.lastCheck || !provider.lastCheck.ok;
}

function providerSecretCanBeChecked(store: ProviderStoreFacet, provider: ProviderPreset, secretResolver: SecretResolver): boolean {
  const needsSecret = provider.api === "anthropic-messages" || provider.authHeader !== false;
  if (provider.apiKeyRef) {
    return providerSecretStatus(store, provider, secretResolver).configured === true;
  }
  return !needsSecret;
}
