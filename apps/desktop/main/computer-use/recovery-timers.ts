import type { ComputerUsePreviewProjection } from "@ling-stack/contracts";
import { terminalLingerMilliseconds } from "./selectors.js";

type RecoveryTimer = ReturnType<typeof setTimeout>;

export interface ComputerUseRecoveryTimerOptions {
  readonly now: () => Date;
  readonly setTimer: (callback: () => void, milliseconds: number) => RecoveryTimer;
  readonly clearTimer: (timer: RecoveryTimer) => void;
}

export type ReconnectScheduleResult = "scheduled" | "timed_out";

/**
 * Owns bounded Desktop recovery timers and reconnect backoff state.
 *
 * The coordinator supplies side-effect callbacks. This module deliberately does
 * not know about BrowserWindow, media, or runtime projections beyond terminal
 * linger classification, keeping timer behavior deterministic and testable.
 */
export class ComputerUseRecoveryTimers {
  private readonly terminalLinger: PausableRecoveryTimer;
  private readonly sourceErrorLinger: PausableRecoveryTimer;
  private reconnectTimer: RecoveryTimer | undefined;
  private reconnectDeadlineTimer: RecoveryTimer | undefined;
  private reconnectGeneration = 0;
  private reconnectRetryGeneration = 0;
  private firstFrameTimer: RecoveryTimer | undefined;
  private firstFrameGeneration = 0;
  private frameGapTimer: RecoveryTimer | undefined;
  private frameGapGeneration = 0;
  private reconnectStartedAt: number | undefined;
  private reconnectAttempt = 0;
  private interactionPaused = false;
  private terminalPausable = false;

  constructor(private readonly options: ComputerUseRecoveryTimerOptions) {
    this.terminalLinger = new PausableRecoveryTimer(options);
    this.sourceErrorLinger = new PausableRecoveryTimer(options);
  }

  startTerminalLinger(
    projection: ComputerUsePreviewProjection,
    onExpire: () => void,
  ): void {
    if (this.terminalLinger.active) {
      return;
    }
    const delay = terminalLingerMilliseconds(projection.status);
    if (delay === undefined) {
      return;
    }
    this.terminalPausable = projection.status === "failed";
    this.terminalLinger.start(delay, onExpire, this.terminalPausable && this.interactionPaused);
  }

  startSourceErrorLinger(onExpire: () => void): void {
    if (this.sourceErrorLinger.active) {
      return;
    }
    this.sourceErrorLinger.start(5_000, onExpire, this.interactionPaused);
  }

  clearSourceErrorTimer(): void {
    this.sourceErrorLinger.clear();
  }

  setInteractionPaused(paused: boolean): void {
    if (this.interactionPaused === paused) {
      return;
    }
    this.interactionPaused = paused;
    if (paused) {
      if (this.terminalPausable) {
        this.terminalLinger.pause();
      }
      this.sourceErrorLinger.pause();
      return;
    }
    if (this.terminalPausable) {
      this.terminalLinger.resume();
    }
    this.sourceErrorLinger.resume();
  }

  restartFrameGapWatchdog(onGap: () => void): void {
    this.clearFrameGapWatchdog();
    const generation = this.frameGapGeneration;
    this.frameGapTimer = this.options.setTimer(() => {
      if (generation !== this.frameGapGeneration) {
        return;
      }
      this.frameGapTimer = undefined;
      onGap();
    }, 1_000);
  }

  restartFirstFrameWatchdog(onTimeout: () => void): void {
    this.clearFirstFrameWatchdog();
    const generation = this.firstFrameGeneration;
    this.firstFrameTimer = this.options.setTimer(() => {
      if (generation !== this.firstFrameGeneration) {
        return;
      }
      this.firstFrameTimer = undefined;
      onTimeout();
    }, 1_000);
  }

  clearFirstFrameWatchdog(): void {
    this.firstFrameGeneration += 1;
    if (!this.firstFrameTimer) {
      return;
    }
    this.options.clearTimer(this.firstFrameTimer);
    this.firstFrameTimer = undefined;
  }

