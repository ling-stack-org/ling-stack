import type { Server } from "node:http";
import { createDaemonServer } from "./index.js";

/** Narrow trusted-launch interface; do not export runtime/SDK implementation types to CLI. */
export interface ExecutionEngineHost {
  readonly server: Server;
  readonly engineManagement: { readonly capability: string; readonly csrfToken: string };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createExecutionEngineHost(config: {
  readonly host: string;
  readonly port: number;
  readonly defaultWorkspaceCwd: string;
}): ExecutionEngineHost {
  return createDaemonServer(config);
}
