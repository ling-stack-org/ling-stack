import { runArtifactBuildCompleted } from "./hooks.mjs";

export default async function artifactBuildCompleted(context) {
  return runArtifactBuildCompleted(context);
}
