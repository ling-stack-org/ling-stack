import type { ExecutionEngineManagementClient } from "@ling-stack/api-client";
import type {
  ExecutionEngineConnectionProbe, ExecutionEngineLoginMethod, ExecutionEngineLoginOperation,
  ExecutionEngineProfile, ExecutionEngineProfileConfiguration, ExternalExecutionEngineId,
} from "@ling-stack/contracts";

export type EngineManagementApi = Pick<ExecutionEngineManagementClient,
  "listProfiles" | "getProfile" | "saveProfile" | "saveProfileWithSecret" | "disconnectProfile" | "probeConnection"
  | "startLogin" | "getLogin" | "cancelLogin">;

export type EngineManagementTransport =
  | { readonly kind: "desktop"; readonly api: EngineManagementApi }
  | { readonly kind: "web"; readonly api: EngineManagementApi;
      readonly enroll: (code: string) => Promise<void>; readonly revoke: () => Promise<void> }
  | { readonly kind: "unavailable"; readonly code: string };

export interface EngineProfileEditor {
  readonly expectedRevision: number;
  readonly draft: ExecutionEngineProfileConfiguration;
  readonly error?: string;
}

export interface EngineManagementState {
  readonly phase: "loading" | "ready" | "authorization_required" | "unavailable" | "error";
  readonly profiles: readonly ExecutionEngineProfile[];
  readonly editor?: EngineProfileEditor;
  readonly busy: Readonly<Partial<Record<ExternalExecutionEngineId, "save" | "reload" | "probe" | "disconnect">>>;
  readonly probes: Readonly<Partial<Record<ExternalExecutionEngineId, ExecutionEngineConnectionProbe>>>;
  readonly errors: Readonly<Partial<Record<ExternalExecutionEngineId, string>>>;
  readonly authorizing?: boolean;
  readonly error?: string;
}

/** Owns settings drafts; neither saved configuration nor a probe is execution readiness. */
export class ExecutionEngineManager {
  readonly transport: EngineManagementTransport;
  readonly #listeners = new Set<() => void>();
  #state: EngineManagementState = { phase: "loading", profiles: [], busy: {}, probes: {}, errors: {} };
  #loadRevision = 0;
  #scope = 0;
  #revalidation?: Promise<void>;
  readonly #probes = new Map<ExternalExecutionEngineId, AbortController>();

  constructor(transport: EngineManagementTransport) { this.transport = transport; }

