import { join, basename } from "node:path";

import { runProviderAwareSign } from "./hooks.mjs";

/**
 * Electron Builder 26.15.3 `mac.sign` callback.  Builder hands the callback a
 * bundle path rather than an individual executable.  The fixture/release
 * adapter records the outer main executable as the governed app identity;
 * the real macOS signer remains an injected platform service in Slice 6A.
 */
export default async function electronBuilderMacSign(configuration, packager) {
  const appPath = configuration.app;
  const productFilename = packager?.appInfo?.productFilename;
  const executable = productFilename
    ? join(appPath, "Contents", "MacOS", productFilename)
    : join(appPath, "Contents", "MacOS", basename(appPath, ".app"));
  return runProviderAwareSign(
    {
      path: executable,
      appOutDir: packager?.__lingSigningAppOutDir,
      electronPlatformName: "darwin",
    },
    {
      profile: packager?.__lingSigningProfile,
      signer: packager?.__lingSigningSigner,
      outerSigner: packager?.__lingSigningOuterSigner,
      stateDirectory: packager?.__lingSigningStateDirectory,
    },
  );
}
