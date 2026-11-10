import { join } from "node:path";

export const claudeCliRuntimeVersion = "2.1.156";

export function claudeProcessEnvironment(root: string): NodeJS.ProcessEnv {
  return { CLAUDE_CONFIG_DIR: join(root, "claude"), DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_SIMPLE: "1" };
}
