import type { SkillDefinition } from "@ling-stack/core/skill-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveSkill,
  createSkillImportDraft,
  getSkillSourceHealth,
  listSkills,
  listTeammateSkills,
  publishSkillImportDraft,
  replaceTeammateSkills,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type {
  EffectiveTeammateSkill,
  SkillImportDraft,
  SkillRegistryEntry,
  SkillSourceSnapshot,
  TeammateSkillBinding,
} from "../../types.js";
import { normalizeManualSkillId } from "./teammate-workspace-utils.js";
import type {
  SkillImportForm,
  TeammateSkillsController,
  TeammateSkillsSnapshot,
} from "./teammate-skills-controller-types.js";
import {
  buildTeammateSkillRows,
  filterTeammateSkillRows,
  importDraftHasErrors,
  summarizeTeammateSkills,
  type SkillBindingFilter,
} from "./teammate-skills-view-models.js";

const emptyImportForm: SkillImportForm = { name: "", sourcePath: "", source: "custom", content: "" };

export function useTeammateSkillsController({
  cwd,
  fallbackDefinitions,
  teammateId,
}: {
  readonly cwd: string;
  readonly fallbackDefinitions: readonly SkillDefinition[];
  readonly teammateId: string;
}): TeammateSkillsController {
  const { t } = useI18n();
  const { dismissToast, showToast } = useLingToast();
  const teammateIdRef = useRef(teammateId);
  const operationSequenceRef = useRef(0);
  const feedbackToastIdRef = useRef("");
  const mutationKeyRef = useRef("");
  const snapshotSequenceRef = useRef(0);
  teammateIdRef.current = teammateId;

  const [registryEntries, setRegistryEntries] = useState<readonly SkillRegistryEntry[]>([]);
  const [bindings, setBindings] = useState<readonly TeammateSkillBinding[]>([]);
  const [effectiveSkills, setEffectiveSkills] = useState<readonly EffectiveTeammateSkill[]>([]);
  const [sourceSnapshots, setSourceSnapshots] = useState<readonly SkillSourceSnapshot[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<SkillBindingFilter>("all");
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [archiveSkillId, setArchiveSkillId] = useState("");
  const [manualSkillId, setManualSkillIdState] = useState("");
  const [manualSkillIdError, setManualSkillIdError] = useState("");
  const [importOpen, setImportOpenState] = useState(false);
  const [importForm, setImportForm] = useState<SkillImportForm>(emptyImportForm);
  const [importDraft, setImportDraft] = useState<SkillImportDraft>();
  const [importError, setImportError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [mutationKey, setMutationKey] = useState("");

  const rows = useMemo(() => buildTeammateSkillRows({
    bindings,
    effectiveSkills,
    fallbackDefinitions,
    registryEntries,
    sourceSnapshots,
    t,
  }), [bindings, effectiveSkills, fallbackDefinitions, registryEntries, sourceSnapshots, t]);
  const visibleRows = useMemo(
    () => filterTeammateSkillRows(rows, searchQuery, filter),
    [filter, rows, searchQuery],
  );
  const stats = useMemo(() => summarizeTeammateSkills(rows), [rows]);
  const selectedRow = rows.find((row) => row.id === selectedSkillId);
  const archiveConfirmRow = rows.find((row) => row.id === archiveSkillId);

  useEffect(() => {
    if (feedbackToastIdRef.current) dismissToast(feedbackToastIdRef.current);
    feedbackToastIdRef.current = "";
    operationSequenceRef.current += 1;
    snapshotSequenceRef.current += 1;
    setRegistryEntries([]);
    setBindings([]);
    setEffectiveSkills([]);
    setSourceSnapshots([]);
    setSearchQuery("");
    setFilter("all");
    setSelectedSkillId("");
    setDetailsOpen(false);
    setArchiveSkillId("");
    setManualSkillIdState("");
    setManualSkillIdError("");
    setImportOpenState(false);
    setImportForm(emptyImportForm);
    setImportDraft(undefined);
    setImportError("");
    setFeedback("");
    mutationKeyRef.current = "";
    setMutationKey("");
  }, [dismissToast, teammateId]);

  const beginSnapshotRequest = useCallback((snapshotTeammateId: string): number => {
    if (snapshotTeammateId !== teammateIdRef.current) return -1;
    snapshotSequenceRef.current += 1;
    return snapshotSequenceRef.current;
  }, []);

  const applySnapshot = useCallback((snapshotTeammateId: string, requestId: number, snapshot: TeammateSkillsSnapshot): void => {
    if (snapshotTeammateId !== teammateIdRef.current || requestId !== snapshotSequenceRef.current) return;
    applyAuthoritativeSnapshot(snapshot);
  }, []);

  function openDetails(skillId: string): void {
    dismissSkillToast();
    setSelectedSkillId(skillId);
    setDetailsOpen(true);
  }

  function closeDetails(): void { setDetailsOpen(false); }

  function setImportOpen(open: boolean): void {
    if (mutationKeyRef.current === "import:preview" || mutationKeyRef.current === "import:publish") return;
    setImportOpenState(open);
    if (!open) setImportError("");
  }

  function updateImportForm(form: SkillImportForm): void {
    setImportForm(form);
    setImportDraft(undefined);
    setImportError("");
  }

  function setManualSkillId(value: string): void {
    setManualSkillIdState(value);
    setManualSkillIdError("");
  }

  function clearFilters(): void { setSearchQuery(""); setFilter("all"); }

  async function toggleBinding(skillId: string): Promise<void> {
    const binding = bindings.find((item) => item.skillId === skillId);
    const nextBindings = binding
      ? bindings.map((item) => item.skillId === skillId
        ? { skillId: item.skillId, source: item.source, enabled: !item.enabled }
        : { skillId: item.skillId, source: item.source, enabled: item.enabled })
      : [
        ...bindings.map((item) => ({ skillId: item.skillId, source: item.source, enabled: item.enabled })),
        { skillId, source: "user" as const, enabled: true },
      ];
    await saveBindings(nextBindings, `${binding?.enabled ? "disable" : "enable"}:${skillId}`, binding?.enabled
      ? t("Skill disabled for teammate")
      : t("Skill enabled for teammate"));
  }

  async function removeBinding(skillId: string): Promise<void> {
    const binding = bindings.find((item) => item.skillId === skillId);
    if (!binding || binding.source !== "user") return;
    const nextBindings = bindings
      .filter((item) => item.skillId !== skillId)
      .map((item) => ({ skillId: item.skillId, source: item.source, enabled: item.enabled }));
    await saveBindings(nextBindings, `remove:${skillId}`, t("Skill removed from teammate"));
  }

  async function bindManualSkill(): Promise<void> {
    const normalizedId = normalizeManualSkillId(manualSkillId);
    if (!normalizedId) {
      setManualSkillIdError(t("Enter a skill id first"));
      return;
    }
    const binding = bindings.find((item) => item.skillId === normalizedId);
    if (binding?.enabled) {
      setManualSkillIdError(t("Skill already exists"));
      return;
    }
    const nextBindings = binding
      ? bindings.map((item) => item.skillId === normalizedId
        ? { skillId: item.skillId, source: item.source, enabled: true }
        : { skillId: item.skillId, source: item.source, enabled: item.enabled })
      : [
        ...bindings.map((item) => ({ skillId: item.skillId, source: item.source, enabled: item.enabled })),
        { skillId: normalizedId, source: "user" as const, enabled: true },
      ];
    const saved = await saveBindings(nextBindings, `manual:${normalizedId}`, t("Skill enabled for teammate"));
    if (saved) setManualSkillIdState("");
  }

  async function saveBindings(
    nextBindings: readonly { readonly skillId: string; readonly source?: TeammateSkillBinding["source"]; readonly enabled?: boolean }[],
    key: string,
    successMessage: string,
  ): Promise<boolean> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !beginMutation(key)) return false;
    const operationId = ++operationSequenceRef.current;
    const operationTeammateId = teammateId;
    setFeedback("");
    setManualSkillIdError("");
    try {
      const response = await replaceTeammateSkills(workspaceCwd, operationTeammateId, nextBindings);
      if (!isCurrentOperation(operationId, operationTeammateId)) return false;
      setBindings(response.bindings);
      setEffectiveSkills(response.effectiveSkills ?? []);
      showSkillToast({ message: successMessage, scope: `teammate:skills:${operationTeammateId}:${key}` });
      return true;
    } catch {
      if (isCurrentOperation(operationId, operationTeammateId)) {
        setFeedback(t("Skill changes were not saved. Try again."));
      }
      return false;
    } finally {
      if (isCurrentOperation(operationId, operationTeammateId)) finishMutation(key);
    }
  }

  async function previewImport(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !importForm.content.trim() || !beginMutation("import:preview")) {
      if (!importForm.content.trim()) setImportError(t("Paste skill content first"));
      return;
    }
    const operationId = ++operationSequenceRef.current;
    const operationTeammateId = teammateId;
    setImportError("");
    try {
      const response = await createSkillImportDraft(workspaceCwd, {
        content: importForm.content,
        source: importForm.source,
        sourcePath: importForm.sourcePath.trim() || undefined,
        name: importForm.name.trim() || undefined,
      });
      if (!isCurrentOperation(operationId, operationTeammateId)) return;
      setImportDraft(response.draft);
    } catch {
      if (isCurrentOperation(operationId, operationTeammateId)) {
        setImportError(t("Skill draft could not be checked. Try again."));
      }
    } finally {
      if (isCurrentOperation(operationId, operationTeammateId)) finishMutation("import:preview");
    }
  }

  async function publishImport(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !importDraft || importDraftHasErrors(importDraft) || !beginMutation("import:publish")) return;
    const operationId = ++operationSequenceRef.current;
    const operationTeammateId = teammateId;
    setImportError("");
    try {
      const response = await publishSkillImportDraft(workspaceCwd, importDraft.id);
      const [registryResponse, skillResponse, sourceResponse] = await Promise.all([
        listSkills(workspaceCwd),
        listTeammateSkills(workspaceCwd, operationTeammateId),
        getSkillSourceHealth(workspaceCwd, { limit: 100 }),
      ]);
      if (!isCurrentOperation(operationId, operationTeammateId)) return;
      applyAuthoritativeSnapshot({
        registryEntries: registryResponse.skills,
        sourceSnapshots: sourceResponse.snapshots,
        bindings: skillResponse.bindings,
        effectiveSkills: skillResponse.effectiveSkills ?? [],
      });
      setImportOpenState(false);
      setImportForm(emptyImportForm);
      setImportDraft(undefined);
      showSkillToast({
        message: response.skills.length === 1
          ? t("Published 1 skill")
          : t("Published {count} skills", { count: response.skills.length }),
        scope: `teammate:skills:${operationTeammateId}:publish`,
      });
    } catch {
      if (isCurrentOperation(operationId, operationTeammateId)) {
        setImportError(t("Skill draft could not be published. Try again."));
      }
    } finally {
      if (isCurrentOperation(operationId, operationTeammateId)) finishMutation("import:publish");
    }
  }

  function requestArchive(skillId?: string): void {
    if (!mutationKeyRef.current) setArchiveSkillId(skillId ?? "");
  }

  async function archiveSkillFromRegistry(): Promise<void> {
    const workspaceCwd = cwd.trim();
    const archiveMutationKey = archiveConfirmRow ? `archive:${archiveConfirmRow.id}` : "";
    if (!workspaceCwd || !archiveConfirmRow || !beginMutation(archiveMutationKey)) return;
    const skillId = archiveConfirmRow.id;
    const operationId = ++operationSequenceRef.current;
    const operationTeammateId = teammateId;
    setFeedback("");
    try {
      await archiveSkill(workspaceCwd, skillId);
      const [registryResponse, sourceResponse] = await Promise.all([
        listSkills(workspaceCwd),
        getSkillSourceHealth(workspaceCwd, { limit: 100 }),
      ]);
      if (!isCurrentOperation(operationId, operationTeammateId)) return;
      setRegistryEntries(registryResponse.skills);
      setSourceSnapshots(sourceResponse.snapshots);
      setArchiveSkillId("");
      if (selectedSkillId === skillId) setDetailsOpen(false);
      showSkillToast({ message: t("Skill archived"), scope: `teammate:skills:${operationTeammateId}:archive:${skillId}` });
    } catch {
      if (isCurrentOperation(operationId, operationTeammateId)) {
        setFeedback(t("Skill could not be archived. Try again."));
        setArchiveSkillId("");
      }
    } finally {
      if (isCurrentOperation(operationId, operationTeammateId)) finishMutation(archiveMutationKey);
    }
  }

  function isCurrentOperation(operationId: number, operationTeammateId: string): boolean {
    return operationSequenceRef.current === operationId && teammateIdRef.current === operationTeammateId;
  }

  function beginMutation(key: string): boolean {
    if (!key || mutationKeyRef.current) return false;
    snapshotSequenceRef.current += 1;
    mutationKeyRef.current = key;
    setMutationKey(key);
    return true;
  }

  function finishMutation(key: string): void {
    if (mutationKeyRef.current !== key) return;
    mutationKeyRef.current = "";
    setMutationKey("");
  }

  function showSkillToast(input: { readonly message: string; readonly scope: string }): void {
    if (feedbackToastIdRef.current) dismissToast(feedbackToastIdRef.current);
    feedbackToastIdRef.current = showToast({ ...input, tone: "success" });
  }

  function dismissSkillToast(): void {
    if (!feedbackToastIdRef.current) return;
    dismissToast(feedbackToastIdRef.current);
    feedbackToastIdRef.current = "";
  }

  function applyAuthoritativeSnapshot(snapshot: TeammateSkillsSnapshot): void {
    setRegistryEntries(snapshot.registryEntries);
    setSourceSnapshots(snapshot.sourceSnapshots);
    setBindings(snapshot.bindings);
    setEffectiveSkills(snapshot.effectiveSkills);
  }

  return {
    archiveConfirmRow,
    detailsOpen,
    effectiveSkills,
    feedback,
    filter,
    importDraft,
    importError,
    importForm,
    importOpen,
    manualSkillId,
    manualSkillIdError,
    mutationBusy: Boolean(mutationKey),
    mutationKey,
    rows,
    searchQuery,
    selectedRow,
    stats,
    visibleRows,
    applySnapshot,
    beginSnapshotRequest,
    archiveSkillFromRegistry,
    bindManualSkill,
    clearFilters,
    closeDetails,
    openDetails,
    previewImport,
    publishImport,
    removeBinding,
    requestArchive,
    setFilter,
    setImportOpen,
    setManualSkillId,
    setSearchQuery,
    toggleBinding,
    updateImportForm,
  };
}
