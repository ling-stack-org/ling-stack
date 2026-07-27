import { Server, Wrench } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import {
  DataRow,
  EmptyState,
  InlineFeedback,
  Skeleton,
} from "../../shared/ui/index.js";
import type { McpServer, McpServerFormState, McpTool } from "../../types.js";
import { McpServerDeleteDialog } from "./McpServerDeleteDialog.js";
import { McpServerEditorDialog } from "./McpServerEditorDialog.js";
import { McpServerList } from "./McpServerList.js";
import { McpServerToolbar } from "./McpServerToolbar.js";
import {
  groupMcpToolsByServer,
  mcpServerStatusPresentation,
} from "./mcp-settings-view-models.js";
import { useMcpRowFeedbackController } from "./useMcpRowFeedbackController.js";

export interface McpSettingsError {
  readonly message: string;
  readonly scope: "load" | "mutation" | "stream";
}

export function McpToolsPage({
  busyAction,
  busyServerId,
  cwd,
  error,
  isLoading,
  onCheck,
  onClearError,
  onCreate,
  onDelete,
  onRefresh,
  onSyncTools,
  onUpdate,
  servers,
  tools,
}: {
  readonly busyAction?: "check" | "delete" | "save" | "sync";
  readonly busyServerId: string;
  readonly cwd: string;
  readonly error?: McpSettingsError;
  readonly isLoading: boolean;
  readonly onCheck: (serverId: string) => Promise<boolean>;
  readonly onClearError: () => void;
  readonly onCreate: (form: McpServerFormState) => Promise<void>;
  readonly onDelete: (serverId: string) => Promise<boolean>;
  readonly onRefresh: () => void;
  readonly onSyncTools: (serverId: string) => Promise<boolean>;
  readonly onUpdate: (serverId: string, form: McpServerFormState) => Promise<void>;
  readonly servers: readonly McpServer[];
  readonly tools: readonly McpTool[];
}): JSX.Element {
  const { t } = useI18n();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingServer, setDeletingServer] = useState<McpServer | undefined>();
  const [expandedServerIds, setExpandedServerIds] = useState<ReadonlySet<string>>(() => new Set());
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toolsByServerId = useMemo(() => groupMcpToolsByServer(tools), [tools]);
  const readyCount = servers.filter((server) => mcpServerStatusPresentation(server).id === "ready").length;
  const { feedbackByServerId, runCheck, runSync } = useMcpRowFeedbackController(servers);

  const openCreate = (trigger: HTMLButtonElement): void => {
    editorTriggerRef.current = trigger;
    setEditingServer(undefined);
    onClearError();
    setEditorOpen(true);
  };

  const openEdit = (server: McpServer, trigger: HTMLButtonElement): void => {
    editorTriggerRef.current = trigger;
    setEditingServer(server);
    onClearError();
    setEditorOpen(true);
  };

  const openDelete = (server: McpServer, trigger: HTMLButtonElement | null): void => {
    deleteTriggerRef.current = trigger;
    setDeletingServer(server);
    onClearError();
    setDeleteOpen(true);
  };

  const saveEditor = async (form: McpServerFormState): Promise<string | undefined> => {
    try {
      if (editingServer) await onUpdate(editingServer.id, form);
      else await onCreate(form);
      return undefined;
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  };

  const checkServer = async (serverId: string): Promise<void> => {
    await runCheck(serverId, onCheck);
  };

  const syncServer = async (serverId: string): Promise<void> => {
    const synced = await runSync(serverId, onSyncTools);
    if (synced) {
      setExpandedServerIds((current) => new Set(current).add(serverId));
    }
  };

  return (
    <div className="mcp-page settings-mcp-page" data-ui2-mcp-tools="">
      <McpServerToolbar
        disabled={!cwd.trim()}
        loading={isLoading}
        readyCount={readyCount}
        serverCount={servers.length}
        toolCount={tools.length}
        onAdd={openCreate}
        onRefresh={onRefresh}
      />

      {error?.scope === "load" ? (
        <InlineFeedback tone="danger">
          {t("MCP servers could not be refreshed. The last loaded list is still shown.")}
        </InlineFeedback>
      ) : null}

      {isLoading && servers.length === 0 ? (
        <McpServerLoadingState />
      ) : servers.length === 0 ? (
        <EmptyState
          className="settings-mcp-empty"
          icon={<Wrench />}
          title={t("No MCP servers")}
          description={t("Add a server, check it, then assign tools to AI teammates explicitly.")}
        />
      ) : (
        <McpServerList
          busyAction={busyAction}
          busyServerId={busyServerId}
          expandedServerIds={expandedServerIds}
          feedbackByServerId={feedbackByServerId}
          servers={servers}
          toolsByServerId={toolsByServerId}
          onCheck={(serverId) => void checkServer(serverId)}
          onEdit={openEdit}
          onExpandedChange={(serverId, expanded) => {
            setExpandedServerIds((current) => {
              const next = new Set(current);
              if (expanded) next.add(serverId);
              else next.delete(serverId);
              return next;
            });
          }}
          onRequestDelete={openDelete}
          onSync={(serverId) => void syncServer(serverId)}
        />
      )}

      <McpServerEditorDialog
        busy={busyAction === "save" && busyServerId === (editingServer?.id ?? "")}
        open={editorOpen}
        returnFocusRef={editorTriggerRef}
        server={editingServer}
        onOpenChange={setEditorOpen}
        onSubmit={saveEditor}
      />
      <McpServerDeleteDialog
        busy={busyAction === "delete" && busyServerId === deletingServer?.id}
        errorMessage={deleteOpen && error?.scope === "mutation" ? error.message : undefined}
        open={deleteOpen}
        returnFocusRef={deleteTriggerRef}
        server={deletingServer}
        onConfirm={async () => deletingServer ? onDelete(deletingServer.id) : false}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}

function McpServerLoadingState(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="settings-mcp-loading" aria-label={t("Loading MCP servers")}>
      {[0, 1, 2].map((index) => (
        <DataRow
          key={index}
          identity={(
            <span className="settings-mcp-loading-identity">
              <Skeleton shape="circle" width={30} height={30} />
              <span><Skeleton width="11rem" /><Skeleton width="7rem" /></span>
            </span>
          )}
          summary={<Skeleton width="4rem" />}
          status={<Skeleton width="5rem" />}
        />
      ))}
    </div>
  );
}
