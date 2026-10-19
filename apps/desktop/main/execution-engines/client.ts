import { ExecutionEngineManagementClient } from "@ling-stack/api-client";
import type { ExecutionEngineHostAuthority } from "@ling-stack/core/execution-engine-host-authority";

export async function createHostExecutionEngineClient(baseUrl: string, getAuthority: () => Promise<ExecutionEngineHostAuthority>): Promise<ExecutionEngineManagementClient> {
  const authority = await getAuthority();
  if (authority.baseUrl !== new URL(baseUrl).origin) throw new Error("engine_host_authority_unavailable");
  return new ExecutionEngineManagementClient({
    baseUrl: authority.baseUrl,
    origin: authority.baseUrl,
    credentials: () => ({ token: authority.credentials.capability, csrfToken: authority.credentials.csrfToken }),
  });
}
