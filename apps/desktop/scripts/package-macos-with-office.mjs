import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, Platform, Arch } from "electron-builder";
import { buildFreshPackagedDaemonForMacOffice } from "./build-packaged-daemon.mjs";
import { withOriginalPackagedOfficeNativePublication } from "./build-packaged-office-native.mjs";
import { withCuaDriverBuilderEnvironment } from "./cua-driver-builder-environment.mjs";
import { runCuaDriverElectronPackageCli } from "./cua-driver-electron-package.mjs";
import { resolveSigningProfile } from "./cua-driver-signing/signing-contract.mjs";
import { assertPackagedOfficeSigningConfig,
  assertPackagedOfficeSigningEnvironment } from "./packaged-office-signing-inputs.mjs";
import { buildHumanEvaluationHelper } from "./build-human-evaluation-helper.mjs";
import { readPackagedOfficeBuildLane, selectPackagedOfficeBuildLane } from "./packaged-human-qa-lane.mjs";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const builderArguments = Object.freeze(["--mac", "dmg", "zip", "--arm64"]);
let busy = false, configSequence = 0;

/** Fixed same-process macOS lane; there is no CLI config/target/publication override. */
export async function packageMacosWithOffice() {
  if (busy) throw new Error("packaged_office_native_package_busy");
  const admittedLane = readPackagedOfficeBuildLane(process.env);
  busy = true;
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64"
      || resolveSigningProfile().signingTier !== "unsigned_dev") {
      throw new Error("packaged_office_native_package_profile_unsupported");
    }
    // Existing unsigned_dev Cua custom signing can return signed:false and has
    // no default-sign fallback. This first Office lane uses Builder's default
    // ad-hoc signer; do not silently call a noop custom signer a signed package.
    if (process.env.LING_CUA_DRIVER_PACKAGE_PROVIDER === "1") {
      throw new Error("packaged_office_native_provider_signing_lane_unsupported");
    }
    assertPackagedOfficeSigningEnvironment(process.env);
    await runCuaDriverElectronPackageCli(["--platform", "darwin", "--", ...builderArguments], process.env, {
      async runBuilder({ appRoot, args, environment }) {
        if (readPackagedOfficeBuildLane(environment) !== admittedLane) {
          throw new Error("packaged_human_qa_selection_changed");
        }
        if (realpathSync(appRoot) !== desktopRoot
          || JSON.stringify(args) !== JSON.stringify(["--config", resolve(desktopRoot,
            "scripts/cua-driver-electron-builder.config.mjs"), ...builderArguments])) {
          throw new Error("packaged_office_native_builder_invocation_invalid");
        }
        assertPackagedOfficeSigningEnvironment(process.env);
        assertPackagedOfficeSigningEnvironment(environment);
        return withCuaDriverBuilderEnvironment(environment, async () => {
          assertPackagedOfficeSigningEnvironment(process.env);
          const token = await buildFreshPackagedDaemonForMacOffice();
          return withOriginalPackagedOfficeNativePublication(token, async () => {
            buildHumanEvaluationHelper();
            // The URL is fixed original code. A fresh module instance prevents
            // one validated Cua environment from leaking into a later build.
            const configUrl = new URL("./cua-driver-electron-builder.config.mjs", import.meta.url);
            configUrl.searchParams.set("officeInvocation", String(++configSequence));
            const { default: originalConfig } = await import(configUrl.href);
            if (readPackagedOfficeBuildLane(process.env) !== admittedLane) {
              throw new Error("packaged_human_qa_selection_changed");
            }
            const config = selectPackagedOfficeBuildLane(originalConfig, process.env);
            config.extraResources = [...(config.extraResources ?? []),
              { from: resolve(desktopRoot, "dist/office-local"), to: "office-local" }];
            // Resolve lifecycle hooks from this application, independent of caller cwd.
            for (const hook of ["afterPack", "afterSign", "artifactBuildCompleted"]) {
              if (typeof config[hook] === "string" && config[hook].startsWith("./scripts/")) {
                config[hook] = resolve(desktopRoot, config[hook]);
              }
            }
            if (config.mac.sign !== undefined || config.mac.identity !== "-") {
              throw new Error("packaged_office_native_default_signer_required");
            }
            assertPackagedOfficeSigningConfig(config);
            assertPackagedOfficeSigningEnvironment(process.env);
            // Builder otherwise skips even ad-hoc signing in PR jobs. Only
            // the admitted fixed no-credential lane owns this temporary input.
            process.env.CSC_FOR_PULL_REQUEST = "true";
            try {
              await build({ projectDir: desktopRoot, publish: "never",
                targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64), config });
            } finally { delete process.env.CSC_FOR_PULL_REQUEST; }
            return 0;
          });
        });
      },
    });
  } finally { busy = false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("packaged_office_native_package_arguments_invalid");
  await packageMacosWithOffice();
}
