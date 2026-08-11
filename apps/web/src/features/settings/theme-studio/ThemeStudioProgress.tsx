import { Check, Circle } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { QuickThemeStage } from "./quick-theme-state.js";

const steps = [
  { id: "source", label: "Image" },
  { id: "analysis", label: "Colors" },
  { id: "preview", label: "Preview" },
  { id: "install", label: "Install" },
] as const;

export function ThemeStudioProgress({ stage, hasSource }: {
  readonly hasSource: boolean;
  readonly stage: QuickThemeStage;
}): React.JSX.Element {
  const { t } = useI18n();
  const completed = completedCount(stage, hasSource);
  return (
    <ol className="settings-theme-studio-progress" aria-label={t("Theme creation progress")}>
      {steps.map((step, index) => {
        const done = index < completed;
        const current = index === completed && stage !== "installed";
        return (
          <li key={step.id} aria-current={current ? "step" : undefined} data-complete={done ? "true" : undefined}>
            {done ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
            <span>{t(step.label)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function completedCount(stage: QuickThemeStage, hasSource: boolean): number {
  if (stage === "installed") return 4;
  if (stage === "publishing" || stage === "preview-ready") return 3;
  if (stage === "compiling") return 2;
  if (hasSource) return 2;
  return 0;
}
