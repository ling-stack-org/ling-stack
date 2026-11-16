import type { ProviderPreset } from "@ling-stack/contracts";
import { artifactContentUrl, listMediaJobArtifacts, listProviders, runMediaJob } from "../../../api.js";
import { daemonClient } from "../../../api/client.js";

export function canEditImage(provider: ProviderPreset): boolean {
  const transport = provider.compat.mediaVendorTransport;
  return provider.enabled && provider.kind === "seedream" && provider.api === "media-job" && provider.capabilities.includes("image_edit") && Boolean(transport && typeof transport === "object" && "mode" in transport && transport.mode === "live");
}
export async function imageEditProviders(cwd: string): Promise<readonly ProviderPreset[]> {
  return (await listProviders(cwd)).providers.filter(canEditImage);
}
export async function runImageEdit(input: { cwd: string; providerPresetId: string; imageUrl: string; maskUrl?: string; prompt: string }): Promise<{ imageUrl: string; artifactId: string; jobId: string }> {
  if (input.imageUrl.length + (input.maskUrl?.length ?? 0) > 23 * 1024 * 1024) throw new Error("Image input is too large for model editing. Resize the image first.");
  const created = await daemonClient.createMediaJob(input.cwd, { providerPresetId: input.providerPresetId, operation: "image_edit", prompt: input.prompt,
    input: { imageUrl: input.imageUrl, ...(input.maskUrl ? { maskUrl: input.maskUrl } : {}) } });
  const result = await runMediaJob(input.cwd, created.mediaJob.id);
  if (result.mediaJob.status !== "succeeded") throw new Error(result.mediaJob.errorMessage || (result.mediaJob.status === "waiting_for_approval" ? "Image editing requires approval in Media Jobs." : `Image edit status: ${result.mediaJob.status}`));
  const artifacts = result.artifacts ?? (await listMediaJobArtifacts(result.mediaJob.id, input.cwd)).artifacts;
  const image = artifacts.find(artifact => artifact.contentType?.startsWith("image/"));
  if (!image) throw new Error("Image edit returned no image.");
  return { imageUrl: artifactContentUrl(image.id, input.cwd), artifactId: image.id, jobId: result.mediaJob.id };
}
