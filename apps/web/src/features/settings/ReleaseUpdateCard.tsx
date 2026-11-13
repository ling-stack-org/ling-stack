import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import { formatReleaseDate, fetchReleaseUpdate, LING_RELEASE_PAGE_URL, type ReleaseUpdate } from "./release-update.js";

type ReleaseCheckState = "checking" | "current" | "available" | "error";

export function ReleaseUpdateCard(): React.JSX.Element {
  const { locale, t } = useI18n();
  const currentVersion = window.lingDesktop?.productVersion ?? __LING_PRODUCT_VERSION__;
  const [state, setState] = useState<ReleaseCheckState>("checking");
  const [update, setUpdate] = useState<ReleaseUpdate>();
  const [lastCheckedAt, setLastCheckedAt] = useState<Date>();

  const check = useCallback(async () => {
    setState("checking");
    try {
      const next = await fetchReleaseUpdate({ currentVersion });
      setUpdate(next);
      setState(next ? "available" : "current");
    } catch {
      setUpdate(undefined);
      setState("error");
    } finally {
      setLastCheckedAt(new Date());
    }
  }, [currentVersion]);

  useEffect(() => {
    void check();
  }, [check]);

  const checkedLabel = useMemo(
    () => lastCheckedAt ? `${t("Last checked")}: ${lastCheckedAt.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}` : t("Checking for updates..."),
    [lastCheckedAt, locale, t],
  );

  return (
    <section className="release-update-card" data-ui2-release-update="true" aria-label={t("Ling updates")}>
      <header className="release-update-card-heading">
        <div className="release-update-card-title">
          <Sparkles aria-hidden="true" />
          <span>
            <strong>{t("Ling updates")}</strong>
            <small>{t("Stable releases are published on GitHub")}</small>
          </span>
        </div>
        <StatusIndicator
          label={state === "available" ? t("Update available") : state === "error" ? t("Check failed") : state === "checking" ? t("Checking") : t("Up to date")}
          tone={state === "available" ? "warning" : state === "error" ? "danger" : state === "checking" ? "neutral" : "success"}
        />
      </header>

      <div className="release-update-card-body">
        <div className="release-update-card-version-row">
          <span>{t("Current version")}</span>
          <code>v{currentVersion}</code>
        </div>
        {update ? (
          <div className="release-update-card-version-row release-update-card-version-row--available">
            <span>{t("Latest stable release")}</span>
            <strong>v{update.latestVersion}</strong>
          </div>
        ) : null}
        <small className="release-update-card-meta">
          {update ? `${t("Published on")}: ${formatReleaseDate(update.publishedAt, locale)}` : checkedLabel}
        </small>
      </div>

      {state === "available" && update ? (
        <InlineFeedback tone="warning" title={t("A new Ling version is ready")}>
          {t("Open the GitHub release page to read the notes and download the installer.")}
        </InlineFeedback>
      ) : null}
      {state === "error" ? <InlineFeedback tone="danger" title={t("Update check unavailable")}>{t("Ling will continue to work. Check your network and try again.")}</InlineFeedback> : null}

      <footer className="release-update-card-actions">
        <Button
          leadingIcon={<RefreshCw aria-hidden="true" />}
          loading={state === "checking"}
          loadingLabel={t("Checking for updates...")}
          size="sm"
          variant="secondary"
          onClick={() => void check()}
        >
          {t("Check for updates")}
        </Button>
        <a className="release-update-card-link" href={update?.releaseUrl ?? LING_RELEASE_PAGE_URL} target="_blank" rel="noreferrer">
          {t("View GitHub releases")} <ExternalLink aria-hidden="true" size={14} />
        </a>
      </footer>
    </section>
  );
}
