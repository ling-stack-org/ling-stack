import type { RunStore } from "../../run-types.js";
import type { ChannelWorkflow, ChannelWorkflowStep } from "../../workspace-types.js";
import type { AppendConversationUserTurnInput, AppendConversationUserTurnResult } from "../../conversation-turn-ingest-types.js";
import type { ResolveOrCreateConversationThreadInput, ResolveOrCreateConversationThreadResult } from "../../conversation-thread-topology-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { withSqliteSnapshotParentTransaction } from "./read-snapshot.js";

interface CompiledWorkflow {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
}

interface WorkflowUserCreationStore {
  create(input: { readonly channelId: string; readonly compile: () => CompiledWorkflow; readonly now: string }): CompiledWorkflow;
  createWithinTransaction(input: { readonly channelId: string; readonly compile: () => CompiledWorkflow; readonly now: string }): CompiledWorkflow;
}

interface WorkflowUserCreationPorts {
  readonly resolveThread: (input: ResolveOrCreateConversationThreadInput, now: string) => ResolveOrCreateConversationThreadResult;
  readonly appendInput: (input: AppendConversationUserTurnInput, now: string) => AppendConversationUserTurnResult;
}

const adapters = new WeakMap<RunStore, WorkflowUserCreationStore>();

export function createSqliteWorkflowUserCreationStore(store: RunStore): WorkflowUserCreationStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new Error("workflow_user_creation.store_not_sqlite");
  return adapter;
}

export function registerSqliteWorkflowUserCreationStore(store: RunStore, context: SqliteStoreContext, ports: WorkflowUserCreationPorts): void {
  if (adapters.has(store)) throw new Error("workflow_user_creation.store_already_registered");
  const createWithinTransaction: WorkflowUserCreationStore["createWithinTransaction"] = ({ channelId, compile, now }) => {
    const db = context.database;
    if (!db.isTransaction) throw new Error("workflow_user_creation.transaction_required");
    if (Object.prototype.toString.call(compile) === "[object AsyncFunction]") throw new TypeError("Workflow compiler must be synchronous");
    const channel = store.getChannel(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    const compiled = withSqliteSnapshotParentTransaction(db, compile);
    if (compiled && typeof Reflect.get(compiled, "then") === "function") {
      void Promise.resolve(compiled).catch(() => undefined);
      throw new TypeError("Workflow compiler must be synchronous");
    }
    const { workflow } = compiled;
    if (workflow.channelId !== channelId || !store.getChannelWorkflow(workflow.id)) throw new Error("workflow_user_creation.workflow_scope_mismatch");
    const { thread } = ports.resolveThread({ surfaceKind: "channel_root", channelId,
      title: `${channel.name} conversation`, objective: `Root conversation for ${channel.name}.` }, now);
    // This records the explicit Create/repair request, not a dispatch or an Agent reply.
    const source = ports.appendInput({ channelId, threadId: thread.id,
      turnKind: thread.nextItemSequence > 1 ? "manual_followup" : "initial_request",
      title: workflow.title, userInstruction: workflow.objective,
      payload: { body: workflow.objective, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      domainRefs: [{ type: "workflow", id: workflow.id }], idempotencyKey: `workflow-create:${workflow.id}` }, now);
    const linked = store.updateChannelWorkflow(workflow.id, { metadata: { ...workflow.metadata,
      sourceTurnId: source.turnId, sourceMessageId: source.item.id } }, now);
    if (!linked) throw new Error("workflow_user_creation.workflow_missing");
    return { ...compiled, workflow: linked };
  };
  adapters.set(store, {
    createWithinTransaction,
    create({ channelId, compile, now }) {
      const db = context.database;
      if (db.isTransaction) throw new Error("workflow_user_creation.transaction_owned");
      if (Object.prototype.toString.call(compile) === "[object AsyncFunction]") throw new TypeError("Workflow compiler must be synchronous");
      db.exec("BEGIN IMMEDIATE");
      try {
        const compiled = createWithinTransaction({ channelId, compile, now });
        db.exec("COMMIT");
        return compiled;
      } catch (error) {
        rollbackOwnedSqliteTransaction(db);
        throw error;
      }
    },
  });
}
