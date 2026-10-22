import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const baseBuild = packageJson.build;

/**
 * Disposable hook-order config for Slice -1.  It is intentionally opt-in via
 * `--config`; the normal Desktop package keeps its existing platform signer
 * until the real certificate adapter lands in Slice 6A.
 */
export default {
  ...baseBuild,
  // This opt-in fixture validates only CUA signing, not other native package payloads.
  afterSign: "./scripts/cua-driver-signing/after-sign.mjs",
  directories: {
    ...baseBuild.directories,
    ...(process.env.LING_CUA_FIXTURE_OUTPUT
      ? { output: process.env.LING_CUA_FIXTURE_OUTPUT }
      : {}),
  },
  extraResources: [
    ...(baseBuild.extraResources ?? []),
    ...(process.env.LING_CUA_FIXTURE_PROVIDER_ROOT
      ? [
          {
            from: process.env.LING_CUA_FIXTURE_PROVIDER_ROOT,
            to: "providers/cua-driver/0.8.3-ling.1",
          },
        ]
      : []),
  ],
  mac: {
    ...baseBuild.mac,
    sign: "./scripts/cua-driver-signing/electron-builder-mac-sign.mjs",
    identity: "-",
    hardenedRuntime: false,
  },
  win: {
    ...baseBuild.win,
    extraResources: (baseBuild.win.extraResources ?? []).filter(entry => entry.to !== "engine-supervisor"),
    signtoolOptions: {
      sign: "./scripts/cua-driver-signing/electron-builder-win-sign.mjs",
      signingHashAlgorithms: ["sha256"],
    },
    signExts: [
      "!resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/ling-cua-driver.exe",
      "!resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\payload\\ling-cua-driver.exe",
    ],
  },
};
