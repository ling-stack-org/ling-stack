import { runProviderAwareSign } from "./hooks.mjs";

/**
 * Electron Builder 26.15.3 `mac.sign` callback.  Builder hands the callback a
 * bundle path rather than an individual executable.  The fixture/release
 * adapter records the outer main executable as the governed app identity;
 * the real macOS signer remains an injected platform service in Slice 6A.
 */
export default async function electronBuilderMacSign(configuration, packager) {
  const appPath = configuration.app;
  return runProviderAwareSign(
    {
      path: appPath,
      packager,
      electronPlatformName: "darwin",
    },
    {
      signer: packager?.__lingSigningSigner,
      outerSigner: packager?.__lingSigningOuterSigner,
      outerRole: "outer-app-bundle",
    },
  );
}
