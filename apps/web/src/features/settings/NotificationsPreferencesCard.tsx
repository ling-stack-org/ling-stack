import { useCallback, useEffect, useState } from "react";
import { BellRing, Save } from "lucide-react";
import type { NotificationPreferences } from "@ling-stack/contracts";
import { daemonClient } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import { Button, Field, InlineFeedback, Input, InspectorSection, Select, Switch } from "../../shared/ui/index.js";

type EventKind = "automation_run_finished" | "automation_run_failed" | "approval_required";

const EVENT_KINDS: readonly EventKind[] = ["automation_run_finished", "automation_run_failed", "approval_required"];

interface NotificationsPreferencesCardProps {
  readonly cwd: string;
}

export function NotificationsPreferencesCard({ cwd }: NotificationsPreferencesCardProps): React.JSX.Element {
  const { t } = useI18n();
  const [preferences, setPreferences] = useState<NotificationPreferences | undefined>(undefined);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    daemonClient.getNotificationPreferences()
      .then((response) => {
        if (!cancelled) setPreferences(response.preferences);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    if (!preferences) return;
    setSaving(true);
    setError("");
    try {
      const response = await daemonClient.updateNotificationPreferences({
        globalEnabled: preferences.globalEnabled,
        events: preferences.events,
        quietHours: preferences.quietHours ?? null,
      });
      setPreferences(response.preferences);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [preferences]);

  return (
    <section className="notifications-preferences-card" data-ui2-notifications-preferences="true" aria-label={t("Notifications")}>
      <header className="diagnostics-doctor-heading">
        <strong>{t("Notifications")}</strong>
        <Button
          aria-label={t("Save notification preferences")}
          disabled={!preferences}
          leadingIcon={<Save aria-hidden="true" />}
          loading={saving}
          loadingLabel={t("Saving notification preferences...")}
          size="sm"
          variant="secondary"
          onClick={() => void save()}
        >
          {saved ? t("Saved") : t("Save notification preferences")}
        </Button>
      </header>

      {error ? (
        <InlineFeedback tone="danger" title={t("Notification preferences unavailable")}>
          {error}
        </InlineFeedback>
      ) : null}

      {preferences ? (
        <div className="notifications-preferences-body">
          <label className="notifications-preferences-switch-row">
            <span>
              <BellRing aria-hidden="true" />
              <strong>{t("Enable notifications")}</strong>
              <small>{t("Show desktop and in-app notifications for automation runs.")}</small>
            </span>
            <Switch
              aria-label={t("Enable notifications")}
              checked={preferences.globalEnabled}
              onCheckedChange={(checked) => setPreferences({ ...preferences, globalEnabled: checked })}
            />
          </label>

          {EVENT_KINDS.map((kind) => (
            <Field key={kind} label={notificationKindLabel(kind, t)}>
              <Select
                aria-label={notificationKindLabel(kind, t)}
                value={preferences.events[kind]}
                onChange={(event) => setPreferences({
                  ...preferences,
                  events: { ...preferences.events, [kind]: event.currentTarget.value as "all" | "failures" | "off" },
                })}
              >
                <option value="all">{t("All runs")}</option>
                <option value="failures">{t("Failures only")}</option>
                <option value="off">{t("Off")}</option>
              </Select>
            </Field>
          ))}

          <InspectorSection
            aria-label={t("Quiet hours")}
            className="notifications-quiet-hours"
            summary={t("Suppress notifications during a daily time window")}
            title={t("Quiet hours")}
          >
            <div className="notifications-quiet-hours-fields">
              <Field label={t("Start")}>
                <Input
                  aria-label={t("Quiet hours start")}
                  placeholder="22:00"
                  value={preferences.quietHours?.start ?? ""}
                  onChange={(event) => setPreferences({
                    ...preferences,
                    quietHours: event.currentTarget.value || preferences.quietHours
                      ? { start: event.currentTarget.value, end: preferences.quietHours?.end ?? "" }
                      : undefined,
                  })}
                />
              </Field>
              <Field label={t("End")}>
                <Input
                  aria-label={t("Quiet hours end")}
                  placeholder="08:00"
                  value={preferences.quietHours?.end ?? ""}
                  onChange={(event) => setPreferences({
                    ...preferences,
                    quietHours: event.currentTarget.value || preferences.quietHours
                      ? { start: preferences.quietHours?.start ?? "", end: event.currentTarget.value }
                      : undefined,
                  })}
                />
              </Field>
            </div>
          </InspectorSection>
        </div>
      ) : null}
    </section>
  );
}

function notificationKindLabel(kind: EventKind, t: (key: string) => string): string {
  switch (kind) {
    case "automation_run_finished": return t("Automation run finished");
    case "automation_run_failed": return t("Automation run failed");
    case "approval_required": return t("Approval required");
  }
}
