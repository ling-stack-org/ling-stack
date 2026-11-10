import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function openclawProcessEnvironment(root: string, home = join(root, "openclaw")): NodeJS.ProcessEnv {
  return {
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: home,
    OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
    OPENCLAW_HIDE_BANNER: "1",
    OPENCLAW_SUPPRESS_NOTES: "1",
    // Keep the ACP bridge inside the host-owned process group during cleanup.
    OPENCLAW_NO_RESPAWN: "1",
  };
}

export async function writeOpenClawProbeCredential(root: string, value: string): Promise<string> {
  const path = join(root, "gateway-credential");
  await writeFile(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}
