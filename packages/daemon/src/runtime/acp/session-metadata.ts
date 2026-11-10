import type { AvailableCommand, Cost } from "@agentclientprotocol/sdk";
import { AcpLifecycleError, record, text } from "./live-errors.js";

export interface AcpSessionMetadataSnapshot {
  readonly title?: string | null;
  readonly updatedAt?: string | null;
  readonly availableCommands?: readonly AvailableCommand[];
  readonly usage?: { readonly used: number; readonly size: number; readonly cost?: Cost | null };
}

/** Native presentation data only; never executable commands, Ling titles or prompt acceptance. */
export class AcpSessionMetadata {
  #value: AcpSessionMetadataSnapshot = {};
  #bytes = 0;

  get snapshot(): AcpSessionMetadataSnapshot { return structuredClone(this.#value); }

  receive(update: Readonly<Record<string, unknown>>): boolean {
    if (!["session_info_update", "available_commands_update", "usage_update"].includes(String(update.sessionUpdate))) return false;
    const bytes = Buffer.byteLength(JSON.stringify(update));
    this.#bytes += bytes;
    if (bytes > 128 * 1024 || this.#bytes > 8 * 1024 * 1024) throw new AcpLifecycleError("output_limit");
    if (update.sessionUpdate === "session_info_update") {
      if ((update.title != null && typeof update.title !== "string")
        || (update.updatedAt != null && (typeof update.updatedAt !== "string" || !Number.isFinite(Date.parse(update.updatedAt))))) invalid();
      this.#value = { ...this.#value,
        ...(update.title !== undefined ? { title: update.title as string | null } : {}),
        ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt as string | null } : {}) };
    } else if (update.sessionUpdate === "available_commands_update") {
      if (!Array.isArray(update.availableCommands) || update.availableCommands.length > 256) invalid();
      const names = new Set<string>();
      const commands = update.availableCommands.map(command => {
        if (!record(command) || !text(command.name) || names.has(command.name) || typeof command.description !== "string"
          || (command.input != null && (!record(command.input) || typeof command.input.hint !== "string"))) invalid();
        names.add(command.name);
        return { name: command.name, description: command.description,
          ...(command.input != null ? { input: { hint: command.input.hint as string } } : {}) };
      });
      this.#value = { ...this.#value, availableCommands: commands };
    } else {
      if (!tokens(update.used) || !tokens(update.size)) invalid();
      let cost: Cost | null | undefined;
      if (update.cost === null) cost = null;
      else if (update.cost !== undefined) {
        if (!record(update.cost) || typeof update.cost.amount !== "number" || !Number.isFinite(update.cost.amount)
          || update.cost.amount < 0 || typeof update.cost.currency !== "string" || !/^[A-Z]{3}$/.test(update.cost.currency)) invalid();
        cost = { amount: update.cost.amount, currency: update.cost.currency };
      }
      this.#value = { ...this.#value, usage: { used: update.used, size: update.size,
        ...(cost !== undefined ? { cost } : {}) } };
    }
    return true;
  }
}

function tokens(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function invalid(): never { throw new AcpLifecycleError("protocol_error"); }
