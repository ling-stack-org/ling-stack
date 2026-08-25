import type { ConversationGeneratedMedia, RunArtifact } from "../../types.js";

export function displayableGeneratedMediaArtifacts(
  item: Pick<ConversationGeneratedMedia, "operation" | "artifacts">,
): readonly RunArtifact[] {
  const expectedType = item.operation === "video_generate" ? "video" : "image";
  return item.artifacts.filter((artifact) => artifact.type === expectedType);
}
