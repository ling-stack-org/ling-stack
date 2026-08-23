import {
  isChannelTurnDispatchRequestV1,
  projectConversationItemToChannelMessage,
  type ChannelMessage,
  type ChannelTurnDispatchRequestV1,
  type RunStore,
} from "@ling-stack/core";
import type { ChannelReplyPendingEvent } from "@ling-stack/contracts";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import {
  blockAcceptedChannelTurnDispatch,
  claimAcceptedChannelTurnDispatch,
  completeAcceptedChannelTurnDispatch,
  failAcceptedChannelTurnDispatch,
  findAcceptedChannelTurnDispatch,
  replayAcceptedChannelTurnDispatch,
  type ClaimedChannelTurnDispatch,
} from "./channel-turn-dispatch-lifecycle.js";
import type { LingAgentChannelMessageResult } from "./messages.js";

const recoverableDispatchStatuses = [
  "queued",
  "claimed",
  "running",
  "waiting_for_approval",
  "cancelling",
  "stale",
] as const;

export interface ChannelTurnDispatchObserver {
  readonly onReplyPending?: (pending: ChannelReplyPendingEvent) => void;
  readonly onReplyReady?: (reply: ChannelMessage) => void;
  readonly onRunLinked?: (reply: ChannelMessage) => void;
  readonly onDelta?: (reply: ChannelMessage, delta: string) => void;
  readonly onDone?: (reply: ChannelMessage) => void;
  readonly onBlocked?: (reply: ChannelMessage) => void;
}

export interface ChannelTurnDispatchExecution {
  readonly result: LingAgentChannelMessageResult;
  readonly settled?: Promise<void>;
}

export type ExecuteClaimedChannelTurnDispatch = (input: {
  readonly store: RunStore;
  readonly channel: NonNullable<ReturnType<RunStore["getChannel"]>>;
  readonly sourceMessage: ChannelMessage;
  readonly request: ChannelTurnDispatchRequestV1;
  readonly observer: ChannelTurnDispatchObserver;
}) => Promise<ChannelTurnDispatchExecution>;

interface DispatchJob {
  readonly observers: Set<ChannelTurnDispatchObserver>;
  readonly handoff: Promise<LingAgentChannelMessageResult>;
  readonly settled: Promise<LingAgentChannelMessageResult>;
  resolveHandoff(result: LingAgentChannelMessageResult): void;
  resolveSettled(result: LingAgentChannelMessageResult): void;
  reject(error: unknown): void;
}

export class ChannelTurnDispatchWorkerRegistry {
  private readonly drains = new Map<string, Promise<void>>();
  private readonly jobs = new Map<string, DispatchJob>();
  private readonly settlements = new Set<Promise<void>>();
  private accepting = true;
  private started = false;

  constructor(
    private readonly runtimeSupervisor: RuntimeSupervisor,
    private readonly execute: ExecuteClaimedChannelTurnDispatch,
  ) {}

  dispatchAcceptedTurn(input: {
    readonly store: RunStore;
    readonly message: ChannelMessage;
    readonly observer?: ChannelTurnDispatchObserver;
    readonly waitForSettled?: boolean;
  }): Promise<LingAgentChannelMessageResult> {
    const workUnit = findAcceptedChannelTurnDispatch(input.store, input.message);
    if (workUnit.status === "succeeded" || workUnit.status === "failed" || workUnit.status === "cancelled") {
      return Promise.resolve(replayAcceptedChannelTurnDispatch(input.store, input.message.id));
    }
    const job = this.ensureJob(workUnit.id);
    if (input.observer) job.observers.add(input.observer);
    this.wake(input.store);
    return input.waitForSettled ? job.settled : job.handoff;
  }

  start(store: RunStore): void {
    if (!this.accepting) return;
    this.started = true;
    this.wake(store);
  }

  wake(store: RunStore): void {
    if (!this.accepting || !this.started || this.drains.has(store.paths.cwd)) return;
    const drain = this.drain(store).finally(() => {
      if (this.drains.get(store.paths.cwd) === drain) this.drains.delete(store.paths.cwd);
      if (this.accepting && store.listWorkUnits({ kind: "channel_turn_dispatch", status: "queued", limit: 1 }).length > 0) {
        this.wake(store);
      }
    });
    this.drains.set(store.paths.cwd, drain);
  }

  async close(): Promise<void> {
    this.accepting = false;
    this.started = false;
    await waitForPromisesOrDeadline([...this.drains.values()], 2_000);
    await waitForPromisesOrDeadline([...this.settlements.values()], 2_000);
  }

  private async drain(store: RunStore): Promise<void> {
    const hasRecoverableDispatch = recoverableDispatchStatuses.some((status) =>
      store.listWorkUnits({ kind: "channel_turn_dispatch", status, limit: 1 }).length > 0
    );
    if (!hasRecoverableDispatch) return;
    this.runtimeSupervisor.getRuntime(store.paths.cwd, store);
    while (this.accepting) {
      const queued = store
        .listWorkUnits({ kind: "channel_turn_dispatch", status: "queued", limit: 500 })
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      const candidate = queued[0];
      if (!candidate) return;
      const claim = claimAcceptedChannelTurnDispatch({ store, workUnit: candidate, runtimeSupervisor: this.runtimeSupervisor });
      if (claim.kind === "owned") continue;
      if (claim.kind === "replay") {
        this.resolveJob(candidate.id, claim.result, true);
        continue;
      }
      await this.executeClaimed(store, claim.dispatch);
    }
  }

