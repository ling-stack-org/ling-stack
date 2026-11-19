import { useEffect, useState } from "react";
import { RefreshCw, ScanSearch, Shield } from "lucide-react";
import type { CodeAssessmentKind } from "@ling-stack/contracts";
import { Badge, Button, DataRow, Field, InlineFeedback, Input, Select, Textarea } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { listProviders } from "../../api/providers.js";
import type { ProviderPreset } from "../../types.js";
import { providerModelRouteLabel } from "../../lib/providers.js";
import { useCodeAssessments } from "./use-code-assessments.js";
import { CodeAssessmentDetail } from "./CodeAssessmentDetail.js";
import { assessmentStatusLabel, assessmentTone } from "./assessment-labels.js";
import "../../styles/code-assessments.css";

export interface CodeAssessmentPageProps {
  readonly cwd: string;
  readonly defaultProviderPresetId?: string;
  readonly providers?: readonly ProviderPreset[];
  readonly initialKind?: CodeAssessmentKind;
  readonly compact?: boolean;
  readonly onOpenRun?: (runId: string) => void;
}

export function CodeAssessmentPage({ cwd, defaultProviderPresetId, providers: suppliedProviders, initialKind = "review", compact = false, onOpenRun }: CodeAssessmentPageProps): React.JSX.Element {
  const { t } = useI18n();
  const [kind, setKind] = useState<CodeAssessmentKind>(initialKind);
  const [target, setTarget] = useState<"working_tree" | "branch" | "commit">("working_tree");
  const [baseRef, setBaseRef] = useState("main");
  const [commitSha, setCommitSha] = useState("");
  const [commitBaseRef, setCommitBaseRef] = useState("");
  const [instructions, setInstructions] = useState("");
  const [providerPresetId, setProviderPresetId] = useState(defaultProviderPresetId ?? "");
  const [loadedProviders, setLoadedProviders] = useState<readonly ProviderPreset[]>([]);
  const [providerError, setProviderError] = useState<string>();
  const controller = useCodeAssessments(cwd, kind);
  const providers = (suppliedProviders ?? loadedProviders).filter(provider => provider.enabled && provider.capabilities.includes("chat") && provider.api !== "media-job");
  const selectedProvider = providers.some(provider => provider.id === providerPresetId) ? providerPresetId
    : providers.find(provider => provider.id === defaultProviderPresetId)?.id ?? providers[0]?.id ?? "";
  useEffect(() => {
    if (suppliedProviders) return;
    let cancelled = false;
    setProviderError(undefined); setLoadedProviders([]);
    void listProviders(cwd).then(result => { if (!cancelled) setLoadedProviders(result.providers); })
      .catch(cause => { if (!cancelled) setProviderError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [cwd, suppliedProviders]);
  const start = () => controller.start({ kind, target: target === "commit" ? { type: "commit", commitSha, ...(commitBaseRef.trim() ? { baseRef: commitBaseRef.trim() } : {}) } : target === "branch" ? { type: "branch", baseRef } : { type: "working_tree" }, providerPresetId: selectedProvider, ...(instructions.trim() ? { instructions } : {}) });
  return <section className={`code-assessment-page${compact ? " compact" : ""}`} aria-label={t("Code review and security")}>
    {!compact ? <header className="code-assessment-header">
      <div><h1>{t("Code review and security")}</h1><p>{t("Review a local Diff snapshot and track its findings.")}</p></div>
      <Button leadingIcon={<RefreshCw />} onClick={() => void controller.refresh()} loading={controller.loading}>{t("Refresh")}</Button>
    </header> : null}
    {controller.error || providerError ? <InlineFeedback tone="danger" title={t("Assessment unavailable")}>{controller.error ?? providerError}</InlineFeedback> : null}
    {!compact ? <div className="code-assessment-tabs" role="group" aria-label={t("Assessment type")}>
      <Button variant={kind === "review" ? "secondary" : "ghost"} aria-pressed={kind === "review"} onClick={() => setKind("review")} leadingIcon={<ScanSearch />}>{t("Code review")}</Button>
      <Button variant={kind === "security" ? "secondary" : "ghost"} aria-pressed={kind === "security"} onClick={() => setKind("security")} leadingIcon={<Shield />}>{t("Security scan")}</Button>
    </div> : null}
    <div className="code-assessment-grid">
      <aside className="code-assessment-sidebar" aria-label={t("Assessment setup and history")}>
        <div className="code-assessment-start">
          <Field label={t("Target")}><Select aria-label={t("Target")} value={target} onChange={event => setTarget(event.target.value as typeof target)}>
            <option value="working_tree">{t("Working tree")}</option><option value="branch">{t("Branch Diff")}</option><option value="commit">{t("Commit")}</option>
          </Select></Field>
          {target === "branch" ? <Field label={t("Base branch")}><Input value={baseRef} onChange={event => setBaseRef(event.target.value)} aria-label={t("Base branch")} /></Field> : null}
          {target === "commit" ? <><Field label={t("Commit SHA")}><Input value={commitSha} onChange={event => setCommitSha(event.target.value)} aria-label={t("Commit SHA")} maxLength={40} /></Field>
            <Field label={t("Base revision (optional)")}><Input value={commitBaseRef} onChange={event => setCommitBaseRef(event.target.value)} aria-label={t("Base revision (optional)")} placeholder={t("First parent")} /></Field></> : null}
          <details><summary>{t("Review instructions")}</summary><Field label={t("Review instructions")}><Textarea aria-label={t("Review instructions")} value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={4000} /></Field></details>
          <Field label={t("Model")}><Select aria-label={t("Model")} value={selectedProvider} onChange={event => setProviderPresetId(event.target.value)} disabled={!providers.length}>
            {!providers.length ? <option value="">{t("Select model")}</option> : providers.map(provider => <option key={provider.id} value={provider.id}>{providerModelRouteLabel(provider)}</option>)}
          </Select></Field>
          {!providers.length && !providerError ? <p className="code-assessment-muted">{t("Configure a chat model in Models to start.")}</p> : null}
          <Button variant="primary" onClick={() => void start()} loading={controller.busy} disabled={controller.active || !selectedProvider || target === "branch" && !baseRef.trim() || target === "commit" && !/^[a-fA-F0-9]{40}$/u.test(commitSha)}>{kind === "review" ? t("Start review") : t("Start security scan")}</Button>
          <p className="code-assessment-muted">{t("Only the captured Diff is sent to the selected model. Analysis cannot use tools.")}</p>
        </div>
        <div className="code-assessment-list"><div className="code-assessment-history-heading"><h2>{t("History")}</h2>{compact ? <Button size="sm" variant="ghost" aria-label={t("Refresh")} leadingIcon={<RefreshCw />} onClick={() => void controller.refresh()} /> : null}</div>
          {controller.loading ? <p role="status">{t("Loading")}</p> : controller.items.length === 0 ? <p className="code-assessment-muted">{t("No assessments yet.")}</p> : null}
          <div role="listbox" aria-label={t("Assessment history")}>{controller.items.map(item => <DataRow key={item.id} compact selected={controller.detail?.assessment.id === item.id}
            identity={<strong>{item.target.type === "branch" ? t("Branch Diff") : item.target.type === "commit" ? t("Commit") : t("Working tree")}</strong>}
            summary={<small>{t("{count} findings", { count: item.findingCount })} · {new Date(item.createdAt).toLocaleString()}</small>}
            status={<Badge tone={assessmentTone(item.status)}>{t(assessmentStatusLabel[item.status])}</Badge>} onClick={() => void controller.select(item.id)} />)}</div>
          {controller.nextOffset !== undefined ? <Button variant="ghost" onClick={() => void controller.refresh(controller.nextOffset)}>{t("Load more")}</Button> : null}
        </div>
      </aside>
      <div className="code-assessment-detail">{controller.detail ? <CodeAssessmentDetail key={controller.detail.assessment.id} cwd={cwd} detail={controller.detail} onOpenRun={onOpenRun}
        busy={controller.busy} freshness={controller.freshness} onCancel={() => void controller.cancel()} onCheckFreshness={() => void controller.checkFreshness()}
        onRunAgain={() => void controller.start({ kind: controller.detail!.assessment.kind, target: controller.detail!.assessment.target, providerPresetId: selectedProvider, instructions: controller.detail!.assessment.instructions })}
        canRunAgain={Boolean(selectedProvider) && !controller.active} onDisposition={controller.disposition} />
        : <div className="code-assessment-empty"><ScanSearch /><h2>{t("Select an assessment")}</h2><p>{t("Start a review or select a result from history.")}</p></div>}
      </div>
    </div>
  </section>;
}
