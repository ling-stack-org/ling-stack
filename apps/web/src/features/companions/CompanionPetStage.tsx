import type { CompanionState } from "../../types.js";
import { useI18n } from "../../i18n.js";
import { publicAssetUrl } from "../../shared/ui/public-asset-url.js";

const lanxingSpritesheet = publicAssetUrl("companions/lanxing-spritesheet.png");

export function CompanionPetStage({
  companionName,
  phase,
  actionId,
  emotionLabel,
  message,
  onPointerDown,
}: {
  readonly companionName: string;
  readonly phase?: CompanionState["phase"];
  readonly actionId?: string;
  readonly emotionLabel: string;
  readonly message: string;
  readonly onPointerDown?: React.PointerEventHandler<HTMLElement>;
}): React.JSX.Element {
  const { t } = useI18n();
  const phaseName = phase ?? "idle";

  return (
    <section
      className={`companion-pet-stage companion-pet-stage-${phaseName}`}
      aria-label={`${companionName} ${t("Companion status")}`}
      data-companion-drag-handle="true"
      onPointerDown={onPointerDown}
    >
      <div className="companion-pet-stage-topline">
        <span className="companion-pet-stage-name">{companionName}</span>
        <span className="companion-pet-stage-emotion">{emotionLabel}</span>
      </div>
      <div className="companion-pet-scene">
        <div className="companion-pet-bubble" aria-live="polite">
          {message}
        </div>
        <div className="companion-pet-art-wrap">
          <span
            className={`companion-pet-sprite companion-pet-sprite-${spriteStateForPhase(phase, actionId)}`}
            role="img"
            aria-label={companionName}
            style={{ backgroundImage: `url(${lanxingSpritesheet})` }}
          />
        </div>
        <span className="companion-pet-ground" aria-hidden="true" />
      </div>
    </section>
  );
}

function spriteStateForPhase(
  phase: CompanionState["phase"] | undefined,
  actionId?: string,
): "idle" | "running" | "waiting" | "waving" | "jumping" | "failed" {
  if (actionId === "greet") return "waving";
  if (actionId === "think") return "running";
  if (actionId === "celebrate") return "jumping";
  if (actionId === "idle") return "idle";
  if (phase === "thinking") return "running";
  if (phase === "speaking") return "waving";
  if (phase === "reacting") return actionId ? "jumping" : "idle";
  if (phase === "error") return "failed";
  return "idle";
}
