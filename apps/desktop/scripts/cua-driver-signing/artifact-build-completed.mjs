import { isCompanionBlockmap, runArtifactBuildCompleted } from "./hooks.mjs";
import { extractCuaDriverFinalArtifact } from "./final-artifact-extractor.mjs";
import { verifyOfficeFinalArtifact } from "../packaged-office-native-package-checks.mjs";

// Builder queues ZIP work internally, so concurrency.jobs=1 does not prevent
// its final verifier from overlapping DMG. Keep both verifiers AND their
// awaited cleanup in one lane per actual Packager. A rejected lane stays
// rejected: unknown extraction/cleanup state cannot admit another artifact.
const verificationLanes = new WeakMap();

async function verifyArtifact(context) {
  // Share Cua's original metadata-only skip; actual ZIP/DMG still verify first.
  if (!isCompanionBlockmap(context)) await verifyOfficeFinalArtifact(context);
  return runArtifactBuildCompleted(context, {
    extractArtifact: extractCuaDriverFinalArtifact,
  });
}

export default async function artifactBuildCompleted(context) {
  const packager = context?.packager;
  if (!packager || (typeof packager !== "object" && typeof packager !== "function")) {
    throw new TypeError("artifact_verification_packager_required");
  }
  const previous = verificationLanes.get(packager) ?? Promise.resolve();
  const result = previous.then(() => verifyArtifact(context));
  verificationLanes.set(packager, result);
  // The returned promise and queued callers still reject with the original
  // error. Observe the stored tail too, in case no later callback arrives.
  void result.catch(() => {});
  return result;
}
