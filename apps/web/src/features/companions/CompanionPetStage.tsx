import type { CompanionState } from "../../types.js";
import { useI18n } from "../../i18n.js";
import { publicAssetUrl } from "../../shared/ui/public-asset-url.js";

const yuiPoseAtlas = publicAssetUrl("companions/yui-poses.png");

export function CompanionPetStage({
  companionName,
  phase,
  actionId,
  emotionId,
  emotionLabel,
  message,
  onPointerDown,
}: {
  readonly companionName: string;
  readonly phase?: CompanionState["phase"];
  readonly actionId?: string;
  readonly emotionId?: string;
  readonly emotionLabel: string;
  readonly message: string;
  readonly onPointerDown?: React.PointerEventHandler<HTMLElement>;
}): React.JSX.Element {
  const { t } = useI18n();
  const phaseName = phase ?? "idle";
  const pose = characterPose(phase, actionId, emotionId);

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
            className={`companion-character companion-character-${pose}`}
            role="img"
            aria-label={companionName}
            data-companion-pose={pose}
            style={{ backgroundImage: `url(${yuiPoseAtlas})` }}
          />
        </div>
        <span className="companion-pet-ground" aria-hidden="true" />
      </div>
    </section>
  );
}

function characterPose(
  phase: CompanionState["phase"] | undefined,
  actionId?: string,
  emotionId?: string,
): "idle" | "thinking" | "greeting" | "celebrating" | "waiting" | "attention" {
  if (phase === "error") return "attention";
  if (actionId === "greet") return "greeting";
  if (actionId === "think") return "thinking";
  if (actionId === "celebrate") return "celebrating";
  if (actionId === "idle") return "idle";
  if (phase === "thinking") return "thinking";
  if (phase === "speaking") return "greeting";
  if (emotionId === "tired") return "waiting";
  if (emotionId === "sad") return "attention";
  return "idle";
}
