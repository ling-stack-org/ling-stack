export const HARNESS_LIFECYCLE_DOMAINS = ["continuation", "tool_execution", "evaluation", "delegation"] as const;
export type HarnessLifecycleDomain = typeof HARNESS_LIFECYCLE_DOMAINS[number];

export interface HarnessLifecyclePort {
  readonly domain: HarnessLifecycleDomain;
  /** A disabled producer is reported as disabled, never represented as a verified implementation. */
  readonly enabled: boolean;
  readonly stopAdmission: () => void | Promise<void>;
  readonly abortOwned: () => void | Promise<void>;
  /** Must resolve only after the actual underlying operations settle, not a timeout race. */
  readonly settle: () => Promise<void>;
}

export interface HarnessShutdownReceipt {
  readonly status: "closed" | "draining_timeout" | "failed";
  readonly disabledDomains: readonly HarnessLifecycleDomain[];
  readonly failureStages: readonly string[];
}

/** Four-domain barrier. No Store or runtime lease may close while an owned operation can still write. */
export class HarnessLifecycleCoordinator {
  private readonly ports = new Map<HarnessLifecycleDomain, HarnessLifecyclePort>();
  private work?: Promise<HarnessShutdownReceipt>;
  private readonly failureCauses: { readonly stage: string; readonly error: unknown }[] = [];
  private phase: "accepting" | "stopping_admission" | "aborting" | "draining" | "closed" | "failed" = "accepting";

  constructor(private readonly options: {
    readonly stopExternalAdmission: () => void | Promise<void>;
    readonly closeResources: () => void | Promise<void>;
  }) {}

  register(port: HarnessLifecyclePort): void {
    if (this.phase !== "accepting") throw new Error("harness_lifecycle_registration_closed");
    if (!HARNESS_LIFECYCLE_DOMAINS.includes(port.domain) || this.ports.has(port.domain)) {
      throw new TypeError("harness_lifecycle_domain_invalid_or_duplicate");
    }
    this.ports.set(port.domain, port);
  }

  getPhase(): typeof this.phase { return this.phase; }

  /** Host diagnostics may inspect causes; the redacted receipt exposes stage names only. */
  getFailureCauses(): readonly { readonly stage: string; readonly error: unknown }[] { return [...this.failureCauses]; }

  shutdown(options: { readonly timeoutMs?: number } = {}): Promise<HarnessShutdownReceipt> {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      return Promise.reject(new TypeError("harness_lifecycle_timeout_invalid"));
    }
    if (!this.work) {
      if (HARNESS_LIFECYCLE_DOMAINS.some(domain => !this.ports.has(domain))) {
        return Promise.reject(new Error("harness_lifecycle_domain_missing"));
      }
      this.phase = "stopping_admission";
      this.work = this.drain();
    }
    if (options.timeoutMs === undefined) return this.work;
    const work = this.work;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({
        status: "draining_timeout", disabledDomains: this.disabledDomains(), failureStages: [],
      }), options.timeoutMs);
      // No cancellation of work: the timed-out caller cannot authorize closing resources early.
      void work.then(result => { clearTimeout(timer); resolve(result); });
    });
  }

  private async drain(): Promise<HarnessShutdownReceipt> {
    const failures: string[] = [];
    await Promise.all([
      this.attempt("external_admission", this.options.stopExternalAdmission, failures),
      this.all("stop_admission", port => port.stopAdmission(), failures),
    ]);
    this.phase = "aborting";
    await this.all("abort_owned", port => port.abortOwned(), failures);
    this.phase = "draining";
    await this.all("settle", port => port.settle(), failures);
    if (!failures.length) await this.attempt("close_resources", this.options.closeResources, failures);
    this.phase = failures.length ? "failed" : "closed";
    return { status: failures.length ? "failed" : "closed", disabledDomains: this.disabledDomains(), failureStages: failures };
  }

  private async all(stage: string, action: (port: HarnessLifecyclePort) => void | Promise<void>, failures: string[]): Promise<void> {
    await Promise.all([...this.ports.values()].map(port => this.attempt(`${port.domain}:${stage}`, () => action(port), failures)));
  }

  private async attempt(stage: string, action: () => void | Promise<void>, failures: string[]): Promise<void> {
    try { await action(); } catch (error) {
      failures.push(stage);
      this.failureCauses.push({ stage, error });
    }
  }

  private disabledDomains(): readonly HarnessLifecycleDomain[] {
    return HARNESS_LIFECYCLE_DOMAINS.filter(domain => this.ports.get(domain)?.enabled === false);
  }
}
