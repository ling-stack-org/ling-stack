import { useCallback, useEffect, useRef, useState } from "react";
import { isActiveCodeAssessment } from "@ling-stack/contracts";
import type { CodeAssessment, CodeAssessmentOverview, CodeAssessmentFreshness, CodeAssessmentKind, CreateCodeAssessmentRequest, CodeFindingDisposition, CodeFindingCloseReason } from "@ling-stack/contracts";
import * as api from "../../api/code-assessments.js";

export function useCodeAssessments(cwd: string, kind: CodeAssessmentKind) {
  const [items, setItems] = useState<readonly CodeAssessment[]>([]);
  const [detail, setDetail] = useState<CodeAssessmentOverview>();
  const [nextOffset, setNextOffset] = useState<number>();
  const [freshness, setFreshness] = useState<CodeAssessmentFreshness>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const scope = useRef(0);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectedId = useRef<string | undefined>(undefined);
  const actionBusy = useRef(false);

  const select = useCallback(async (id: string) => {
    const currentScope = scope.current;
    const request = ++detailRequest.current;
    selectedId.current = id;
    setDetail(undefined);
    setFreshness(undefined);
    try {
      const result = await api.getCodeAssessmentOverview(cwd, id);
      if (scope.current === currentScope && detailRequest.current === request) { setDetail(result); setFreshness(result.assessment.freshness); setError(undefined); }
    } catch (cause) { if (scope.current === currentScope && request === detailRequest.current) setError(String(cause instanceof Error ? cause.message : cause)); }
  }, [cwd]);

  const refresh = useCallback(async (offset = 0) => {
    const currentScope = scope.current;
    const request = ++listRequest.current;
    try {
      const result = await api.listCodeAssessments(cwd, kind, offset);
      if (scope.current !== currentScope || listRequest.current !== request) return;
      setItems(current => offset === 0 ? result.assessments : [...current, ...result.assessments.filter(item => !current.some(existing => existing.id === item.id))]);
      setNextOffset(result.nextOffset);
      setError(undefined);
      if (!selectedId.current && result.assessments[0]) await select(result.assessments[0].id);
      else if (selectedId.current) {
        const id = selectedId.current;
        const detailSequence = detailRequest.current;
        const next = await api.getCodeAssessmentOverview(cwd, id);
        if (scope.current === currentScope && selectedId.current === id && detailRequest.current === detailSequence && listRequest.current === request) { setDetail(next); setFreshness(next.assessment.freshness); }
      }
    } catch (cause) { if (scope.current === currentScope && listRequest.current === request) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (scope.current === currentScope && listRequest.current === request) setLoading(false); }
  }, [cwd, kind, select]);

  useEffect(() => {
    scope.current++;
    selectedId.current = undefined;
    actionBusy.current = false;
    setItems([]); setDetail(undefined); setFreshness(undefined); setNextOffset(undefined); setError(undefined); setBusy(false); setLoading(true);
    void refresh();
    return () => { scope.current++; };
  }, [refresh]);

  const active = items.some(item => isActiveCodeAssessment(item.status)) || Boolean(detail && isActiveCodeAssessment(detail.assessment.status));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { if (!actionBusy.current) void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const act = useCallback(async (operation: () => Promise<void>) => {
    if (actionBusy.current) return false;
    const currentScope = scope.current;
    detailRequest.current++;
    listRequest.current++;
    actionBusy.current = true; setBusy(true); setError(undefined);
    try { await operation(); return scope.current === currentScope; }
    catch (cause) { if (scope.current === currentScope) setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { if (scope.current === currentScope) { actionBusy.current = false; setBusy(false); } }
  }, []);

  const start = (input: CreateCodeAssessmentRequest) => act(async () => {
    const currentScope = scope.current;
    const next = await api.createCodeAssessmentOverview(cwd, input);
    if (scope.current !== currentScope) return;
    detailRequest.current++;
    selectedId.current = next.assessment.id;
    setDetail(next); setFreshness(undefined);
    await refresh();
  });
  const cancel = () => act(async () => {
    if (!detail) return;
    const currentScope = scope.current;
    await api.cancelCodeAssessment(cwd, detail.assessment.id);
    if (scope.current === currentScope) await refresh();
  });
  const disposition = (findingId: string, value: CodeFindingDisposition, reason?: string, closeReason?: CodeFindingCloseReason) => act(async () => {
    if (!detail) return;
    const currentScope = scope.current;
    const id = detail.assessment.id;
    const finding = await api.setCodeFindingDisposition(cwd, id, findingId, { snapshotDigest: detail.snapshot.digest, disposition: value, reason, closeReason });
    if (scope.current === currentScope && selectedId.current === id) setDetail(current => current?.assessment.id === id
      ? { ...current, findings: current.findings.map(item => item.id === finding.id ? finding : item) } : current);
  });
  const checkFreshness = () => act(async () => {
    if (!detail) return;
    const currentScope = scope.current;
    const result = await api.checkCodeAssessmentFreshness(cwd, detail.assessment.id);
    if (scope.current === currentScope && selectedId.current === detail.assessment.id) { setFreshness(result); await refresh(); }
  });
  return { items, detail, nextOffset, freshness, loading, busy, error, active, refresh, select, start, cancel, disposition, checkFreshness };
}
