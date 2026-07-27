import type { MediaJob, RunArtifact } from "../../types.js";
import type { MediaJobArtifactState } from "./media-domain-types.js";

export function mediaJobArtifactSignature(job: MediaJob): string {
  return job.artifactIds.join("\u001f");
}

export function emptyMediaJobArtifactState(job?: MediaJob): MediaJobArtifactState {
  return {
    signature: job ? mediaJobArtifactSignature(job) : "",
    phase: "idle",
    artifacts: [],
  };
}

export function reconcileMediaJobArtifactStates(
  jobs: readonly MediaJob[],
  current: Readonly<Record<string, MediaJobArtifactState>>,
): Record<string, MediaJobArtifactState> {
  return Object.fromEntries(jobs.map((job) => {
    const signature = mediaJobArtifactSignature(job);
    const previous = current[job.id];
    if (previous?.signature === signature) return [job.id, previous];
    return [job.id, {
      signature,
      phase: job.artifactIds.length > 0 ? "loading" : "idle",
      artifacts: [],
    } satisfies MediaJobArtifactState];
  }));
}

export function mediaJobArtifactRequestIdentity(cwd: string, job: MediaJob): string {
  return `${cwd}\u001e${job.id}\u001e${mediaJobArtifactSignature(job)}`;
}

export function artifactStateReady(
  signature: string,
  artifacts: readonly RunArtifact[],
): MediaJobArtifactState {
  return { signature, phase: "ready", artifacts };
}

export function artifactStateError(
  signature: string,
  artifacts: readonly RunArtifact[],
  errorMessage: string,
): MediaJobArtifactState {
  return { signature, phase: "error", artifacts, errorMessage };
}
