import {
  browserHostStatus,
  buildDevelopmentBrowserHost,
  defaultDevelopmentBrowserHostPath,
  installBrowserHost,
  uninstallBrowserHost,
  type BrowserHostInstallationStatus,
} from "@ling-stack/browser-host";
import { CliError } from "./errors.js";

export interface BrowserHostCommandResult extends BrowserHostInstallationStatus {
  readonly action: "install" | "status" | "uninstall";
}

export async function runBrowserHostCommand(args: readonly string[]): Promise<BrowserHostCommandResult> {
  const [action, ...rest] = args;
  if (rest.length > 0 || (action !== "install" && action !== "status" && action !== "uninstall")) {
    throw new CliError(2, "bad_usage", "Usage: ling-stack browser-host install|status|uninstall");
  }
  if (action === "install") {
    const hostPath = await buildDevelopmentBrowserHost();
    return { action, ...(await installBrowserHost({ hostPath })) };
  }
  const hostPath = defaultDevelopmentBrowserHostPath();
  return {
    action,
    ...(action === "status"
      ? await browserHostStatus({ hostPath })
      : await uninstallBrowserHost({ hostPath })),
  };
}
