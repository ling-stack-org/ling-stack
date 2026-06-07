import type {
  MediaJobArtifactListResponse,
  MediaJobFormState,
  MediaJobListResponse,
  MediaJobMutationResponse,
  PreviewContentResponse,
} from "../types.js";
import { daemonClient } from "./client.js";
import { mediaJobFormToPayload } from "./media-payloads.js";

export async function listMediaJobs(cwd: string, limit = 100): Promise<MediaJobListResponse> {
  return daemonClient.listMediaJobs(cwd, limit);
}

export async function createMediaJob(cwd: string, form: MediaJobFormState): Promise<MediaJobMutationResponse> {
  return daemonClient.createMediaJob(cwd, mediaJobFormToPayload(form));
}

export async function runMediaJob(cwd: string, mediaJobId: string): Promise<MediaJobMutationResponse> {
  return daemonClient.runMediaJob(cwd, mediaJobId);
}

export async function listMediaJobArtifacts(mediaJobId: string, cwd?: string): Promise<MediaJobArtifactListResponse> {
  return daemonClient.listMediaJobArtifacts(mediaJobId, cwd);
}

export function artifactContentUrl(artifactId: string, cwd?: string): string {
  return daemonClient.artifactContentUrl(artifactId, cwd);
}

export async function previewArtifactContent(cwd: string, artifactId: string, maxBytes?: number): Promise<PreviewContentResponse> {
  return daemonClient.previewArtifactContent(cwd, artifactId, maxBytes);
}
