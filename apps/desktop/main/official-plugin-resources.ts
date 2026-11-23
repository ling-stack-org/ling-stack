import { access } from "node:fs/promises";
import { readVerifiedOfficialPluginRuntime } from "@ling-stack/core/official-plugin-runtime";

export async function resolveOptionalPluginExecutable(input: {
  readonly packaged: boolean;
  readonly pluginId: "official:chrome-browser" | "official:office-documents";
  readonly lingVersion: string;
  readonly executable: string;
  readonly bundledPath: string | undefined;
  readonly onInvalidCache: (error: unknown) => void;
}): Promise<string | undefined> {
  if (input.packaged) {
    try {
      const downloaded = await readVerifiedOfficialPluginRuntime(input);
      if (downloaded) return downloaded.executablePath;
    } catch (error) {
      input.onInvalidCache(error);
    }
  }
  if (!input.bundledPath) return undefined;
  try {
    await access(input.bundledPath);
    return input.bundledPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") input.onInvalidCache(error);
    return undefined;
  }
}
