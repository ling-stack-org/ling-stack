import { useId, useState } from "react";
import { Activity, Coins } from "lucide-react";
import type { ConversationRuntimeMetrics } from "@ling-stack/contracts";

export interface ConversationBottomStatusStripProps {
  readonly ariaLabel: string;
  readonly metrics?: ConversationRuntimeMetrics;
  readonly locale?: string;
}

const unavailable = "—";

function formatNumber(value: number | null | undefined, locale: string): string {
  return value != null && Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat(locale).format(value) : unavailable;
}

function formatPercent(value: number | null): string {
  return value != null && Number.isFinite(value) ? `${Math.round(value)}%` : unavailable;
}

function MetricDetails({ label, detailsLabel = "details", children, detail }: {
  readonly label: string;
  readonly detailsLabel?: string;
  readonly children: React.ReactNode;
  readonly detail: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="conversation-bottom-status-group" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="conversation-bottom-status-trigger" aria-label={label} aria-expanded={open} aria-controls={id}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open ? <span className="conversation-bottom-status-detail" id={id} role="group" aria-label={`${label} ${detailsLabel}`}>{detail}</span> : null}
    </span>
  );
}

export function ConversationBottomStatusStrip({ ariaLabel, metrics, locale = "en-US" }: ConversationBottomStatusStripProps): React.JSX.Element {
  const zh = locale.startsWith("zh");
  const labels = zh ? {
    rounds: "轮 AI", steps: "步工具", tokens: "Token", cacheHit: "缓存命中", runtime: "运行活动",
    tokenUsage: "Token 与缓存", contextUsage: "上下文", details: "详情", aiRounds: "AI 轮次",
    toolSteps: "工具步骤", speed: "最近回复端到端输出速率（含工具耗时）", total: "总 Token",
    input: "非缓存输入", output: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入",
    coverage: "覆盖", unavailable: "未知", complete: "完整", partial: "部分", recentContext: "最近请求上下文",
    estimatedContext: "压缩后上下文估算", context: "上下文", capacity: "容量", usage: "使用率",
  } : {
    rounds: "rounds", steps: "steps", tokens: "tokens", cacheHit: "cache hit", runtime: "Runtime activity",
    tokenUsage: "Token and cache usage", contextUsage: "Context usage", details: "details", aiRounds: "AI rounds",
    toolSteps: "Tool steps", speed: "Recent reply end-to-end output rate (including tool time)", total: "Total tokens",
    input: "Uncached input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write",
    coverage: "Coverage", unavailable: "unavailable", complete: "complete", partial: "partial", recentContext: "Recent request context",
    estimatedContext: "Estimated context after compaction", context: "Context", capacity: "Capacity", usage: "Usage",
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
  return (
    <div className="conversation-bottom-status-strip" role="status" aria-label={ariaLabel} data-conversation-bottom-status="true">
      <MetricDetails label={labels.runtime} detailsLabel={labels.details} detail={<>
        <span>{labels.aiRounds}: {number(metrics?.aiRounds)}</span>
        <span>{labels.toolSteps}: {number(metrics?.toolSteps)}</span>
        <span>{labels.speed}: {metrics?.recentReplyTokensPerSecond != null && Number.isFinite(metrics.recentReplyTokensPerSecond)
          ? `${metrics.recentReplyTokensPerSecond.toFixed(1)} tok/s` : `${unavailable} tok/s`}</span>
      </>}>
        <Activity size={13} aria-hidden="true" />
        <span>{number(metrics?.aiRounds)} {labels.rounds}</span><span>{number(metrics?.toolSteps)} {labels.steps}</span>
        <span>{metrics?.recentReplyTokensPerSecond != null && Number.isFinite(metrics.recentReplyTokensPerSecond)
          ? `${metrics.recentReplyTokensPerSecond.toFixed(1)} tok/s` : `${unavailable} tok/s`}</span>
      </MetricDetails>
      <MetricDetails label={labels.tokenUsage} detailsLabel={labels.details} detail={<>
        <span>{labels.total}: {number(metrics?.totalTokens)}</span>
        <span>{labels.input}: {number(input)}</span>
        <span>{labels.output}: {number(metrics?.outputTokens)}</span>
        <span>{labels.cacheRead}: {number(read)}</span>
        <span>{labels.cacheWrite}: {number(write)}</span>
        <span>{labels.cacheHit}: {formatPercent(cacheHit)}</span>
        <span>{labels.coverage}: {metrics?.coverage === "complete" ? labels.complete : metrics?.coverage === "partial" ? labels.partial : labels.unavailable}</span>
      </>}>
        <Coins size={13} aria-hidden="true" /><span>{number(metrics?.totalTokens)} {labels.tokens}</span><span>{formatPercent(cacheHit)} {labels.cacheHit}</span>
      </MetricDetails>
      <MetricDetails label={labels.contextUsage} detailsLabel={labels.details} detail={<>
        <span>{contextLabel}: {number(occupied)} {labels.tokens}</span>
        <span>{labels.capacity}: {number(context?.capacityTokens)} {labels.tokens}</span>
        <span>{labels.usage}: {formatPercent(contextPercent)}</span>
      </>}>
        <span className="conversation-bottom-status-meter" role="img" aria-label={`${contextLabel} ${formatPercent(contextPercent)}`}
          style={{ "--conversation-context-progress": contextPercent == null ? "0%" : `${Math.min(100, Math.max(0, contextPercent))}%` } as React.CSSProperties} />
        <span>{context?.basis === "estimated" ? "≈" : ""}{formatPercent(contextPercent)}</span>
      </MetricDetails>
    </div>
  );
}
