import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowTemplateRegistryEntry, WorkflowTemplateReviewRequest } from "@ling-stack/contracts";
import { createChannelWorkflowFromTemplate } from "../../api/channels.js";
import {
  getWorkflowTemplateVersion,
  listWorkflowTemplates,
  previewWorkflowTemplate,
  saveWorkflowTemplateVersion,
  setWorkflowTemplateReviewStatus,
} from "../../api/workflow-templates.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import {
  importedWorkflowTemplateSession,
  newWorkflowTemplateSession,
  validateWorkflowTemplateDraft,
  workflowTemplateCreateRequest,
  workflowTemplateDraftDirty,
  workflowTemplateHasExplicitAutoStart,
  workflowTemplateIsConflict,
  workflowTemplatePreviewKey,
  workflowTemplatePublishedPin,
  workflowTemplateSessionFromVersion,
  type WorkflowTemplateDraft,
  type WorkflowTemplateEditorSession,
  type WorkflowTemplatePreviewSnapshot,
} from "./workflow-template-authoring-model.js";

type BusyAction = "" | "loading" | "saving" | "reviewing" | "previewing" | "creating" | "importing";
interface Operation { readonly sequence: number; readonly cwd: string }

export function useWorkflowTemplateAuthoringController({
  cwd, active, refreshToken, onSuccess, t,
}: {
  readonly cwd: string;
  readonly active: boolean;
  readonly refreshToken: number;
  readonly onSuccess: (message: string) => void;
  readonly t: SettingsTranslator;
}) {
  const workspace = cwd.trim();
  const [entries, setEntries] = useState<readonly WorkflowTemplateRegistryEntry[]>([]);
  const [session, setSession] = useState<WorkflowTemplateEditorSession>();
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<BusyAction>("");
  const [discardConfirmation, setDiscardConfirmation] = useState(false);
  const [channelId, setChannelIdState] = useState("");
  const [objective, setObjectiveState] = useState("");
  const [preview, setPreview] = useState<WorkflowTemplatePreviewSnapshot>();
  const [createdWorkflowId, setCreatedWorkflowId] = useState("");
  const mounted = useRef(true);
  const workspaceRef = useRef(workspace);
  const sessionRef = useRef(session);
  const previewKeyRef = useRef("");
  const listSequence = useRef(0);
  const operationSequence = useRef(0);
  const busyRef = useRef(false);
  const pendingLeave = useRef<(() => void) | undefined>(undefined);
  workspaceRef.current = workspace;
  sessionRef.current = session;
  previewKeyRef.current = session ? workflowTemplatePreviewKey(session, channelId, objective) : "";
  const dirty = workflowTemplateDraftDirty(session);
  const validation = useMemo(() => session ? validateWorkflowTemplateDraft(session.draft) : { error: "" }, [session?.draft]);
  const createRequest = session ? workflowTemplateCreateRequest(session, channelId, objective, preview) : undefined;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operationSequence.current++; listSequence.current++; };
  }, []);

  useEffect(() => {
    operationSequence.current++;
    listSequence.current++;
    busyRef.current = false;
    pendingLeave.current = undefined;
    setSession(undefined);
    setEntries([]);
    setBusy("");
    setLoading(false);
    setError("");
    setListError("");
    setPreview(undefined);
    setChannelIdState("");
    setObjectiveState("");
    setCreatedWorkflowId("");
    setDiscardConfirmation(false);
  }, [workspace]);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const sequence = ++listSequence.current;
    setLoading(true);
    try {
      const response = await listWorkflowTemplates(workspace, { includeArchived: true });
      if (!mounted.current || workspaceRef.current !== workspace || sequence !== listSequence.current) return;
      setEntries(response.templates);
      setListError("");
    } catch (caught) {
      if (mounted.current && workspaceRef.current === workspace && sequence === listSequence.current) setListError(errorMessage(caught));
    } finally {
      if (mounted.current && workspaceRef.current === workspace && sequence === listSequence.current) setLoading(false);
    }
  }, [workspace]);

  useEffect(() => { if (active) void refresh(); }, [active, refresh, refreshToken]);

  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  function begin(action: Exclude<BusyAction, "">): Operation | undefined {
    if (busyRef.current || !workspace || workspaceRef.current !== workspace) return undefined;
    busyRef.current = true;
    setBusy(action);
    setError("");
    return { sequence: ++operationSequence.current, cwd: workspace };
  }

  function current(operation: Operation): boolean {
    return mounted.current && workspaceRef.current === operation.cwd && operationSequence.current === operation.sequence;
  }

  function finish(operation: Operation): void {
    if (!current(operation)) return;
    busyRef.current = false;
    setBusy("");
  }

  function report(operation: Operation, caught: unknown): void {
    if (!current(operation)) return;
    setPreview(undefined);
    if (workflowTemplateIsConflict(caught)) {
      setSession((value) => value ? { ...value, conflict: true } : value);
      setError(t("Template changed elsewhere. Reload the latest version before saving."));
    } else setError(errorMessage(caught));
  }

  function upsert(entry: WorkflowTemplateRegistryEntry): void {
    listSequence.current++;
    setLoading(false);
    setEntries((rows) => [...rows.filter((row) => row.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id)));
  }

  function resetPreview(): void { setPreview(undefined); setCreatedWorkflowId(""); }

  function requestLeave(action: () => void): void {
    if (busyRef.current) return;
    if (workflowTemplateDraftDirty(sessionRef.current)) {
      pendingLeave.current = action;
      setDiscardConfirmation(true);
    } else action();
  }

  function confirmDiscard(): void {
    if (busyRef.current) return;
    const action = pendingLeave.current;
    pendingLeave.current = undefined;
    setDiscardConfirmation(false);
    setSession((value) => value ? { ...value, draft: value.baseline } : value);
    resetPreview();
    action?.();
  }

  function continueEditing(): void { pendingLeave.current = undefined; setDiscardConfirmation(false); }

  function newTemplate(): void {
    requestLeave(() => {
      setSession(newWorkflowTemplateSession(`workflow-${globalThis.crypto.randomUUID()}`));
      setError("");
      resetPreview();
    });
  }

  async function loadEntry(entry: WorkflowTemplateRegistryEntry): Promise<void> {
    const operation = begin("loading");
    if (!operation) return;
    try {
      const response = await getWorkflowTemplateVersion(operation.cwd, entry.id, entry.latestVersion);
      if (!current(operation)) return;
      if (response.version.id !== entry.id || response.version.version !== response.entry.latestVersion) {
        throw new Error(t("Template changed while loading. Refresh and try again."));
      }
      setSession(workflowTemplateSessionFromVersion(response.entry, response.version));
      upsert(response.entry);
      resetPreview();
    } catch (caught) { report(operation, caught); }
    finally { finish(operation); }
  }

  function selectEntry(entry: WorkflowTemplateRegistryEntry): void {
    if (entry.id === session?.entry?.id) return;
    requestLeave(() => { void loadEntry(entry); });
  }

  function reloadLatest(): void {
    const id = session?.entry?.id ?? session?.draft.template.id;
    if (!id) return;
    requestLeave(() => {
      void (async () => {
        const operation = begin("loading");
        if (!operation) return;
        let entry: WorkflowTemplateRegistryEntry | undefined;
        try {
          const response = await listWorkflowTemplates(operation.cwd, { includeArchived: true });
          if (!current(operation)) return;
          entry = response.templates.find((row) => row.id === id);
          if (!entry) throw new Error(t("Template no longer exists."));
        } catch (caught) { report(operation, caught); }
        finally { finish(operation); }
        if (entry && current(operation)) await loadEntry(entry);
      })();
    });
  }

  function setDraft(draft: WorkflowTemplateDraft): void {
    if (busyRef.current) return;
    setSession((value) => value ? { ...value, draft } : value);
    setError("");
    resetPreview();
  }

  async function save(): Promise<void> {
    if (!session || session.conflict || !dirty) return;
    const checked = validateWorkflowTemplateDraft(session.draft);
    if (!checked.template) { setError(checked.error); return; }
    const operation = begin("saving");
    if (!operation) return;
    try {
      const response = await saveWorkflowTemplateVersion(operation.cwd, {
        id: checked.template.id, version: session.draft.version, template: checked.template,
        expectedRevision: session.entry?.revision ?? 0,
      });
      if (!current(operation)) return;
      setSession(workflowTemplateSessionFromVersion(response.entry, response.version));
      upsert(response.entry);
      resetPreview();
      onSuccess(t("Workflow template draft saved"));
    } catch (caught) { report(operation, caught); }
    finally { finish(operation); }
  }

  async function review(reviewStatus: "draft" | "published" | "disabled" | "archived"): Promise<void> {
    if (!session?.entry || !session.savedVersion || dirty || session.conflict) return;
    const operation = begin("reviewing");
    if (!operation) return;
    try {
      const input: WorkflowTemplateReviewRequest = reviewStatus === "published"
        ? { expectedRevision: session.entry.revision, reviewStatus, version: session.savedVersion.version, digest: session.savedVersion.digest }
        : { expectedRevision: session.entry.revision, reviewStatus };
      const response = await setWorkflowTemplateReviewStatus(operation.cwd, session.entry.id, input);
      if (!current(operation)) return;
      setSession((value) => value ? { ...value, entry: response.entry } : value);
      upsert(response.entry);
      resetPreview();
      onSuccess(t("Workflow template status updated"));
    } catch (caught) { report(operation, caught); }
    finally { finish(operation); }
  }

  async function compilePreview(): Promise<void> {
    if (!session || !channelId || !objective.trim() || session.conflict) return;
    const checked = validateWorkflowTemplateDraft(session.draft);
    if (!checked.template) { setError(checked.error); return; }
    const operation = begin("previewing");
    if (!operation) return;
    const key = workflowTemplatePreviewKey(session, channelId, objective);
    const pin = workflowTemplatePublishedPin(session);
    resetPreview();
    try {
      const result = await previewWorkflowTemplate(operation.cwd, {
        channelId, objective: objective.trim(),
        ...(pin ? { customTemplateId: pin.id, customTemplateVersion: pin.version, customTemplateDigest: pin.digest }
          : { customTemplate: checked.template }),
        ...(workflowTemplateHasExplicitAutoStart(checked.template) ? { confirmUnsafeAutoStart: true } : {}),
      });
      if (current(operation) && previewKeyRef.current === key) setPreview({ key, result });
    } catch (caught) { report(operation, caught); }
    finally { finish(operation); }
  }

  async function createWorkflow(): Promise<void> {
    if (!session || createdWorkflowId) return;
    const request = workflowTemplateCreateRequest(session, channelId, objective, preview);
    if (!request) return;
    const operation = begin("creating");
    if (!operation) return;
    try {
      const response = await createChannelWorkflowFromTemplate(operation.cwd, channelId, request);
      if (!current(operation)) return;
      setCreatedWorkflowId(response.workflow.id);
      onSuccess(t("Workflow created"));
    } catch (caught) { report(operation, caught); }
    finally { finish(operation); }
  }

  async function importFile(file: File): Promise<void> {
    const operation = begin("importing");
    if (!operation) return;
    let imported: WorkflowTemplateEditorSession | undefined;
    try {
      if (file.size > 4_194_304) throw new Error(t("Template file exceeds 4 MiB."));
      imported = importedWorkflowTemplateSession(await file.text());
    } catch (caught) { report(operation, caught); }
    finally { finish(operation); }
    if (imported && current(operation)) {
      const next = imported;
      requestLeave(() => { setSession(next); setError(""); resetPreview(); });
    }
  }

  function exportJson(): void {
    if (!validation.template || !session) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(validation.template, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${validation.template.id.replace(/[^a-zA-Z0-9_.-]/gu, "_")}.json`;
    link.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return {
    entries, session, loading, listError, error, busy, dirty, validation, preview, channelId, objective,
    discardConfirmation, createdWorkflowId, canCreate: Boolean(createRequest && !createdWorkflowId),
    refresh, newTemplate, selectEntry, setDraft, save, review, compilePreview, createWorkflow,
    importFile, exportJson, reloadLatest, requestLeave, confirmDiscard, continueEditing,
    closeEditor: () => requestLeave(() => { setSession(undefined); setError(""); resetPreview(); }),
    setChannelId: (value: string) => { setChannelIdState(value); resetPreview(); },
    setObjective: (value: string) => { setObjectiveState(value); resetPreview(); },
  } as const;
}

export type WorkflowTemplateAuthoringController = ReturnType<typeof useWorkflowTemplateAuthoringController>;
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
