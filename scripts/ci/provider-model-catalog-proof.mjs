import { providerModelCatalogDigest } from "../provider-model-catalog-format.mjs";

const producerWorkflow = ".github/workflows/sync-provider-model-catalog.yml";

/** Match the candidate bytes to an artifact named by the main-branch generator. */
export async function findProviderModelCatalogProof({ github, context, source }) {
  const repository = context.payload?.repository;
  if (!Number.isSafeInteger(repository?.id) || !repository.default_branch) return undefined;
  const digest = providerModelCatalogDigest(source);
  const name = `provider-model-catalog-${digest}`;
  const request = { signal: AbortSignal.timeout(8_000) };
  try {
    const { data } = await github.rest.actions.listArtifactsForRepo({
      ...context.repo, name, per_page: 10, request,
    });
    for (const artifact of data.artifacts) {
      if (artifact.name !== name || artifact.expired !== false || !Number.isSafeInteger(artifact.workflow_run?.id)) continue;
      const { data: run } = await github.rest.actions.getWorkflowRun({
        ...context.repo, run_id: artifact.workflow_run.id, request,
      });
      if (run.path === producerWorkflow && run.head_branch === repository.default_branch
        && run.repository?.id === repository.id && run.head_repository?.id === repository.id
        && ["schedule", "workflow_dispatch"].includes(run.event)) return digest;
    }
  } catch {
    // Missing or unavailable proof selects the ordinary consumer graph.
  }
  return undefined;
}
