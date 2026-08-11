import { Eye, Power } from "lucide-react";
import {
  Button,
  InlineFeedback,
  InspectorSection,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { Translate } from "../../i18n.js";
import type { PluginRuntimeView } from "./plugin-manager-types.js";

export function PluginRuntimePreviewSection({
  runtime,
  canPreview,
  canEnable,
  busy,
  open,
  onOpenChange,
  onPreview,
  onEnable,
  t,
}: {
  readonly runtime?: PluginRuntimeView;
  readonly canPreview: boolean;
  readonly canEnable: boolean;
  readonly busy: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPreview: () => void;
  readonly onEnable: () => void;
  readonly t: Translate;
}): React.JSX.Element {
  return (
    <InspectorSection
      className="plugin-runtime-section"
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      open={open}
      summary={runtime?.statusLabel ?? t("Not previewed")}
      title={t("Runtime preview")}
    >
      <div className="plugin-runtime-content">
        {runtime ? (
          <>
            <StatusIndicator label={runtime.summary} tone={runtime.tone} />
            {runtime.blocker ? <InlineFeedback tone={runtime.tone === "danger" ? "danger" : "warning"}>{runtime.blocker}</InlineFeedback> : null}
            {runtime.groups.map((group) => (
              <section className="plugin-runtime-group" key={group.label}>
                <strong>{group.label}</strong>
                <dl className="plugin-detail-fields">
                  {group.items.map((item, index) => (
                    <div key={`${item.label}-${index}`}>
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            {runtime.policySummary ? <span className="plugin-runtime-policy">{runtime.policySummary}</span> : null}
          </>
        ) : null}
        <div className="plugin-runtime-actions">
          {canEnable && runtime?.tone === "neutral" ? (
            <Button leadingIcon={<Power aria-hidden="true" />} onClick={onEnable} size="sm">{t("Enable")}</Button>
          ) : null}
          {canPreview ? (
            <Button
              leadingIcon={<Eye aria-hidden="true" />}
              loading={busy}
              loadingLabel={t("Loading")}
              onClick={onPreview}
              size="sm"
            >
              {t("Runtime preview")}
            </Button>
          ) : null}
        </div>
      </div>
    </InspectorSection>
  );
}
