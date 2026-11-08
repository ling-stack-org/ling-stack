import type { RuntimeConcurrencyPolicySnapshot } from "@ling-stack/contracts";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { getRuntime } from "../../../api/runtime.js";
import { useI18n } from "../../../i18n.js";
import { Button, InlineFeedback, Skeleton } from "../../../shared/ui/index.js";

type LoadState =
  | { readonly phase: "loading"; readonly policy?: undefined; readonly error?: undefined }
  | { readonly phase: "ready"; readonly policy: RuntimeConcurrencyPolicySnapshot; readonly error?: undefined }
  | { readonly phase: "error"; readonly policy?: undefined; readonly error: string };

export function HostConcurrencyPolicySection({ cwd }: { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  async function load(): Promise<void> {
    if (!cwd.trim()) {
      setState({ phase: "error", error: t("Workspace is not ready.") });
      return;
    }
    setState({ phase: "loading" });
    try {
      const response = await getRuntime(cwd);
      if (!response.concurrency) throw new Error("Host concurrency policy is unavailable.");
      setState({ phase: "ready", policy: response.concurrency });
    } catch (error) {
      setState({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => { void load(); }, [cwd]);

  return (
    <section className="engine-host-concurrency" aria-label={t("Host concurrency")} aria-busy={state.phase === "loading"}>
      <div className="engine-host-concurrency-heading">
        <div>
          <h2>{t("Host concurrency")}</h2>
          <p>{t("Read-only limits from the active Ling Host. Change the trusted daemon startup configuration to modify them.")}</p>
        </div>
        {state.phase === "ready" ? <span className={`engine-host-concurrency-status ${state.policy.enabled ? "enabled" : "disabled"}`}>
          {state.policy.enabled ? t("Enabled") : t("Disabled")}
        </span> : null}
      </div>
      {state.phase === "loading" ? <Skeleton width="100%" height={128} /> : null}
      {state.phase === "error" ? <div className="engine-host-concurrency-error">
        <InlineFeedback tone="warning" role="alert">{t("Could not load Host concurrency limits.")}</InlineFeedback>
        <Button size="sm" leadingIcon={<RotateCcw />} onClick={() => void load()}>{t("Retry")}</Button>
      </div> : null}
      {state.phase === "ready" ? <dl className="engine-host-concurrency-grid">
        <ConcurrencyValue label={t("Total concurrent runs")} value={state.policy.maxConcurrentRuns} />
        <ConcurrencyValue label={t("Read-only runs")} value={state.policy.maxReadOnlyRuns} />
        <ConcurrencyValue label={t("Workspace write runs")} value={state.policy.maxWorkspaceWriteRuns} />
        <ConcurrencyValue label={t("Runs per Provider")} value={state.policy.maxRunsPerProvider} />
        <ConcurrencyValue label={t("Runs per Runner")} value={state.policy.maxRunsPerRunner} />
        <ConcurrencyValue label={t("Isolated workflow branches")} value={state.policy.isolatedWriteMaxConcurrentSteps} />
      </dl> : null}
    </section>
  );
}

function ConcurrencyValue({ label, value }: { readonly label: string; readonly value: number }): React.JSX.Element {
  return <div className="engine-host-concurrency-value"><dt>{label}</dt><dd>{value}</dd></div>;
}
