import { randomUUID } from "node:crypto";
import type { ExecutionEngineLoginMethod, ExecutionEngineLoginOperation, ExecutionEngineProfile, ExternalExecutionEngineId } from "@ling-stack/contracts";
import { ExecutionEngineProfileError, type ExecutionEngineProfileStore, type LingStackUserConfigPaths, type SecretResolver } from "@ling-stack/core";
import { EngineAuthorityError, type EngineManagementAuthority, type EnginePrincipal } from "./authority.js";
import { EngineProbeBusyError } from "./installation-probe.js";
import { assertNativeLoginSupported, EngineLoginError, runEngineLogin } from "./native-login.js";

export type NativeLoginProcessOptions = Pick<Parameters<typeof runEngineLogin>[2], "spawn" | "platform" | "timeoutMs" | "startupTimeoutMs">;
interface OwnedLogin {
  snapshot: ExecutionEngineLoginOperation;
  readonly owner: string;
  readonly controller: AbortController;
  active: boolean;
  done: Promise<void>;
}

export class EngineLoginManager {
  private readonly operations = new Map<ExternalExecutionEngineId, OwnedLogin>();
  private closing?: Promise<void>;

  constructor(private readonly options: {
    readonly authority: EngineManagementAuthority;
    readonly getStore: () => ExecutionEngineProfileStore;
    readonly userPaths: LingStackUserConfigPaths;
    readonly isProbing: (engineId: ExternalExecutionEngineId) => boolean;
    readonly process?: NativeLoginProcessOptions;
    readonly secretResolver?: SecretResolver;
  }) {}

  start(engineId: ExternalExecutionEngineId, expectedRevision: number, method: ExecutionEngineLoginMethod, principal: EnginePrincipal): ExecutionEngineLoginOperation {
    const authority = this.options.authority.lifetime(principal);
    this.assertIdle(engineId);
    if (this.options.isProbing(engineId)) throw new EngineProbeBusyError();
    const store = this.options.getStore();
    const profile = store.get(engineId);
    if (!profile) throw new ExecutionEngineProfileError("profile_not_found");
    if (profile.revision !== expectedRevision) throw new ExecutionEngineProfileError("profile_revision_conflict");
    if (profile.status !== "configured") throw new ExecutionEngineProfileError("profile_unavailable");
    if (store.listReferences(engineId).length) throw new ExecutionEngineProfileError("profile_in_use");
    assertNativeLoginSupported(profile, method, this.options.process?.platform);
    const operation: OwnedLogin = { owner: ownerKey(principal), controller: new AbortController(), active: true, done: Promise.resolve(),
      snapshot: { id: randomUUID(), engineId, profileId: profile.id, profileRevision: profile.revision,
        expiresAt: new Date(Date.now() + (this.options.process?.timeoutMs ?? 10 * 60_000)).toISOString(), status: "starting" },
    };
    this.operations.set(engineId, operation);
    const signal = AbortSignal.any([authority, operation.controller.signal]);
    const cancelling = (): void => {
      if (operation.snapshot.status === "starting" || operation.snapshot.status === "waiting") {
        this.update(operation, { status: "cancelling", challenge: undefined });
      }
    };
    signal.addEventListener("abort", cancelling, { once: true });
    operation.done = this.execute(operation, profile, method, principal, signal).finally(() => {
      operation.active = false;
      signal.removeEventListener("abort", cancelling);
    });
    return operation.snapshot;
  }

  get(engineId: ExternalExecutionEngineId, id: string, principal: EnginePrincipal): ExecutionEngineLoginOperation {
    return this.owned(engineId, id, principal).snapshot;
  }

  async cancel(engineId: ExternalExecutionEngineId, id: string, principal: EnginePrincipal): Promise<ExecutionEngineLoginOperation> {
    const operation = this.owned(engineId, id, principal);
    if (operation.active && operation.snapshot.status !== "completed") operation.controller.abort();
    await operation.done;
    this.options.authority.lifetime(principal);
    return operation.snapshot;
  }

  isActive(engineId: ExternalExecutionEngineId): boolean { return this.operations.get(engineId)?.active ?? false; }

  assertIdle(engineId: ExternalExecutionEngineId): void {
    if (this.closing) throw new EngineLoginError("engine_authority_required");
    if (this.operations.get(engineId)?.snapshot.errorCode === "engine_login_cleanup_failed") throw new EngineLoginError("engine_login_cleanup_failed");
    if (this.isActive(engineId)) throw new EngineProbeBusyError();
  }

  invalidate(engineId: ExternalExecutionEngineId): void {
    const operation = this.operations.get(engineId);
    if (operation?.active && operation.snapshot.status !== "completed") operation.controller.abort();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const operations = [...this.operations.values()];
    for (const operation of operations) if (operation.active && operation.snapshot.status !== "completed") operation.controller.abort();
    this.closing = Promise.all(operations.map((operation) => operation.done)).then(() => {
      if (operations.some((operation) => operation.snapshot.errorCode === "engine_login_cleanup_failed")) throw new EngineLoginError("engine_login_cleanup_failed");
      this.operations.clear();
    });
    return this.closing;
  }

  private owned(engineId: ExternalExecutionEngineId, id: string, principal: EnginePrincipal): OwnedLogin {
    this.options.authority.lifetime(principal);
    const operation = this.operations.get(engineId);
    if (!operation || operation.snapshot.id !== id || operation.owner !== ownerKey(principal)) throw new EngineLoginError("engine_login_not_found");
    if (operation.active && operation.snapshot.status !== "completed") {
      const current = this.options.getStore().get(engineId);
      if (!current || current.id !== operation.snapshot.profileId || current.revision !== operation.snapshot.profileRevision || current.status !== "configured") {
        operation.controller.abort();
        throw new ExecutionEngineProfileError("profile_revision_conflict");
      }
    }
    return operation;
  }

  private update(operation: OwnedLogin, changes: Partial<ExecutionEngineLoginOperation>): void {
    operation.snapshot = { ...operation.snapshot, ...changes };
  }

  private async execute(operation: OwnedLogin, profile: ExecutionEngineProfile, method: ExecutionEngineLoginMethod,
    principal: EnginePrincipal, signal: AbortSignal,
  ): Promise<void> {
    try {
      await runEngineLogin(profile, this.options.userPaths, { ...this.options.process, method, signal, secretResolver: this.options.secretResolver,
        onChallenge: (challenge) => {
          signal.throwIfAborted();
          this.options.authority.lifetime(principal);
          this.update(operation, { status: "waiting", challenge });
        },
        adopt: (configuration) => {
          signal.throwIfAborted();
          this.options.authority.lifetime(principal);
          const updated = this.options.getStore().save(configuration, profile.revision);
          // The synchronous CAS is the terminal winner. A later cancel cannot undo a committed login.
          this.update(operation, { status: "completed", profileRevision: updated.revision, challenge: undefined,
            authentication: method === "apiKey" ? "configured_unverified" : "login_completed" });
          return updated;
        },
      });
    } catch (error) {
      if (operation.snapshot.status === "completed") return;
      const code = error instanceof EngineLoginError || error instanceof ExecutionEngineProfileError || error instanceof EngineAuthorityError
        ? error.code : "engine_login_failed";
      this.update(operation, { status: code === "engine_login_cleanup_failed" ? "failed" : code === "engine_login_timed_out" ? "timed_out"
        : signal.aborted || code === "engine_login_cancelled" ? "cancelled" : "failed", challenge: undefined, errorCode: code });
    }
  }
}

function ownerKey(principal: EnginePrincipal): string { return principal.kind === "host" ? "host" : `web:${principal.token}`; }
