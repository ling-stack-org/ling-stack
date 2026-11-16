import { createHash } from "node:crypto";
import {
  type CompanionMessageResponse,
  type CompanionProfile,
  type CompanionProactiveRequest,
  type RunStore,
  type TeammateDirectMessage,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import {
  assertCompanionReplyNotPending,
  buildCompanionPrompt,
  finalizeCompanionReply,
  listAllCompanionEvents,
  readCachedCompanionMessage,
  recordCompanionError,
} from "./dialogue.js";
import type { CompanionReplyService } from "./reply-service.js";

export type CompanionProactiveTriggerSource = "scheduler" | "manual";

export interface CompanionProactiveTriggerOptions extends CompanionProactiveRequest {
  readonly source?: CompanionProactiveTriggerSource;
  readonly now?: string;
}

export interface CompanionProactiveResult {
  readonly status: "started" | "duplicate" | "skipped";
  readonly cwd: string;
  readonly companion: CompanionProfile;
  readonly reason?: string;
  readonly response?: CompanionMessageResponse;
}

export interface CompanionSchedulerState {
  readonly cwd: string;
  readonly status: "running" | "stopped";
  readonly intervalMs: number;
  readonly nextTickAt?: string;
}

interface CompanionSchedulerEntry {
  readonly cwd: string;
  readonly intervalMs: number;
  readonly pending: Set<Promise<unknown>>;
  timer?: NodeJS.Timeout;
  ticking: boolean;
  status: CompanionSchedulerState["status"];
  nextTickAt?: string;
}

export class CompanionSchedulerRegistry {
  private readonly entries = new Map<string, CompanionSchedulerEntry>();
  private readonly inFlight = new Map<string, Promise<CompanionProactiveResult>>();

  constructor(
    private readonly dependencies: {
      readonly storeRegistry: RunStoreRegistry;
      readonly replyService: Pick<CompanionReplyService, "createReply">;
      readonly intervalMs?: number;
    },
  ) {}

  start(cwd: string): CompanionSchedulerState {
    const existing = this.entries.get(cwd);
    if (existing) {
      if (existing.status === "stopped") {
        existing.status = "running";
        existing.nextTickAt = undefined;
        void this.runTick(existing);
      }
      return this.toState(existing);
    }
    const intervalMs = Math.max(this.dependencies.intervalMs ?? 60_000, 1_000);
    const entry: CompanionSchedulerEntry = {
      cwd,
      intervalMs,
      pending: new Set(),
      ticking: false,
      status: "running",
    };
    this.entries.set(cwd, entry);
    void this.runTick(entry);
    return this.toState(entry);
  }

  stop(cwd: string): CompanionSchedulerState | undefined {
    const entry = this.entries.get(cwd);
    if (!entry) return undefined;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.status = "stopped";
    entry.nextTickAt = undefined;
    return this.toState(entry);
  }

  stopAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.status = "stopped";
      entry.nextTickAt = undefined;
    }
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const pending = [...this.entries.values()].flatMap((entry) => [...entry.pending]);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  list(cwd?: string): CompanionSchedulerState[] {
    return [...this.entries.values()]
      .filter((entry) => cwd === undefined || entry.cwd === cwd)
      .map((entry) => this.toState(entry));
  }

  async trigger(
    cwd: string,
    companionId: string,
    options: CompanionProactiveTriggerOptions = {},
  ): Promise<CompanionProactiveResult> {
    const store = this.dependencies.storeRegistry.getStore(cwd);
    const companion = store.getCompanion(companionId);
    if (!companion) {
      throw new HttpError(404, "companion_not_found", `Companion not found: ${companionId}`);
    }
    const source = options.source ?? "manual";
    if (companion.status === "disabled") {
      throw new HttpError(409, "companion_disabled", "Disabled companions cannot proactively message.");
    }
    if (companion.status === "paused") {
      throw new HttpError(409, "companion_paused", "Paused companions cannot proactively message.");
    }
    const now = options.now ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error(`Invalid Companion scheduler time: ${now}`);
    if (source === "scheduler" && !companion.behaviorPolicy.proactiveEnabled) {
      return { status: "skipped", cwd, companion, reason: "proactive_disabled" };
    }
    if (source === "manual" && !options.force && !companion.behaviorPolicy.proactiveEnabled) {
      throw new HttpError(409, "companion_proactive_disabled", "Proactive behavior is disabled for this Companion.");
    }

    const events = listAllCompanionEvents(store, companionId);
    const idempotencyKey = options.idempotencyKey?.trim()
      || (options.force && source === "manual"
        ? `manual:${companionId}:${now}`
        : `scheduler:${companionId}:${Math.floor(nowMs / Math.max(companion.behaviorPolicy.cooldownMs, 60_000))}`);
    const key = `${cwd}:${companionId}:${idempotencyKey}`;
    const pending = this.inFlight.get(key);
    if (pending) return { ...await pending, status: "duplicate" };
    const existing = events.find((event) => event.type === "proactive_prompt" && event.payload.idempotencyKey === idempotencyKey);
    const cached = existing ? cachedProactiveResponse(store, companion, existing, cwd) : undefined;
    if (cached) {
      return {
        status: "duplicate",
        cwd,
        companion,
        response: cached,
      };
    }

    if (!options.force && inQuietHours(companion, nowMs)) {
      return { status: "skipped", cwd, companion, reason: "quiet_hours" };
    }
    if (!options.force && companion.behaviorPolicy.cooldownMs > 0
      && [...this.inFlight.keys()].some((activeKey) => activeKey.startsWith(`${cwd}:${companionId}:`))) {
      return { status: "skipped", cwd, companion, reason: "cooldown" };
    }
    const latest = events.find((event) => event.type === "proactive_prompt" && event.payload.idempotencyKey !== idempotencyKey);
    if (!options.force && latest && nowMs - Date.parse(latest.createdAt) < companion.behaviorPolicy.cooldownMs) {
      return { status: "skipped", cwd, companion, reason: "cooldown" };
    }

    const run = this.runProactive({ cwd, store, companion, idempotencyKey, source, now });
    this.inFlight.set(key, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    }
  }

  private async runProactive(input: {
    readonly cwd: string;
    readonly store: RunStore;
    readonly companion: CompanionProfile;
    readonly idempotencyKey: string;
    readonly source: CompanionProactiveTriggerSource;
    readonly now: string;
  }): Promise<CompanionProactiveResult> {
    const teammate = input.store.getAiTeammate(input.companion.teammateId);
    if (!teammate) {
      throw new HttpError(409, "companion_teammate_missing", `Bound AI teammate not found: ${input.companion.teammateId}`);
    }
    const thread = input.store.getOrCreateTeammateDirectThread(teammate.id, input.now);
    const prompt = "主动陪伴触发。请根据当前 Companion 状态，用一两句自然、具体的话主动陪伴用户；不要执行工具，不要声称用户刚刚发送了消息。";
    const sourceMessageId = `companion_prompt_${stableHash(`${input.companion.id}:${input.idempotencyKey}`)}`;
    const replyMessageId = `companion_reply_${stableHash(`${input.companion.id}:${input.idempotencyKey}`)}`;
    assertCompanionReplyNotPending(input.store, replyMessageId);
    const sourceMessage = input.store.getTeammateDirectMessage(sourceMessageId) ?? input.store.createTeammateDirectMessage({
      id: sourceMessageId,
      threadId: thread.id,
      teammateId: teammate.id,
      authorType: "system",
      authorId: "companion-scheduler",
      body: prompt,
      status: "ready",
    }, input.now);
    const started = input.store.recordCompanionInteraction({
      companionId: input.companion.id,
      type: "presence_changed",
      phase: "thinking",
      payload: { source: "proactive", messageId: sourceMessage.id },
    }, input.now).state;
    let finalized: ReturnType<typeof finalizeCompanionReply>;
    try {
      const aiReply = await this.dependencies.replyService.createReply({
        store: input.store,
        companion: input.companion,
        teammate,
        thread,
        sourceMessage,
        replyMessageId,
        disableWebEvidence: true,
        systemPromptAppend: `${buildCompanionPrompt(input.companion, started)}\nThis is a proactive Companion message. Keep it brief and do not ask for tool execution.`,
      });
      finalized = finalizeCompanionReply(input.store, input.companion, sourceMessage, aiReply);
      input.store.recordCompanionEvent({
        companionId: input.companion.id,
        type: "proactive_prompt",
        payload: { idempotencyKey: input.idempotencyKey, source: input.source, messageId: sourceMessage.id },
      }, input.now);
    } catch (error) {
      recordCompanionError(input.store, input.companion.id, error, sourceMessage.id);
      throw error;
    }
    return {
      status: "started",
      cwd: input.cwd,
      companion: input.store.getCompanion(input.companion.id) ?? input.companion,
      response: {
        cwd: input.cwd,
        companion: input.store.getCompanion(input.companion.id) ?? input.companion,
        thread,
        message: sourceMessage,
        aiReply: finalized.aiReply,
        companionReply: finalized.companionReply,
        state: finalized.state,
      },
    };
  }

  private async runTick(entry: CompanionSchedulerEntry): Promise<void> {
    if (entry.ticking || entry.status !== "running") return;
    entry.ticking = true;
    const work = (async () => {
      try {
        const store = this.dependencies.storeRegistry.getStore(entry.cwd);
        const companions = store.listCompanions({ status: "active", limit: 500 });
        await Promise.allSettled(companions
          .filter((companion) => companion.behaviorPolicy.proactiveEnabled)
          .map((companion) => this.trigger(entry.cwd, companion.id, { source: "scheduler" })));
      } catch {
        // Scheduler ticks are background work. A legacy/custom store may not
        // have Companion tables yet; leave the rest of the daemon available
        // and retry on the next tick after storage initialization catches up.
      } finally {
        entry.ticking = false;
        if (entry.status === "running") {
          entry.nextTickAt = new Date(Date.now() + entry.intervalMs).toISOString();
          entry.timer = setTimeout(() => void this.runTick(entry), entry.intervalMs);
          entry.timer.unref?.();
        }
      }
    })();
    entry.pending.add(work);
    try {
      await work;
    } finally {
      entry.pending.delete(work);
    }
  }

  private toState(entry: CompanionSchedulerEntry): CompanionSchedulerState {
    return {
      cwd: entry.cwd,
      status: entry.status,
      intervalMs: entry.intervalMs,
      ...(entry.nextTickAt ? { nextTickAt: entry.nextTickAt } : {}),
    };
  }
}

function cachedProactiveResponse(
  store: RunStore,
  companion: CompanionProfile,
  event: { readonly payload: Readonly<Record<string, unknown>> },
  cwd: string,
): CompanionMessageResponse | undefined {
  const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : undefined;
  if (!messageId) return undefined;
  const message = store.getTeammateDirectMessage(messageId);
  if (!message) return undefined;
  const thread = store.getOrCreateTeammateDirectThread(companion.teammateId, message.createdAt);
  return readCachedCompanionMessage(store, companion, thread, message.id, cwd);
}

function inQuietHours(companion: CompanionProfile, nowMs: number): boolean {
  const quietHours = companion.behaviorPolicy.quietHours;
  if (!quietHours) return false;
  const hour = new Date(nowMs).getHours();
  const [start, end] = quietHours;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}
