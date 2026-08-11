import { DataRow, InlineFeedback, Switch } from "../../shared/ui/index.js";
import { MonitorUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";

export function DesktopComputerUsePreference({
  sectionTitle = "Desktop",
}: {
  readonly sectionTitle?: string;
} = {}): React.JSX.Element | null {
  const { t } = useI18n();
  const desktopComputerUse = typeof window === "undefined" ? undefined : window.lingDesktop?.computerUse;
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(Boolean(desktopComputerUse));
  const [feedback, setFeedback] = useState<"error" | "not-persisted" | undefined>();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!desktopComputerUse) {
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }
    setLoading(true);
    void desktopComputerUse.getPreferences().then((preferences) => {
      if (mountedRef.current) {
        setEnabled(preferences.previewAutoShow);
        setFeedback(undefined);
      }
    }).catch(() => {
      if (mountedRef.current) {
        setFeedback("error");
      }
    }).finally(() => {
      if (mountedRef.current) {
        setLoading(false);
      }
    });
    return () => {
      mountedRef.current = false;
    };
  }, [desktopComputerUse]);

  if (!desktopComputerUse) {
    return null;
  }

  const update = (next: boolean): void => {
    const previous = enabled;
    setEnabled(next);
    setFeedback(undefined);
    setLoading(true);
    void desktopComputerUse.setAutoShow(next).then((result) => {
      if (!mountedRef.current) {
        return;
      }
      if (!result.accepted) {
        setEnabled(previous);
        setFeedback("error");
        return;
      }
      setFeedback(result.reason === "desktop_preferences_not_persisted" ? "not-persisted" : undefined);
    }).catch(() => {
      if (mountedRef.current) {
        setEnabled(previous);
        setFeedback("error");
      }
    }).finally(() => {
      if (mountedRef.current) {
        setLoading(false);
      }
    });
  };

  const switchLabel = t("Automatically show Computer Use picture-in-picture");
  return (
    <section
      className="settings-interface-section settings-interface-desktop"
      aria-labelledby="settings-interface-desktop-title"
      data-ui2-interface-desktop
    >
      <header className="settings-interface-section-header">
        <MonitorUp aria-hidden="true" />
        <h2 id="settings-interface-desktop-title">{t(sectionTitle)}</h2>
      </header>
      <div className="desktop-computer-use-preference">
        <DataRow
          className="settings-interface-preference-row"
          identity={(
            <span className="settings-interface-preference-identity">
              <MonitorUp aria-hidden="true" />
              <span>
                <strong>{t("Computer Use picture-in-picture")}</strong>
              </span>
            </span>
          )}
          actions={(
            <Switch
              aria-label={switchLabel}
              checked={enabled}
              loading={loading}
              onCheckedChange={update}
              title={switchLabel}
            />
          )}
        />
        {feedback === "error" ? (
          <InlineFeedback className="desktop-computer-use-preference-feedback" tone="danger">
            {t("Unable to save Desktop preview preference")}
          </InlineFeedback>
        ) : null}
        {feedback === "not-persisted" ? (
          <InlineFeedback
            aria-live="polite"
            className="desktop-computer-use-preference-feedback"
            tone="warning"
          >
            {t("Changed for this session, but not saved. It may revert after restart.")}
          </InlineFeedback>
        ) : null}
      </div>
    </section>
  );
}
