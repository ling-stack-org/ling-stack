import { mergeClassNames } from "../shared/merge-class-names.js";

export type LingCoreMarkState = "idle" | "thinking" | "receiving" | "completed" | "blocked";

export interface LingCoreMarkProps {
  readonly artworkSrc: string;
  readonly state?: LingCoreMarkState;
  readonly className?: string;
  readonly label?: string;
}

const ORB_DATA = [
  { id: "a", cx: 139, cy: 61, r: 3.2 },
  { id: "b", cx: 119, cy: 77, r: 2.8 },
  { id: "c", cx: 103, cy: 92, r: 2.5 },
] as const;

/**
 * Ling Core IP —— ink-wash spirit seal.
 *
 * The managed ink artwork owns the mountain platform, crescent and warm heart
 * glow. Three live nodes move independently so the mark can respond to state
 * without losing the original ink-wash composition.
 */
export function LingCoreMark({
  artworkSrc,
  state = "idle",
  className,
  label,
}: LingCoreMarkProps): React.JSX.Element {
  return (
    <div
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={mergeClassNames("ling-core-mark", className)}
      data-state={state}
      role={label ? "img" : "presentation"}
    >
      <span className="ling-core-mark-aura" />
      <img alt="" className="ling-core-mark-artwork" draggable={false} src={artworkSrc} />
      <svg aria-hidden="true" className="ling-core-mark-overlay" focusable="false" viewBox="0 0 240 180">
        <g className="ling-core-mark-orbs">
          {ORB_DATA.map((orb) => (
            <g className={`ling-core-mark-orb ling-core-mark-orb-${orb.id}`} key={orb.id}>
              <circle className="ling-core-mark-orb-core" cx={orb.cx} cy={orb.cy} r={orb.r} />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
