import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  createMediaJob,
  listMediaJobArtifacts,
  listMediaJobs,
  runMediaJob,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type {
  ApprovalRequest,
  MediaJob,
  MediaJobFormState,
  RunArtifact,
} from "../../types.js";

export const defaultMediaJobForm: MediaJobFormState = {
  providerPresetId: "",
  operation: "image_generate",
  prompt: "Generate a concise visual concept for the selected workspace outcome.",
  inputText: "",
};

export interface MediaState {
  readonly mediaJobs: readonly MediaJob[];
  readonly mediaJobArtifacts: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly mediaJobsLoading: boolean;
  readonly runningMediaJobId: string;
  readonly mediaJobForm: MediaJobFormState;
  readonly selectedMediaJobId: string;
}

export interface MediaActions {
  readonly setMediaJobForm: Dispatch<SetStateAction<MediaJobFormState>>;
  readonly setSelectedMediaJobId: Dispatch<SetStateAction<string>>;
  readonly refreshMediaJobs: (cwd?: string) => Promise<void>;
  readonly saveMediaJob: () => Promise<void>;
  readonly executeMediaJob: (jobId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type MediaController = DomainController<MediaState, MediaActions>;

export function useMediaDomain(input: {
  readonly cwd: string;
  readonly translate: (value: string) => string;
  readonly setErrorMessage: (message: string) => void;
  readonly upsertApproval: (approval: ApprovalRequest) => void;
  readonly refreshApprovals: (cwd: string) => Promise<void>;
}): MediaController {
  const [mediaJobs, setMediaJobs] = useState<readonly MediaJob[]>([]);
  const [mediaJobArtifacts, setMediaJobArtifacts] = useState<Record<string, readonly RunArtifact[]>>({});
  const [mediaJobsLoading, setMediaJobsLoading] = useState(false);
  const [runningMediaJobId, setRunningMediaJobId] = useState("");
  const [mediaJobForm, setMediaJobForm] = useState<MediaJobFormState>(() => ({
    ...defaultMediaJobForm,
    prompt: input.translate(defaultMediaJobForm.prompt),
  }));
  const [selectedMediaJobId, setSelectedMediaJobId] = useState("");
  const [error, setError] = useState<DomainError | undefined>();

  useEffect(() => {
    if (selectedMediaJobId && mediaJobs.some((job) => job.id === selectedMediaJobId)) {
      return;
    }
    setSelectedMediaJobId(mediaJobs[0]?.id ?? "");
  }, [mediaJobs, selectedMediaJobId]);

  async function refreshMediaJobs(cwd = input.cwd): Promise<void> {
    if (!cwd) {
      setMediaJobs([]);
      setMediaJobArtifacts({});
      return;
    }

    setMediaJobsLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await listMediaJobs(cwd);
      setMediaJobs(response.mediaJobs);
      setMediaJobArtifacts(await loadMediaJobArtifacts(cwd, response.mediaJobs));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      input.setErrorMessage(message);
    } finally {
      setMediaJobsLoading(false);
    }
  }

  async function saveMediaJob(): Promise<void> {
    if (!input.cwd.trim()) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }
    if (!mediaJobForm.providerPresetId) {
      input.setErrorMessage("请选择 media provider preset");
      return;
    }
    if (!mediaJobForm.prompt.trim()) {
      input.setErrorMessage("请输入 media prompt");
      return;
    }

    setMediaJobsLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await createMediaJob(input.cwd.trim(), {
        ...mediaJobForm,
        prompt: mediaJobForm.prompt.trim(),
      });
      setSelectedMediaJobId(response.mediaJob.id);
      setMediaJobs((current) => [response.mediaJob, ...current.filter((job) => job.id !== response.mediaJob.id)]);
      setMediaJobArtifacts((current) => ({ ...current, [response.mediaJob.id]: response.artifacts ?? [] }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setMediaJobsLoading(false);
    }
  }

  async function executeMediaJob(jobId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }

    setRunningMediaJobId(jobId);
    setSelectedMediaJobId(jobId);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await runMediaJob(cwd, jobId);
      const artifactsResponse = response.mediaJob.artifactIds.length > 0
        ? await listMediaJobArtifacts(response.mediaJob.id, cwd)
        : { artifacts: response.artifacts ?? [] };
      setMediaJobs((current) => current.map((job) => (job.id === response.mediaJob.id ? response.mediaJob : job)));
      setMediaJobArtifacts((current) => ({ ...current, [response.mediaJob.id]: artifactsResponse.artifacts }));
      const mediaApproval = response.approval;
      if (mediaApproval) {
        input.upsertApproval(mediaApproval);
        void input.refreshApprovals(cwd);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      void refreshMediaJobs(cwd);
    } finally {
      setRunningMediaJobId("");
    }
  }

  async function loadMediaJobArtifacts(cwd: string, jobs: readonly MediaJob[]): Promise<Record<string, readonly RunArtifact[]>> {
    const jobsWithArtifacts = jobs.filter((job) => job.artifactIds.length > 0);
    if (jobsWithArtifacts.length === 0) {
      return {};
    }
    const entries = await Promise.all(
      jobsWithArtifacts.map(async (job) => {
        const response = await listMediaJobArtifacts(job.id, cwd);
        return [job.id, response.artifacts] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  function resetForCwd(): void {
    setMediaJobs([]);
    setMediaJobArtifacts({});
    setMediaJobsLoading(false);
    setRunningMediaJobId("");
    setMediaJobForm({
      ...defaultMediaJobForm,
      prompt: input.translate(defaultMediaJobForm.prompt),
    });
    setSelectedMediaJobId("");
    setError(undefined);
  }

  return {
    state: {
      mediaJobs,
      mediaJobArtifacts,
      mediaJobsLoading,
      runningMediaJobId,
      mediaJobForm,
      selectedMediaJobId,
    },
    actions: {
      setMediaJobForm,
      setSelectedMediaJobId,
      refreshMediaJobs,
      saveMediaJob,
      executeMediaJob,
      resetForCwd,
    },
    refresh: refreshMediaJobs,
    isLoading: mediaJobsLoading,
    error,
    clearError: () => setError(undefined),
  };
}
