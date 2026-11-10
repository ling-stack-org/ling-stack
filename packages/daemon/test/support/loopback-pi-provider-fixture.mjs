import assert from "node:assert/strict";
import { createServer } from "node:http";

/** A deterministic loopback-only OpenAI-compatible SSE fixture, never a model. */
export async function startLoopbackPiProvider(respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "static-tools", object: "model" }] }));
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      const answer = respond(body, requests.length);
      const delta = answer.tool ? { role: "assistant", tool_calls: [{ index: 0, id: `static-tool-${requests.length}`,
        type: "function", function: { name: answer.tool, arguments: JSON.stringify(answer.input) } }] }
        : { role: "assistant", content: answer.text };
      const finishReason = answer.tool ? "tool_calls" : "stop";
      const base = { id: `static-response-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "static-tools" };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: delta, finish_reason: finishReason }] }));
      }
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
