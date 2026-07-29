import type { McpServer, McpTool } from "../../types.js";
import { McpServerRow, type McpServerRowFeedback } from "./McpServerRow.js";

export function McpServerList({
  busyAction,
  busyServerId,
  expandedServerIds,
  feedbackByServerId,
  onCheck,
  onEdit,
  onExpandedChange,
  onRequestDelete,
  onSync,
  servers,
  toolsByServerId,
}: {
  readonly busyAction?: "check" | "delete" | "save" | "sync";
  readonly busyServerId: string;
  readonly expandedServerIds: ReadonlySet<string>;
  readonly feedbackByServerId: Readonly<Record<string, McpServerRowFeedback>>;
  readonly onCheck: (serverId: string) => void;
  readonly onEdit: (server: McpServer, trigger: HTMLButtonElement) => void;
  readonly onExpandedChange: (serverId: string, expanded: boolean) => void;
  readonly onRequestDelete: (server: McpServer, trigger: HTMLButtonElement | null) => void;
  readonly onSync: (serverId: string) => void;
  readonly servers: readonly McpServer[];
  readonly toolsByServerId: ReadonlyMap<string, readonly McpTool[]>;
}): JSX.Element {
  return (
    <div className="mcp-server-list settings-mcp-server-list" aria-live="polite">
      {servers.map((server) => (
        <McpServerRow
          key={server.id}
          busyAction={busyServerId === server.id ? busyAction : undefined}
          expanded={expandedServerIds.has(server.id)}
          feedback={feedbackByServerId[server.id]}
          server={server}
          tools={toolsByServerId.get(server.id) ?? []}
          onCheck={onCheck}
          onEdit={onEdit}
          onExpandedChange={(expanded) => onExpandedChange(server.id, expanded)}
          onRequestDelete={onRequestDelete}
          onSync={onSync}
        />
      ))}
    </div>
  );
}
