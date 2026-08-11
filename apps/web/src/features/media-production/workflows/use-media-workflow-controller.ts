import { useCallback, useEffect, useRef, useState } from "react";
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
  MediaWorkflowFailure,
  MediaWorkflowFailureOwner,
  MediaWorkflowImportDraft,
  MediaWorkflowMutationOutcome,
  MediaWorkflowResourcePhase,
} from "./media-workflow-types.js";
import {
  deriveMediaWorkflowImportValidation,
  mediaWorkflowBusyKey,
  repairMediaWorkflowConnectionSelection,
  repairMediaWorkflowSelection,
  referencedWorkflowCount,
} from "./media-workflow-view-models.js";

interface RequestIdentity {
  readonly cwd: string;
  readonly epoch: number;
}

interface BusyTicket extends RequestIdentity {
  readonly key: string;
  readonly lockKey: string;
  readonly token: number;
}

const fiveMegabytes = 5 * 1024 * 1024;

export function useMediaWorkflowController(input: {
  readonly cwd: string;
  readonly onJobsChanged: () => void;
}): { readonly state: MediaWorkflowControllerState; readonly actions: MediaWorkflowControllerActions } {
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [phase, setPhase] = useState<MediaWorkflowResourcePhase>("idle");
  const [connections, setConnectionsState] = useState<readonly MediaWorkflowConnection[]>([]);
  const [workflows, setWorkflowsState] = useState<readonly MediaWorkflowDefinitionDetail[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [libraryDetail, setLibraryDetail] = useState<"workflow" | "import">("workflow");
  const [importDraft, setImportDraftState] = useState<MediaWorkflowImportDraft>();
  const [busyKeys, setBusyKeys] = useState<readonly string[]>([]);
  const [failures, setFailures] = useState<readonly MediaWorkflowFailure[]>([]);

  const epochRef = useRef(0);
  const cwdRef = useRef("");
  const loadRequestRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const busyTokenRef = useRef(0);
  const busyTicketsRef = useRef(new Map<string, number>());
  const subjectTicketsRef = useRef(new Map<string, number>());
  const connectionsRef = useRef<readonly MediaWorkflowConnection[]>([]);
  const workflowsRef = useRef<readonly MediaWorkflowDefinitionDetail[]>([]);
  const importDraftRef = useRef<MediaWorkflowImportDraft | undefined>(undefined);
  const onJobsChangedRef = useRef(input.onJobsChanged);
  onJobsChangedRef.current = input.onJobsChanged;

  const setConnections = useCallback((next: readonly MediaWorkflowConnection[]): void => {
    connectionsRef.current = next;
    setConnectionsState(next);
  }, []);

  const updateConnections = useCallback((update: (current: readonly MediaWorkflowConnection[]) => readonly MediaWorkflowConnection[]): void => {
    setConnections(update(connectionsRef.current));
  }, [setConnections]);

  const setWorkflows = useCallback((next: readonly MediaWorkflowDefinitionDetail[]): void => {
    workflowsRef.current = next;
    setWorkflowsState(next);
  }, []);

  const updateWorkflows = useCallback((update: (current: readonly MediaWorkflowDefinitionDetail[]) => readonly MediaWorkflowDefinitionDetail[]): void => {
    setWorkflows(update(workflowsRef.current));
  }, [setWorkflows]);

  const setImportDraft = useCallback((next: MediaWorkflowImportDraft | undefined): void => {
    importDraftRef.current = next;
    setImportDraftState(next);
  }, []);

  const isCurrent = useCallback((identity: RequestIdentity): boolean => (
    identity.epoch === epochRef.current && identity.cwd === cwdRef.current
  ), []);

  const clearFailure = useCallback((owner: MediaWorkflowFailureOwner, subjectId?: string): void => {
    setFailures((current) => current.filter((failure) => failure.owner !== owner || failure.subjectId !== subjectId));
  }, []);

  const replaceFailure = useCallback((identity: RequestIdentity, failure: MediaWorkflowFailure): void => {
    if (!isCurrent(identity)) return;
    setFailures((current) => [
      ...current.filter((item) => item.owner !== failure.owner || item.subjectId !== failure.subjectId),
      failure,
    ]);
  }, [isCurrent]);

  const claimBusy = useCallback((identity: RequestIdentity, owner: string, subjectId?: string): BusyTicket | undefined => {
    if (!isCurrent(identity)) return undefined;
    const key = mediaWorkflowBusyKey(owner, subjectId);
    const lockKey = mutationLockKey(owner, subjectId);
    if (busyTicketsRef.current.has(key) || subjectTicketsRef.current.has(lockKey)) return undefined;
    const ticket = { ...identity, key, lockKey, token: ++busyTokenRef.current };
    busyTicketsRef.current.set(key, ticket.token);
    subjectTicketsRef.current.set(lockKey, ticket.token);
    setBusyKeys([...busyTicketsRef.current.keys()]);
    return ticket;
  }, [isCurrent]);

  const releaseBusy = useCallback((ticket: BusyTicket): void => {
    if (busyTicketsRef.current.get(ticket.key) !== ticket.token) return;
    busyTicketsRef.current.delete(ticket.key);
    if (subjectTicketsRef.current.get(ticket.lockKey) === ticket.token) subjectTicketsRef.current.delete(ticket.lockKey);
    if (isCurrent(ticket)) setBusyKeys([...busyTicketsRef.current.keys()]);
  }, [isCurrent]);

  const load = useCallback(async (identity: RequestIdentity): Promise<MediaWorkflowMutationOutcome> => {
    if (!identity.cwd || !isCurrent(identity)) return { ok: false, reason: "stale" };
    const requestId = ++loadRequestRef.current;
    const retained = hasLoadedRef.current;
    setPhase(retained ? "refreshing" : "initial-loading");
    clearFailure("load");
    try {
      const [connectionResponse, workflowResponse] = await Promise.all([
        listMediaWorkflowConnections(identity.cwd),
        listMediaWorkflows(identity.cwd),
      ]);
      if (!isCurrent(identity) || requestId !== loadRequestRef.current) return { ok: false, reason: "stale" };
      setConnections(connectionResponse.connections);
      setWorkflows(workflowResponse.workflows);
      setSelectedConnectionId((current) => repairMediaWorkflowConnectionSelection(connectionResponse.connections, current));
      setSelectedWorkflowId((current) => repairMediaWorkflowSelection(workflowResponse.workflows, current));
      hasLoadedRef.current = true;
      setPhase("ready");
      return { ok: true };
    } catch (error) {
      if (!isCurrent(identity) || requestId !== loadRequestRef.current) return { ok: false, reason: "stale" };
      replaceFailure(identity, {
        owner: "load",
        productMessageKey: retained
          ? "Could not refresh production workflows. Showing the last loaded data."
          : "Could not load production workflows.",
        technicalMessage: readError(error),
      });
      setPhase(retained ? "retained-error" : "initial-error");
      return { ok: false, reason: "failed" };
    }
  }, [clearFailure, isCurrent, replaceFailure, setConnections, setWorkflows]);

  const refresh = useCallback(async (): Promise<MediaWorkflowMutationOutcome> => (
    load({ cwd: cwdRef.current, epoch: epochRef.current })
  ), [load]);

  useEffect(() => {
    const cwd = input.cwd.trim();
    const epoch = ++epochRef.current;
    cwdRef.current = cwd;
    loadRequestRef.current += 1;
    busyTicketsRef.current.clear();
    subjectTicketsRef.current.clear();
    hasLoadedRef.current = false;
    setWorkspaceEpoch(epoch);
    setBusyKeys([]);
    setFailures([]);
    setConnections([]);
    setWorkflows([]);
    setSelectedConnectionId("");
    setSelectedWorkflowId("");
    setLibraryDetail("workflow");
    setImportDraft(undefined);
    setPhase(cwd ? "initial-loading" : "idle");
    if (cwd) void load({ cwd, epoch });
    return () => {
      if (epochRef.current === epoch) {
        epochRef.current += 1;
        loadRequestRef.current += 1;
      }
    };
  }, [input.cwd, load, setConnections, setImportDraft, setWorkflows]);

  const createConnection = useCallback(async (
    request: CreateMediaWorkflowConnectionRequest,
  ): Promise<MediaWorkflowMutationOutcome<MediaWorkflowConnection>> => {
    const identity = currentIdentity(cwdRef, epochRef);
    const ticket = claimBusy(identity, "connection-create", "new");
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("connection-create", "new");
    try {
      const response = await createMediaWorkflowConnection(identity.cwd, request);
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      updateConnections((current) => [response.connection, ...current.filter((item) => item.id !== response.connection.id)]);
      setSelectedConnectionId(response.connection.id);
      return { ok: true, value: response.connection };
    } catch (error) {
      replaceFailure(identity, mutationFailure("connection-create", "new", "Could not create this connection.", error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, releaseBusy, replaceFailure, updateConnections]);

  const updateConnection = useCallback(async (
    connectionId: string,
    request: UpdateMediaWorkflowConnectionRequest,
  ): Promise<MediaWorkflowMutationOutcome<MediaWorkflowConnection>> => {
    const identity = currentIdentity(cwdRef, epochRef);
    const ticket = claimBusy(identity, "connection-update", connectionId);
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("connection-update", connectionId);
    try {
      const response = await updateMediaWorkflowConnection(identity.cwd, connectionId, request);
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      updateConnections((current) => current.map((item) => item.id === connectionId ? response.connection : item));
      return { ok: true, value: response.connection };
    } catch (error) {
      replaceFailure(identity, mutationFailure("connection-update", connectionId, "Could not save this connection.", error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, releaseBusy, replaceFailure, updateConnections]);

  const checkConnection = useCallback(async (
    connectionId: string,
  ): Promise<MediaWorkflowMutationOutcome<MediaWorkflowConnection>> => {
    const identity = currentIdentity(cwdRef, epochRef);
    const ticket = claimBusy(identity, "connection-check", connectionId);
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("connection-check", connectionId);
    try {
      const response = await checkMediaWorkflowConnection(identity.cwd, connectionId);
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      updateConnections((current) => current.map((item) => item.id === connectionId ? response.connection : item));
      return { ok: true, value: response.connection };
    } catch (error) {
      replaceFailure(identity, mutationFailure("connection-check", connectionId, "Could not check this connection.", error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, releaseBusy, replaceFailure, updateConnections]);

  const deleteConnection = useCallback(async (connectionId: string): Promise<MediaWorkflowMutationOutcome> => {
    const identity = currentIdentity(cwdRef, epochRef);
    if (referencedWorkflowCount(workflowsRef.current, connectionId) > 0) {
      replaceFailure(identity, {
        owner: "connection-delete",
        subjectId: connectionId,
        productMessageKey: "This connection is used by a production workflow and cannot be deleted.",
      });
      return { ok: false, reason: "invalid" };
    }
    const ticket = claimBusy(identity, "connection-delete", connectionId);
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("connection-delete", connectionId);
    try {
      await deleteMediaWorkflowConnection(identity.cwd, connectionId);
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      const next = connectionsRef.current.filter((item) => item.id !== connectionId);
      setConnections(next);
      setSelectedConnectionId((current) => repairMediaWorkflowConnectionSelection(next, current === connectionId ? "" : current));
      return { ok: true };
    } catch (error) {
      replaceFailure(identity, mutationFailure("connection-delete", connectionId, "Could not delete this connection.", error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, releaseBusy, replaceFailure, setConnections]);

  const inspectImportFile = useCallback(async (file: File, connectionId: string): Promise<MediaWorkflowMutationOutcome> => {
    const identity = currentIdentity(cwdRef, epochRef);
    const subjectId = connectionId || "unselected";
    const ticket = claimBusy(identity, "import-analyze", subjectId);
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("import-analyze", subjectId);
    try {
      if (!connectionId) throw new WorkflowInputError("Create and select a ComfyUI connection before importing.");
      if (file.size > fiveMegabytes) throw new WorkflowInputError("Workflow JSON files cannot exceed 5 MB.");
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isRecord(parsed)) throw new WorkflowInputError("Choose a ComfyUI API Format JSON object.");
      const analysis = await analyzeMediaWorkflow(identity.cwd, { connectionId, graph: parsed });
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      const draft: MediaWorkflowImportDraft = {
        connectionId,
        fileName: file.name,
        name: file.name.replace(/\.json$/iu, "").trim(),
        description: "",
        graph: parsed,
        analysis,
        inputFields: analysis.inputFields,
        outputRules: analysis.outputRules,
      };
      setImportDraft(draft);
      setLibraryDetail("import");
      return { ok: true };
    } catch (error) {
      const productMessageKey = error instanceof WorkflowInputError
        ? error.messageKey
        : error instanceof SyntaxError ? "Workflow JSON is not valid." : "Could not analyze this workflow file.";
      replaceFailure(identity, mutationFailure("import-analyze", subjectId, productMessageKey, error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, releaseBusy, replaceFailure, setImportDraft]);

  const updateImportDraft = useCallback((patch: Partial<Pick<MediaWorkflowImportDraft, "name" | "description" | "inputFields" | "outputRules">>): void => {
    const current = importDraftRef.current;
    if (!current) return;
    setImportDraft({ ...current, ...patch });
    clearFailure("import-save", current.connectionId);
  }, [clearFailure, setImportDraft]);

  const cancelImport = useCallback((): void => {
    const current = importDraftRef.current;
    if (current) {
      clearFailure("import-analyze", current.connectionId);
      clearFailure("import-save", current.connectionId);
    }
    setImportDraft(undefined);
    setLibraryDetail("workflow");
  }, [clearFailure, setImportDraft]);

  const saveImport = useCallback(async (): Promise<MediaWorkflowMutationOutcome<MediaWorkflowDefinitionDetail>> => {
    const identity = currentIdentity(cwdRef, epochRef);
    const draft = importDraftRef.current;
    if (!draft) return { ok: false, reason: "invalid" };
    const validation = deriveMediaWorkflowImportValidation(draft);
    if (!validation.canImport) {
      replaceFailure(identity, {
        owner: "import-save",
        subjectId: draft.connectionId,
        productMessageKey: validation.issues[0]?.key ?? "Review the workflow mappings before importing.",
        productMessageValues: validation.issues[0]?.values,
      });
      return { ok: false, reason: "invalid" };
    }
    const ticket = claimBusy(identity, "import-save", draft.connectionId);
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("import-save", draft.connectionId);
    try {
      const response = await importMediaWorkflow(identity.cwd, {
        connectionId: draft.connectionId,
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        fileName: draft.fileName,
        graph: draft.graph,
        inputFields: draft.inputFields,
        outputRules: draft.outputRules,
      });
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      const detail: MediaWorkflowDefinitionDetail = response;
      updateWorkflows((current) => [detail, ...current.filter((item) => item.definition.id !== detail.definition.id)]);
      setSelectedWorkflowId(detail.definition.id);
      clearFailure("import-analyze", draft.connectionId);
      setImportDraft(undefined);
      setLibraryDetail("workflow");
      return { ok: true, value: detail };
    } catch (error) {
      replaceFailure(identity, mutationFailure("import-save", draft.connectionId, "Could not import this workflow. Your draft is still available.", error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, releaseBusy, replaceFailure, setImportDraft, updateWorkflows]);

  const testWorkflow = useCallback(async (
    workflowId: string,
    versionId: string,
    inputValues: Record<string, unknown>,
  ): Promise<MediaWorkflowMutationOutcome> => {
    const identity = currentIdentity(cwdRef, epochRef);
    const ticket = claimBusy(identity, "workflow-test", workflowId);
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("workflow-test", workflowId);
    try {
      await testMediaWorkflow(identity.cwd, workflowId, { versionId, inputValues });
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      onJobsChangedRef.current();
      await load(identity);
      return isCurrent(identity) ? { ok: true } : { ok: false, reason: "stale" };
    } catch (error) {
      replaceFailure(identity, mutationFailure("workflow-test", workflowId, "Could not start this workflow test.", error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, load, releaseBusy, replaceFailure]);

  const activateWorkflow = useCallback(async (
    workflowId: string,
    versionId: string,
  ): Promise<MediaWorkflowMutationOutcome<MediaWorkflowDefinitionDetail>> => {
    const identity = currentIdentity(cwdRef, epochRef);
    const ticket = claimBusy(identity, "workflow-activate", workflowId);
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("workflow-activate", workflowId);
    try {
      const response = await activateMediaWorkflow(identity.cwd, workflowId, versionId);
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      updateWorkflows((current) => current.map((item) => item.definition.id === workflowId ? response : item));
      return { ok: true, value: response };
    } catch (error) {
      replaceFailure(identity, mutationFailure("workflow-activate", workflowId, "Could not activate this workflow.", error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, releaseBusy, replaceFailure, updateWorkflows]);

  const archiveWorkflow = useCallback(async (
    workflowId: string,
  ): Promise<MediaWorkflowMutationOutcome<MediaWorkflowDefinitionDetail>> => {
    const identity = currentIdentity(cwdRef, epochRef);
    const ticket = claimBusy(identity, "workflow-archive", workflowId);
    if (!ticket) return { ok: false, reason: "in_flight" };
    clearFailure("workflow-archive", workflowId);
    try {
      const response = await archiveMediaWorkflow(identity.cwd, workflowId);
      if (!isCurrent(identity)) return { ok: false, reason: "stale" };
      updateWorkflows((current) => current.map((item) => item.definition.id === workflowId ? response : item));
      setSelectedWorkflowId((current) => repairMediaWorkflowSelection(
        workflowsRef.current,
        current === workflowId ? "" : current,
      ));
      return { ok: true, value: response };
    } catch (error) {
      replaceFailure(identity, mutationFailure("workflow-archive", workflowId, "Could not archive this workflow.", error));
      return { ok: false, reason: isCurrent(identity) ? "failed" : "stale" };
    } finally {
      releaseBusy(ticket);
    }
  }, [claimBusy, clearFailure, isCurrent, releaseBusy, replaceFailure, updateWorkflows]);

  return {
    state: {
      workspaceEpoch,
      phase,
      connections,
      workflows,
      selectedConnectionId,
      selectedWorkflowId,
      libraryDetail,
      importDraft,
      busyKeys,
      busyAction: busyKeys[0] ?? "",
      failures,
    },
    actions: {
      refresh,
      clearFailure,
      selectConnection: setSelectedConnectionId,
      selectWorkflow: (workflowId) => {
        setSelectedWorkflowId(workflowId);
        setLibraryDetail("workflow");
      },
      showImportDraft: () => { if (importDraftRef.current) setLibraryDetail("import"); },
      createConnection,
      updateConnection,
      checkConnection,
      deleteConnection,
      inspectImportFile,
      updateImportDraft,
      cancelImport,
      saveImport,
      testWorkflow,
      activateWorkflow,
      archiveWorkflow,
    },
  };
}

function currentIdentity(
  cwdRef: { readonly current: string },
  epochRef: { readonly current: number },
): RequestIdentity {
  return { cwd: cwdRef.current, epoch: epochRef.current };
}

function mutationFailure(
  owner: MediaWorkflowFailureOwner,
  subjectId: string,
  productMessageKey: string,
  error: unknown,
): MediaWorkflowFailure {
  return {
    owner,
    subjectId,
    productMessageKey,
    technicalMessage: error instanceof WorkflowInputError ? undefined : readError(error),
  };
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class WorkflowInputError extends Error {
  readonly messageKey: string;

  constructor(messageKey: string) {
    super(messageKey);
    this.messageKey = messageKey;
  }
}

function mutationLockKey(owner: string, subjectId?: string): string {
  if (owner.startsWith("connection-")) return `connection:${subjectId ?? "new"}`;
  if (owner.startsWith("workflow-")) return `workflow:${subjectId ?? "unknown"}`;
  if (owner.startsWith("import-")) return "import";
  return mediaWorkflowBusyKey(owner, subjectId);
}
