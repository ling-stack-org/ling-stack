import { resolve } from "node:path";
import type { RunStore } from "@ling-stack/core";
import {
  CUA_DRIVER_BUNDLED_LOGICAL_ENDPOINT,
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_PLUGIN_ID,
} from "./presets.js";

/**
 * Store-level mode discriminator for the daemon side of bundled embedded Cua.
 * The activation row alone is insufficient because it intentionally survives
 * gate changes; the exact logical placeholder proves this is not external
 * stdio or the historical packaged-plugin transport.
 */
export function isBundledEmbeddedCuaDriverRuntime(
  store: Pick<RunStore, "getCuaDriverActivationState" | "getMcpServer" | "paths">,
  authority: {
    readonly enabled: boolean;
    readonly workspaceCwd: string;
    readonly platform: NodeJS.Platform;
    readonly hasCurrentLease: () => boolean;
  },
  requestCwd: string,
): boolean {
  const workspaceCwd = resolve(authority.workspaceCwd);
  if (
    !authority.enabled
    || !authority.hasCurrentLease()
    || resolve(requestCwd) !== workspaceCwd
    || resolve(store.paths.cwd) !== workspaceCwd
  ) {
    return false;
  }
  return hasPersistedBundledCuaDriverProjection(store);
}

export function hasPersistedBundledCuaDriverProjection(
  store: Pick<RunStore, "getCuaDriverActivationState" | "getMcpServer">,
): boolean {
  const activation = store.getCuaDriverActivationState(CUA_DRIVER_PLUGIN_ID);
  const server = store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  return Boolean(
    activation
    && server?.transport.type === "streamable-http"
    && server.transport.url === CUA_DRIVER_BUNDLED_LOGICAL_ENDPOINT,
  );
}
