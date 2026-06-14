import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonContext } from "../context.js";
import { writeJson } from "../shared/response.js";
import { warmDefaultWorkspaceStartup } from "./warmup.js";

export async function handleStartupStatus(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const cwd = url.searchParams.get("cwd") || context.config.defaultWorkspaceCwd;

  if (url.pathname === "/startup/status" && request.method === "GET") {
    const existing = context.startupState.snapshot(cwd);
    if (existing && existing.state !== "starting") {
      writeJson(response, 200, existing);
      return;
    }
    await warmDefaultWorkspaceStartup({ ...startupWarmupContext(context), cwd });
    warmOptionalStartupPhases(context, cwd);
    writeJson(response, 200, context.startupState.ensureWorkspace(cwd));
    return;
  }

  if (url.pathname === "/startup/refresh" && request.method === "POST") {
    context.startupState.resetWorkspace(cwd);
    await warmDefaultWorkspaceStartup({ ...startupWarmupContext(context), cwd });
    warmOptionalStartupPhases(context, cwd, { forceProviderRefresh: true });
    writeJson(response, 200, context.startupState.ensureWorkspace(cwd));
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for ${url.pathname}` });
}

function startupWarmupContext(context: DaemonContext): Omit<Parameters<typeof warmDefaultWorkspaceStartup>[0], "cwd"> {
  return {
    startupState: context.startupState,
    storeRegistry: context.storeRegistry,
    runnerRegistry: context.runnerRegistry,
    secretResolver: context.secretResolver,
  };
}

function warmOptionalStartupPhases(context: DaemonContext, cwd: string, options: { readonly forceProviderRefresh?: boolean } = {}): void {
  const status = context.startupState.snapshot(cwd);
  if (status?.phases.workspace_store !== "ready") {
    return;
  }
  try {
    context.startupOptionalWarmups.start(cwd, context.storeRegistry.getStore(cwd), options);
  } catch {
    // Optional warmups own their startup diagnostics and must not break status reads.
  }
}
