import { publicAssetUrl } from "../ui/public-asset-url.js";

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
