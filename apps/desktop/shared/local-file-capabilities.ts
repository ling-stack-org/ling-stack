export interface DesktopLocalFileRequest {
  readonly path: string;
  readonly cwd?: string;
  readonly line?: number;
  readonly locale?: string;
}

export interface DesktopLocalFilePreview {
  readonly path: string;
  readonly name: string;
  readonly kind: "text" | "image" | "directory" | "unsupported";
  readonly sizeBytes: number;
  readonly text?: string;
  readonly imageUrl?: string;
  readonly language?: string;
  readonly line?: number;
  readonly truncated: boolean;
  readonly entries?: readonly { readonly path: string; readonly name: string; readonly directory: boolean }[];
}

/** User-activated local viewing; independent from model/tool execution grants. */
export interface DesktopLocalFileCapabilities {
  inspect(request: DesktopLocalFileRequest): Promise<DesktopLocalFilePreview>;
  showMenu(request: DesktopLocalFileRequest): Promise<DesktopLocalFilePreview | undefined>;
}