  getSnapshot = (): EngineManagementState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  async load(): Promise<void> {
    if (this.transport.kind === "unavailable") {
      this.publish({ phase: "unavailable", error: this.transport.code });
      return;
    }
    const revision = ++this.#loadRevision;
    const scope = this.#scope;
    try {
      const { profiles } = await this.transport.api.listProfiles();
      if (revision !== this.#loadRevision || scope !== this.#scope) return;
      const probes = Object.fromEntries(Object.entries(this.#state.probes).filter(([id, probe]) => {
        const profile = profiles.find((item) => item.configuration.engineId === id);
        return probe && profile?.status === "configured" && profile.id === probe.profileId
          && profile.revision === probe.profileRevision && profile.configurationFingerprint === probe.configurationFingerprint;
      }));
      this.publish({ phase: "ready", profiles, probes, error: undefined });
    } catch (error) {
      if (revision !== this.#loadRevision || scope !== this.#scope) return;
      const code = engineManagementErrorCode(error);
      if (needsAuthority(code)) this.loseAuthority(code);
      else this.publish({ phase: "error", error: code });
    }
  }

  async revalidate(): Promise<void> {
    if (this.#state.phase !== "ready" || this.#state.authorizing || Object.values(this.#state.busy).some(Boolean)) return;
    if (this.#revalidation) return this.#revalidation;
    const pending = this.load();
    this.#revalidation = pending;
    try { await pending; }
    finally { if (this.#revalidation === pending) this.#revalidation = undefined; }
  }

  edit(engineId: ExternalExecutionEngineId): void {
    if (this.#state.phase !== "ready" || this.#state.editor || this.#state.busy[engineId]) return;
    const profile = this.#state.profiles.find((item) => item.configuration.engineId === engineId);
    this.publish({ editor: {
      expectedRevision: profile?.revision ?? 0,
      draft: structuredClone(profile?.configuration ?? { engineId, executablePath: "", authProfileId: "ling" }),
    } });
  }

  updateDraft(patch: Partial<Omit<ExecutionEngineProfileConfiguration, "engineId">>): void {
    const editor = this.#state.editor;
    if (!editor || this.#state.busy[editor.draft.engineId]) return;
    this.publish({ editor: { ...editor, draft: { ...editor.draft, ...structuredClone(patch) }, error: undefined } });
  }

  setAuthenticationMode(mode: "account" | "apiKey"): void {
    const draft = this.#state.editor?.draft;
    if (!draft || !["codex-app-server", "kimi-acp"].includes(draft.engineId)
      || (draft.secretRef !== undefined) === (mode === "apiKey")) return;
    this.updateDraft({ secretRef: mode === "apiKey" ? "" : undefined, kimiLoginRegion: undefined,
      kimi: mode === "apiKey" && draft.engineId === "kimi-acp"
        ? { providerType: "kimi", baseUrl: "", modelId: "", maxContextSize: 0 } : undefined });
  }

  async save(secret?: string): Promise<boolean> {
    const editor = this.#state.editor;
    if (!editor || !this.canAct(editor.draft.engineId) || this.transport.kind === "unavailable") return false;
    const id = editor.draft.engineId;
    const scope = this.#scope;
    const input = { expectedRevision: editor.expectedRevision, configuration: structuredClone(editor.draft) };
    this.#loadRevision++;
    this.setBusy(id, "save");
    try {
      const { secretRef: _ref, ...configuration } = input.configuration;
      const { profile } = secret === undefined ? await this.transport.api.saveProfile(id, input)
        : await this.transport.api.saveProfileWithSecret(id, { expectedRevision: input.expectedRevision, configuration, secret });
      if (scope !== this.#scope) return false;
      this.acceptProfile(profile);
      this.publish({ editor: undefined });
      return true;
    } catch (error) {
      if (scope === this.#scope) this.editorError(error);
      return false;
    } finally {
      if (scope === this.#scope) this.setBusy(id, undefined);
    }
  }

  cancelEdit(): void {
    const editor = this.#state.editor;
    if (editor && !this.#state.busy[editor.draft.engineId]) this.publish({ editor: undefined });
  }

  async reloadEditor(): Promise<void> {
    const editor = this.#state.editor;
    if (!editor || !this.canAct(editor.draft.engineId) || this.transport.kind === "unavailable") return;
    const id = editor.draft.engineId;
    const scope = this.#scope;
    this.#loadRevision++;
    this.setBusy(id, "reload");
    try {
      const { profile } = await this.transport.api.getProfile(id);
      if (scope !== this.#scope) return;
      this.acceptProfile(profile);
      this.publish({ editor: { expectedRevision: profile.revision, draft: structuredClone(profile.configuration) } });
    } catch (error) {
      if (scope === this.#scope) this.editorError(error);
    } finally {
      if (scope === this.#scope) this.setBusy(id, undefined);
    }
  }

  async enroll(code: string): Promise<void> {
    if (this.transport.kind !== "web" || this.#state.authorizing) return;
    const scope = ++this.#scope;
    this.#loadRevision++;
    this.abortProbes();
    this.publish({ authorizing: true, error: undefined, busy: {} });
    try {
      await this.transport.enroll(code);
      if (scope === this.#scope) await this.load();
    } catch (error) {
      if (scope === this.#scope) this.publish({ phase: "authorization_required", error: engineManagementErrorCode(error) });
    } finally {
      if (scope === this.#scope) this.publish({ authorizing: false });
    }
  }

  async revoke(): Promise<void> {
    if (this.transport.kind !== "web" || this.#state.authorizing) return;
    const scope = ++this.#scope;
    this.#loadRevision++;
    this.abortProbes();
    this.publish({ phase: "authorization_required", profiles: [], editor: undefined, busy: {}, probes: {}, errors: {}, authorizing: true, error: undefined });
    try {
      await this.transport.revoke();
    } catch (error) {
      if (scope === this.#scope) this.publish({ error: engineManagementErrorCode(error) });
    } finally {
      if (scope === this.#scope) this.publish({ authorizing: false });
    }
  }

  /** Detach this view without revoking the shared in-memory Web authorization. */
  detach(): void {
    this.#scope++;
    this.#loadRevision++;
    this.abortProbes();
    this.#state = { ...this.#state, editor: undefined, busy: {}, authorizing: false };
  }

  private canAct(id: ExternalExecutionEngineId): boolean {
    return this.#state.phase === "ready" && !this.#state.authorizing && !this.#state.busy[id];
  }

  private acceptProfile(profile: ExecutionEngineProfile): void {
    this.#loadRevision++;
    const id = profile.configuration.engineId;
    this.publish({ profiles: [...this.#state.profiles.filter((item) => item.configuration.engineId !== id), profile],
      probes: { ...this.#state.probes, [id]: undefined }, errors: { ...this.#state.errors, [id]: undefined } });
  }

  async checkConnection(id: ExternalExecutionEngineId): Promise<void> {
    const profile = this.#state.profiles.find((item) => item.configuration.engineId === id);
    if (!profile || profile.status !== "configured" || !this.canAct(id) || this.transport.kind === "unavailable") return;
    const scope = this.#scope;
    const abort = new AbortController();
    this.#probes.set(id, abort);
    this.setBusy(id, "probe");
    this.publish({ probes: { ...this.#state.probes, [id]: undefined }, errors: { ...this.#state.errors, [id]: undefined } });
    try {
      const probe = await this.transport.api.probeConnection(id, profile.revision, abort.signal);
      if (scope !== this.#scope) return;
      const current = this.#state.profiles.find((item) => item.configuration.engineId === id);
      if (current?.revision !== probe.profileRevision || current.id !== probe.profileId
        || current.configurationFingerprint !== probe.configurationFingerprint) {
        this.rowError(id, { code: "profile_revision_conflict" });
        return;
      }
      this.publish({ probes: { ...this.#state.probes, [id]: probe } });
    } catch (error) {
      if (scope === this.#scope) this.rowError(id, error);
    } finally {
      if (this.#probes.get(id) === abort) this.#probes.delete(id);
      if (scope === this.#scope) this.setBusy(id, undefined);
    }
  }

  async disconnect(id: ExternalExecutionEngineId): Promise<void> {
    const profile = this.#state.profiles.find((item) => item.configuration.engineId === id);
    if (!profile || !this.canAct(id) || this.transport.kind === "unavailable") return;
    const scope = this.#scope;
    this.#loadRevision++;
    this.setBusy(id, "disconnect");
    try {
      const result = await this.transport.api.disconnectProfile(id, profile.revision);
      if (scope === this.#scope) this.acceptProfile(result.profile);
    } catch (error) {
      if (scope === this.#scope) this.rowError(id, error);
    } finally {
      if (scope === this.#scope) this.setBusy(id, undefined);
    }
  }

  private rowError(id: ExternalExecutionEngineId, error: unknown): void {
    const code = engineManagementErrorCode(error);
    if (needsAuthority(code)) this.loseAuthority(code);
    else this.publish({ errors: { ...this.#state.errors, [id]: code } });
  }

  private loseAuthority(code: string): void {
    this.#scope++;
    this.#loadRevision++;
    this.abortProbes();
    this.publish({ phase: "authorization_required", profiles: [], editor: undefined,
      probes: {}, errors: {}, busy: {}, authorizing: false, error: code });
  }

  private abortProbes(): void {
    for (const abort of this.#probes.values()) abort.abort();
    this.#probes.clear();
  }

  private setBusy(id: ExternalExecutionEngineId, action: EngineManagementState["busy"][ExternalExecutionEngineId]): void {
    this.publish({ busy: { ...this.#state.busy, [id]: action } });
  }

  private editorError(error: unknown): void {
    const code = engineManagementErrorCode(error);
    if (needsAuthority(code)) this.loseAuthority(code);
    else if (this.#state.editor) this.publish({ editor: { ...this.#state.editor, error: code } });
  }

  private publish(patch: Partial<EngineManagementState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

export function engineManagementErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^(engine|profile)_[a-z_]+$/.test(code)) return code;
  // Electron strips custom Error fields but preserves its prefixed, stable IPC message.
  const match = error instanceof Error ? /(?:^|: )((?:engine|profile)_[a-z_]+)$/.exec(error.message) : undefined;
  return match?.[1] ?? "engine_operation_failed";
}

export function needsAuthority(code: string): boolean {
  return ["engine_authority_required", "engine_session_invalid", "engine_host_authority_unavailable"].includes(code);
}

export function engineProbeOutcome(probe: ExecutionEngineConnectionProbe): ExecutionEngineConnectionProbe["status"] {
  return probe.status === "connected" && probe.authentication === "required" ? "auth_required" : probe.status;
}

export interface EngineLoginState {
  readonly profile: ExecutionEngineProfile;
  readonly method: ExecutionEngineLoginMethod;
  readonly operation?: ExecutionEngineLoginOperation;
  readonly pending?: "start" | "refresh" | "cancel";
  readonly error?: string;
  readonly cancelRequested?: boolean;
}

export function interactiveEngineLoginMethod(profile: ExecutionEngineProfile): ExecutionEngineLoginMethod | undefined {
  if (profile.status !== "configured" || profile.configuration.secretRef) return undefined;
  if (profile.configuration.engineId === "codex-app-server") return "chatgptDeviceCode";
  if (profile.configuration.engineId === "kimi-acp" && profile.configuration.kimiLoginRegion) return "terminal";
  return undefined;
}

export function engineLoginMethod(profile: ExecutionEngineProfile): ExecutionEngineLoginMethod | undefined {
  const { engineId, secretRef, kimi } = profile.configuration;
  if (profile.status !== "configured" || engineId === "openclaw-acp") return undefined;
  if (secretRef && (engineId !== "kimi-acp" || kimi)) return "apiKey";
  return interactiveEngineLoginMethod(profile);
}

export function engineLoginPending(operation?: ExecutionEngineLoginOperation): boolean {
  return Boolean(operation && ["starting", "waiting", "cancelling"].includes(operation.status));
}

/** Owns one explicit native login, separately from browser management authorization. */
export class ExecutionEngineLoginController {
  readonly #listeners = new Set<() => void>();
  readonly #transport: EngineManagementTransport;
  #state?: EngineLoginState;
  #readSequence = 0;
  #cancelSent = false;

  constructor(transport: EngineManagementTransport) { this.#transport = transport; }
  getSnapshot = (): EngineLoginState | undefined => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  async start(profile: ExecutionEngineProfile): Promise<void> {
    const method = engineLoginMethod(profile);
    if (!method || this.#state || this.#transport.kind === "unavailable") return;
    this.publish({ profile: structuredClone(profile), method, pending: "start" });
    try {
      const operation = await this.#transport.api.startLogin(profile.configuration.engineId, profile.revision, method);
      this.accept(operation);
      if (this.getSnapshot()?.cancelRequested) await this.cancel();
    } catch (error) { this.fail(error); }
  }

  async refresh(): Promise<void> {
    const state = this.#state;
    if (!state?.operation || state.pending || !engineLoginPending(state.operation) || this.#transport.kind === "unavailable") return;
    this.publish({ ...state, pending: "refresh", error: undefined });
    const sequence = ++this.#readSequence;
    try {
      const operation = await this.#transport.api.getLogin(state.operation.engineId, state.operation.id);
      if (sequence === this.#readSequence) this.accept(operation);
    } catch (error) { if (sequence === this.#readSequence) this.fail(error); }
  }

  async cancel(): Promise<void> {
    const state = this.#state;
    if (!state || this.#cancelSent || (!state.pending && !engineLoginPending(state.operation))
      || this.#transport.kind === "unavailable") return;
    this.#readSequence++;
    this.publish({ ...state, pending: "cancel", cancelRequested: true, error: undefined,
      operation: state.operation ? { ...state.operation, challenge: undefined } : undefined });
    if (!state.operation) return; // Start still owns the eventual operation id and its cancellation.
    this.#cancelSent = true;
    try {
      this.accept(await this.#transport.api.cancelLogin(state.operation.engineId, state.operation.id));
    } catch (error) { this.fail(error); }
    finally { this.#cancelSent = false; }
  }

  close(): void {
    if (this.#state?.pending || engineLoginPending(this.#state?.operation)) return;
    this.publish(undefined);
  }

  private accept(operation: ExecutionEngineLoginOperation): void {
    const state = this.#state;
    if (!state || operation.engineId !== state.profile.configuration.engineId || operation.profileId !== state.profile.id
      || operation.profileRevision !== state.profile.revision + (operation.status === "completed" ? 1 : 0)
      || (state.operation && operation.id !== state.operation.id)) {
      this.fail({ code: "engine_operation_failed" });
      return;
    }
    this.publish({ profile: state.profile, method: state.method, cancelRequested: state.cancelRequested, operation: { ...operation,
      challenge: engineLoginPending(operation) && !state.cancelRequested ? operation.challenge : undefined } });
  }

  private fail(error: unknown): void {
    const code = engineManagementErrorCode(error);
    const lostOperation = needsAuthority(code) || code === "engine_login_not_found";
    if (this.#state) this.publish({ ...this.#state, pending: undefined, error: code,
      operation: this.#state.operation && !lostOperation ? { ...this.#state.operation, challenge: undefined } : undefined });
  }
  private publish(state: EngineLoginState | undefined): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
