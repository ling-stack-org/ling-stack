// Retry-tolerant GitHub API helper: node scripts/gh-api.mjs <path-or-url> [outfile]
const token = process.env.GH_TOKEN;
const path = process.argv[2];
const out = process.argv[3];
if (!token || !path) {
  console.error("usage: GH_TOKEN=... node scripts/gh-api.mjs <path-or-url> [outfile]");
  process.exit(2);
}
const url = path.startsWith("http") ? path : `https://api.github.com/repos/ling-stack-org/ling-stack/${path.replace(/^\//, "")}`;
const proxy = process.env.HTTPS_PROXY ?? "http://127.0.0.1:7897";
for (let attempt = 1; attempt <= 6; attempt += 1) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ling-stack-smoke" },
      signal: AbortSignal.timeout(30_000),
      // Node fetch does not honor HTTPS_PROXY by default; use a dispatcher only when available.
      ...(globalThis.EnvHttpProxy ? {} : {}),
    }).catch(async (error) => {
      // Fall back to curl through the proxy when direct fetch fails.
      const result = await import("node:child_process").then(({ execFileSync }) => {
        const stdout = execFileSync("curl", ["-s", "-x", proxy, "-H", `Authorization: Bearer ${token}`, "-H", "Accept: application/vnd.github+json", url], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
        return stdout;
      });
      return new Response(result, { status: 200 });
    });
    const text = await response.text();
    if (text.length === 0) throw new Error("empty response");
    if (!text.startsWith("{") && !text.startsWith("[")) throw new Error(`non-JSON response: ${text.slice(0, 60)}`);
    if (out) {
      (await import("node:fs/promises")).writeFile(out, text);
      console.log(`saved ${text.length} bytes -> ${out}`);
    } else {
      console.log(text.slice(0, 2000));
    }
    process.exit(0);
  } catch (error) {
    console.error(`attempt ${attempt} failed: ${String(error).slice(0, 120)}`);
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
  }
}
process.exit(1);
