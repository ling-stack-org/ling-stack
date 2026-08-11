import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  exportMemoryMarkdown,
  importMemoryMarkdown,
  reviewMemory,
  updateMemoryReviewPolicy,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type {
  AiTeammate,
  Channel,
  MemoryMarkdownImportPlan,
  MemoryPromotionInboxItem,
  MemoryReviewAction,
  MemoryReviewMode,
} from "../../types.js";
import { downloadMemoryMarkdown } from "./teammate-memory-files.js";
import { loadTeammateMemorySnapshot } from "./teammate-memory-data.js";
import {
  buildTeammateMemoryViewModel,
  createMemoryEditForm,
  emptyMemoryReviewEditForm,
  isDestructiveMemoryReviewAction,
  memoryReviewActionMessage,
  type MemoryReviewEditForm,
  type MemoryTransferBusy,
  type TeammateMemoryDetail,
  type TeammateMemorySnapshot,
} from "./teammate-memory-view-models.js";

export function useTeammateMemoryController({
  channels,
  cwd,
  teammate,
}: {
  readonly channels: readonly Channel[];
  readonly cwd: string;
  readonly teammate: AiTeammate;
}) {
  const { t } = useI18n();
  const { dismissToast, showToast } = useLingToast();
  const identityKey = `${cwd.trim()}::${teammate.id}`;
  const identityRef = useRef(identityKey);
  const requestSequenceRef = useRef(0);
  const snapshotRef = useRef<TeammateMemorySnapshot | undefined>(undefined);
  const toastIdRef = useRef("");
  identityRef.current = identityKey;

  const [snapshot, setSnapshot] = useState<TeammateMemorySnapshot>();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState("");
  const [reviewingId, setReviewingId] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [detail, setDetail] = useState<TeammateMemoryDetail>();
  const [editId, setEditId] = useState("");
  const [editForm, setEditForm] = useState<MemoryReviewEditForm>(emptyMemoryReviewEditForm);
  const [pendingReview, setPendingReview] = useState<{ readonly item: MemoryPromotionInboxItem; readonly action: MemoryReviewAction }>();
  const [importOpen, setImportOpenState] = useState(false);
  const [importSourceLabel, setImportSourceLabel] = useState("");
  const [importContent, setImportContentState] = useState("");
  const [importPlan, setImportPlan] = useState<MemoryMarkdownImportPlan>();
  const [previewIdentity, setPreviewIdentity] = useState("");
  const [transferBusy, setTransferBusy] = useState<MemoryTransferBusy>("");
  const [importError, setImportError] = useState("");
  const [exportError, setExportError] = useState("");
  const [exportIncludeSecretAdjacent, setExportIncludeSecretAdjacent] = useState(false);

  const viewModel = useMemo(
    () => buildTeammateMemoryViewModel({ snapshot, teammate, channels, t }),
    [channels, snapshot, t, teammate],
  );
  const memoryById = useMemo(
    () => new Map((snapshot?.memories ?? []).map((memory) => [memory.id, memory])),
    [snapshot?.memories],
  );
  const importIdentity = `${importSourceLabel.trim()}::${importContent}`;

  const refresh = useCallback(async (mode: "initial" | "refresh" | "background" = "refresh"): Promise<void> => {
    const workspaceCwd = cwd.trim();
    const requestIdentity = `${workspaceCwd}::${teammate.id}`;
    const requestId = ++requestSequenceRef.current;
    if (!workspaceCwd) {
      setLoadError(t("Workspace path is required."));
      return;
    }
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setLoadError("");
    try {
      const nextSnapshot = await loadTeammateMemorySnapshot(workspaceCwd, teammate.id);
      if (identityRef.current !== requestIdentity || requestId !== requestSequenceRef.current) return;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setStale(false);
    } catch {
      if (identityRef.current !== requestIdentity || requestId !== requestSequenceRef.current) return;
      setStale(Boolean(snapshotRef.current));
      setLoadError(t("Memory could not be loaded. Try again."));
    } finally {
      if (identityRef.current === requestIdentity && requestId === requestSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [cwd, t, teammate.id]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    snapshotRef.current = undefined;
    setSnapshot(undefined);
    setLoading(false);
    setRefreshing(false);
    setStale(false);
    setLoadError("");
    setPolicySaving(false);
    setPolicyError("");
    setReviewError("");
    setReviewingId("");
    setDetail(undefined);
    setEditId("");
    setEditForm(emptyMemoryReviewEditForm);
    setPendingReview(undefined);
    resetImportState();
    setExportError("");
    setExportIncludeSecretAdjacent(false);
    if (toastIdRef.current) dismissToast(toastIdRef.current);
    toastIdRef.current = "";
    void refresh("initial");
  }, [dismissToast, identityKey, refresh]);

  async function changeReviewMode(mode: MemoryReviewMode): Promise<void> {
    const workspaceCwd = cwd.trim();
    const operationIdentity = identityRef.current;
    if (!workspaceCwd || policySaving || snapshot?.policy.mode === mode) return;
    setPolicySaving(true);
    setPolicyError("");
    try {
      const response = await updateMemoryReviewPolicy(workspaceCwd, { mode });
      if (identityRef.current !== operationIdentity || !snapshotRef.current) return;
      const nextSnapshot = { ...snapshotRef.current, policy: response.policy };
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      showSuccess("Memory review mode updated", "policy");
    } catch {
      if (identityRef.current === operationIdentity) setPolicyError(t("Memory review mode could not be saved. Try again."));
    } finally {
      if (identityRef.current === operationIdentity) setPolicySaving(false);
    }
  }

  async function exportProjection(): Promise<void> {
    const workspaceCwd = cwd.trim();
    const operationIdentity = identityRef.current;
    if (!workspaceCwd || transferBusy) return;
    setTransferBusy("export");
    setExportError("");
    try {
      const response = await exportMemoryMarkdown(workspaceCwd, {
        includeMarkdown: true,
        includeSecretAdjacent: exportIncludeSecretAdjacent,
      });
      if (identityRef.current !== operationIdentity) return;
      if (!("markdown" in response.export)) throw new Error("missing_memory_markdown");
      downloadMemoryMarkdown(response.export.suggestedFileName, response.export.markdown);
      showSuccess(
        exportIncludeSecretAdjacent
          ? t("Exported {count} memories", { count: response.export.memoryCount })
          : t("Exported {count} memories; secret-adjacent content stayed excluded", { count: response.export.memoryCount }),
        "export",
      );
    } catch {
      if (identityRef.current === operationIdentity) setExportError(t("Memory export failed. Try again."));
    } finally {
      if (identityRef.current === operationIdentity) setTransferBusy("");
    }
  }

  async function loadImportFile(file: File | undefined): Promise<void> {
    if (!file || transferBusy) return;
    try {
      const content = await file.text();
      setImportSourceLabel(file.name);
      updateImportContent(content);
      setImportError("");
    } catch {
      setImportError(t("The Markdown file could not be read. Try another file."));
    }
  }

  async function previewImport(): Promise<void> {
    await runImport("preview");
  }

  async function commitImport(): Promise<void> {
    if (!importPlan || previewIdentity !== importIdentity) {
      setImportError(t("Preview the current Markdown before importing."));
      return;
    }
    await runImport("import");
  }

  async function runImport(mode: "preview" | "import"): Promise<void> {
    const workspaceCwd = cwd.trim();
    const operationIdentity = identityRef.current;
    if (!workspaceCwd || transferBusy) return;
    if (!importContent.trim()) {
      setImportError(t("Paste or choose a Markdown export first"));
      return;
    }
    setTransferBusy(mode);
    setImportError("");
    try {
      const response = await importMemoryMarkdown(workspaceCwd, {
        markdown: importContent,
        sourceLabel: importSourceLabel.trim() || undefined,
        dryRun: mode === "preview",
      });
      if (identityRef.current !== operationIdentity) return;
      setImportPlan(response.plan);
      setPreviewIdentity(importIdentity);
      if (mode === "import") {
        await refresh("background");
        if (identityRef.current !== operationIdentity) return;
        showSuccess(t("Imported {count} candidates", { count: response.importedCount }), "import");
        resetImportState();
      }
    } catch {
      if (identityRef.current === operationIdentity) setImportError(t("Memory import failed. Check the Markdown and try again."));
    } finally {
      if (identityRef.current === operationIdentity) setTransferBusy("");
    }
  }

  function requestReview(item: MemoryPromotionInboxItem, action: MemoryReviewAction): void {
    setReviewError("");
    if (isDestructiveMemoryReviewAction(action)) setPendingReview({ item, action });
    else void applyReview(item, action);
  }

  async function confirmReview(): Promise<void> {
    if (!pendingReview) return;
    await applyReview(pendingReview.item, pendingReview.action);
  }

  async function applyReview(item: MemoryPromotionInboxItem, action: MemoryReviewAction): Promise<void> {
    const workspaceCwd = cwd.trim();
    const operationIdentity = identityRef.current;
    if (!workspaceCwd || reviewingId) return;
    if (action === "edit_and_approve" && (!editForm.title.trim() || !editForm.body.trim())) {
      setReviewError(t("Title and body are required before approval."));
      return;
    }
    setReviewingId(item.memory.id);
    setReviewError("");
    try {
      await reviewMemory(workspaceCwd, item.memory.id, action === "edit_and_approve" ? {
        action,
        actor: "local-user",
        reason: "Reviewed in teammate Memory management.",
        editedMemory: {
          title: editForm.title.trim(),
          body: editForm.body.trim(),
          sensitivity: editForm.sensitivity,
        },
      } : { action, actor: "local-user", reason: "Reviewed in teammate Memory management." });
      if (identityRef.current !== operationIdentity) return;
      await refresh("background");
      if (identityRef.current !== operationIdentity) return;
      setPendingReview(undefined);
      if (action !== "keep_candidate") setDetail(undefined);
      setEditId("");
      showSuccess(memoryReviewActionMessage(action), `review:${item.memory.id}`);
    } catch {
      if (identityRef.current === operationIdentity) {
        if (!isDestructiveMemoryReviewAction(action)) setPendingReview(undefined);
        setReviewError(t("Memory review action failed. Try again."));
      }
    } finally {
      if (identityRef.current === operationIdentity) setReviewingId("");
    }
  }

  function openMemoryDetail(nextDetail: TeammateMemoryDetail): void {
    setDetail(nextDetail);
    setEditId("");
    setReviewError("");
  }

  function startEdit(item: MemoryPromotionInboxItem): void {
    setDetail({ kind: "memory", item });
    setEditId(item.memory.id);
    setEditForm(createMemoryEditForm(item));
    setReviewError("");
  }

  function setImportOpen(open: boolean): void {
    if (transferBusy) return;
    if (open) setImportOpenState(true);
    else resetImportState();
  }

  function cancelPendingReview(): void {
    setPendingReview(undefined);
    setReviewError("");
  }

  function updateImportContent(value: string): void {
    setImportContentState(value);
    setImportPlan(undefined);
    setPreviewIdentity("");
    setImportError("");
  }

  function resetImportState(): void {
    setImportOpenState(false);
    setImportSourceLabel("");
    setImportContentState("");
    setImportPlan(undefined);
    setPreviewIdentity("");
    setImportError("");
    setTransferBusy("");
  }

  function showSuccess(messageKey: string, scope: string): void {
    if (toastIdRef.current) dismissToast(toastIdRef.current);
    toastIdRef.current = showToast({
      message: t(messageKey),
      scope: `teammate:memory:${teammate.id}:${scope}`,
      tone: "success",
    });
  }

  return {
    detail,
    editForm,
    editId,
    exportError,
    exportIncludeSecretAdjacent,
    importContent,
    importError,
    importOpen,
    importPlan,
    importPreviewCurrent: Boolean(importPlan && previewIdentity === importIdentity),
    importSourceLabel,
    loadError,
    loading,
    memoryById,
    pendingReview,
    policyError,
    policySaving,
    refreshing,
    reviewError,
    reviewingId,
    snapshot,
    stale,
    transferBusy,
    viewModel,
    changeReviewMode,
    closeDetail: () => setDetail(undefined),
    commitImport,
    confirmReview,
    exportProjection,
    loadImportFile,
    openMemoryDetail,
    previewImport,
    refresh,
    requestReview,
    setEditForm,
    setExportIncludeSecretAdjacent,
    setImportOpen,
    setImportSourceLabel,
    startEdit,
    updateImportContent,
    cancelPendingReview,
    cancelEdit: () => setEditId(""),
  };
}

export type TeammateMemoryController = ReturnType<typeof useTeammateMemoryController>;
