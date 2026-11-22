interface TestEnvironment extends NodeJS.ProcessEnv {
  LING_STACK_HOME: string;
  LING_STACK_DEFAULT_WORKSPACE_CWD: string;
}

export function supportsNativeHostBuild(platform: string, arch: string): boolean;

export function runBrowserHostTests(options?: {
  platform?: string;
  arch?: string;
  run?: (command: string, args: string[], options: { env: TestEnvironment }) => void;
}): Promise<void>;
