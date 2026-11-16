import { useId, useState } from "react";
import { Activity, Coins } from "lucide-react";
import type { ConversationRuntimeMetrics } from "@ling-stack/contracts";

export interface ConversationBottomStatusStripProps {
  readonly ariaLabel: string;
  readonly metrics?: ConversationRuntimeMetrics;
  readonly locale?: string;
  readonly translate?: (key: string) => string;
}

const unavailable = "—";

function formatNumber(value: number | null | undefined, locale: string): string {
  return value != null && Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat(locale).format(value) : unavailable;
}

function formatPercent(value: number | null): string {
  return value != null && Number.isFinite(value) ? `${Math.round(value)}%` : unavailable;
}

function MetricDetails({ label, detailsLabel = "details", kind, children, detail }: {
  readonly label: string;
  readonly detailsLabel?: string;
  readonly kind: "runtime" | "tokens" | "context";
  readonly children: React.ReactNode;
  readonly detail: React.ReactNode;
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;
  const id = useId();
  return (
    <span className="conversation-bottom-status-group" data-status-kind={kind}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button type="button" className="conversation-bottom-status-trigger" aria-label={label} aria-expanded={open} aria-controls={id}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
        {children}
      </button>
      {open ? <span className="conversation-bottom-status-detail" id={id} role="group" aria-label={`${label} ${detailsLabel}`}>{detail}</span> : null}
    </span>
  );
}

export function ConversationBottomStatusStrip({ ariaLabel, metrics, locale = "en-US", translate = (key) => key }: ConversationBottomStatusStripProps): React.JSX.Element {
  const labels = {
    rounds: translate("rounds"),
    steps: translate("steps"),
    tokens: translate("tokens"),
    cacheHit: translate("cache hit"),
    runtime: translate("Runtime activity"),
    tokenUsage: translate("Token and cache usage"),
    contextUsage: translate("Context usage"),
    details: translate("details"),
    unavailable: translate("Status unavailable"),
    aiRounds: translate("AI rounds"),
    toolSteps: translate("Tool steps"),
    speed: translate("Recent reply end-to-end output rate (including tool time)"),
    total: translate("Total tokens"),
    input: translate("Uncached input"),
    output: translate("Output"),
    cacheRead: translate("Cache read"),
    cacheWrite: translate("Cache write"),
    coverage: translate("Coverage"),
    coverageUnavailable: translate("unavailable"),
    complete: translate("complete"),
    partial: translate("partial"),
    recentContext: translate("Recent request context"),
    estimatedContext: translate("Estimated context after compaction"),
    context: translate("Context"),
    capacity: translate("Capacity"),
    usage: translate("Usage"),
  };
  const number = (value: number | null | undefined) => formatNumber(value, locale);
  // Pi input excludes cache reads/writes; all three classes must be measured before computing a hit rate.
  const input = metrics?.inputTokens;
  const read = metrics?.cacheReadTokens;
  const write = metrics?.cacheWriteTokens;
  const denominator = input != null && read != null && write != null ? input + read + write : 0;
  const cacheHit = denominator > 0 && read != null ? read / denominator * 100 : null;
  const { context } = metrics ?? {};
  const occupied = context?.basis === "measured" ? context.measuredInputTokens
    : context?.basis === "estimated" ? context.estimatedTokens : null;
  const contextPercent = occupied != null && occupied >= 0 && context?.capacityTokens != null && context.capacityTokens > 0
    ? occupied / context.capacityTokens * 100 : null;
  const contextLabel = context?.basis === "measured" ? labels.recentContext : context?.basis === "estimated" ? labels.estimatedContext : labels.context;
  const hasRuntimeMetrics = [metrics?.aiRounds, metrics?.toolSteps, metrics?.recentReplyTokensPerSecond]
    .some((value) => value != null && Number.isFinite(value));
  const hasTokenMetrics = [metrics?.totalTokens, input, metrics?.outputTokens, read, write]
    .some((value) => value != null && Number.isFinite(value));
  const hasContextMetrics = occupied != null || context?.capacityTokens != null;
  const hasAnyMetrics = hasRuntimeMetrics || hasTokenMetrics || hasContextMetrics;
  return (
    <div className="conversation-bottom-status-strip" role="status" aria-label={ariaLabel}
      data-conversation-bottom-status="true" data-status-state={metrics == null ? "empty" : "available"}>
      {!hasAnyMetrics ? <span className="conversation-bottom-status-empty">{labels.unavailable}</span> : null}
      {hasAnyMetrics ? <><MetricDetails kind="runtime" label={labels.runtime} detailsLabel={labels.details} detail={<>
        <span>{labels.aiRounds}: {number(metrics?.aiRounds)}</span>
        <span>{labels.toolSteps}: {number(metrics?.toolSteps)}</span>
        <span>{labels.speed}: {metrics?.recentReplyTokensPerSecond != null && Number.isFinite(metrics.recentReplyTokensPerSecond)
          ? `${metrics.recentReplyTokensPerSecond.toFixed(1)} tok/s` : `${unavailable} tok/s`}</span>
      </>}>
        <Activity size={14} aria-hidden="true" />
        {hasRuntimeMetrics ? <>
          <span>{number(metrics?.aiRounds)} {labels.rounds}</span><span aria-hidden="true">·</span><span>{number(metrics?.toolSteps)} {labels.steps}</span>
          <span aria-hidden="true">·</span>
          <span>{metrics?.recentReplyTokensPerSecond != null && Number.isFinite(metrics.recentReplyTokensPerSecond)
            ? `${metrics.recentReplyTokensPerSecond.toFixed(1)} tok/s` : `${unavailable} tok/s`}</span>
        </> : <span className="conversation-bottom-status-empty">{labels.unavailable}</span>}
      </MetricDetails>
      <MetricDetails kind="tokens" label={labels.tokenUsage} detailsLabel={labels.details} detail={<>
        <span>{labels.total}: {number(metrics?.totalTokens)}</span>
        <span>{labels.input}: {number(input)}</span>
        <span>{labels.output}: {number(metrics?.outputTokens)}</span>
        <span>{labels.cacheRead}: {number(read)}</span>
        <span>{labels.cacheWrite}: {number(write)}</span>
        <span>{labels.cacheHit}: {formatPercent(cacheHit)}</span>
        <span>{labels.coverage}: {metrics?.coverage === "complete" ? labels.complete : metrics?.coverage === "partial" ? labels.partial : labels.coverageUnavailable}</span>
      </>}>
        <Coins size={14} aria-hidden="true" />
        {hasTokenMetrics ? <><span>{number(metrics?.totalTokens)}</span><span aria-hidden="true">·</span><span>{formatPercent(cacheHit)} {labels.cacheHit}</span></>
          : <span className="conversation-bottom-status-empty">{labels.unavailable}</span>}
      </MetricDetails>
      <MetricDetails kind="context" label={labels.contextUsage} detailsLabel={labels.details} detail={<>
        <span>{contextLabel}: {number(occupied)} {labels.tokens}</span>
        <span>{labels.capacity}: {number(context?.capacityTokens)} {labels.tokens}</span>
        <span>{labels.usage}: {formatPercent(contextPercent)}</span>
      </>}>
        <span className="conversation-bottom-status-meter" role="img" aria-label={`${contextLabel} ${formatPercent(contextPercent)}`}
          style={{ "--conversation-context-progress": contextPercent == null ? "0%" : `${Math.min(100, Math.max(0, contextPercent))}%` } as React.CSSProperties} />
        {hasContextMetrics ? <span>{context?.basis === "estimated" ? "≈" : ""}{formatPercent(contextPercent)}</span>
          : <span className="conversation-bottom-status-empty">{labels.unavailable}</span>}
      </MetricDetails>
      </> : null}
    </div>
  );
}
