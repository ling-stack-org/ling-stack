import { join } from "node:path";
import { resolveUserConfigPaths, type SkillSourceRuntimeContext } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { loadRetainedPackagedSkillGeneration } from "./packaged-history.js";
import { getPackagedSkillGenerationChecksum, hasPackagedSkillGeneration, registerPackagedSkillGeneration } from "./packaged-runtime.js";

const loading = new Map<string, Promise<void>>();

/** Desktop can start offline without inspecting optional resources. Load the known generation at use. */
export async function preparePackagedSkillGeneration(
  context: SkillSourceRuntimeContext | undefined,
  workspaceEnabled = false,
): Promise<void> {
  const checksum = getPackagedSkillGenerationChecksum(context);
  if (!checksum || hasPackagedSkillGeneration(checksum)
    || (!workspaceEnabled && process.env.LING_STACK_PACKAGED_DESKTOP !== "1" && !context?.resourceBinding)) return;
  const pending = loading.get(checksum);
  if (pending) return pending;
  const cache = join(resolveUserConfigPaths().sourcesDir, "bundled-gstack");
  const load = loadRetainedPackagedSkillGeneration(cache, checksum).then(registerPackagedSkillGeneration).catch((error: unknown) => {
    const unavailable = new HttpError(409, "packaged_skill_resource_version_unavailable",
      "The task's authenticated skill resources are unavailable or changed; restore the matching generation before retrying.");
    unavailable.cause = error;
    throw unavailable;
  }).finally(() => loading.delete(checksum));
  loading.set(checksum, load);
  await load;
}
