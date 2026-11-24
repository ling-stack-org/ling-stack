import { FolderOpen, GitBranch, MoreHorizontal, Pin, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { WORKTREE_CONFIGURATION_PLACEHOLDER, type ManagedWorktreeEntry } from "@ling-stack/contracts";
import { useI18n, type Translate } from "../../i18n.js";
import { Button, DataRow, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Field, IconButton, InlineFeedback, Input, Menu, MenuContent, MenuItem, MenuTrigger, SegmentedControl, SegmentedControlItem, Skeleton, StatusIndicator, Switch, Textarea } from "../../shared/ui/index.js";
import { useWorktreeSettings } from "./useWorktreeSettings.js";

export function WorktreeSettingsPanel({ cwd, registerGuard, onSwitchWorkspace }: { readonly cwd: string;
  readonly onSwitchWorkspace?: () => void;
  readonly registerGuard?: (guard: { readonly dirty: boolean; readonly save: () => Promise<boolean> } | undefined) => void }): React.JSX.Element {
  const { t } = useI18n();
  const state = useWorktreeSettings(cwd);
  const [tab, setTab] = useState("general");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLButtonElement | null>(null);
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const refreshRef = useRef<HTMLButtonElement>(null);
  const disabled = state.loading || Boolean(state.busy);
  const target = state.cleanupTarget;
  const scriptConfigured = state.environment.setupScript === WORKTREE_CONFIGURATION_PLACEHOLDER;
  const workspaceName = cwd.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? cwd;
  useEffect(() => { registerGuard?.({ dirty: state.dirty, save: state.save }); }, [registerGuard, state.dirty, state.save]);
  useEffect(() => () => registerGuard?.(undefined), [registerGuard]);

  return (
    <div className="settings-worktrees" data-worktree-settings="true" aria-busy={state.loading}>
      <header className="settings-worktrees-heading">
        <div><h1>{t("Worktrees")}</h1><p>{t("Manage isolated Git workspaces for channels and private chats.")}</p></div>
        <div className="settings-worktrees-workspace"><span>{t("Current workspace")}: <strong>{workspaceName}</strong></span>
          {onSwitchWorkspace ? <Button size="sm" variant="ghost" onClick={onSwitchWorkspace}>{t("Switch workspace")}</Button> : null}</div>
      </header>
      {state.error ? <InlineFeedback tone="danger">{state.error}</InlineFeedback> : null}
      {!state.data && state.loading ? (
        <div className="settings-worktrees-loading" aria-label={t("Loading")}><Skeleton height={48} /><Skeleton height={140} /><Skeleton height={100} /></div>
      ) : state.data ? (
        <>
          <SegmentedControl value={tab} onValueChange={setTab} aria-label={t("Worktree settings")}>
            <SegmentedControlItem value="general">{t("General")}</SegmentedControlItem>
            <SegmentedControlItem value="environment">{t("Environment")}</SegmentedControlItem>
          </SegmentedControl>
          {tab === "general" ? <section className="settings-worktrees-section" aria-labelledby="worktree-creation-heading">
            <h2 id="worktree-creation-heading">{t("Worktree creation")}</h2>
            <div className="settings-worktrees-rows">
              <DataRow
                identity={<FolderOpen size={18} aria-hidden="true" />}
                summary={(
                  <Field label={t("Worktree root directory")} description={t("Leave empty to use the default location. Applies to new worktrees.")}>
                    <Input aria-label={t("Worktree root directory")} value={state.rootDir} placeholder={state.data.defaultRootDir}
                      disabled={disabled} onChange={(event) => state.setRootDir(event.target.value)} />
                  </Field>
                )}
              />
              <DataRow
                identity={<RefreshCw size={18} aria-hidden="true" />}
                summary={<div><strong>{t("Fetch upstream before creating worktrees")}</strong><p>{t("Updates remote refs without merging into your local branch. Fetch failures stop creation.")}</p></div>}
                actions={<Switch aria-label={t("Fetch upstream before creating worktrees")} checked={state.fetchBeforeCreate} disabled={disabled} onCheckedChange={state.setFetchBeforeCreate} />}
              />
              <DataRow identity={<Trash2 size={18} aria-hidden="true" />} summary={<div><strong>{t("Automatically clean up old worktrees")}</strong><p>{t("Keeps the most recently used worktrees. Pinned, busy, shared and dirty worktrees are preserved.")}</p></div>}
                actions={<Switch aria-label={t("Automatically clean up old worktrees")} checked={state.autoCleanup} disabled={disabled} onCheckedChange={state.setAutoCleanup} />} />
              <DataRow identity={<GitBranch size={18} aria-hidden="true" />} summary={<Field label={t("Worktrees to retain")} description={t("Retain between 1 and 100 worktrees.")}>
                <Input type="number" min={1} max={100} aria-label={t("Worktrees to retain")} value={state.retainCount} disabled={disabled} onChange={(event) => state.setRetainCount(event.target.value)} />
              </Field>} />
              <DataRow identity={<Trash2 size={18} aria-hidden="true" />} summary={<div><strong>{t("Ask before cleaning up a worktree")}</strong><p>{t("Applies to manual cleanup. Automatic cleanup follows the retention policy.")}</p></div>}
                actions={<Switch aria-label={t("Ask before cleaning up a worktree")} checked={state.confirmBeforeDelete} disabled={disabled} onCheckedChange={state.setConfirmBeforeDelete} />} />
            </div>
          </section> : <section className="settings-worktrees-section" aria-labelledby="worktree-environment-heading">
            <h2 id="worktree-environment-heading">{t("Worktree environment")}</h2>
            <p>{t("The saved script runs locally on new worktrees with your account permissions. Existing worktrees are unchanged.")}</p>
            <DataRow identity={<RefreshCw size={18} aria-hidden="true" />} summary={<strong>{t("Run setup script on new worktrees")}</strong>}
              actions={<Switch aria-label={t("Run setup script on new worktrees")} checked={state.environment.enabled} disabled={disabled} onCheckedChange={(enabled) => state.setEnvironment({ ...state.environment, enabled })} />} />
            <Field label={t("Setup script")}>
              <div>
                <Textarea aria-label={t("Setup script")} rows={8} value={scriptConfigured ? "" : state.environment.setupScript} disabled={disabled}
                  placeholder={scriptConfigured ? WORKTREE_CONFIGURATION_PLACEHOLDER : undefined}
                  onChange={(event) => state.setEnvironment({ ...state.environment, setupScript: event.target.value })} />
                {scriptConfigured ? <Button size="sm" variant="ghost" disabled={disabled}
                  onClick={() => state.setEnvironment({ ...state.environment, enabled: false, setupScript: "" })}>{t("Clear")}</Button> : null}
              </div>
            </Field>
            <Field label={t("Environment variables")} description={t("Use one unique NAME=value environment variable per line.")}><Textarea aria-label={t("Environment variables")} rows={4}
              value={state.variablesText} disabled={disabled} onChange={(event) => state.setVariablesText(event.target.value)} /></Field>
            <Field label={t("Setup timeout (seconds)")}><Input type="number" min={1} max={600} aria-label={t("Setup timeout (seconds)")} value={state.environment.timeoutSeconds} disabled={disabled}
              onChange={(event) => state.setEnvironment({ ...state.environment, timeoutSeconds: Number(event.target.value) })} /></Field>
          </section>}
            <div className="settings-worktrees-save-row">
              <div><small>{t("Current worktree location")}</small><code>{state.data.effectiveRootDir}</code></div>
              <Button size="sm" disabled={disabled || !state.dirty} loading={state.busy === "save"} loadingLabel={t("Saving...")} onClick={() => void state.save()}>{t("Save")}</Button>
            </div>
          <section className="settings-worktrees-section" aria-labelledby="managed-worktrees-heading">
            <div className="settings-worktrees-list-heading">
              <h2 id="managed-worktrees-heading">{t("Managed worktrees")} <span>{state.data.entries.length}</span></h2>
              <Button ref={refreshRef} leadingIcon={<RefreshCw size={16} />} size="sm" variant="ghost" loading={state.loading} loadingLabel={t("Refreshing...")}
                disabled={Boolean(state.busy)} onClick={() => void state.refresh()}>{t("Refresh")}</Button>
            </div>
            <p>{t("Recovery snapshots keep files and continue using disk space until restored.")}</p>
            {state.data.cleanup?.errorMessage ? <InlineFeedback tone="warning">{state.data.cleanup.errorMessage}</InlineFeedback> : null}
            {state.data.limitReached ? <InlineFeedback tone="warning">{t("Only the most recent workspace owners are shown.")}</InlineFeedback> : null}
            {state.data.entries.length ? (
              <ul className="settings-worktrees-list">
                {state.data.entries.map((entry) => (
                  <li key={`${entry.ownerKind}:${entry.ownerId}`} className="settings-worktree-entry">
                    <div className="settings-worktree-entry-main"><strong>{entry.ownerName}</strong>
                      <small>{[entry.branchName, entry.lastUsedAt ? new Date(entry.lastUsedAt).toLocaleDateString() : undefined].filter(Boolean).join(" · ")}</small></div>
                    <div className="settings-worktree-status">
                      {entry.status !== "ready" ? <StatusIndicator tone={entry.status === "blocked" ? "danger" : "neutral"} label={statusLabel(entry, t)} /> : null}
                      {entry.inUse ? <StatusIndicator tone="warning" label={t("In use")} /> : null}
                      {entry.isDirty ? <StatusIndicator tone="warning" label={t("Uncommitted changes")} /> : null}
                      {entry.pinned || entry.kept ? <StatusIndicator tone="neutral" label={t("Pinned")} /> : null}
                    </div>
                    <div className="settings-worktree-actions">
                      <Button leadingIcon={<FolderOpen size={15} />} size="sm" variant="secondary" disabled={disabled || entry.status !== "ready"}
                        loading={state.busy === `open:${entry.ownerKind}:${entry.ownerId}`} loadingLabel={t("Opening...")} onClick={() => void state.perform(entry, "open")}>{t("Open path")}</Button>
                      <Menu><MenuTrigger asChild><IconButton ref={node => { const key = `${entry.ownerKind}:${entry.ownerId}`; if (node) menuTriggers.current.set(key, node); else menuTriggers.current.delete(key); }}
                        icon={MoreHorizontal} label={t("Manage worktree")} size="sm" tooltip="" disabled={disabled} /></MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem onSelect={() => void state.perform(entry, entry.kept ? "unpin" : "pin")}><Pin aria-hidden="true" />{entry.kept ? t("Unpin worktree") : t("Keep worktree")}</MenuItem>
                          {entry.initialization && entry.initialization.status !== "succeeded" ? <MenuItem disabled={entry.inUse} onSelect={() => void state.perform(entry, "initialize")}><RefreshCw aria-hidden="true" />{t("Retry setup")}</MenuItem> : null}
                          <MenuItem tone="danger" disabled={entry.inUse || entry.status === "not_created" || entry.status === "missing" || entry.initialization?.status === "running" || entry.status === "blocked" && !entry.initialization}
                            onSelect={() => { returnRef.current = menuTriggers.current.get(`${entry.ownerKind}:${entry.ownerId}`) ?? null; state.requestCleanup(entry); }}><Trash2 aria-hidden="true" />{t("Clean up worktree")}</MenuItem>
                        </MenuContent></Menu>
                    </div>
                    {entry.errorMessage ? <InlineFeedback tone="danger">{entry.errorMessage}</InlineFeedback> : null}
                    {entry.initialization?.output ? <details><summary>{t("Setup output")}</summary><pre className="settings-worktree-output">{entry.initialization.output}</pre></details> : null}
                  </li>
                ))}
              </ul>
            ) : <div className="settings-worktrees-empty"><GitBranch size={24} aria-hidden="true" /><strong>{t("No managed worktrees")}</strong><p>{t("Create a worktree in channel settings, or start a private chat in a Git repository.")}</p></div>}
          </section>
          {state.data.snapshots?.length ? <section className="settings-worktrees-section" aria-labelledby="worktree-recovery-heading">
            <h2 id="worktree-recovery-heading">{t("Recovery snapshots")}</h2>
            <p>{t("Restore returns the directory to its original path and never overwrites an existing directory.")}</p>
            <ul className="settings-worktrees-list">{state.data.snapshots.map((snapshot) => {
              const owner = state.data?.entries.find((entry) => entry.ownerId === snapshot.ownerId && entry.ownerKind === snapshot.ownerKind);
              return <li key={snapshot.id} className="settings-worktree-entry">
                <strong>{snapshot.ownerName}</strong><time dateTime={snapshot.createdAt}>{new Date(snapshot.createdAt).toLocaleString()}</time>
                {snapshot.errorMessage ? <InlineFeedback tone="danger">{snapshot.errorMessage}</InlineFeedback> : null}
                <div className="settings-worktree-actions"><Button size="sm" variant="secondary" leadingIcon={<RotateCcw size={15} />}
                  disabled={disabled || !owner || owner.inUse || owner.status === "ready"} onClick={() => void state.perform(snapshot, "restore", snapshot.id)}>{t("Restore worktree")}</Button></div>
              </li>;
            })}</ul>
          </section> : null}
        </>
      ) : <Button size="sm" onClick={() => void state.refresh()}>{t("Retry")}</Button>}
      <Dialog open={Boolean(target)} busy={Boolean(state.busy)} onOpenChange={(open) => { if (!open) state.closeCleanup(); }}>
        <DialogContent size="sm"
          onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); (returnRef.current?.isConnected ? returnRef.current : refreshRef.current)?.focus(); }}>
          <DialogHeader closeLabel={t("Close")} title={t("Clean up worktree?")} description={t("The complete worktree will be saved as a recovery snapshot before its original path is removed.")} />
          <DialogBody>
            <div className="settings-worktree-confirm-target"><strong>{target?.ownerName}</strong><code>{target?.path}</code></div>
            {state.cleanupError ? <InlineFeedback tone="danger">{state.cleanupError}</InlineFeedback> : null}
          </DialogBody>
          <DialogFooter>
            <Button ref={cancelRef} size="sm" variant="secondary" disabled={Boolean(state.busy)} onClick={state.closeCleanup}>{t("Cancel")}</Button>
            <Button leadingIcon={<Trash2 size={15} />} size="sm" variant="danger" loading={Boolean(state.busy)} loadingLabel={t("Cleaning up...")}
              onClick={() => { if (target) void state.perform(target, "cleanup"); }}>{t("Clean up worktree")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusLabel(entry: ManagedWorktreeEntry, t: Translate): string {
  if (entry.status === "ready") return t("Ready");
  if (entry.status === "missing") return t("Missing");
  if (entry.status === "not_created") return t("Not created");
  return t("Blocked");
}
