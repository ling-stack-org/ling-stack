import { publicAssetUrl } from "../ui/public-asset-url.js";

/**
 * The product logo remains the original Ling Stack mark. Scene artwork is
 * theme decoration and must not replace the brand asset.
 */
export function LingStackLogo({ size = 20 }: { readonly size?: number }): React.JSX.Element {
  const file = size <= 24 ? "ling-mark-micro.svg" : size <= 64 ? "ling-mark-compact.svg" : "ling-mark.svg";
  return (
    <img
      aria-hidden="true"
      alt=""
      height={size}
      src={publicAssetUrl(`icons/${file}`)}
      style={{ display: "block", objectFit: "contain", flexShrink: 0 }}
      width={size}
    />
  );
}
