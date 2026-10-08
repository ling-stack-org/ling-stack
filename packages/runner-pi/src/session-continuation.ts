import { toToolDeclaration } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./utils.js";

const HOST_RESUME_CONTROL = "ling_host_resume_v1";

/** Initialize frozen authority without copying Pi's private prompt builder. */
export function appendPiSessionAuthority(session: AgentSession): void {
  // Store the exact rendered prompt in a replaceable preamble, not content:
  // Pi may refine it into its own sections on the next turn without duplicating
  // the opaque prompt. The first request still carries the exact receipt text.
  session.sessionManager.appendMessage({ role: "system", content: "",
    sections: { preamble: session.systemPrompt },
    toolsAdded: session.state.tools.map(toToolDeclaration), timestamp: 0 });
}

export function isPiHostResumeControl(message: unknown): boolean {
  return isRecord(message) && message.role === "custom" && message.customType === HOST_RESUME_CONTROL;
}

function omitResumeControl(session: AgentSession): void {
  const controls = session.sessionManager.buildSessionProjection().entries.filter((entry) =>
    entry.sourceEntry.type === "custom_message" && entry.sourceEntry.customType === HOST_RESUME_CONTROL
    && entry.messages.length > 0);
  if (controls.length > 1) throw new Error("Pi Host continuation has duplicate controls");
  for (const entry of controls) session.sessionManager.appendContextEdit(entry.sourceEntry.id, null);
  if (controls.length > 0) session.refreshContext();
}

/**
 * Resume through Pi's public Session driver, preserving SDK-owned retry,
 * compaction and settlement. Its empty internal trigger is omitted from both
 * canonical history and this request before the original transform chain runs.
 * No historical prompt or tool is replayed and no private driver is called.
 */
export async function continuePiSession(session: AgentSession): Promise<void> {
  if (!session.isIdle || session.messages.at(-1)?.role !== "toolResult") {
    throw new Error("Pi Host continuation requires an idle canonical tool result");
  }
  const previous = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    omitResumeControl(session);
    const conversation = messages.filter((message) => !isPiHostResumeControl(message));
    const transformed = previous ? await previous(conversation, signal) : conversation;
    if (transformed.some(isPiHostResumeControl)) throw new Error("Pi Host continuation control escaped projection");
    return transformed;
  };
  try {
    await session.sendCustomMessage({ customType: HOST_RESUME_CONTROL, content: [], display: false }, { triggerTurn: true });
    await session.waitForIdle();
    if (session.sessionManager.buildSessionProjection().messages.some(isPiHostResumeControl)) {
      throw new Error("Pi Host continuation control remains in canonical context");
    }
  } finally {
    // Cancellation can win before the first transform callback. Still omit
    // its already-persisted trigger from the finalized canonical transcript.
    try { omitResumeControl(session); }
    finally { session.agent.transformContext = previous; }
  }
}
