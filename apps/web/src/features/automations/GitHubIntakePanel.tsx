import { useEffect, useState } from "react";
import type { LingAppServerGitHubIntakePolicyList, LingAppServerGitHubIntakePollResult, LingAppServerGitHubIntakeReceipt } from "@ling-stack/contracts";
import { daemonClient } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import { Badge, Button, InlineFeedback } from "../../shared/ui/index.js";

const modeLabels = { manual: "Manual", suggest: "Suggest", auto_start: "Automatic intake" } as const;
const outcomeLabels: Record<LingAppServerGitHubIntakeReceipt["outcome"], string> = {
  manual: "Manual", suggested: "Suggested", accepted: "Accepted",
  suppressed: "Skipped", paused: "Paused", deduplicated: "Already in work",
};
const reasonLabels: Readonly<Record<string, string>> = {
  quiet_hours: "Quiet hours", concurrency_limit: "Concurrent work limit reached",
  start_budget_exhausted: "Start budget reached", work_item_held: "Work item paused",
  required_label_missing: "Required label missing", policy_disabled: "Policy paused",
};

export function GitHubIntakePanel({ cwd }: { readonly cwd: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const [sources, setSources] = useState<LingAppServerGitHubIntakePolicyList["sources"]>([]);
  useEffect(() => {
    let current = true;
    void daemonClient.listGitHubIntakePolicies(cwd).then(result => {
      if (current) setSources(result.sources);
    }, () => { if (current) setSources([]); });
    return () => { current = false; };
  }, [cwd]);
  if (!sources.length) return null;

  return <details className="automation-ui2-github-intake">
    <summary>{t("GitHub intake")}</summary>
    {sources.map(source => <GitHubIntakeSource key={source.repository} cwd={cwd} source={source} />)}
  </details>;
}

function GitHubIntakeSource({ cwd, source }: {
  readonly cwd: string;
  readonly source: LingAppServerGitHubIntakePolicyList["sources"][number];
}): React.JSX.Element {
  const { t } = useI18n();
  const [result, setResult] = useState<LingAppServerGitHubIntakePollResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { policy, repository } = source;
  async function check(page?: number) {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await daemonClient.pollGitHubIntake(cwd, { repository, page, retryKey: crypto.randomUUID() }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return <section aria-label={repository}>
    <header>
      <strong>{repository}</strong>
      <Badge>{t(policy.enabled ? modeLabels[policy.mode] : "Paused")}</Badge>
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void check()}>{t("Check GitHub inbox")}</Button>
    </header>
    {policy.requiredLabel ? <small>{t("Required label")} <code>{policy.requiredLabel}</code></small> : null}
    {policy.mode === "auto_start" ? <small>
      {t("Up to {concurrent} active and {starts} starts per {minutes} min", {
        concurrent: policy.budget.maxConcurrent, starts: policy.budget.maxStartsPerWindow, minutes: policy.budget.windowMs / 60_000,
      })}
      {policy.quietHours ? ` · ${t("Quiet hours")} ${policy.quietHours.start}–${policy.quietHours.end} ${policy.quietHours.timeZone}` : null}
      {source.providerAvailable === false ? ` · ${t("Provider unavailable")}` : null}
    </small> : null}
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
    {result ? <ul>{result.receipts.map(receipt => <li key={receipt.receiptId}>
      <span>#{receipt.subject.number}</span>
      <Badge>{t(outcomeLabels[receipt.outcome])}</Badge>
      {reasonLabels[receipt.reasonCode] ? <small>{t(reasonLabels[receipt.reasonCode])}</small> : null}
    </li>)}</ul> : null}
    {result?.nextPage ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void check(result.nextPage)}>{t("Next page")}</Button> : null}
  </section>;
}
