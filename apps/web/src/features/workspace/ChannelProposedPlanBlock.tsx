import { CheckCircle2, FileCheck2, RefreshCw, Save, Workflow } from "lucide-react";
import type { Translate } from "../../i18n.js";
import { MessageBodyRenderer } from "../../shared/conversation/index.js";
import { Button } from "../../shared/ui/index.js";
import type { ProposedPlanArtifact } from "../../types.js";

export interface ChannelProposedPlanBlockProps {
  readonly plan: ProposedPlanArtifact;
  readonly cwd: string;
  readonly t: Translate;
  readonly busy: boolean;
  readonly onAccept: (plan: ProposedPlanArtifact) => void;
  readonly onConvert: (plan: ProposedPlanArtifact) => void;
  readonly onRefine: (plan: ProposedPlanArtifact) => void;
  readonly onSave: (plan: ProposedPlanArtifact) => void;
}

export function ChannelProposedPlanBlock({
  plan,
  cwd,
  t,
  busy,
  onAccept,
  onConvert,
  onRefine,
  onSave,
}: ChannelProposedPlanBlockProps): React.JSX.Element {
  const loadingLabel = t("Loading");
  return (
    <section className="proposed-plan-block" data-plan-status={plan.status} aria-label={t("Proposed plan")}>
      <header className="proposed-plan-head">
        <span className="proposed-plan-icon" aria-hidden="true">
          <FileCheck2 size={15} />
        </span>
        <span>
          <strong title={plan.title}>{plan.title}</strong>
          <small>{t("Proposed plan")} · {proposedPlanDisplayStatus(plan, t)}</small>
        </span>
      </header>
      <div className="proposed-plan-body">
        <MessageBodyRenderer text={plan.bodyMarkdown} cwd={cwd} compact />
      </div>
      <footer className="proposed-plan-actions">
        <Button
          className="proposed-plan-action"
          size="sm"
          leadingIcon={<Save size={14} />}
          loading={busy}
          loadingLabel={loadingLabel}
          disabled={busy}
          onClick={() => onSave(plan)}
        >
          {t("Save")}
        </Button>
        <Button
          className="proposed-plan-action"
          size="sm"
          leadingIcon={<Workflow size={14} />}
          loading={busy}
          loadingLabel={loadingLabel}
          disabled={busy}
          onClick={() => onConvert(plan)}
        >
          {t("Convert to workflow")}
        </Button>
        <Button
          className="proposed-plan-action"
          size="sm"
          leadingIcon={<RefreshCw size={14} />}
          loading={busy}
          loadingLabel={loadingLabel}
          disabled={busy}
          onClick={() => onRefine(plan)}
        >
          {t("Refine plan")}
        </Button>
        <Button
          className="proposed-plan-action"
          variant="primary"
          size="sm"
          leadingIcon={<CheckCircle2 size={14} />}
          loading={busy}
          loadingLabel={loadingLabel}
          disabled={busy}
          onClick={() => onAccept(plan)}
        >
          {t("Implement")}
        </Button>
      </footer>
    </section>
  );
}

function proposedPlanDisplayStatus(plan: ProposedPlanArtifact, t: Translate): string {
  switch (plan.status) {
    case "accepted": return t("Accepted");
    case "superseded": return t("Superseded");
    case "archived": return t("Archived");
    case "draft": return plan.savedAt ? t("Saved") : t("Draft");
  }
}
