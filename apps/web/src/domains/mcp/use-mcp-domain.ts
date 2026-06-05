import { useState } from "react";
import {
  checkMcpServer,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  listMcpTools,
  syncMcpServerTools,
  updateMcpServer,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type {
  McpServer,
  McpServerFormState,
  McpTool,
} from "../../types.js";

export type McpBusyAction = "check" | "sync" | "delete" | "save";

export interface McpState {
  readonly mcpServers: readonly McpServer[];
  readonly mcpTools: readonly McpTool[];
  readonly mcpLoading: boolean;
  readonly mcpBusyServerId: string;
  readonly mcpBusyAction: McpBusyAction | undefined;
}

export interface McpActions {
  readonly refreshMcp: (cwd?: string) => Promise<void>;
  readonly addMcpServer: (formState: McpServerFormState) => Promise<void>;
  readonly saveMcpServer: (serverId: string, formState: McpServerFormState) => Promise<void>;
  readonly runMcpServerCheck: (serverId: string) => Promise<boolean>;
  readonly syncMcpTools: (serverId: string) => Promise<boolean>;
  readonly removeMcpServer: (serverId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type McpController = DomainController<McpState, McpActions>;

export function useMcpDomain(input: {
  readonly cwd: string;
  readonly translate: (value: string) => string;
  readonly setErrorMessage: (message: string) => void;
}): McpController {
  const [mcpServers, setMcpServers] = useState<readonly McpServer[]>([]);
  const [mcpTools, setMcpTools] = useState<readonly McpTool[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpBusyServerId, setMcpBusyServerId] = useState("");
  const [mcpBusyAction, setMcpBusyAction] = useState<McpBusyAction | undefined>();
  const [error, setError] = useState<DomainError | undefined>();

  async function refreshMcp(cwd = input.cwd): Promise<void> {
    if (!cwd) {
      setMcpServers([]);
      setMcpTools([]);
      return;
    }

    setMcpLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const [serversResponse, toolsResponse] = await Promise.all([
        listMcpServers(cwd),
        listMcpTools(cwd),
      ]);
      setMcpServers(serversResponse.servers);
      setMcpTools(toolsResponse.tools);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      input.setErrorMessage(message);
    } finally {
      setMcpLoading(false);
    }
  }

  async function addMcpServer(formState: McpServerFormState): Promise<void> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      throw new Error(input.translate("Local workspace is not ready."));
    }
    setMcpBusyAction("save");
    setMcpBusyServerId("");
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await createMcpServer(workspaceCwd, formState);
      setMcpServers((current) => [response.server, ...current.filter((server) => server.id !== response.server.id)]);
      await refreshMcp(workspaceCwd);
    } catch (caught) {
      setError({ scope: "mutation", message: caught instanceof Error ? caught.message : String(caught) });
      throw caught;
    } finally {
      setMcpBusyAction(undefined);
      setMcpBusyServerId("");
    }
  }

  async function saveMcpServer(serverId: string, formState: McpServerFormState): Promise<void> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      throw new Error(input.translate("Local workspace is not ready."));
    }
    setMcpBusyAction("save");
    setMcpBusyServerId(serverId);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await updateMcpServer(workspaceCwd, serverId, formState);
      setMcpServers((current) => current.map((server) => (server.id === response.server.id ? response.server : server)));
      await refreshMcp(workspaceCwd);
    } catch (caught) {
      setError({ scope: "mutation", message: caught instanceof Error ? caught.message : String(caught) });
      throw caught;
    } finally {
      setMcpBusyAction(undefined);
      setMcpBusyServerId("");
    }
  }

  async function runMcpServerCheck(serverId: string): Promise<boolean> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return false;
    }
    setMcpBusyAction("check");
    setMcpBusyServerId(serverId);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await checkMcpServer(workspaceCwd, serverId);
      setMcpServers((current) => current.map((server) => (server.id === response.server.id ? response.server : server)));
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      return false;
    } finally {
      setMcpBusyAction(undefined);
      setMcpBusyServerId("");
    }
  }

  async function syncMcpTools(serverId: string): Promise<boolean> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return false;
    }
    setMcpBusyAction("sync");
    setMcpBusyServerId(serverId);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await syncMcpServerTools(workspaceCwd, serverId);
      setMcpServers((current) => current.map((server) => (server.id === response.server.id ? response.server : server)));
      setMcpTools((current) => [
        ...current.filter((tool) => tool.serverId !== serverId),
        ...response.tools,
      ]);
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      return false;
    } finally {
      setMcpBusyAction(undefined);
      setMcpBusyServerId("");
    }
  }

  async function removeMcpServer(serverId: string): Promise<void> {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      input.setErrorMessage(input.translate("Local workspace is not ready."));
      return;
    }
    setMcpBusyAction("delete");
    setMcpBusyServerId(serverId);
    try {
      input.setErrorMessage("");
      setError(undefined);
      await deleteMcpServer(workspaceCwd, serverId);
      setMcpServers((current) => current.filter((server) => server.id !== serverId));
      setMcpTools((current) => current.filter((tool) => tool.serverId !== serverId));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setMcpBusyAction(undefined);
      setMcpBusyServerId("");
    }
  }

  function resetForCwd(): void {
    setMcpServers([]);
    setMcpTools([]);
    setMcpLoading(false);
    setMcpBusyServerId("");
    setMcpBusyAction(undefined);
    setError(undefined);
  }

  return {
    state: {
      mcpServers,
      mcpTools,
      mcpLoading,
      mcpBusyServerId,
      mcpBusyAction,
    },
    actions: {
      refreshMcp,
      addMcpServer,
      saveMcpServer,
      runMcpServerCheck,
      syncMcpTools,
      removeMcpServer,
      resetForCwd,
    },
    refresh: refreshMcp,
    isLoading: mcpLoading,
    error,
    clearError: () => setError(undefined),
  };
}
