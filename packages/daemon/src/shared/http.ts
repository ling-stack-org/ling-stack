export async function readLimitedResponseText(response: Response, limit: number): Promise<string> {
  try {
    const text = await response.text();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  } catch {
    return "";
  }
}
