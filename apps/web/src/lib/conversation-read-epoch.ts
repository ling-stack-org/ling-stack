export interface ConversationReadTicket {
  readonly owner: string;
  readonly epoch: number;
}

/**
 * Client ordering only, never a permission revision. A full refresh fences all
 * older reads, including older-page requests carrying previously unseen IDs.
 * Tokens never restart at zero on A -> B -> A or reset. A failed read does not
 * restore the authority of an older in-flight response.
 */
export function createConversationReadEpoch() {
  let owner = "";
  let epoch = 0;
  return {
    begin(nextOwner: string, kind: "full" | "page" = "full"): ConversationReadTicket {
      if (owner !== nextOwner || kind === "full") epoch += 1;
      owner = nextOwner;
      return { owner, epoch };
    },
    isCurrent(ticket: ConversationReadTicket): boolean {
      return ticket.owner === owner && ticket.epoch === epoch;
    },
    invalidate(): void { epoch += 1; owner = ""; },
  };
}
