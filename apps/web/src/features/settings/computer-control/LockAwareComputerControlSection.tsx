import { LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n.js";
import { Badge, DataRow, InlineFeedback, Switch } from "../../../shared/ui/index.js";
import { LockedComputerControlAuthorization } from "./LockedComputerControlAuthorization.js";

/**
 * The non-visual task preference does not grant capture or input authority.
 */
export function LockAwareComputerControlSection({ computerControlReady = false }: {
  readonly computerControlReady?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const desktopCapability = typeof window === "undefined"
    ? undefined
    : window.lingDesktop?.lockedTaskContinuation;
  const [continueWhileLocked, setContinueWhileLocked] = useState(true);
  const [loading, setLoading] = useState(Boolean(desktopCapability));
  const [feedback, setFeedback] = useState<"load" | "save" | undefined>();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!desktopCapability) {
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }
    setLoading(true);
    void desktopCapability.getLockedTaskContinuationPreferences().then((preference) => {
      if (!mountedRef.current) return;
      setContinueWhileLocked(preference.continueWhileLocked);
      setFeedback(undefined);
    }).catch(() => {
      if (mountedRef.current) setFeedback("load");
    }).finally(() => {
      if (mountedRef.current) setLoading(false);
    });
    return () => {
      mountedRef.current = false;
    };
  }, [desktopCapability]);

  const updatePreference = (enabled: boolean): void => {
    if (!desktopCapability) return;
    const previous = continueWhileLocked;
    setContinueWhileLocked(enabled);
    setFeedback(undefined);
    setLoading(true);
    void (async () => {
      try {
        const result = await desktopCapability.setContinueTasksWhileLocked(enabled);
        if (!mountedRef.current) return;
        if (!result.accepted) {
          try {
            const persisted = await desktopCapability.getLockedTaskContinuationPreferences();
            if (mountedRef.current) setContinueWhileLocked(persisted.continueWhileLocked);
          } catch {
            if (mountedRef.current) setContinueWhileLocked(previous);
          }
          if (mountedRef.current) setFeedback("save");
        }
      } catch {
        if (!mountedRef.current) return;
        try {
          const persisted = await desktopCapability.getLockedTaskContinuationPreferences();
          if (mountedRef.current) setContinueWhileLocked(persisted.continueWhileLocked);
        } catch {
          if (mountedRef.current) setContinueWhileLocked(previous);
        }
        if (mountedRef.current) setFeedback("save");
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
  };

  const switchLabel = t("Continue running while locked");
  return (
    <section
      className="computer-control-section lock-aware-computer-control-section"
      aria-labelledby="computer-control-lock-behavior-title"
      data-lock-behavior="configurable-task-continuation"
    >
      <header className="computer-control-section-header">
        <span aria-hidden="true"><LockKeyhole /></span>
        <h2 id="computer-control-lock-behavior-title">{t("When the computer locks")}</h2>
      </header>

      <DataRow
        identity={(
          <span className="computer-control-row-copy">
            <strong>{t("Continue running while locked")}</strong>
            <small>{t("Allow Ling to continue Agent reasoning, Shell, API, and file operations while the computer is locked.")}</small>
          </span>
        )}
        actions={desktopCapability ? (
          <Switch
            aria-label={switchLabel}
            checked={continueWhileLocked}
            loading={loading}
            onCheckedChange={updatePreference}
            title={switchLabel}
          />
        ) : <Badge tone="info">{t("Managed by Desktop")}</Badge>}
      />
      {feedback === "load" ? (
        <InlineFeedback aria-live="polite" tone="warning">
          {t("Ling could not load the locked-task preference. The default remains on.")}
        </InlineFeedback>
      ) : null}
      {feedback === "save" ? (
        <InlineFeedback aria-live="polite" tone="danger">
          {t("Ling could not apply the locked-task preference. The saved setting was reloaded.")}
        </InlineFeedback>
      ) : null}
      <LockedComputerControlAuthorization computerControlReady={computerControlReady} />
    </section>
  );
}
