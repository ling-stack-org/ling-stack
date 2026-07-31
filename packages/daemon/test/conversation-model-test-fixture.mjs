import assert from "node:assert/strict";

const preparedProviderByWorkspace = new Map();

export async function prepareChannelCreateBody(url, body) {
  const requestUrl = new URL(url);
  if (requestUrl.pathname !== "/channels") {
    return body;
  }
  const cwd = requestUrl.searchParams.get("cwd");
  assert.ok(cwd, "channel test request must include cwd");

  const requestedProviderId = typeof body.defaultProviderPresetId === "string"
    ? body.defaultProviderPresetId.trim()
    : "";
  if (requestedProviderId) {
    await ensureProviderChecked(requestUrl.origin, cwd, requestedProviderId);
    return body;
  }

  const key = `${requestUrl.origin}\n${cwd}`;
  let providerId = preparedProviderByWorkspace.get(key);
  if (!providerId) {
    const response = await fetch(`${requestUrl.origin}/providers?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "glm",
        displayName: "Channel Test Model",
        providerId: "channel-test-model",
        model: "channel-test-model",
        api: "google-generative-ai",
        capabilities: ["chat"],
        input: ["text"],
        authHeader: false,
        enabled: true,
      }),
    });
    const responseText = await response.text();
    assert.equal(response.ok, true, responseText);
    const created = JSON.parse(responseText);
    providerId = created.provider.id;
    preparedProviderByWorkspace.set(key, providerId);
  }
  await ensureProviderChecked(requestUrl.origin, cwd, providerId);
  return { ...body, defaultProviderPresetId: providerId };
}

async function ensureProviderChecked(origin, cwd, providerId) {
  const response = await fetch(`${origin}/providers/${encodeURIComponent(providerId)}?cwd=${encodeURIComponent(cwd)}`);
  const responseText = await response.text();
  assert.equal(response.ok, true, responseText);
  const provider = JSON.parse(responseText).provider;
  if (provider.lastCheck?.ok === true || provider.lastCheck?.ok === false) {
    return;
  }
  await checkProvider(origin, cwd, providerId);
}

async function checkProvider(origin, cwd, providerId) {
  const response = await fetch(`${origin}/providers/${encodeURIComponent(providerId)}/check?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const responseText = await response.text();
  assert.equal(response.ok, true, responseText);
}
