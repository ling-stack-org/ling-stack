import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function startMockOpenAICompatibleServer(t, options = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    const responseContent = typeof options.responseContent === "function"
      ? options.responseContent({ request, body })
      : options.responseContent ?? "OK";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-startup-refresh",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: responseContent }, finish_reason: "stop" }],
    }));
  });
  // Register ownership before any caller can fail during daemon startup/stop.
  t.after(() => new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  }));
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}
