import { isCompanionBlockmap, runArtifactBuildCompleted } from "./hooks.mjs";
import { extractCuaDriverFinalArtifact } from "./final-artifact-extractor.mjs";
import { verifyOfficeFinalArtifact } from "../packaged-office-native-package-checks.mjs";

export default async function artifactBuildCompleted(context) {
  // Share Cua's original metadata-only skip; actual ZIP/DMG still verify first.
  if (!isCompanionBlockmap(context)) await verifyOfficeFinalArtifact(context);
  return runArtifactBuildCompleted(context, {
    extractArtifact: extractCuaDriverFinalArtifact,
  });
}
