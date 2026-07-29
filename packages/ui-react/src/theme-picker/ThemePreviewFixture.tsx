import type { CSSProperties } from "react";
import { Button } from "../controls/Button.js";
import { Input } from "../controls/Input.js";
import { DataRow } from "../data-display/DataRow.js";
import { StatusIndicator } from "../feedback/StatusIndicator.js";
import type { LingThemeCssVariable } from "../theme/types.js";

export interface ThemePreviewFixtureCopy {
  readonly action: string;
  readonly body: string;
  readonly inputLabel: string;
  readonly rowLabel: string;
  readonly rowSummary: string;
  readonly status: string;
  readonly title: string;
}

export interface ThemePreviewFixtureProps {
  readonly copy: ThemePreviewFixtureCopy;
  readonly previewUrl?: string;
  readonly themeName: string;
  readonly variableMap: Readonly<Record<LingThemeCssVariable, string>>;
}

export function ThemePreviewFixture({
  copy,
  previewUrl,
  themeName,
  variableMap,
}: ThemePreviewFixtureProps): JSX.Element {
  return (
    <section
      className="ling-ui-theme-preview-fixture"
      data-theme-preview-fixture
      style={variableMap as CSSProperties}
    >
      {previewUrl ? (
        <img
          alt=""
          className="ling-ui-theme-preview-artwork"
          draggable={false}
          src={previewUrl}
        />
      ) : null}
      <div className="ling-ui-theme-preview-surface">
        <header className="ling-ui-theme-preview-header">
          <span>
            <small>{themeName}</small>
            <strong>{copy.title}</strong>
          </span>
          <StatusIndicator label={copy.status} tone="success" />
        </header>
        <p>{copy.body}</p>
        <Input aria-label={copy.inputLabel} placeholder={copy.inputLabel} readOnly />
        <DataRow
          compact
          identity={<strong>{copy.rowLabel}</strong>}
          summary={copy.rowSummary}
          status={<StatusIndicator label={copy.status} tone="info" />}
        />
        <Button size="sm" variant="primary">{copy.action}</Button>
      </div>
    </section>
  );
}
