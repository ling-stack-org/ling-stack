import { runProviderAwareSign } from "./hooks.mjs";

/**
 * Electron Builder 26.15.3 `win.signtoolOptions.sign` callback.  The callback
 * receives the exact file task that Builder is about to sign; the shared seam
 * either proves the sealed provider digest and skips it or delegates the outer
 * executable to the injected/release signer.
 */
export default async function electronBuilderWindowsSign(configuration, packager) {
  return runProviderAwareSign(
    {
      path: configuration.path,
      appOutDir: packager?.__lingSigningAppOutDir,
      electronPlatformName: "win32",
    },
    {
      profile: packager?.__lingSigningProfile,
      signer: packager?.__lingSigningSigner,
      outerSigner: packager?.__lingSigningOuterSigner,
      stateDirectory: packager?.__lingSigningStateDirectory,
    },
  );
}
