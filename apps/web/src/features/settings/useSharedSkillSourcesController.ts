import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewSharedSkillSources, publishSharedSkillSources } from "../../api.js";
import type { SharedSkillSourceScanResponse, SkillSourceSyncPreviewRecord } from "../../types.js";
import {
  actionableSharedSkillCount,
  canIgnoreSharedSkill,
  canPublishSharedSkill,
  readIgnoredSharedSkills,
  sharedSkillIgnoreStorageKey,
  sharedSkillSourceKey,
} from "./shared-skill-sources-model.js";

export function useSharedSkillSourcesController({ cwd, active, refreshToken, onPublished }: {
  readonly cwd: string;
  readonly active: boolean;
  readonly refreshToken: number;
  readonly onPublished: () => Promise<void>;
}) {
  const [response, setResponse] = useState<SharedSkillSourceScanResponse>();
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => readIgnoredSharedSkills(globalThis.localStorage, cwd));
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectedRef = useRef<ReadonlySet<string>>(selected);
  selectedRef.current = selected;
  const [confirming, setConfirming] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);

  const refresh = useCallback(async (preserveSelection = false) => {
    if (!cwd.trim()) return;
    const previousSelection = selectedRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await previewSharedSkillSources(cwd.trim());
      setResponse(result);
      setSelected(preserveSelection ? new Set(previousSelection) : new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setResponse(undefined);
    setSelected(new Set());
    setIgnored(readIgnoredSharedSkills(globalThis.localStorage, cwd));
  }, [cwd]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh, refreshToken]);

  const records = response?.preview.records ?? [];
  const actionableCount = useMemo(() => actionableSharedSkillCount(records, ignored), [records, ignored]);
  const selectedRecords = records.filter((record) => selected.has(sharedSkillSourceKey(record)) && canPublishSharedSkill(record) && !ignored.has(sharedSkillSourceKey(record)));
  const hasNewSkills = selectedRecords.some((record) => record.state === "new");

  function toggleSelected(record: SkillSourceSyncPreviewRecord): void {
    const key = sharedSkillSourceKey(record);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function ignore(record: SkillSourceSyncPreviewRecord): void {
    const key = sharedSkillSourceKey(record);
    if (!canIgnoreSharedSkill(record) && !ignored.has(key)) return;
    const next = new Set(ignored);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setIgnored(next);
    setSelected((current) => new Set([...current].filter((item) => item !== key)));
    try { globalThis.localStorage.setItem(sharedSkillIgnoreStorageKey(cwd), JSON.stringify([...next])); } catch { /* Private storage may be unavailable. */ }
  }

  function requestPublish(record?: SkillSourceSyncPreviewRecord): void {
    if (record) setSelected(new Set([sharedSkillSourceKey(record)]));
    setConfirmNew(false);
    setConfirming(true);
  }

  async function publish(): Promise<void> {
    if (selectedRecords.length === 0 || publishing || (hasNewSkills && !confirmNew)) return;
    setPublishing(true);
    setError("");
    try {
      await publishSharedSkillSources(cwd.trim(), {
        selectedSkillIds: selectedRecords.map((record) => record.skillId),
        allowNewSkills: hasNewSkills && confirmNew,
        publishArtifacts: true,
      });
      setConfirming(false);
      await onPublished();
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Keep the confirmation open and the selected candidates checked so the user can retry.
      await refresh(true);
      setError(message);
    } finally {
      setPublishing(false);
    }
  }

  return {
    response, records, ignored, selected, selectedRecords, actionableCount,
    hasNewSkills, confirmNew, setConfirmNew, confirming, setConfirming,
    loading, publishing, error, refresh, toggleSelected, ignore, requestPublish, publish,
  } as const;
}

export type SharedSkillSourcesController = ReturnType<typeof useSharedSkillSourcesController>;
