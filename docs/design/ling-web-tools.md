# Ling Web Tools

## Goal

Ling Agent should answer channel questions that require current public web evidence without pretending that Codex-only tools are part of the Ling runtime. The first slice adds daemon-owned web context before channel reply generation:

- `web_search`: provider-backed hosted web search, currently implemented for a selected official OpenAI Responses provider that explicitly declares the `web_search` capability.
- `open_url` / `read_url`: public URL body extraction for explicit URL-reading requests.
- `browser`: deferred; interactive browser control requires a separate session, approval, and audit model.

## Current Slice

The daemon builds web context before calling the channel reply runner. This keeps web access out of the local `RunTool` permission enum (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`) and avoids treating internet lookup as a workspace filesystem or shell permission.

```mermaid
flowchart LR
  User["User channel message"] --> Materialize["Inline materialization"]
  Materialize --> Envelope["Ling turn envelope"]
  Envelope --> WebIntent["Web intent detector"]
  WebIntent -->|search intent| Search["Responses API web_search"]
  WebIntent -->|URL read intent| ReadUrl["Public URL reader"]
  Search --> Context["Ling web context"]
  ReadUrl --> Context
  Context --> Prompt["Channel reply prompt"]
  Prompt --> Runner["Configured Ling runner"]
  Runner --> Reply["AI channel reply with visible source URLs"]
```

## Tool Semantics

### web_search

`web_search` is a daemon-side context enrichment, not a runner tool. It triggers on explicit web/search language or freshness queries such as latest/current/today/news combined with search or verification intent.

Implementation contract:

- Call the OpenAI Responses API with `tools: [{ "type": "web_search", "search_context_size": "low" }]`.
- Request `include: ["web_search_call.action.sources"]` so the prompt can carry source URLs beyond inline citations.
- Use only the selected official OpenAI Responses preset when it is enabled, has `capabilities` containing `web_search`, and has a configured provider key.
- Do not fall back to a standalone `env:OPENAI_API_KEY` outside the selected provider. Real-time search must be explained as a provider capability in model settings, not as a separate daemon key.
- Never log or render the plaintext key.
- If search fails, the provider lacks `web_search`, or the provider key is missing, continue the reply with a web-context blocked reason instead of fabricating current facts.

### open_url / read_url

URL reading reuses the existing link-body materialization policy:

- Only `http` and `https` are allowed.
- Localhost, loopback, link-local, private IPv4, private IPv6, and local hostnames are blocked.
- Redirects are followed only after rechecking the target URL and resolved addresses.
- Body size, text size, redirect count, and timeout are bounded.
- Supported content types are HTML, plain text, and JSON.

When the turn envelope already contains an available materialized link body, the web context does not duplicate it. If the user explicitly asks to open/read a URL and no available link-body materialization exists, the daemon reads up to a small number of public URLs and injects the extracted text into the reply prompt.

### browser

Codex Browser Use is not directly portable into Ling Agent as a simple function call. It carries a live browser session, UI interaction targets, screenshots, event timing, and user-visible side effects. Ling needs its own contract before exposing this:

- user approval before navigation that changes account state or submits forms;
- session lifecycle and artifact capture;
- source/event rows for open page, click, type, screenshot, and find-in-page;
- network and origin policy;
- replayable audit evidence in the channel/work-unit timeline.

Until that exists, Ling supports current public lookup and public URL reading, not interactive browser automation.

## Prompt Boundary

The channel reply system prompt remains side-effect free:

- the runner still receives `tools: []`;
- web context is explicitly labeled as evidence;
- replies may use only included web-search/open-url results;
- replies must keep source URLs visible when using web evidence;
- replies must not claim page/body access beyond the included context.

## Provider And Key Boundary

The slice intentionally reuses the existing provider secret system:

- Selected official OpenAI Responses preset with `web_search`: use its configured `apiKeyRef`.
- OpenAI-compatible chat/completions providers are not assumed to support hosted web search.
- Ling does not read a separate daemon-level `OPENAI_API_KEY` as a hidden fallback.
- No new key is created.
- No secret is persisted by this feature.
- A future provider adapter may map Ling's generic `web_search` capability to another vendor-specific search or grounding API, but each adapter must define its request and citation contract explicitly.

## Failure Modes

| Failure | Behavior |
| --- | --- |
| Selected provider lacks `web_search` | Inject blocked web-search status; reply should say the current model configuration does not support real-time search. |
| Selected web-search provider key is missing | Inject blocked web-search status; reply should say the configured provider key is missing. |
| OpenAI request fails | Inject sanitized HTTP/network error; continue ordinary reply. |
| Model returns no citations | Include summary and mark sources as none returned. |
| URL points to private/local network | Block before fetch or after DNS/redirect check. |
| URL body too large | Truncate to prompt budget. |
| Unsupported content type | Block URL body extraction. |

## Next Slice

1. Add UI evidence rows for web search calls, opened URLs, and cited sources.
2. Add configurable search controls: allowed/blocked domains, live-access toggle, and context size.
3. Add a browser-session design with approvals, artifacts, and replayable interaction events.
4. Consider promoting `web_search` to a first-class tool only after the tool schema can represent non-workspace side effects and source evidence.
