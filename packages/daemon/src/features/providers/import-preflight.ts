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

export const PROVIDER_IMPORT_CHECK_CONCURRENCY = 3;
export const PROVIDER_IMPORT_CHECK_PENDING_CODE = "checking";

interface ProviderImportCheckJob {
  readonly cwd: string;
  readonly store: RunStore;
  readonly provider: ProviderPreset;
  readonly pendingCheck: ProviderCheckResult;
}

export class ProviderImportPreflightService {
  private readonly queuedJobs: ProviderImportCheckJob[] = [];
  private readonly abortController = new AbortController();
  private readonly idleWaiters = new Set<() => void>();
  private activeCount = 0;
  private closing = false;

  constructor(
    private readonly dependencies: {
      readonly secretResolver: SecretResolver;
      readonly controlPlaneEvents: ControlPlaneEventHub;
      readonly concurrency?: number;
    },
  ) {}

  enqueue(cwd: string, store: RunStore, provider: ProviderPreset): ProviderPreset {
    if (provider.api === "media-job" || this.closing) {
      return provider;
    }
    const pendingCheck: ProviderCheckResult = {
      ok: false,
      code: PROVIDER_IMPORT_CHECK_PENDING_CODE,
      message: "Provider check is running.",
      checkedAt: new Date().toISOString(),
    };
    const pendingProvider = store.recordProviderCheckResult(provider.id, pendingCheck) ?? provider;
    this.queuedJobs.push({ cwd, store, provider: pendingProvider, pendingCheck });
    this.pump();
    return pendingProvider;
  }

  async shutdown(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.queuedJobs.length = 0;
      this.abortController.abort();
    }
    await this.waitForIdle();
  }

  private pump(): void {
    const concurrency = Math.max(1, this.dependencies.concurrency ?? PROVIDER_IMPORT_CHECK_CONCURRENCY);
    while (!this.closing && this.activeCount < concurrency && this.queuedJobs.length > 0) {
      const job = this.queuedJobs.shift();
      if (!job) {
        break;
      }
      this.activeCount += 1;
      void this.run(job).finally(() => {
        this.activeCount -= 1;
        this.pump();
        this.resolveIdleWaiters();
      });
    }
  }

  private async run(job: ProviderImportCheckJob): Promise<void> {
    let result: ProviderCheckResult;
    try {
      result = await checkProviderPreset(
        job.store,
        job.provider,
        this.dependencies.secretResolver,
        { signal: this.abortController.signal },
      );
    } catch {
      result = {
        ok: false,
        code: "background_check_failed",
        message: "Provider background check failed unexpectedly.",
        checkedAt: new Date().toISOString(),
      };
    }
    if (this.closing || this.abortController.signal.aborted) {
      return;
    }
    const currentProvider = job.store.getProviderPreset(job.provider.id);
    if (!currentProvider || !isCurrentPendingImportCheck(job, currentProvider)) {
      return;
    }
    const checked = job.store.recordProviderCheckResult(job.provider.id, result);
    if (!checked) {
      return;
    }
    appendControlPlaneEvent(job.store, this.dependencies.controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd: job.cwd,
      domain: "providers",
      entityType: "provider",
      entityId: checked.id,
      action: "provider.preflight_checked",
      data: {
        providerId: checked.id,
        ok: result.ok,
        code: result.code ?? (result.ok ? "ok" : "failed"),
        checkedAt: result.checkedAt,
        source: "model_import",
      },
    });
  }

  private waitForIdle(): Promise<void> {
    if (this.activeCount === 0 && this.queuedJobs.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private resolveIdleWaiters(): void {
    if (this.activeCount !== 0 || this.queuedJobs.length !== 0) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}

function isCurrentPendingImportCheck(job: ProviderImportCheckJob, current: ProviderPreset): boolean {
  return (
    current.updatedAt === job.provider.updatedAt &&
    current.lastCheck?.code === PROVIDER_IMPORT_CHECK_PENDING_CODE &&
    current.lastCheck.checkedAt === job.pendingCheck.checkedAt
  );
}
