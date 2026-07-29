import { Save } from "lucide-react";
import { Button, Field, InlineFeedback, Select } from "../../shared/ui/index.js";
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
  supported,
  saving,
  onChange,
  onSave,
  t,
}: {
  readonly dirty: boolean;
  readonly policy: SkillGovernancePolicy;
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

function skillGovernanceRecordingModeLabel(mode: SkillGovernanceRecordingMode, t: (key: string) => string): string {
  return mode === "disabled" ? t("Disabled") : t("User initiated");
}
