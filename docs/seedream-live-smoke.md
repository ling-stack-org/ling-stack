# Seedream Live Smoke

This smoke test verifies the live Seedream `image_generate` path without adding new provider behavior. It uses the existing media job API, generation runtime readiness checks, and artifact content endpoint.

Do not paste real API keys into files, PR descriptions, logs, or docs. Keep `SEEDREAM_API_KEY` only in the current shell environment.

## Prerequisites

- A live Ark/Seedream key exported as `SEEDREAM_API_KEY`.
- Ark Beijing endpoint: `https://ark.cn-beijing.volces.com/api/v3`.
- Model: `doubao-seedream-5-0-260128`.
- Local daemon URL: `http://127.0.0.1:17891`.
- Optional Web UI for final visual checks.

This is a real vendor smoke. If auth, quota, model, region, or network fails, record the blocker. Do not use `--skip-preflight` as a success path.

## 1. Build And Initialize

```bash
corepack pnpm build
node packages/cli/dist/index.js init --with-provider-templates
```

Export the key only in the shell that will start the daemon:

```bash
export SEEDREAM_API_KEY=...
```

Start the daemon in that same environment:

```bash
node packages/cli/dist/index.js daemon start --foreground
```

In a second terminal, set helper variables:

```bash
export DAEMON_URL=http://127.0.0.1:17891
export CWD="$PWD"
export CWD_ENCODED="$(python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["CWD"], safe=""))')"
```

## 2. Configure Seedream Provider

Find the Seedream provider id created from the template:

```bash
node packages/cli/dist/index.js --json provider list
```

Copy the `id` for the `seedream` / `Seedream Image` media provider, then set it:

```bash
export SEEDREAM_PROVIDER_ID=provider_...
```

Enable live transport:

```bash
node packages/cli/dist/index.js provider update "$SEEDREAM_PROVIDER_ID" \
  --enabled true \
  --base-url https://ark.cn-beijing.volces.com/api/v3 \
  --model doubao-seedream-5-0-260128 \
  --api-key-ref env:SEEDREAM_API_KEY \
  --compat-json '{"mediaVendorTransport":{"mode":"live"}}'
```

Run the static provider check:

```bash
node packages/cli/dist/index.js provider check "$SEEDREAM_PROVIDER_ID"
```

Expected result: the check passes and reports that the Seedream `image_generate` live transport configuration is complete. This check validates configuration only; it does not create media.

## 3. Create A Media Job

Use a short, low-cost prompt:

```bash
curl "$DAEMON_URL/media-jobs?cwd=$CWD_ENCODED" \
  -H 'content-type: application/json' \
  -d '{
    "providerPresetId": "'"$SEEDREAM_PROVIDER_ID"'",
    "operation": "image_generate",
    "prompt": "A small red cube on a white background, product render style.",
    "input": {
      "size": "2K",
      "response_format": "url",
      "watermark": true
    }
  }'
```

Copy the returned `mediaJob.id`:

```bash
export MEDIA_JOB_ID=media_job_...
```

## 4. Execute The Live Run

Run the media job:

```bash
curl -X POST "$DAEMON_URL/media-jobs/$MEDIA_JOB_ID/run?cwd=$CWD_ENCODED" \
  -H 'content-type: application/json' \
  -d '{}'
```

Expected result:

- `mediaJob.status` is `succeeded`.
- `mediaJob.artifactIds` is non-empty.
- Response artifacts include JSON metadata and at least one `image` artifact.
- Response does not include an approval; new media jobs no longer create `media_cost` approval requests.
- No returned artifact content or error message includes `SEEDREAM_API_KEY` or the raw key value.

## 5. Verify Artifacts

List artifacts:

```bash
curl "$DAEMON_URL/media-jobs/$MEDIA_JOB_ID/artifacts?cwd=$CWD_ENCODED"
```

For the JSON metadata artifact, verify:

- It includes `live_seedream_image_generate`.
- It includes endpoint `/images/generations`.
- It includes the configured model and image count.
- It does not include the raw secret value.

For the image artifact, verify:

- `type` is `image`.
- `contentType` starts with `image/`.
- `sizeBytes` is greater than zero.
- `GET /artifacts/:id/content` returns image bytes from `.ling-stack/artifacts`.

```bash
curl -sS \
  -o /tmp/seedream-image-artifact.bin \
  -w '%{http_code} %{content_type} %{size_download}\n' \
  "$DAEMON_URL/artifacts/$IMAGE_ARTIFACT_ID/content?cwd=$CWD_ENCODED"
```

## 6. Optional Web Check

Start the Web UI:

```bash
node packages/cli/dist/index.js ui --foreground
```

Open Media Jobs and verify:

- The job is `succeeded`.
- Artifact rows are visible.
- Image artifacts show `Open` and `Download`.
- Opening or downloading uses the existing artifact content endpoint.

## Success Criteria

- No `--skip-preflight` was used.
- Provider check passed before execution.
- The run called Seedream directly and finished `succeeded`.
- No new `media_cost` approval was created.
- Local artifacts include JSON metadata and image bytes.
- Artifact content is served only through existing artifact APIs.
- No secret value appears in artifacts, errors, PR notes, or docs.

## Known Blockers

Record the smoke as blocked, not failed, when the vendor returns:

- auth failure for `SEEDREAM_API_KEY`,
- quota or rate limit,
- unsupported model,
- endpoint or region mismatch,
- local network failure.

Out of scope for this smoke: Jimeng, Seedance, Seedream operations beyond `image_generate`, video bytes, billing, OS Keychain, Desktop packaging, and inline image preview.
