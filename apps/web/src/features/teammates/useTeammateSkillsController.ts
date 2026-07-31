import type { SkillDefinition } from "@ling-stack/core/skill-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { replaceTeammateSkills } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type {
  EffectiveTeammateSkill,
  SkillRegistryEntry,
  SkillSourceSnapshot,
  TeammateSkillBinding,
} from "../../types.js";
import type { TeammateSkillsController, TeammateSkillsSnapshot } from "./teammate-skills-controller-types.js";
import {
  buildTeammateSkillRows,
  filterTeammateSkillRows,
  type SkillBindingFilter,
} from "./teammate-skills-view-models.js";

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
  const selectedRow = rows.find((row) => row.id === selectedSkillId);

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
    setRegistryEntries(snapshot.registryEntries);
    setSourceSnapshots(snapshot.sourceSnapshots);
    setBindings(snapshot.bindings);
    setEffectiveSkills(snapshot.effectiveSkills);
  }, []);

  function openDetails(skillId: string): void {
    dismissSkillToast();
    setSelectedSkillId(skillId);
    setDetailsOpen(true);
  }

  function closeDetails(): void {
    setDetailsOpen(false);
  }

  function clearFilters(): void {
    setSearchQuery("");
    setFilter("all");
  }

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

  async function saveBindings(
    nextBindings: readonly {
      readonly skillId: string;
      readonly source?: TeammateSkillBinding["source"];
      readonly enabled?: boolean;
    }[],
    key: string,
    successMessage: string,
  ): Promise<boolean> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !beginMutation(key)) return false;
    const operationId = ++operationSequenceRef.current;
    const operationTeammateId = teammateId;
    setFeedback("");
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

  return {
    detailsOpen,
    effectiveSkills,
    feedback,
    filter,
    mutationBusy: Boolean(mutationKey),
    mutationKey,
    rows,
    searchQuery,
    selectedRow,
    visibleRows,
    applySnapshot,
    beginSnapshotRequest,
    clearFilters,
    closeDetails,
    openDetails,
    removeBinding,
    setFilter,
    setSearchQuery,
    toggleBinding,
  };
}
