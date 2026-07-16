import { useCallback, useEffect, useState } from "react";
import {
  activateMediaWorkflow,
  analyzeMediaWorkflow,
  archiveMediaWorkflow,
  checkMediaWorkflowConnection,
  createMediaWorkflowConnection,
  deleteMediaWorkflowConnection,
  importMediaWorkflow,
  listMediaWorkflowConnections,
  listMediaWorkflows,
  testMediaWorkflow,
  updateMediaWorkflowConnection,
} from "../../../api.js";
import type {
  CreateMediaWorkflowConnectionRequest,
  MediaWorkflowConnection,
  MediaWorkflowDefinitionDetail,
  UpdateMediaWorkflowConnectionRequest,
} from "../../../types.js";
import type {
  MediaWorkflowControllerActions,
  MediaWorkflowControllerState,
  MediaWorkflowImportDraft,
} from "./media-workflow-types.js";

export function useMediaWorkflowController(input: {
  readonly cwd: string;
  readonly onJobsChanged: () => void;
}): { readonly state: MediaWorkflowControllerState; readonly actions: MediaWorkflowControllerActions } {
  const [connections, setConnections] = useState<readonly MediaWorkflowConnection[]>([]);
  const [workflows, setWorkflows] = useState<readonly MediaWorkflowDefinitionDetail[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [importDraft, setImportDraft] = useState<MediaWorkflowImportDraft>();
  const [isLoading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    const cwd = input.cwd.trim();
    if (!cwd) {
      setConnections([]);
      setWorkflows([]);
      return;
    }
    setLoading(true);
    try {
      setErrorMessage("");
      const [connectionResponse, workflowResponse] = await Promise.all([
        listMediaWorkflowConnections(cwd),
        listMediaWorkflows(cwd),
      ]);
      setConnections(connectionResponse.connections);
      setWorkflows(workflowResponse.workflows);
      setSelectedConnectionId((current) => current && connectionResponse.connections.some((item) => item.id === current)
        ? current
        : connectionResponse.connections[0]?.id ?? "");
      setSelectedWorkflowId((current) => current && workflowResponse.workflows.some((item) => item.definition.id === current)
        ? current
        : workflowResponse.workflows.find((item) => item.definition.status !== "archived")?.definition.id ?? "");
    } catch (error) {
      setErrorMessage(readError(error));
    } finally {
      setLoading(false);
    }
  }, [input.cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createConnection(request: CreateMediaWorkflowConnectionRequest): Promise<MediaWorkflowConnection | undefined> {
    setBusyAction("create-connection");
    try {
      setErrorMessage("");
      const response = await createMediaWorkflowConnection(input.cwd.trim(), request);
      setConnections((current) => [response.connection, ...current]);
      setSelectedConnectionId(response.connection.id);
      return response.connection;
    } catch (error) {
      setErrorMessage(readError(error));
      return undefined;
    } finally {
      setBusyAction("");
    }
  }

  async function updateConnection(connectionId: string, request: UpdateMediaWorkflowConnectionRequest): Promise<void> {
    setBusyAction(`save-connection:${connectionId}`);
    try {
      setErrorMessage("");
      const response = await updateMediaWorkflowConnection(input.cwd.trim(), connectionId, request);
      setConnections((current) => current.map((item) => item.id === connectionId ? response.connection : item));
    } catch (error) {
      setErrorMessage(readError(error));
    } finally {
      setBusyAction("");
    }
  }

  async function checkConnection(connectionId: string): Promise<void> {
    setBusyAction(`check-connection:${connectionId}`);
    try {
      setErrorMessage("");
      const response = await checkMediaWorkflowConnection(input.cwd.trim(), connectionId);
      setConnections((current) => current.map((item) => item.id === connectionId ? response.connection : item));
    } catch (error) {
      setErrorMessage(readError(error));
    } finally {
      setBusyAction("");
    }
  }

  async function deleteConnection(connectionId: string): Promise<void> {
    setBusyAction(`delete-connection:${connectionId}`);
    try {
      setErrorMessage("");
      await deleteMediaWorkflowConnection(input.cwd.trim(), connectionId);
      setConnections((current) => current.filter((item) => item.id !== connectionId));
      setSelectedConnectionId((current) => current === connectionId ? "" : current);
    } catch (error) {
      setErrorMessage(readError(error));
    } finally {
      setBusyAction("");
    }
  }

  async function inspectImportFile(file: File, connectionId: string): Promise<void> {
    if (!connectionId) {
      setErrorMessage("请先创建并选择一个 ComfyUI 连接。");
      return;
    }
    setBusyAction("analyze-workflow");
    try {
      setErrorMessage("");
      if (file.size > 5 * 1024 * 1024) throw new Error("工作流 JSON 不能超过 5 MB。");
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isRecord(parsed)) throw new Error("请选择 ComfyUI API Format JSON 文件。");
      const analysis = await analyzeMediaWorkflow(input.cwd.trim(), { connectionId, graph: parsed });
      setImportDraft({
        connectionId,
        fileName: file.name,
        name: file.name.replace(/\.json$/iu, "").trim() || "未命名生产流程",
        description: "",
        graph: parsed,
        analysis,
        inputFields: analysis.inputFields,
        outputRules: analysis.outputRules,
      });
    } catch (error) {
      setErrorMessage(readError(error));
      setImportDraft(undefined);
    } finally {
      setBusyAction("");
    }
  }

  function updateImportDraft(patch: Partial<Pick<MediaWorkflowImportDraft, "name" | "description" | "inputFields" | "outputRules">>): void {
    setImportDraft((current) => current ? { ...current, ...patch } : current);
  }

  async function saveImport(): Promise<MediaWorkflowDefinitionDetail | undefined> {
    if (!importDraft || !importDraft.name.trim()) return undefined;
    setBusyAction("import-workflow");
    try {
      setErrorMessage("");
      const response = await importMediaWorkflow(input.cwd.trim(), {
        connectionId: importDraft.connectionId,
        name: importDraft.name.trim(),
        description: importDraft.description.trim() || undefined,
        fileName: importDraft.fileName,
        graph: importDraft.graph,
        inputFields: importDraft.inputFields,
        outputRules: importDraft.outputRules,
      });
      const detail: MediaWorkflowDefinitionDetail = response;
      setWorkflows((current) => [detail, ...current.filter((item) => item.definition.id !== detail.definition.id)]);
      setSelectedWorkflowId(detail.definition.id);
      setImportDraft(undefined);
      return detail;
    } catch (error) {
      setErrorMessage(readError(error));
      return undefined;
    } finally {
      setBusyAction("");
    }
  }

  async function testWorkflow(workflowId: string, versionId: string, inputValues: Record<string, unknown>): Promise<void> {
    setBusyAction(`test-workflow:${workflowId}`);
    try {
      setErrorMessage("");
      await testMediaWorkflow(input.cwd.trim(), workflowId, { versionId, inputValues });
      input.onJobsChanged();
      await refresh();
    } catch (error) {
      setErrorMessage(readError(error));
    } finally {
      setBusyAction("");
    }
  }

  async function activateWorkflow(workflowId: string, versionId: string): Promise<void> {
    setBusyAction(`activate-workflow:${workflowId}`);
    try {
      setErrorMessage("");
      const response = await activateMediaWorkflow(input.cwd.trim(), workflowId, versionId);
      setWorkflows((current) => current.map((item) => item.definition.id === workflowId ? response : item));
    } catch (error) {
      setErrorMessage(readError(error));
    } finally {
      setBusyAction("");
    }
  }

  async function archiveWorkflow(workflowId: string): Promise<void> {
    setBusyAction(`archive-workflow:${workflowId}`);
    try {
      setErrorMessage("");
      const response = await archiveMediaWorkflow(input.cwd.trim(), workflowId);
      setWorkflows((current) => current.map((item) => item.definition.id === workflowId ? response : item));
    } catch (error) {
      setErrorMessage(readError(error));
    } finally {
      setBusyAction("");
    }
  }

  return {
    state: {
      connections,
      workflows,
      selectedConnectionId,
      selectedWorkflowId,
      importDraft,
      isLoading,
      busyAction,
      errorMessage,
    },
    actions: {
      refresh,
      selectConnection: setSelectedConnectionId,
      selectWorkflow: setSelectedWorkflowId,
      createConnection,
      updateConnection,
      checkConnection,
      deleteConnection,
      inspectImportFile,
      updateImportDraft,
      cancelImport: () => setImportDraft(undefined),
      saveImport,
      testWorkflow,
      activateWorkflow,
      archiveWorkflow,
    },
  };
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
