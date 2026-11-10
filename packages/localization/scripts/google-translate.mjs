/** Shared Google translate endpoint caller with bounded retry for catalog tooling. */
export async function translateBatch(texts, target) {
  const query = new URLSearchParams({ client: "dict-chrome-ex", sl: "en", tl: target });
  for (const text of texts) query.append("q", text);
  const url = `https://clients5.google.com/translate_a/t?${query}`;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (response.ok) {
      const value = await response.json();
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
      throw new Error(`Unexpected translation response for ${target}`);
    }
    if (attempt === 10) throw new Error(`Translation request failed for ${target}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 1_000));
  }
  return [];
}