  private async executeClaimed(store: RunStore, dispatch: ClaimedChannelTurnDispatch): Promise<void> {
    const job = this.ensureJob(dispatch.workUnitId);
    try {
      const request = dispatch.workUnit.request;
      if (!isChannelTurnDispatchRequestV1(request)) {
        throw new Error(`Channel turn dispatch request is invalid: ${dispatch.workUnitId}`);
      }
      if (
        request.sourceItemId !== dispatch.sourceItemId
        || request.sourceTurnId !== dispatch.sourceTurnId
        || request.channelId !== dispatch.workUnit.channelId
      ) {
        throw new Error(`Channel turn dispatch request does not match WorkUnit lineage: ${dispatch.workUnitId}`);
      }
      const sourceItem = store.getConversationItem(request.sourceItemId);
      const channel = store.getChannel(request.channelId);
      if (!sourceItem || sourceItem.turnId !== request.sourceTurnId || sourceItem.threadId !== request.threadId || !channel) {
        throw new Error(`Channel turn dispatch source records are unavailable: ${dispatch.workUnitId}`);
      }
      if (request.unavailableRequestedParticipantIds?.length) {
        if (sourceItem.kind !== "user_message") {
          throw new Error(`Channel turn dispatch unavailable participants require a user source item: ${dispatch.workUnitId}`);
        }
        const mentionedParticipantIds = new Set(sourceItem.payload.mentions
          .filter((mention) => mention.kind === "ai_teammate")
          .map((mention) => mention.id));
        const unboundParticipantId = request.unavailableRequestedParticipantIds
          .find((participantId) => !mentionedParticipantIds.has(participantId));
        if (unboundParticipantId) {
          throw new Error(`Channel turn dispatch unavailable participant is not bound to the source item: ${unboundParticipantId}`);
        }
      }
      const sourceMessage = projectConversationItemToChannelMessage(sourceItem);
      const execution = await this.execute({
        store,
        channel,
        sourceMessage,
        request,
        observer: multiplexObservers(job.observers),
      });
      this.resolveJob(dispatch.workUnitId, execution.result, false);
      if (execution.settled) {
        const settlement = execution.settled.then(
          () => {
            completeAcceptedChannelTurnDispatch(store, dispatch);
            this.resolveJob(dispatch.workUnitId, replayAcceptedChannelTurnDispatch(store, request.sourceItemId), true);
          },
          (error) => {
            failAcceptedChannelTurnDispatch(store, dispatch, error);
            this.rejectJob(dispatch.workUnitId, error);
          },
        ).finally(() => this.settlements.delete(settlement));
        this.settlements.add(settlement);
      } else {
        completeAcceptedChannelTurnDispatch(store, dispatch);
        this.resolveJob(dispatch.workUnitId, execution.result, true);
      }
    } catch (error) {
      const sourceItem = store.getConversationItem(dispatch.sourceItemId);
      if (sourceItem) {
        const blocker = blockAcceptedChannelTurnDispatch(store, projectConversationItemToChannelMessage(sourceItem), error);
        if (blocker) multiplexObservers(job.observers).onBlocked?.(blocker);
      }
      failAcceptedChannelTurnDispatch(store, dispatch, error);
      this.rejectJob(dispatch.workUnitId, error);
    }
  }

  private ensureJob(workUnitId: string): DispatchJob {
    const existing = this.jobs.get(workUnitId);
    if (existing) return existing;
    let resolveHandoff!: (result: LingAgentChannelMessageResult) => void;
    let resolveSettled!: (result: LingAgentChannelMessageResult) => void;
    let rejectHandoff!: (error: unknown) => void;
    let rejectSettled!: (error: unknown) => void;
    const handoff = new Promise<LingAgentChannelMessageResult>((resolve, reject) => {
      resolveHandoff = resolve;
      rejectHandoff = reject;
    });
    const settled = new Promise<LingAgentChannelMessageResult>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    const job: DispatchJob = {
      observers: new Set(),
      handoff,
      settled,
      resolveHandoff,
      resolveSettled,
      reject: (error) => {
        rejectHandoff(error);
        rejectSettled(error);
      },
    };
    void handoff.catch(() => undefined);
    void settled.catch(() => undefined);
    this.jobs.set(workUnitId, job);
    return job;
  }

  private resolveJob(workUnitId: string, result: LingAgentChannelMessageResult, terminal: boolean): void {
    const job = this.jobs.get(workUnitId);
    if (!job) return;
    job.resolveHandoff(result);
    if (!terminal) return;
    this.jobs.delete(workUnitId);
    job.resolveSettled(result);
  }

  private rejectJob(workUnitId: string, error: unknown): void {
    const job = this.jobs.get(workUnitId);
    if (!job) return;
    this.jobs.delete(workUnitId);
    job.reject(error);
  }
}

async function waitForPromisesOrDeadline(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function multiplexObservers(observers: Set<ChannelTurnDispatchObserver>): ChannelTurnDispatchObserver {
  const notify = <Args extends readonly unknown[]>(
    select: (observer: ChannelTurnDispatchObserver) => ((...args: Args) => void) | undefined,
    ...args: Args
  ): void => {
    for (const observer of [...observers]) {
      try {
        select(observer)?.(...args);
      } catch {
        observers.delete(observer);
      }
    }
  };
  return {
    onReplyPending: (pending) => notify((observer) => observer.onReplyPending, pending),
    onReplyReady: (reply) => notify((observer) => observer.onReplyReady, reply),
    onRunLinked: (reply) => notify((observer) => observer.onRunLinked, reply),
    onDelta: (reply, delta) => notify((observer) => observer.onDelta, reply, delta),
    onDone: (reply) => notify((observer) => observer.onDone, reply),
    onBlocked: (reply) => notify((observer) => observer.onBlocked, reply),
  };
}
