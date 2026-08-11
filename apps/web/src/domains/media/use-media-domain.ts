import { useEffect, useMemo, useRef, useState } from "react";
import { createMediaJob, listMediaJobArtifacts, listMediaJobs, runMediaJob } from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import { canUseGenerationProviderForOperation } from "../../lib/providers.js";
import { useLatestKeyedRequestGuard, useLatestRequestGuard } from "../../lib/use-latest-request.js";
import type { ApprovalRequest, MediaJob, MediaJobFormState, ProviderPreset } from "../../types.js";
import {
  artifactStateError,
  artifactStateReady,
  emptyMediaJobArtifactState,
  mediaJobArtifactRequestIdentity,
  mediaJobArtifactSignature,
  reconcileMediaJobArtifactStates,
} from "./media-domain-artifacts.js";
import {
  attachMediaJobsDomainBridge,
  type MediaJobArtifactState,
  type MediaJobArtifactsCompatMap,
  type MediaJobsDomainActions,
  type MediaJobsDomainState,
  type MediaJobsRefreshReason,
  type MediaMutationResult,
  type MediaScopedError,
  type MediaScopedErrorOwner,
} from "./media-domain-types.js";

export const defaultMediaJobForm: MediaJobFormState = {
  providerPresetId: "",
  operation: "image_generate",
  prompt: "",
  size: "",
  count: "",
  seed: "",
  ratio: "16:9",
  duration: "5",
  watermark: "",
  imageUrl: "",
  maskUrl: "",
  inputText: "",
};

export interface MediaState extends MediaJobsDomainState {
  readonly mediaJobArtifacts: MediaJobArtifactsCompatMap;
  readonly mediaJobsLoading: boolean;
  readonly runningMediaJobId: string;
  readonly mediaJobForm: MediaJobFormState;
}

export interface MediaActions extends MediaJobsDomainActions {
  readonly saveMediaJob: () => Promise<MediaMutationResult>;
}

export type MediaController = DomainController<MediaState, MediaActions>;

