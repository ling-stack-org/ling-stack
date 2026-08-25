export interface ProviderWorkbenchReadinessInput {
  readonly enabled: boolean;
  readonly secretReady: boolean;
  readonly latestCheckReady: boolean;
  readonly generationCapable: boolean;
  readonly generationRuntimeReady: boolean;
}

export function providerWorkbenchReady(input: ProviderWorkbenchReadinessInput): boolean {
  return input.enabled &&
    input.secretReady &&
    input.latestCheckReady &&
    (!input.generationCapable || input.generationRuntimeReady);
}
