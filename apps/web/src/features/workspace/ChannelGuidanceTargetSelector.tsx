import { useId } from "react";
import { useI18n } from "../../i18n.js";
import { Select } from "../../shared/ui/index.js";
import type { ChannelGuidanceTarget } from "./channel-guidance-targets.js";

export function ChannelGuidanceTargetSelector({
  targets,
  value,
  onChange,
}: {
  readonly targets: readonly ChannelGuidanceTarget[];
  readonly value: string;
  readonly onChange: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const selectId = useId();

  return (
    <div className="channel-guidance-target-selector">
      <label htmlFor={selectId}>{t("Guide whom")}</label>
      <Select
        id={selectId}
        size="sm"
        containerClassName="channel-guidance-target-select"
        aria-label={t("Guide whom")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("Select a teammate reply")}</option>
        {targets.map((target) => (
          <option key={target.run.id} value={target.run.id}>{target.label}</option>
        ))}
      </Select>
    </div>
  );
}