export function useMediaDomain(input: {
  readonly cwd: string;
  readonly translate: (value: string) => string;
  readonly providers: readonly ProviderPreset[];
  readonly upsertApproval: (approval: ApprovalRequest) => void;
  readonly refreshApprovals: (cwd: string) => Promise<void>;
}): MediaController {
  const [mediaJobs, setMediaJobs] = useState<readonly MediaJob[]>([]);
  const [artifactsByJob, setArtifactsByJob] = useState<Record<string, MediaJobArtifactState>>({});
  const [loadPhase, setLoadPhase] = useState<MediaJobsDomainState["loadPhase"]>("idle");
  const [createPhase, setCreatePhase] = useState<MediaJobsDomainState["createPhase"]>("idle");
  const [runningJobIds, setRunningJobIds] = useState<ReadonlySet<string>>(() => new Set());
  const [mediaJobForm, setMediaJobForm] = useState<MediaJobFormState>(defaultMediaJobForm);
  const [selectedMediaJobId, setSelectedMediaJobId] = useState("");
  const [errors, setErrors] = useState<readonly MediaScopedError[]>([]);
  const listGuard = useLatestRequestGuard();
  const artifactGuard = useLatestKeyedRequestGuard();
  const workspaceEpochRef = useRef(0);
  const mutationEpochRef = useRef(0);
  const listInFlightRef = useRef<Promise<void> | undefined>(undefined);
  const cwdRef = useRef(input.cwd.trim());
  const jobsRef = useRef(mediaJobs);
  const artifactsRef = useRef(artifactsByJob);
  const runningRef = useRef(runningJobIds);

  jobsRef.current = mediaJobs;
  artifactsRef.current = artifactsByJob;
  runningRef.current = runningJobIds;

  useEffect(() => {
    const cwd = input.cwd.trim();
    if (cwdRef.current === cwd) return;
    cwdRef.current = cwd;
    resetForCwd();
  }, [input.cwd]);

  useEffect(() => {
    if (selectedMediaJobId && mediaJobs.some((job) => job.id === selectedMediaJobId)) return;
    setSelectedMediaJobId(mediaJobs[0]?.id ?? "");
  }, [mediaJobs, selectedMediaJobId]);

  useEffect(() => {
    setMediaJobForm((current) => {
      if (current.providerPresetId) return current;
      const provider = input.providers.find((item) => canUseGenerationProviderForOperation(item, current.operation));
      return provider ? { ...current, providerPresetId: provider.id } : current;
    });
  }, [input.providers]);

  useEffect(() => {
    const cwd = input.cwd.trim();
    if (!cwd || !mediaJobs.some((job) => job.status === "queued" || job.status === "running")) return;
    const timer = window.setTimeout(() => void refreshMediaJobs(cwd, "poll"), 2_000);
    return () => window.clearTimeout(timer);
  }, [input.cwd, mediaJobs]);

  function clearMediaError(owner: MediaScopedErrorOwner): void {
    setErrors((current) => current.filter((item) => item.owner !== owner));
  }

  function writeError(owner: MediaScopedErrorOwner, caught: unknown): string {
    const message = caught instanceof Error ? caught.message : String(caught);
    setErrors((current) => [...current.filter((item) => item.owner !== owner), { owner, message }]);
    return message;
  }

  async function refreshMediaJobs(cwd = input.cwd, reason: MediaJobsRefreshReason = "manual"): Promise<void> {
    const normalizedCwd = cwd.trim();
    if (!normalizedCwd) {
      resetForCwd();
      return;
    }
    if (listInFlightRef.current) {
      if (reason === "poll") return listInFlightRef.current;
      listGuard.next();
      await listInFlightRef.current;
    }

    const task = performListRefresh(normalizedCwd, reason);
    listInFlightRef.current = task;
    try {
      await task;
    } finally {
      if (listInFlightRef.current === task) listInFlightRef.current = undefined;
    }
  }

  async function performListRefresh(cwd: string, reason: MediaJobsRefreshReason): Promise<void> {
    const token = listGuard.next();
    const workspaceEpoch = workspaceEpochRef.current;
    const mutationEpoch = mutationEpochRef.current;
    setLoadPhase(jobsRef.current.length === 0 ? "initial" : reason === "poll" ? "polling" : "refreshing");
    try {
      const response = await listMediaJobs(cwd);
      if (!isCurrentListRequest(cwd, workspaceEpoch, mutationEpoch, token)) return;
      const nextJobs = response.mediaJobs;
      const nextArtifacts = reconcileMediaJobArtifactStates(nextJobs, artifactsRef.current);
      jobsRef.current = nextJobs;
      artifactsRef.current = nextArtifacts;
      setMediaJobs(nextJobs);
      setArtifactsByJob(nextArtifacts);
      setSelectedMediaJobId((current) => current && nextJobs.some((job) => job.id === current) ? current : nextJobs[0]?.id ?? "");
      setErrors((current) => current.filter((item) => item.owner !== "load" && item.owner !== "refresh"));
      await loadArtifactsForJobs(cwd, nextJobs, workspaceEpoch);
    } catch (caught) {
      if (!listGuard.isCurrent(token) || cwdRef.current !== cwd || workspaceEpochRef.current !== workspaceEpoch) return;
      writeError(jobsRef.current.length > 0 ? "refresh" : "load", caught);
    } finally {
      if (listGuard.isCurrent(token) && workspaceEpochRef.current === workspaceEpoch) setLoadPhase("idle");
    }
  }

  function isCurrentListRequest(cwd: string, workspaceEpoch: number, mutationEpoch: number, token: number): boolean {
    return cwdRef.current === cwd && workspaceEpochRef.current === workspaceEpoch &&
      mutationEpochRef.current === mutationEpoch && listGuard.isCurrent(token);
  }

  async function loadArtifactsForJobs(cwd: string, jobs: readonly MediaJob[], workspaceEpoch: number): Promise<void> {
    const pending = jobs.filter((job) => job.artifactIds.length > 0 && artifactsRef.current[job.id]?.phase === "loading");
    await Promise.allSettled(pending.map((job) => loadArtifactsForJob(cwd, job, workspaceEpoch)));
  }

  async function loadArtifactsForJob(cwd: string, job: MediaJob, workspaceEpoch: number): Promise<void> {
    const identity = mediaJobArtifactRequestIdentity(cwd, job);
    const token = artifactGuard.next(identity);
    const signature = mediaJobArtifactSignature(job);
    try {
      const response = await listMediaJobArtifacts(job.id, cwd);
      if (!isCurrentArtifactRequest(identity, token, cwd, workspaceEpoch, job.id, signature)) return;
      updateArtifactState(job.id, artifactStateReady(signature, response.artifacts));
      clearMediaError(`artifacts:${job.id}`);
    } catch (caught) {
      if (!isCurrentArtifactRequest(identity, token, cwd, workspaceEpoch, job.id, signature)) return;
      const message = writeError(`artifacts:${job.id}`, caught);
      updateArtifactState(job.id, artifactStateError(signature, artifactsRef.current[job.id]?.artifacts ?? [], message));
    }
  }

  function isCurrentArtifactRequest(
    identity: string,
    token: number,
    cwd: string,
    workspaceEpoch: number,
    jobId: string,
    signature: string,
  ): boolean {
    return artifactGuard.isCurrent(identity, token) && cwdRef.current === cwd &&
      workspaceEpochRef.current === workspaceEpoch && artifactsRef.current[jobId]?.signature === signature;
  }

  function updateArtifactState(jobId: string, state: MediaJobArtifactState): void {
    const next = { ...artifactsRef.current, [jobId]: state };
    artifactsRef.current = next;
    setArtifactsByJob(next);
  }

  async function createMediaJobFromForm(): Promise<MediaMutationResult> {
    const cwd = input.cwd.trim();
    const selectedProvider = input.providers.find((provider) => provider.id === mediaJobForm.providerPresetId);
    if (!cwd || !selectedProvider || !canUseGenerationProviderForOperation(selectedProvider, mediaJobForm.operation) || !mediaJobForm.prompt.trim()) {
      writeError("create", new Error("Generation task settings are incomplete."));
      return { ok: false };
    }
    mutationEpochRef.current += 1;
    listGuard.next();
    setCreatePhase("submitting");
    clearMediaError("create");
    try {
      const response = await createMediaJob(cwd, { ...mediaJobForm, prompt: mediaJobForm.prompt.trim() });
      if (cwdRef.current !== cwd) return { ok: false };
      mutationEpochRef.current += 1;
      const nextJobs = [response.mediaJob, ...jobsRef.current.filter((job) => job.id !== response.mediaJob.id)];
      const nextArtifacts = {
        ...artifactsRef.current,
        [response.mediaJob.id]: response.artifacts
          ? artifactStateReady(mediaJobArtifactSignature(response.mediaJob), response.artifacts)
          : emptyMediaJobArtifactState(response.mediaJob),
      };
      jobsRef.current = nextJobs;
      artifactsRef.current = nextArtifacts;
      setMediaJobs(nextJobs);
      setArtifactsByJob(nextArtifacts);
      setSelectedMediaJobId(response.mediaJob.id);
      return { ok: true, jobId: response.mediaJob.id, status: response.mediaJob.status };
    } catch (caught) {
      writeError("create", caught);
      return { ok: false };
    } finally {
      if (cwdRef.current === cwd) setCreatePhase("idle");
    }
  }

  async function executeMediaJob(jobId: string): Promise<MediaMutationResult> {
    const cwd = input.cwd.trim();
    if (!cwd || runningRef.current.has(jobId)) return { ok: false };
    mutationEpochRef.current += 1;
    listGuard.next();
    const nextRunning = new Set(runningRef.current).add(jobId);
    runningRef.current = nextRunning;
    setRunningJobIds(nextRunning);
    setSelectedMediaJobId(jobId);
    clearMediaError(`run:${jobId}`);
    try {
      const response = await runMediaJob(cwd, jobId);
      if (cwdRef.current !== cwd) return { ok: false };
      mutationEpochRef.current += 1;
      const nextJobs = jobsRef.current.map((job) => job.id === response.mediaJob.id ? response.mediaJob : job);
      jobsRef.current = nextJobs;
      setMediaJobs(nextJobs);
      if (response.artifacts) {
        updateArtifactState(response.mediaJob.id, artifactStateReady(mediaJobArtifactSignature(response.mediaJob), response.artifacts));
      } else if (response.mediaJob.artifactIds.length > 0) {
        updateArtifactState(response.mediaJob.id, {
          signature: mediaJobArtifactSignature(response.mediaJob),
          phase: "loading",
          artifacts: [],
        });
        await loadArtifactsForJob(cwd, response.mediaJob, workspaceEpochRef.current);
      }
      if (response.approval) {
        input.upsertApproval(response.approval);
        void input.refreshApprovals(cwd);
      }
      return { ok: true, jobId: response.mediaJob.id, status: response.mediaJob.status };
    } catch (caught) {
      writeError(`run:${jobId}`, caught);
      void refreshMediaJobs(cwd, "poll");
      return { ok: false, jobId };
    } finally {
      const remaining = new Set(runningRef.current);
      remaining.delete(jobId);
      runningRef.current = remaining;
      setRunningJobIds(remaining);
    }
  }

  async function retryMediaJobArtifacts(jobId: string): Promise<void> {
    const job = jobsRef.current.find((item) => item.id === jobId);
    const cwd = input.cwd.trim();
    if (!job || !cwd || job.artifactIds.length === 0) return;
    updateArtifactState(jobId, {
      signature: mediaJobArtifactSignature(job),
      phase: "loading",
      artifacts: artifactsRef.current[jobId]?.artifacts ?? [],
    });
    await loadArtifactsForJob(cwd, job, workspaceEpochRef.current);
  }

  function resetForCwd(): void {
    workspaceEpochRef.current += 1;
    mutationEpochRef.current += 1;
    listGuard.next();
    artifactGuard.reset();
    listInFlightRef.current = undefined;
    jobsRef.current = [];
    artifactsRef.current = {};
    runningRef.current = new Set();
    setMediaJobs([]);
    setArtifactsByJob({});
    setLoadPhase("idle");
    setCreatePhase("idle");
    setRunningJobIds(new Set());
    setMediaJobForm(defaultMediaJobForm);
    setSelectedMediaJobId("");
    setErrors([]);
  }

  const domainState: MediaJobsDomainState = {
    mediaJobs,
    artifactsByJob,
    loadPhase,
    createPhase,
    runningJobIds,
    selectedMediaJobId,
    form: mediaJobForm,
    errors,
  };
  const domainActions: MediaJobsDomainActions = {
    setMediaJobForm,
    setSelectedMediaJobId,
    refreshMediaJobs,
    createMediaJobFromForm,
    executeMediaJob,
    retryMediaJobArtifacts,
    clearMediaError,
    resetForCwd,
  };
  const mediaJobArtifacts = useMemo(
    () => attachMediaJobsDomainBridge(artifactsByJob, { state: domainState, actions: domainActions }),
    [artifactsByJob, createPhase, errors, loadPhase, mediaJobForm, mediaJobs, runningJobIds, selectedMediaJobId],
  );
  const latestError = errors.at(-1);
  const domainError: DomainError | undefined = latestError ? {
    scope: latestError.owner === "load" || latestError.owner === "refresh" ? "load" : "mutation",
    message: latestError.message,
  } : undefined;

  return {
    state: {
      ...domainState,
      mediaJobArtifacts,
      mediaJobsLoading: loadPhase !== "idle",
      runningMediaJobId: runningJobIds.values().next().value ?? "",
      mediaJobForm,
    },
    actions: { ...domainActions, saveMediaJob: createMediaJobFromForm },
    refresh: () => refreshMediaJobs(),
    isLoading: loadPhase !== "idle",
    error: domainError,
    clearError: () => latestError && clearMediaError(latestError.owner),
  };
}
