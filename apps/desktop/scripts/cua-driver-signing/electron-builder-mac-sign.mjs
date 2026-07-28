import { fileURLToPath } from "node:url";

import { createDarwinPlatformSigner } from "./darwin-platform-signer.mjs";
import { runProviderAwareSign } from "./hooks.mjs";

/**
 * Electron Builder 26.15.3 `mac.sign` callback.  Builder hands the callback a
 * bundle path rather than an individual executable.  The fixture/release
 * adapter records the outer main executable as the governed app identity;
 * the real macOS signer remains an injected platform service in Slice 6A.
 */
export default async function electronBuilderMacSign(configuration, packager) {
  const appPath = configuration.app;
  const realOuterSigner =
    process.env.LING_CUA_SIGNING_FIXTURE !== "1"
    && process.env.LING_CUA_DARWIN_SIGNING_IDENTITY
      ? createDarwinPlatformSigner({
          identity: process.env.LING_CUA_DARWIN_SIGNING_IDENTITY,
          expectedTeamId: process.env.LING_CUA_DARWIN_EXPECTED_TEAM_ID,
          entitlementsPath: fileURLToPath(
            new URL("../../build/entitlements.cua-driver.plist", import.meta.url),
          ),
          bundleSignOptions: configuration,
        })
      : undefined;
  return runProviderAwareSign(
    {
      path: appPath,
      packager,
      electronPlatformName: "darwin",
    },
    {
      signer: packager?.__lingSigningSigner,
      outerSigner: packager?.__lingSigningOuterSigner ?? realOuterSigner,
      outerRole: "outer-app-bundle",
    },
  );
}