  clearFrameGapWatchdog(): void {
    this.frameGapGeneration += 1;
    if (!this.frameGapTimer) {
      return;
    }
    this.options.clearTimer(this.frameGapTimer);
    this.frameGapTimer = undefined;
  }

  scheduleReconnect(input: {
    readonly onRetry: () => void;
    readonly onTimeout: () => void;
  }): ReconnectScheduleResult {
    const nowMs = this.options.now().getTime();
    if (this.reconnectStartedAt === undefined) {
      this.reconnectStartedAt = nowMs;
      const generation = this.reconnectGeneration;
      this.reconnectDeadlineTimer = this.options.setTimer(() => {
        if (generation !== this.reconnectGeneration) {
          return;
        }
        this.reconnectDeadlineTimer = undefined;
        this.clearReconnectTimer(true);
        input.onTimeout();
      }, 10_000);
    }
    this.clearReconnectTimer(false);
    const elapsed = nowMs - this.reconnectStartedAt;
    if (elapsed >= 10_000) {
      this.clearReconnectTimer(true);
      return "timed_out";
    }
    const delay = Math.min(2_000, 250 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    if (delay >= 10_000 - elapsed) {
      return "scheduled";
    }
    const generation = this.reconnectGeneration;
    const retryGeneration = this.reconnectRetryGeneration;
    this.reconnectTimer = this.options.setTimer(() => {
      if (
        generation !== this.reconnectGeneration ||
        retryGeneration !== this.reconnectRetryGeneration
      ) {
        return;
      }
      this.reconnectTimer = undefined;
      input.onRetry();
    }, delay);
    return "scheduled";
  }

  clearReconnectTimer(resetState: boolean): void {
    this.reconnectRetryGeneration += 1;
    if (this.reconnectTimer) {
      this.options.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (resetState) {
      this.reconnectGeneration += 1;
      if (this.reconnectDeadlineTimer) {
        this.options.clearTimer(this.reconnectDeadlineTimer);
        this.reconnectDeadlineTimer = undefined;
      }
      this.reconnectStartedAt = undefined;
      this.reconnectAttempt = 0;
    }
  }

  clearAll(): void {
    this.terminalLinger.clear();
    this.terminalPausable = false;
    this.clearSourceErrorTimer();
    this.clearFirstFrameWatchdog();
    this.clearFrameGapWatchdog();
    this.clearReconnectTimer(true);
    this.interactionPaused = false;
  }
}

class PausableRecoveryTimer {
  private timer: RecoveryTimer | undefined;
  private startedAtMs: number | undefined;
  private remainingMs: number | undefined;
  private onExpire: (() => void) | undefined;
  private generation = 0;

  constructor(private readonly options: ComputerUseRecoveryTimerOptions) {}

  get active(): boolean {
    return this.onExpire !== undefined;
  }

  start(milliseconds: number, onExpire: () => void, paused: boolean): void {
    this.clear();
    this.remainingMs = milliseconds;
    this.onExpire = onExpire;
    if (!paused) {
      this.schedule();
    }
  }

  pause(): void {
    if (!this.timer || this.startedAtMs === undefined || this.remainingMs === undefined) {
      return;
    }
    const elapsed = Math.max(0, this.options.now().getTime() - this.startedAtMs);
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    this.generation += 1;
    this.options.clearTimer(this.timer);
    this.timer = undefined;
    this.startedAtMs = undefined;
  }

  resume(): void {
    if (!this.timer && this.active) {
      this.schedule();
    }
  }

  clear(): void {
    this.generation += 1;
    if (this.timer) {
      this.options.clearTimer(this.timer);
    }
    this.timer = undefined;
    this.startedAtMs = undefined;
    this.remainingMs = undefined;
    this.onExpire = undefined;
  }

  private schedule(): void {
    if (this.remainingMs === undefined || !this.onExpire) {
      return;
    }
    const generation = this.generation;
    this.startedAtMs = this.options.now().getTime();
    this.timer = this.options.setTimer(() => {
      if (generation !== this.generation) {
        return;
      }
      const onExpire = this.onExpire;
      this.timer = undefined;
      this.startedAtMs = undefined;
      this.remainingMs = undefined;
      this.onExpire = undefined;
      onExpire?.();
    }, this.remainingMs);
  }
}
