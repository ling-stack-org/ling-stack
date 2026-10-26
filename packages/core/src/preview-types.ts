/**
 * Preview types live in @ling-stack/contracts; this module re-exports them so
 * core consumers keep a single import surface. The previous duplicate copy of
 * these types here drifted from the contract (html_interactive was added to
 * the contract only), so the duplication is now removed by delegation.
 */
export type {
  PreviewContentKind,
  PreviewContentResponse,
  PreviewFileRef,
  PreviewHtmlInteractive,
  PreviewImageCompare,
  PreviewImageCompareMode,
  PreviewImageCompareSource,
} from "@ling-stack/contracts";
export {
  HTML_INTERACTIVE_MAX_BYTES,
  HTML_INTERACTIVE_SANDBOX,
  scanInteractiveHtml,
} from "@ling-stack/contracts";
export type { InteractiveHtmlScanResult } from "@ling-stack/contracts";
