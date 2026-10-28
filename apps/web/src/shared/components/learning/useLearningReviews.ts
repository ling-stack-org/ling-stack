import { useCallback, useEffect, useRef, useState } from "react";
import { cancelLearningReview, createLearningReview, getLearningReviewPolicy, listLearningReviews,
  listProviders, updateLearningReviewPolicy, getRun } from "../../../api.js";
import type { LearningReviewJob, LearningReviewPolicy, ProviderPreset } from "../../../types.js";

/** The caller keys the view by workspace/source; late reads cannot repaint another source. */
export function useLearningReviews(cwd: string, runId?: string, decisionId?: string) {
  const [jobs, setJobs] = useState<readonly LearningReviewJob[]>([]);
  const [policy, setPolicy] = useState<LearningReviewPolicy>();
  const [providers, setProviders] = useState<readonly ProviderPreset[]>([]);
  const [providerId, setProviderId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sourceAvailable, setSourceAvailable] = useState(!runId);
  const alive = useRef(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const load = useCallback(async () => {
    const revision = ++generation.current;
    try {
      const [reviews, configuration, available, sourceRun] = await Promise.all([
        listLearningReviews(cwd, runId, decisionId), getLearningReviewPolicy(cwd), listProviders(cwd),
        runId ? getRun(runId, cwd) : Promise.resolve(undefined),
      ]);
      if (!alive.current || revision !== generation.current) return;
      const supported = available.providers.filter(provider => provider.enabled && provider.capabilities.includes("chat") &&
        provider.api === "openai-completions" && Boolean(provider.baseUrl) && !provider.reasoning);
      setJobs(reviews.jobs); setPolicy(configuration.policy); setProviders(supported);
      setSourceAvailable(!runId || Boolean(sourceRun && ["succeeded", "failed", "cancelled"].includes(sourceRun.status)));
      setProviderId(current => supported.some(provider => provider.id === current) ? current :
        supported.find(provider => provider.id === configuration.policy.providerPresetId)?.id ?? supported[0]?.id ?? "");
      setError("");
    } catch (caught) {
      if (alive.current && revision === generation.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [cwd, runId, decisionId]);
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; generation.current += 1; };
  }, [load]);
  const pending = jobs.some(job => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!pending && policy?.mode !== "propose") return;
    const timer = setInterval(() => { if (!mutation.current) void load(); }, pending ? 2000 : 30000);
    return () => clearInterval(timer);
  }, [load, pending, policy?.mode]);
  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    if (mutation.current) return;
    mutation.current = true; generation.current += 1; setBusy(id); setError("");
    try { await action(); if (alive.current) await load(); }
    catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { mutation.current = false; if (alive.current) setBusy(""); }
  }
  return { jobs, policy, providers, providerId, setProviderId, busy, error, sourceAvailable, refresh: load,
    save: (correction: string) => (runId || decisionId) && providerId ? act("save", () => createLearningReview(cwd, {
      runId, decisionId, providerPresetId: providerId, correction: correction.trim() || undefined,
    })) : Promise.resolve(),
    cancel: (id: string) => act(id, () => cancelLearningReview(cwd, id)),
    setMode: (mode: "off" | "propose") => policy ? act("policy", () => updateLearningReviewPolicy(cwd, {
      mode, providerPresetId: providerId || policy.providerPresetId, expectedRevision: policy.revision,
    })) : Promise.resolve(),
  };
}
