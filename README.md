# Hoopilot

[![npm version](https://img.shields.io/npm/v/%40openhoo%2Fhoopilot?label=npm)](https://www.npmjs.com/package/@openhoo/hoopilot)
[![CI](https://github.com/openhoo/hoopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/openhoo/hoopilot/actions/workflows/ci.yml)

Hoopilot is a local OpenAI- and Anthropic-compatible proxy for GitHub Copilot accounts. It runs on Bun and exposes OpenAI-style `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, and `/v1/models` routes, plus Claude Code-compatible `/v1/messages` and `/v1/messages/count_tokens` routes.

This project uses GitHub Copilot service endpoints and is not an official GitHub product. Upstream behavior can change without notice. Use Hoopilot only with accounts and usage patterns you are allowed to use.

## Highlights

- Browser-based GitHub Copilot OAuth login with a local credential store.
- OpenAI-compatible Chat Completions, Responses, legacy Completions, and model-list routes.
- Anthropic Messages compatibility for Claude Code and other Anthropic-style clients.
- Bundled `codexx` launcher that runs Codex against a local Hoopilot server with the right Responses API provider settings.
- Local API-key gate, loopback-safe defaults, structured logs, Prometheus metrics, and Copilot quota reporting.
- npm package, standalone binaries, Docker image, and self-update support for release binaries.

## Quick start

Sign in once, then start the proxy on localhost:

```sh
npx @openhoo/hoopilot login
npx @openhoo/hoopilot
```

By default the server listens on `127.0.0.1:4141` and accepts local requests without authentication, so any placeholder works as the client key:

```sh
export OPENAI_BASE_URL=http://127.0.0.1:4141/v1
export OPENAI_API_KEY=hoopilot
```

PowerShell:

```powershell
$env:OPENAI_BASE_URL = "http://127.0.0.1:4141/v1"
$env:OPENAI_API_KEY = "hoopilot"
```

To require clients to authenticate — recommended whenever you expose the proxy beyond localhost — set `HOOPILOT_API_KEY` to a strong, unique secret and send that value as the client key:

```sh
export HOOPILOT_API_KEY=$(openssl rand -hex 24)
npx @openhoo/hoopilot
```

Run Codex through Hoopilot after the server is running:

```sh
npx --package @openhoo/hoopilot codexx
```

## Install

### npm

Run without installing:

```sh
npx @openhoo/hoopilot
```

Or install the package globally:

```sh
npm install -g @openhoo/hoopilot
bun add -g @openhoo/hoopilot
```

### Standalone binary

When npm is unavailable but GitHub releases are reachable, install a prebuilt self-contained binary. Node.js and Bun are not required to run the binary.

Linux/macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.ps1 | iex
```

The installer detects your OS, CPU architecture, and libc, downloads the matching binary, verifies its SHA-256 checksum, and installs it to `~/.local/bin` on Linux/macOS or `%LOCALAPPDATA%\Programs\hoopilot` on Windows. Override the install directory with `HOOPILOT_INSTALL_DIR`, or pin a version:

```sh
curl -fsSL https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.sh | sh -s -- --version <version> --dir ~/bin
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.ps1))) -Version <version>
```

The standalone installer also installs a `codexx` wrapper next to `hoopilot`. Re-run the installer if `hoopilot` works but your shell does not recognize `codexx`; the installer stops the installed `hoopilot.exe` if needed and replaces the existing files in place.

### Docker

Run Hoopilot as a long-lived service from the published multi-arch image on the GitHub Container Registry (`linux/amd64` and `linux/arm64`):

```sh
# 1. Sign in once; the OAuth credential is written to the persisted /data volume.
docker run --rm -it -v hoopilot-data:/data ghcr.io/openhoo/hoopilot login

# 2. Run the proxy on localhost with a strong, unique API key.
export HOOPILOT_API_KEY=$(openssl rand -hex 24)
docker run -d --name hoopilot --restart unless-stopped \
  -p 127.0.0.1:4141:4141 \
  -e HOOPILOT_API_KEY \
  -v hoopilot-data:/data ghcr.io/openhoo/hoopilot
```

Tags follow the release version, for example `ghcr.io/openhoo/hoopilot:0.10`, `:0.10.0`, and `:latest`. The image listens on `0.0.0.0:4141` (required so Docker port publishing can reach it), runs as a non-root user, and stores its OAuth credential at `/data/auth.json` by default. Override that path with `HOOPILOT_AUTH_FILE`.

Because it binds a non-loopback interface, the image fails closed: it refuses to start unless you set `HOOPILOT_API_KEY` to a strong, unique secret (well-known demo keys are rejected). Clients then send that key as `Authorization: Bearer <key>` or `x-api-key: <key>`. To intentionally run without authentication — for example behind your own authenticating proxy — set `HOOPILOT_ALLOW_UNAUTHENTICATED=1`.

A `docker-compose.yml` is provided. Set `HOOPILOT_API_KEY` first; compose passes it through to the container:

```sh
docker compose run --rm hoopilot login
export HOOPILOT_API_KEY=$(openssl rand -hex 24)
docker compose up -d
```

## Update

Standalone binaries update themselves in place from the latest GitHub release:

```sh
hoopilot update
```

npm installs report when a newer version is available and print the right command. Hoopilot checks GitHub at most once a day in the background. Disable the check with `--no-update-check`, `HOOPILOT_NO_UPDATE_CHECK`, or `NO_UPDATE_NOTIFIER`.

## Running the proxy

Login uses GitHub's browser/device flow, verifies that the returned OAuth token can reach the Copilot API, and stores it locally:

```sh
hoopilot login
```

Default credential paths:

- Linux/macOS: `$HOME/.config/hoopilot/auth.json`
- Windows: `%APPDATA%\hoopilot\auth.json`

Override the path with `HOOPILOT_AUTH_FILE` or `--auth-file`.

Start the server:

```sh
hoopilot --port 4141
```

By default Hoopilot listens on `127.0.0.1:4141`. If `HOOPILOT_API_KEY` is unset, local requests are accepted without client authentication. Binding to a non-loopback host requires either a strong, unique `HOOPILOT_API_KEY` or the explicit `--allow-unauthenticated` / `HOOPILOT_ALLOW_UNAUTHENTICATED=1` opt-in. Well-known demo keys are always rejected on a non-loopback host, even with the unauthenticated opt-in.

When an API key is configured, clients may send it as either `Authorization: Bearer <key>` or `x-api-key: <key>`.

Cross-origin browser requests are always blocked, even when an API key is set, so a malicious web page cannot drive the local proxy. Requests from loopback origins are allowed; to permit specific web origins, list them in `HOOPILOT_ALLOWED_ORIGINS` (comma-separated).

## Client setup

### OpenAI-compatible clients

```sh
export OPENAI_BASE_URL=http://127.0.0.1:4141/v1
export OPENAI_API_KEY=hoopilot
```

The client key value is arbitrary when the server runs without `HOOPILOT_API_KEY`; if you set one, use that value here instead.

Use any model returned by:

```sh
hoopilot models
```

### Claude Code and Anthropic-style clients

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:4141
export ANTHROPIC_AUTH_TOKEN=hoopilot
claude
```

Hoopilot accepts the local key as `x-api-key` too, so `ANTHROPIC_API_KEY` also works for clients that send Anthropic's standard API-key header.

### Codex

Use the bundled `codexx` command after Hoopilot is running:

```sh
codexx
```

Without a global install:

```sh
npx --package @openhoo/hoopilot codexx
```

If the server requires an API key, set `HOOPILOT_API_KEY` (or `CODEXX_API_KEY`) in the `codexx` environment to match.

`codexx` does not start Hoopilot and does not alter your shell environment. It starts `codex` with a temporary `hoopilot` model provider pointed at `http://127.0.0.1:4141/v1`, uses the Responses API wire format, disables Responses WebSockets for that provider, maps `HOOPILOT_API_KEY` (or a random throwaway key when none is set) to `OPENAI_API_KEY` for the child process, passes `--disable network_proxy`, and removes standard proxy variables from the spawned Codex process.

`codexx` defaults to `gpt-5.5` with `model_reasoning_effort="xhigh"`. Before starting Codex, it checks `/v1/models` and reports if the logged-in Copilot account does not advertise the requested model. Set `CODEXX_MODEL` to one of the listed models, or log in with a Copilot account that has access to the default model.

Codex compaction posts to `/v1/responses/compact` for OpenAI- and Azure-named providers. Hoopilot handles that route with a unary Copilot Responses request and returns the `{ "output": [...] }` summary Codex expects, so compaction works through either `codexx` or a direct OpenAI-compatible base URL override.

## Authentication

Hoopilot supports one upstream credential flow: GitHub Copilot OAuth browser login.

```sh
hoopilot login
hoopilot
```

Direct bearer tokens, GitHub CLI token fallback, classic GitHub PATs, and fine-grained GitHub PATs are not supported.

Re-run `hoopilot login` after upgrading Hoopilot if Copilot reports a supported model as unavailable. Older stored tokens can have a reduced model set.

To print the verified OAuth token for another local tool, use `--print-key`. Login status goes to stderr, so stdout contains only the token.

```sh
hoopilot login --print-key | sed 's/^/COPILOT_OAUTH_TOKEN=/' >> .env
```

PowerShell:

```powershell
hoopilot login --print-key |
  ForEach-Object { "COPILOT_OAUTH_TOKEN=$_" } |
  Add-Content -Encoding utf8 .env
```

Docker:

```sh
docker run --rm -v hoopilot-data:/data ghcr.io/openhoo/hoopilot login --print-key \
  | sed 's/^/COPILOT_OAUTH_TOKEN=/' >> .env
```

## Logging

Hoopilot uses Pino for structured logs. Server startup, request completion, upstream Copilot failures, model-list fallback, auth failures, and update-check diagnostics are logged with stable event names and request IDs.

Logs never include request bodies, prompt text, completions, stream chunks, OAuth tokens, API keys, authorization headers, cookies, or auth-file contents.

Console logs default to pretty output at `info` level:

```sh
hoopilot --log-level info --log-format pretty
```

For newline-delimited JSON:

```sh
hoopilot --log-level info --log-format json
```

Incoming `x-request-id` headers are preserved on responses. If a request has no ID, Hoopilot generates one and returns it as `x-request-id`.

## Metrics and usage

Hoopilot tracks token usage, request counts, and latency in memory while the server runs. It can also report your GitHub Copilot account quota and premium-request usage.

- `GET /metrics` returns Prometheus text (`text/plain; version=0.0.4`). It exposes request counters, upstream call counters, token counters by model and type, a request-duration histogram, an in-flight gauge, and Copilot quota gauges after `/v1/usage` has been fetched at least once. Counters reset to zero on restart, which Prometheus handles natively.
- `GET /v1/usage` returns JSON combining the proxy metrics snapshot with live Copilot quota fetched from GitHub and cached for 60 seconds. If quota cannot be read, `copilot` is `null` and `copilot_error` explains why.
- `hoopilot usage` prints your Copilot plan and quota from the command line.

Token usage is read from the upstream `usage` object. For streaming chat completions, usage is only available when the client sends `stream_options: {"include_usage": true}`; Hoopilot does not inject that flag. Responses API streaming always reports usage, so streamed Responses requests are fully accounted.

`/metrics` and `/v1/usage` are subject to the same `HOOPILOT_API_KEY` gate as the other routes.

## Troubleshooting

### Codex auth errors

Hoopilot does not return raw `403` responses to Codex for authentication or Copilot-entitlement failures. Local Hoopilot API-key problems return `401 invalid_api_key`; OAuth credential and upstream Copilot auth failures return `401 copilot_auth_error`.

Verify browser login and the local proxy before retrying Codex:

```sh
hoopilot login
hoopilot --port 4141
```

Then, in another shell:

```sh
curl http://127.0.0.1:4141/v1/models
codexx
```

If you started the server with `HOOPILOT_API_KEY`, add `-H "Authorization: Bearer $HOOPILOT_API_KEY"` to the curl command and set the same `HOOPILOT_API_KEY` for `codexx`.

If `/v1/models` returns `401 copilot_auth_error`, rerun `hoopilot login` and confirm that the GitHub account has active Copilot access.

## Configuration

Server and local-client settings:

| Setting | Description |
| --- | --- |
| `HOST` / `--host` | Host to listen on. Default: `127.0.0.1` for local runs; Docker sets `0.0.0.0`. |
| `PORT` / `--port` | Port to listen on. Default: `4141`. |
| `HOOPILOT_API_KEY` / `--api-key` | Require clients to send `Authorization: Bearer <key>` or `x-api-key: <key>`. Must be a strong, unique secret on non-loopback binds; well-known demo keys are rejected. |
| `--api-key-file` | Read the local API key from a file instead of argv. |
| `HOOPILOT_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to make cross-origin requests. Loopback origins are always allowed; every other origin is blocked. |
| `HOOPILOT_ALLOW_UNAUTHENTICATED` / `--allow-unauthenticated` | Allow non-loopback binds without a local API key. |
| `HOOPILOT_STREAM_MODE` / `--stream-mode` | `auto`, `live`, or `buffer`. `auto` buffers streams for Windows standalone binaries. |

Copilot and GitHub settings:

| Setting | Description |
| --- | --- |
| `HOOPILOT_AUTH_FILE` / `--auth-file` | OAuth credential store path. |
| `HOOPILOT_GITHUB_CLIENT_ID` | GitHub OAuth app client ID override. |
| `HOOPILOT_GITHUB_DOMAIN` | GitHub domain override. Default: `github.com`. |
| `COPILOT_API_BASE_URL` / `--copilot-api-base-url` | Upstream Copilot API base URL. Default: `https://api.githubcopilot.com`. |
| `HOOPILOT_GITHUB_API_BASE_URL` | GitHub REST API base URL used for quota lookup. Default: `https://api.github.com`. |
| `HOOPILOT_ALLOW_UNSAFE_UPSTREAM=1` | Allow sending the stored OAuth token to nonstandard HTTPS Copilot/GitHub API hosts. Use only for trusted test or enterprise endpoints. |

Logging and update settings:

| Setting | Description |
| --- | --- |
| `HOOPILOT_LOG_LEVEL` / `--log-level` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`. Default: `info`. |
| `HOOPILOT_LOG_FORMAT` / `--log-format` | `pretty` or `json`. Default: `pretty`. |
| `HOOPILOT_NO_UPDATE_CHECK` / `--no-update-check` | Disable background update checks. `NO_UPDATE_NOTIFIER` is also honored. |

`codexx` settings:

| Setting | Description |
| --- | --- |
| `CODEXX_BASE_URL` | OpenAI-compatible Hoopilot base URL. Default: `http://127.0.0.1:4141/v1`. |
| `CODEXX_API_KEY` | API key sent to Hoopilot. Falls back to `HOOPILOT_API_KEY`, then a random per-run key for an unauthenticated local server. |
| `CODEXX_CODEX_BIN` | Codex executable to run. Default: `codex`. |
| `CODEXX_MODEL` | Codex model to use. Default: `gpt-5.5`. |
| `CODEXX_MODEL_REASONING_EFFORT` | Codex reasoning effort. Default: `xhigh`. |
| `CODEXX_SKIP_MODEL_PREFLIGHT=1` | Skip the `/v1/models` availability check before starting Codex. |

## CLI reference

```txt
hoopilot [serve] [options]
hoopilot codexx [codex options] [prompt]
hoopilot login [options]
hoopilot models [options]
hoopilot usage [options]
hoopilot update
```

Commands:

```txt
serve                             Start the proxy server (default)
codexx                            Run Codex through the local Hoopilot server
login                             Sign in through GitHub OAuth in a browser and verify Copilot access
models                            List available GitHub Copilot model IDs
usage                             Show GitHub Copilot quota and premium-request usage
update, upgrade                   Update hoopilot to the latest release
```

Options:

```txt
-p, --port <port>                 Port to listen on. Default: 4141
    --host <host>                 Host to listen on. Default: 127.0.0.1
    --api-key <key>               Require clients to send Authorization: Bearer <key> or x-api-key: <key>
    --api-key-file <path>         Read the local API key from a file instead of argv
    --auth-file <path>            OAuth credential store path
    --copilot-api-base-url <url>  Copilot API base URL override
    --print-key                   Login: print the received OAuth token to stdout
    --log-level <level>           trace, debug, info, warn, error, fatal, or silent
    --log-format <format>         json or pretty. Default: pretty
    --stream-mode <mode>          auto, live, or buffer. Auto buffers Windows standalone streams.
    --no-update-check             Do not check GitHub for a newer release
    --allow-unauthenticated       Allow non-loopback bind without --api-key
-h, --help                        Show help
-v, --version                     Show version
```

## Endpoints

- `GET /` and `GET /healthz`
- `GET /metrics`
- `GET /v1/models`
- `GET /v1/usage`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/completions`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

`/v1/chat/completions` and `/v1/responses` are proxied to the matching Copilot endpoints as directly as possible. `/v1/messages` translates Anthropic Messages requests and responses to Copilot's Responses endpoint. `/v1/messages/count_tokens` returns a local token estimate for Claude Code preflights because Copilot does not expose Anthropic's count-tokens route. `/v1/completions` translates legacy completion requests and responses to the closest chat-completions equivalent. `GET /v1/responses` returns an explicit unsupported-WebSocket response; `codexx` configures Codex to use HTTP Responses instead.

## Development

```sh
bun install
bun run check
```

Useful scripts:

```sh
bun run test
bun run test:coverage
bun run typecheck
bun run build
bun run biome:fix
```

## Release

Commits merged to `main` are evaluated by hooversion after CI passes. When a release is produced, the release workflow creates the release commit, tag, and GitHub release automatically, publishes the package through npm trusted publishing, then cross-compiles standalone binaries for every supported platform with `scripts/build-binaries.sh` and attaches them plus a `SHA256SUMS` manifest to the GitHub release. Build all binaries locally with:

```sh
bun run build:binaries
```

Configure npm trusted publishing for `@openhoo/hoopilot` on npmjs.com before relying on automatic publication. The workflow uses GitHub Actions OIDC with `npm publish --access public --provenance`.

## License

MIT. See [LICENSE](LICENSE).
