import { createContext } from "react";
import type { DesktopLocalFilePreview } from "../../../../../desktop/shared/local-file-capabilities.js";

export const LocalFilePreviewContext = createContext<{
  readonly cwd?: string;
  readonly openPreview: (preview: DesktopLocalFilePreview) => void;
  readonly beginRequest: () => (preview: DesktopLocalFilePreview) => void;
} | undefined>(undefined);
