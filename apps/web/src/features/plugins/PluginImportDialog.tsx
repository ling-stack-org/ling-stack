import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import { useI18n, type Translate } from "../../i18n.js";
import type {
  ManagedPluginImportApplyResponse,
  ManagedPluginImportPreviewCandidate,
  ManagedPluginImportPreviewResponse,
  ManagedPluginImportSource,
} from "../../types.js";

interface ImportSourceOption {
  readonly source: ManagedPluginImportSource;
  readonly label: string;
}

const IMPORT_SOURCES: readonly ImportSourceOption[] = [
  { source: "codex-config-toml", label: "Codex (config.toml)" },
  { source: "claude-user-json", label: "Claude (.claude.json)" },
  { source: "claude-plugin-mcp", label: "Claude (.mcp.json)" },
  { source: "dsh-cordis-patch", label: "dsh (cordis.patch.yml)" },
  { source: "claude-commands", label: "Claude (commands/*.md)" },
];

type WizardStep = "select" | "preview" | "report";

export function PluginImportDialog({
  open,
  busy,
  onPreview,
  onApply,
  onClose,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onPreview: (source: ManagedPluginImportSource) => Promise<ManagedPluginImportPreviewResponse>;
  readonly onApply: (source: ManagedPluginImportSource, names: readonly string[]) => Promise<ManagedPluginImportApplyResponse>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [step, setStep] = useState<WizardStep>("select");
  const [source, setSource] = useState<ManagedPluginImportSource>("codex-config-toml");
  const [preview, setPreview] = useState<ManagedPluginImportPreviewResponse | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [report, setReport] = useState<ManagedPluginImportApplyResponse | undefined>();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep("select");
    setSource("codex-config-toml");
    setPreview(undefined);
    setSelected(new Set());
    setReport(undefined);
    setScanning(false);
    setImporting(false);
    setError("");
  }, [open]);

  async function loadPreview(nextSource: ManagedPluginImportSource): Promise<void> {
    setScanning(true);
    setError("");
    try {
      const response = await onPreview(nextSource);
      setPreview(response);
      setSelected(new Set(
        response.candidates
          .filter((candidate) => candidate.status !== "unchanged")
          .map((candidate) => candidate.name),
      ));
      setStep("preview");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScanning(false);
    }
  }

  async function submit(): Promise<void> {
    if (!preview) return;
    setImporting(true);
    setError("");
    try {
      const response = await onApply(preview.source, [...selected]);
      setReport(response);
      setStep("report");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImporting(false);
    }
  }

  function toggle(name: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  const selectedCandidates = preview?.candidates.filter((candidate) => selected.has(candidate.name)) ?? [];
  const blockedBySecretInput = selectedCandidates.some(
    (candidate) => candidate.kind === "mcp" && candidate.secrets.some((secret) => secret.needsInput),
  );

  return (
    <Dialog busy={busy || scanning || importing} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }} open={open}>
      <DialogContent className="plugin-import-dialog" size="md">
        <DialogHeader
          closeLabel={t("Close")}
          description={t("MCP connections, skills, and commands are moved as data. Nothing is executed; imported plugins stay disabled until you enable them.")}
          title={t("Import from other agents")}
        />
        <DialogBody className="plugin-import-body">
          {step === "select" && (
            <div className="plugin-import-select">
              {IMPORT_SOURCES.map((option) => (
                <label key={option.source} className="plugin-import-source-row">
                  <input
                    checked={source === option.source}
                    name="plugin-import-source"
                    onChange={() => setSource(option.source)}
                    type="radio"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          )}
          {step === "preview" && preview && (
            <div className="plugin-import-preview">
              <p>{t("Review candidates before import. Secret values move into the Ling secret store; previews only show masked tails.")}</p>
              {preview.warnings.map((warning) => (
                <InlineFeedback key={warning} tone="warning">{warning}</InlineFeedback>
              ))}
              {preview.candidates.length === 0 && (
                <InlineFeedback tone="info">{t("No importable candidates found for this source.")}</InlineFeedback>
              )}
              {preview.candidates.map((candidate) => (
                <ImportCandidateRow
                  candidate={candidate}
                  checked={selected.has(candidate.name)}
                  key={`${candidate.source}:${candidate.name}`}
                  onToggle={toggle}
                  t={t}
                />
              ))}
            </div>
          )}
          {step === "report" && report && (
            <div className="plugin-import-report">
              {report.warnings.map((warning) => (
                <InlineFeedback key={warning} tone="warning">{warning}</InlineFeedback>
              ))}
              {report.imported.map((entry) => (
                "pluginId" in entry ? (
                  <InlineFeedback key={entry.pluginId} tone={entry.check === "ready" ? "success" : "warning"}>
                    {t("Imported {name} (connection check: {check})", { name: entry.name, check: entry.check })}
                  </InlineFeedback>
                ) : (
                  <InlineFeedback key={entry.draftId} tone="success">
                    {t("Imported {name} as skill draft {skillId}; publish it from the skill library.", {
                      name: entry.name,
                      skillId: entry.skillId,
                    })}
                  </InlineFeedback>
                )
              ))}
              {report.skipped.map((entry) => (
                <InlineFeedback key={`skipped:${entry.name}`} tone="info">
                  {t("Skipped {name}: already imported.", { name: entry.name })}
                </InlineFeedback>
              ))}
              {report.degradations.map((degradation) => (
                <InlineFeedback key={degradation} tone="warning">{degradation}</InlineFeedback>
              ))}
              <InlineFeedback tone="info">
                {t("Secrets migrated: {migrated}. Secrets needing input: {needsInput}.", {
                  migrated: report.secretsMigrated,
                  needsInput: report.secretsNeedsInput,
                })}
              </InlineFeedback>
            </div>
          )}
          {error && <InlineFeedback tone="danger">{error}</InlineFeedback>}
        </DialogBody>
        <DialogFooter>
          {step === "select" && (
            <>
              <Button disabled={scanning} onClick={onClose} variant="ghost">{t("Cancel")}</Button>
              <Button disabled={scanning} onClick={() => void loadPreview(source)} variant="primary">
                {scanning ? t("Scanning…") : t("Scan source")}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button disabled={importing} onClick={() => setStep("select")} variant="ghost">{t("Back")}</Button>
              <Button
                disabled={importing || selected.size === 0 || blockedBySecretInput}
                onClick={() => void submit()}
                variant="primary"
              >
                {importing ? t("Importing…") : t("Import selected")}
              </Button>
            </>
          )}
          {step === "report" && (
            <Button onClick={onClose} variant="primary">{t("Done")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportCandidateRow({
  candidate,
  checked,
  onToggle,
  t,
}: {
  readonly candidate: ManagedPluginImportPreviewCandidate;
  readonly checked: boolean;
  readonly onToggle: (name: string) => void;
  readonly t: Translate;
}): React.JSX.Element {
  const disabled = candidate.status === "unchanged";
  return (
    <label className={`plugin-import-candidate-row${disabled ? " is-disabled" : ""}`}>
      <input
        checked={checked && !disabled}
        disabled={disabled}
        onChange={() => onToggle(candidate.name)}
        type="checkbox"
      />
      <span className="plugin-import-candidate-main">
        <strong>{candidate.displayName}</strong>
        {candidate.kind === "mcp" && <code>{candidate.transportSummary}</code>}
        {candidate.kind === "command" && candidate.inlineExecutions.length > 0 && (
          <em>{t("Contains inline executions that will be downgraded to bash-tool instructions.")}</em>
        )}
      </span>
      <span className={`plugin-import-status-badge status-${candidate.status}`}>
        {candidate.status === "new" && t("New")}
        {candidate.status === "unchanged" && t("Already imported")}
        {candidate.status === "conflict" && t("Name conflict")}
      </span>
    </label>
  );
}
