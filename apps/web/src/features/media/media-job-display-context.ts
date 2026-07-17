export interface MediaJobDisplayContext {
  readonly projectName: string;
  readonly sceneName: string;
}

export type MediaJobDisplayContextMap = Readonly<Record<string, MediaJobDisplayContext>>;
