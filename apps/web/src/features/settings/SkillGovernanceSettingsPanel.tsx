import { Save } from "lucide-react";
import { Button, Field, InlineFeedback, InspectorSection, Select } from "../../shared/ui/index.js";
import type {
  SkillGovernanceGenerationMode,
  SkillGovernancePolicy,
  SkillGovernanceRecordingMode,
} from "../../types.js";

type SettingsTranslator = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export const defaultSkillGovernancePolicy: SkillGovernancePolicy = {
  generationMode: "semi_auto",
  recordingMode: "user_initiated",
  invocationMode: "explicit_only",
  publishMode: "manual_review",
  bindMode: "manual_review",
};

const skillGovernanceGenerationModes: readonly SkillGovernanceGenerationMode[] = [
  "off",
  "approval_only",
  "semi_auto",
  "auto_candidate",
];

const skillGovernanceRecordingModes: readonly SkillGovernanceRecordingMode[] = ["disabled", "user_initiated"];

export function SkillGovernanceSettingsPanel({
  dirty,
  policy,
  source,
  path,
  supported,
  saving,
  onChange,
  onSave,
  t,
}: {
  readonly dirty: boolean;
  readonly policy: SkillGovernancePolicy;
  readonly source?: string;
  readonly path?: string;
  readonly supported: boolean;
  readonly saving: boolean;
  readonly onChange: (policy: SkillGovernancePolicy) => void;
  readonly onSave: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  return (
    <section className="settings-skill-governance" aria-label={t("Skill policy")}>
      {!supported ? (
        <InlineFeedback className="settings-personalization-governance-feedback" title={t("Unsupported by daemon")} tone="warning">
          {t("Update Ling daemon to save skill governance policy.")}
        </InlineFeedback>
      ) : null}

      <div className="settings-skill-governance-grid">
        <Field
          className="settings-skill-governance-field"
          label={t("Candidate generation")}
          description={skillGovernanceGenerationModeDescription(policy.generationMode, t)}
        >
          <Select
            aria-label={t("Skill candidate generation mode")}
            disabled={!supported || saving}
            size="md"
            value={policy.generationMode}
            onChange={(event) => onChange({ ...policy, generationMode: event.target.value as SkillGovernanceGenerationMode })}
          >
            {skillGovernanceGenerationModes.map((mode) => (
              <option key={mode} value={mode}>{skillGovernanceGenerationModeLabel(mode, t)}</option>
            ))}
          </Select>
        </Field>
        <Field
          className="settings-skill-governance-field"
          label={t("Recording")}
          description={skillGovernanceRecordingModeDescription(policy.recordingMode, t)}
        >
          <Select
            aria-label={t("Skill recording mode")}
            disabled={!supported || saving}
            size="md"
            value={policy.recordingMode}
            onChange={(event) => onChange({ ...policy, recordingMode: event.target.value as SkillGovernanceRecordingMode })}
          >
            {skillGovernanceRecordingModes.map((mode) => (
              <option key={mode} value={mode}>{skillGovernanceRecordingModeLabel(mode, t)}</option>
            ))}
          </Select>
        </Field>
      </div>

      <InspectorSection
        className="settings-personalization-governance-inspector"
        title={t("Advanced governance")}
        summary={t("Candidate generation options")}
      >
        <div className="settings-personalization-governance-mode-guide" aria-label={t("Candidate generation options")}>
          <div>
            {skillGovernanceGenerationModes.map((mode) => (
              <span key={mode} className={policy.generationMode === mode ? "active" : undefined}>
                <small>{skillGovernanceGenerationModeLabel(mode, t)}</small>
                <em>{skillGovernanceGenerationModeDescription(mode, t)}</em>
              </span>
            ))}
          </div>
        </div>
        <div className="settings-personalization-governance-recording-guide" aria-label={t("How recording works")}>
          <strong>{t("How recording works")}</strong>
          <ol>
            <li>{t("Start recording from a deliberate user action; Ling does not record background agent work automatically.")}</li>
            <li>{t("Finish the run, then review the captured evidence before any candidate is created.")}</li>
            <li>{t("Generated candidates still require draft, publish, and binding review before runtime use.")}</li>
          </ol>
        </div>
        <div className="settings-personalization-governance-fixed" aria-label={t("Fixed skill governance guards")}>
          <span><small>{t("Invocation")}</small><strong>{skillGovernanceFixedModeLabel(policy.invocationMode, t)}</strong></span>
          <span><small>{t("Publish")}</small><strong>{skillGovernanceFixedModeLabel(policy.publishMode, t)}</strong></span>
          <span><small>{t("Bind")}</small><strong>{skillGovernanceFixedModeLabel(policy.bindMode, t)}</strong></span>
        </div>
        <div className="settings-personalization-governance-storage">
          <span><small>{t("Source")}</small><strong>{supported ? (source ? t(skillGovernanceSourceLabel(source)) : t("not loaded")) : t("Unsupported by daemon")}</strong></span>
          <span title={path}><small>{t("Stored in workspace settings")}</small><strong>{path ?? t("Read-only compatibility mode")}</strong></span>
        </div>
      </InspectorSection>

      <footer className="settings-skill-governance-actions">
        <Button
          loading={saving}
          loadingLabel={t("Loading")}
          leadingIcon={<Save aria-hidden="true" />}
          size="sm"
          variant="primary"
          onClick={onSave}
          disabled={saving || !supported || !dirty}
        >
          {t("Save governance policy")}
        </Button>
      </footer>
    </section>
  );
}

function skillGovernanceGenerationModeLabel(mode: SkillGovernanceGenerationMode, t: (key: string) => string): string {
  if (mode === "off") {
    return t("Off");
  }
  if (mode === "approval_only") {
    return t("Approval only");
  }
  if (mode === "auto_candidate") {
    return t("Auto candidate");
  }
  return t("Semi-auto");
}

function skillGovernanceGenerationModeDescription(mode: SkillGovernanceGenerationMode, t: (key: string) => string): string {
  if (mode === "off") {
    return t("Record evidence only");
  }
  if (mode === "approval_only") {
    return t("Create candidates only from approved recording jobs");
  }
  if (mode === "auto_candidate") {
    return t("Create pending candidates from one stable successful observation");
  }
  return t("Create pending candidates after repeated stable success");
}

function skillGovernanceRecordingModeLabel(mode: SkillGovernanceRecordingMode, t: (key: string) => string): string {
  return mode === "disabled" ? t("Disabled") : t("User initiated");
}

function skillGovernanceRecordingModeDescription(mode: SkillGovernanceRecordingMode, t: (key: string) => string): string {
  return mode === "disabled" ? t("Skill recording endpoint is disabled") : t("Users can start skill recording explicitly");
}

function skillGovernanceFixedModeLabel(
  mode: SkillGovernancePolicy["invocationMode"] | SkillGovernancePolicy["publishMode"] | SkillGovernancePolicy["bindMode"],
  t: (key: string) => string,
): string {
  if (mode === "explicit_only") {
    return t("Explicit only");
  }
  return t("Manual review");
}

function skillGovernanceSourceLabel(source: string): string {
  if (source === "workspace") {
    return "Workspace";
  }
  if (source === "user") {
    return "User default";
  }
  return "Built-in";
}
