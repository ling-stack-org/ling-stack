import { resolveOriginalPackagedOfficeResources } from "./packaged-office-native-resources.js";
import { PACKAGED_CODESIGN_ACTOR_ENTRY } from "./packaged-restricted-command-bootstrap.js";
import { prepareOriginalPackagedCodesignSource, readOriginalPackagedCodesignSource,
  closeOriginalPackagedCodesignIdentity, createOriginalPackagedCodesignInvocation } from "./packaged-codesign-host-source.js";
import type { OfficeLocalReviewedNativeArtifact } from "./protected-host-office-native-identity.js";

/**
 * Fixed production discovery, not caller dependency injection. The Office
 * publication selects bytes; the original signing actor verifies the same app.
 * Neither step grants Core permission or changes primitive native identity facts.
 */
export function readPackagedOfficeLocalNativeArtifact(): OfficeLocalReviewedNativeArtifact | undefined {
  const resources = resolveOriginalPackagedOfficeResources();
  if (!resources) return undefined;
  const source = prepareOriginalPackagedCodesignSource();
  let failed = false, failure: unknown;
  try {
    if (readOriginalPackagedCodesignSource(source).appBundlePath !== resources.appRoot) {
      throw new Error("packaged_office_native_bundle_identity_invalid");
    }
    const result = PACKAGED_CODESIGN_ACTOR_ENTRY.invoke(undefined, createOriginalPackagedCodesignInvocation(source));
    if (result.error || result.signal || result.status !== 0) {
      throw new Error("packaged_office_native_bundle_identity_invalid");
    }
    // Revalidate the same literal/paths/bytes after the original verification.
    const current = resolveOriginalPackagedOfficeResources();
    if (!current || current.appRoot !== resources.appRoot || current.binaryPath !== resources.binaryPath
      || current.sourceRoot !== resources.sourceRoot || current.review !== resources.review) {
      throw new Error("packaged_office_native_resources_changed");
    }
    return Object.freeze({ binaryPath: resources.binaryPath,
      reviewedBinarySha256: resources.review.finalBinarySha256,
      reviewedSourceSha256: resources.review.sourceSha256 });
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { closeOriginalPackagedCodesignIdentity(source); }
    catch (closeError) {
      if (failed) throw new AggregateError([failure, closeError], "packaged_office_native_bundle_identity_close_unknown");
      throw closeError;
    }
  }
}
