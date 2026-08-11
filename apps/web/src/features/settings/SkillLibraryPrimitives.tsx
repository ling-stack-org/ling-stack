import { StatusIndicator } from "../../shared/ui/index.js";
import type { SkillPackSource, SkillSourceSnapshot } from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import { skillSourceLabel, skillSourceSnapshotState } from "./skill-library-utils.js";

export function SkillSourceStatus({
  source,
  snapshot,
  showSource = true,
  showState = true,
  t,
}: {
  readonly source: SkillPackSource;
  readonly snapshot: SkillSourceSnapshot | undefined;
  readonly showSource?: boolean;
  readonly showState?: boolean;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const sourceState = skillSourceSnapshotState(snapshot, t);
  return (
    <span className="settings-skill-source-status">
      {showSource ? <span>{skillSourceLabel(source, t)}</span> : null}
      {showState ? (
        <StatusIndicator
          compact
          label={sourceState.label}
          tone={sourceState.tone === "backed" ? "success" : sourceState.tone === "warning" ? "warning" : "neutral"}
        />
      ) : null}
    </span>
  );
}

export function SkillTokenList({
  values,
  emptyLabel,
}: {
  readonly values: readonly string[];
  readonly emptyLabel: string;
}): React.JSX.Element {
  if (values.length === 0) return <span className="settings-skill-empty-token">{emptyLabel}</span>;
  return (
    <span className="settings-skill-token-list">
      {values.slice(0, 4).map((value) => <code key={value}>{value}</code>)}
      {values.length > 4 ? <small>+{values.length - 4}</small> : null}
    </span>
  );
}
