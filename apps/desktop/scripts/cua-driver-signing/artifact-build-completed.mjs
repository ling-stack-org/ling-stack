import { runArtifactBuildCompleted } from "./hooks.mjs";
import { extractCuaDriverFinalArtifact } from "./final-artifact-extractor.mjs";

export default async function artifactBuildCompleted(context) {
  return runArtifactBuildCompleted(context, {
    extractArtifact: extractCuaDriverFinalArtifact,
  });
}
