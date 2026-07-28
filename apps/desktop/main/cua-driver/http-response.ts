const DEFAULT_MAX_RESPONSE_BODY_BYTES = 64 * 1024;

/** Consume a loopback daemon response without permitting an unbounded body buffer. */
export async function consumeBoundedResponseBody(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BODY_BYTES,
): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("cua_driver_response_body_limit_invalid");
  }
  const body = response.body;
  if (!body) {
    return;
  }
  const reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel("cua_driver_response_body_too_large");
        throw new Error("cua_driver_response_body_too_large");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
