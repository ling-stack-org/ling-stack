import type { LingDaemonClient } from "@ling-stack/api-client";
import type { ExecutionBindingRequest, ExecutionEngineProfile, RunnerListItem, WorkspaceRuntimeSettings } from "@ling-stack/contracts";

type WorkspacePolicyApi = Pick<LingDaemonClient, "getRuntimeSettings" | "listRunners" | "updateRuntimeSettings">;
interface PolicyDraft {
  readonly defaultRunnerId: string;
  readonly allowedRunnerIds: readonly string[];
  readonly defaultExecutionBinding?: ExecutionBindingRequest;
}
interface WorkspacePolicyState {
  readonly phase: "loading" | "ready" | "error";
  readonly runners: readonly RunnerListItem[];
  readonly saved?: WorkspaceRuntimeSettings;
  readonly draft?: PolicyDraft;
  readonly saving: boolean;
  readonly error?: "load" | "save" | "conflict";
}

export class WorkspaceEnginePolicyController {
  private readonly cwd: string;
  private readonly api: WorkspacePolicyApi;
  private state: WorkspacePolicyState = { phase: "loading", runners: [], saving: false };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private detached = false;
  private profiles: readonly ExecutionEngineProfile[] = [];
  private migrationConfirmed = false;

  constructor(cwd: string, api: WorkspacePolicyApi) { this.cwd = cwd; this.api = api; }
  getSnapshot = (): WorkspacePolicyState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  detach(): void { this.detached = true; this.generation++; }
  private get editable(): boolean { return !this.detached && this.state.phase === "ready" && !this.state.saving; }
  private update(patch: Partial<WorkspacePolicyState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  get dirty(): boolean {
    const { saved, draft } = this.state;
    return Boolean(saved && draft && (saved.defaultRunnerId !== draft.defaultRunnerId
      || saved.allowedRunnerIds.length !== draft.allowedRunnerIds.length
      || saved.allowedRunnerIds.some((id) => !draft.allowedRunnerIds.includes(id))
      || JSON.stringify(saved.defaultExecutionBinding) !== JSON.stringify(draft.defaultExecutionBinding)));
  }
  get valid(): boolean {
    const draft = this.state.draft;
    if (!draft || draft.allowedRunnerIds.length > 0 && !draft.allowedRunnerIds.includes(draft.defaultRunnerId)) return false;
    if (draft.allowedRunnerIds.length === 0) return true;
    const runner = this.state.runners.find(item => item.id === draft.defaultRunnerId);
    if (runner?.profileSelection !== "supported") return true;
    const binding = draft.defaultExecutionBinding;
    const profile = this.profiles.find(item => item.configuration.engineId === draft.defaultRunnerId);
    return Boolean(binding?.kind === "native_profile" && profile?.status === "configured" && binding.engineId === draft.defaultRunnerId
      && binding.profileId === profile.id && binding.profileRevision === profile.revision
      && (binding.engineId !== "codex-app-server" || binding.nativeModelId?.trim())
      && (binding.engineId !== "openclaw-acp" && !(binding.engineId === "kimi-acp" && profile.configuration.secretRef) || binding.nativeModelId === undefined));
  }
  canAllow(id: string): boolean {
    const runner = this.state.runners.find((item) => item.id === id);
    return Boolean(runner && (runner.status === "enabled" || runner.profileSelection === "supported" || this.state.saved?.allowedRunnerIds.includes(id)));
  }
  get confirmationRequired(): boolean {
    const { saved, draft } = this.state;
    if (!saved || !draft) return false;
    const nativeIds = this.state.runners.filter(item => item.profileSelection === "supported").map(item => item.id);
    return draft.allowedRunnerIds.some(id => nativeIds.includes(id) && (!saved.allowedRunnerIds.includes(id) || Boolean(saved.migration)))
      || Boolean(draft.defaultExecutionBinding?.kind === "native_profile"
        && JSON.stringify(draft.defaultExecutionBinding) !== JSON.stringify(saved.defaultExecutionBinding));
  }
  get confirmed(): boolean { return this.migrationConfirmed; }
  setProfiles(profiles: readonly ExecutionEngineProfile[]): void { this.profiles = profiles; this.update({}); }
  confirmMigration(value: boolean): void { if (this.editable) { this.migrationConfirmed = value; this.update({}); } }
  setNativeModel(value: string): void {
    const binding = this.state.draft?.defaultExecutionBinding;
    if (!this.editable || binding?.kind !== "native_profile" || binding.engineId === "openclaw-acp"
      || binding.engineId === "kimi-acp" && this.profiles.find(profile => profile.id === binding.profileId)?.configuration.secretRef) return;
    this.migrationConfirmed = false;
    this.update({ draft: { ...this.state.draft!, defaultExecutionBinding: { ...binding, nativeModelId: value.trim() || undefined } } });
  }
  async load(): Promise<void> {
    if (this.state.saving) return;
    this.detached = false;
    const generation = ++this.generation;
    this.update({ phase: "loading", error: undefined });
    try {
      const [policy, list] = await Promise.all([this.api.getRuntimeSettings(this.cwd), this.api.listRunners(this.cwd)]);
      if (generation !== this.generation) return;
      if (policy.cwd !== this.cwd || list.cwd !== this.cwd) throw new Error("workspace_mismatch");
      this.migrationConfirmed = false;
      this.update({ phase: "ready", saved: policy.settings, draft: policy.settings, runners: list.runners });
    } catch {
      if (generation === this.generation) this.update({ phase: "error", error: "load" });
    }
  }
  setAllowed(id: string, allowed: boolean): void {
    const draft = this.state.draft;
    if (!this.editable || !draft || !this.state.runners.some((item) => item.id === id) || (allowed && !this.canAllow(id))) return;
    this.migrationConfirmed = false;
    this.update({ draft: { ...draft, allowedRunnerIds: allowed
      ? [...new Set([...draft.allowedRunnerIds, id])] : draft.allowedRunnerIds.filter((item) => item !== id) } });
    if (allowed && draft.defaultRunnerId === id && !draft.defaultExecutionBinding
      && this.state.runners.find(item => item.id === id)?.profileSelection === "supported") this.setDefault(id);
  }
  setDefault(id: string): void {
    const draft = this.state.draft;
    const runner = this.state.runners.find(item => item.id === id);
    if (!this.editable || !draft?.allowedRunnerIds.includes(id) || !runner) return;
    let defaultExecutionBinding: ExecutionBindingRequest | undefined;
    if (runner.profileSelection === "supported") {
      const profile = this.profiles.find(item => item.configuration.engineId === id && item.status === "configured");
      if (!profile) return;
      const previous = draft.defaultExecutionBinding;
      const allowsModel = id === "codex-app-server" || id === "kimi-acp" && !profile.configuration.secretRef;
      defaultExecutionBinding = { kind: "native_profile", engineId: profile.configuration.engineId,
        profileId: profile.id, profileRevision: profile.revision,
        ...(allowsModel && previous?.kind === "native_profile" && previous.engineId === id && previous.nativeModelId ? { nativeModelId: previous.nativeModelId } : {}) };
    } else if (runner.status !== "enabled") return;
    this.migrationConfirmed = false;
    this.update({ draft: { ...draft, defaultRunnerId: id, defaultExecutionBinding } });
  }
  cancel(): void {
    this.migrationConfirmed = false;
    if (this.editable) this.update({ draft: this.state.saved, error: this.state.error === "conflict" ? "conflict" : undefined });
  }
  async save(): Promise<boolean> {
    const { draft, saved } = this.state;
    if (!this.editable || !draft || !saved || !this.dirty || !this.valid || this.state.error === "conflict" || this.confirmationRequired && !this.migrationConfirmed) return false;
    const generation = ++this.generation;
    this.update({ saving: true, error: undefined });
    try {
      const response = await this.api.updateRuntimeSettings(this.cwd, {
        defaultRunnerId: draft.defaultRunnerId, allowedRunnerIds: draft.allowedRunnerIds, expectedUpdatedAt: saved.updatedAt,
        ...(draft.defaultExecutionBinding || saved.defaultExecutionBinding || this.confirmationRequired
          ? { schemaVersion: 2 as const, confirmNativeMigration: this.migrationConfirmed,
            defaultExecutionBinding: draft.defaultExecutionBinding ?? null } : {}),
      });
      if (generation !== this.generation) return false;
      if (response.cwd !== this.cwd) throw new Error("workspace_mismatch");
      this.update({ saved: response.settings, draft: response.settings });
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.update({ error: typeof error === "object" && error !== null && "code" in error
        && error.code === "runtime_settings_conflict" ? "conflict" : "save" });
      return false;
    } finally {
      if (generation === this.generation) this.update({ saving: false });
    }
  }
}
