import { LockKeyhole } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { Badge, DataRow } from "../../../shared/ui/index.js";

/**
 * Explains the fixed lock boundary. This is deliberately informational: Ling
 * never offers a renderer command that can authorize control of a lock screen.
 */
export function LockAwareComputerControlSection(): JSX.Element {
  const { t } = useI18n();
  return (
    <section
      className="computer-control-section lock-aware-computer-control-section"
      aria-labelledby="computer-control-lock-behavior-title"
      data-lock-behavior="pause-and-resume"
    >
      <header className="computer-control-section-header">
        <span aria-hidden="true"><LockKeyhole /></span>
        <h2 id="computer-control-lock-behavior-title">{t("When the computer locks")}</h2>
      </header>

      <DataRow
        identity={(
          <span className="computer-control-row-copy">
            <strong>{t("Tasks keep running")}</strong>
            <small>{t("Shell, API, file, and other non-visual work continue while the computer is locked.")}</small>
          </span>
        )}
        status={<Badge tone="success">{t("Continues")}</Badge>}
      />
      <DataRow
        identity={(
          <span className="computer-control-row-copy">
            <strong>{t("Computer Control pauses")}</strong>
            <small>{t("Screen capture and input stop. Ling never interacts with the lock screen, login window, password fields, or secure desktop.")}</small>
          </span>
        )}
        status={<Badge tone="warning">{t("Paused while locked")}</Badge>}
      />
      <DataRow
        identity={(
          <span className="computer-control-row-copy">
            <strong>{t("Control resumes after unlock")}</strong>
            <small>{t("Ling rechecks permissions, the interactive session, and a fresh Driver generation before restoring control.")}</small>
          </span>
        )}
        status={<Badge tone="info">{t("Resumes automatically")}</Badge>}
      />
    </section>
  );
}
