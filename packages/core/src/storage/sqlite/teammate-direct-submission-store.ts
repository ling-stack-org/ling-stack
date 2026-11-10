import type { CreateTeammateDirectMessageInput, TeammateDirectMessage } from "../../workspace-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteTeammateDirectSubmissionStore {
  constructor(private readonly context: SqliteStoreContext, private readonly messages: {
    readonly createTeammateDirectMessage: (input: CreateTeammateDirectMessageInput, now: string) => TeammateDirectMessage;
    readonly getTeammateDirectMessage: (id: string) => TeammateDirectMessage | undefined;
  }) {}

  get(teammateId: string, key: string): TeammateDirectMessage | undefined {
    const row = this.context.database.prepare(`SELECT id FROM teammate_direct_messages
      WHERE workspace_id=? AND teammate_id=? AND submission_key=?`).get(DEFAULT_WORKSPACE_ID, teammateId, key);
    return row ? this.messages.getTeammateDirectMessage(String(row.id)) : undefined;
  }

  accept(input: CreateTeammateDirectMessageInput & { readonly idempotencyKey: string; readonly requestFingerprint: string },
    now: string): { readonly message: TeammateDirectMessage; readonly created: boolean } {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || /[\r\n]/.test(input.idempotencyKey)
      || !/^[a-f0-9]{64}$/.test(input.requestFingerprint) || input.authorType !== "local-user" || input.authorId !== "local-user") {
      throw new Error("Invalid private submission identity");
    }
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.context.database.prepare(`SELECT id, thread_id, submission_fingerprint FROM teammate_direct_messages
        WHERE workspace_id=? AND teammate_id=? AND submission_key=?`).get(DEFAULT_WORKSPACE_ID, input.teammateId, input.idempotencyKey);
      if (row && (row.submission_fingerprint !== input.requestFingerprint || row.thread_id !== input.threadId)) {
        throw new Error("Private submission idempotency key is bound to another input");
      }
      const message = row ? this.messages.getTeammateDirectMessage(String(row.id))!
        : this.messages.createTeammateDirectMessage(input, now);
      if (!row) {
        this.context.database.prepare(`UPDATE teammate_direct_messages SET submission_key=?, submission_fingerprint=? WHERE id=?`)
          .run(input.idempotencyKey, input.requestFingerprint, message.id);
      }
      this.context.database.exec("COMMIT;");
      return { message, created: !row };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }
}
