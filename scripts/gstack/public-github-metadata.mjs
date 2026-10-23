// Public, fixed upstream build metadata must not depend on the user's gh login
// or read its credential/config directory from inside an isolated build HOME.
export async function readPublicGstackGithubMetadata(endpoint, request = fetch) {
  if (typeof endpoint !== "string" || !/^repos\/ungoogled-software\/ungoogled-chromium(?:-macos)?\/(?:git\/ref\/tags|releases\/tags|actions\/runs|git\/trees|contents)\/[A-Za-z0-9._/?=-]+$/.test(endpoint)
    || endpoint.split(/[/?]/).some(part => part === "." || part === "..")) throw new Error("gstack_github_metadata_endpoint_invalid");
  const response = await request(`https://api.github.com/${endpoint}`, { redirect: "error", credentials: "omit",
    headers: { accept: "application/vnd.github+json", "user-agent": "ling-gstack-fixed-resource-builder" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel(); throw new Error(`gstack_github_metadata_http_${response.status}`);
  }
  const maximum = 4 * 1024 ** 2, length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body.cancel(); throw new Error("gstack_github_metadata_too_large");
  }
  const chunks = []; let total = 0;
  for await (const part of response.body) {
    total += part.length;
    if (total > maximum) throw new Error("gstack_github_metadata_too_large");
    chunks.push(part);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
