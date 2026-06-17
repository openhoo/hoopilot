# hoopilot

[![npm version](https://img.shields.io/npm/v/%40openhoo%2Fhoopilot?label=npm)](https://www.npmjs.com/package/@openhoo/hoopilot)
[![CI](https://github.com/openhoo/hoopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/openhoo/hoopilot/actions/workflows/ci.yml)

OpenAI-compatible local proxy for GitHub Copilot accounts. It runs on Bun and exposes `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, and `/v1/models` for clients that can point at a custom OpenAI base URL.

This project uses GitHub Copilot's service endpoints and is not an official GitHub product. The upstream API can change without notice. Use it only with accounts and usage patterns you are allowed to use.

## Install

### npm

```powershell
npx @openhoo/hoopilot
```

Or install it globally:

```powershell
npm install -g @openhoo/hoopilot
bun add -g @openhoo/hoopilot
```

### Standalone Binary

When the npm registry is unreachable but GitHub is reachable, install a prebuilt self-contained binary from the latest GitHub release. No Node.js or Bun runtime is needed to run it.

Linux / macOS from PowerShell:

```powershell
curl -fsSL https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.ps1 | iex
```

The installer detects your OS, CPU architecture, and libc, downloads the matching binary, verifies its SHA-256 checksum, and installs it to `~/.local/bin` on Linux/macOS or `%LOCALAPPDATA%\Programs\hoopilot` on Windows. Override the location with `HOOPILOT_INSTALL_DIR`, or pin a version:

```powershell
curl -fsSL https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.sh | sh -s -- --version <version> --dir ~/bin
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.ps1))) -Version <version>
```

The standalone installer also installs a `codexx` wrapper next to `hoopilot`. Re-run the installer if `hoopilot` works but your shell does not recognize `codexx`; the installer stops the installed `hoopilot.exe` if needed and replaces the existing files in place.

## Update

Standalone binaries update themselves in place from the latest GitHub release:

```powershell
hoopilot update
```

npm installs report when a newer version is available and print the right command. Hoopilot checks GitHub at most once a day in the background. Disable the check with `--no-update-check`, `HOOPILOT_NO_UPDATE_CHECK`, or `NO_UPDATE_NOTIFIER`.

## Run

First sign in with GitHub Copilot OAuth in your browser:

```powershell
npx @openhoo/hoopilot login
```

The login command prints a one-time code, opens `https://github.com/login/device` best-effort, verifies that the returned OAuth token can reach the Copilot API, and stores it in Hoopilot's auth file. Re-run `npx @openhoo/hoopilot login` after upgrading Hoopilot if Copilot reports a supported model as unavailable; older stored tokens can have a reduced model set.

Then start the proxy:

```powershell
npx @openhoo/hoopilot
```

By default Hoopilot listens on `127.0.0.1:4141` and reads the stored OAuth credential from:

- Linux/macOS: `$HOME/.config/hoopilot/auth.json`
- Windows: `$env:APPDATA\hoopilot\auth.json`

Override the path with `HOOPILOT_AUTH_FILE` or `--auth-file`.

For a local API key:

```powershell
$env:HOOPILOT_API_KEY = "local-key"
npx @openhoo/hoopilot --port 4141
```

Point OpenAI-compatible clients at:

```powershell
$env:OPENAI_BASE_URL = "http://127.0.0.1:4141/v1"
$env:OPENAI_API_KEY = "local-key"
```

Use with Codex CLI after Hoopilot is running, via the bundled `codexx` command. It runs Codex against the local server with the right model provider — selecting `gpt-5.5` over Copilot's Responses API, which a plain `openai_base_url` override does not configure (see the note below):

```powershell
$env:HOOPILOT_API_KEY = "local-key"
codexx
```

Without a global install, run it through npm:

```powershell
$env:HOOPILOT_API_KEY = "local-key"
npx --package @openhoo/hoopilot codexx
```

`codexx` does not start Hoopilot and does not change your shell environment. It runs
`codex` with a temporary `hoopilot` model provider pointed at
`http://127.0.0.1:4141/v1`, disables Codex Responses WebSockets for that provider,
maps `HOOPILOT_API_KEY` to `OPENAI_API_KEY` for that child process, passes
`--disable network_proxy` to Codex, and removes standard proxy variables from the
spawned Codex process so Codex talks directly to the local server. Override the local
URL with `CODEXX_BASE_URL`, the local key with `CODEXX_API_KEY`, or the Codex
executable with `CODEXX_CODEX_BIN`, the model with `CODEXX_MODEL`, or the reasoning
effort with `CODEXX_MODEL_REASONING_EFFORT`.

`codexx` defaults to `gpt-5.5` with `model_reasoning_effort="xhigh"`. Codex sends
those requests through its Responses API provider, and Hoopilot forwards them to
Copilot's Responses endpoint because `gpt-5.5` is not available through Copilot's
chat-completions endpoint. Before starting Codex, `codexx` checks
`http://127.0.0.1:4141/v1/models` and reports if the logged-in Copilot account does
not advertise the requested model. Set `CODEXX_MODEL` to one of the listed models,
or log in with a Copilot account that has `gpt-5.5`.

If no `HOOPILOT_API_KEY` is configured, Hoopilot accepts local requests without client authentication. Binding to a non-loopback host requires `HOOPILOT_API_KEY` unless `--allow-unauthenticated` is set.

## Logging

Hoopilot uses Pino for structured logs. Server startup, request completion, upstream Copilot failures, model-list fallback, auth failures, and update-check diagnostics are logged with stable event names and request IDs. Logs never include request bodies, prompt text, completions, stream chunks, OAuth tokens, API keys, authorization headers, cookies, or auth-file contents.

Console logs default to pretty output at `info` level:

```powershell
npx @openhoo/hoopilot --log-level info --log-format pretty
```

For machine-readable newline-delimited JSON:

```powershell
npx @openhoo/hoopilot --log-level info --log-format json
```

Equivalent environment variables:

- `HOOPILOT_LOG_LEVEL`: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`. Default: `info`.
- `HOOPILOT_LOG_FORMAT`: `json` or `pretty`. Default: `pretty`.

Incoming `x-request-id` headers are preserved on responses. If a request has no ID, Hoopilot generates one and returns it as `x-request-id`.

## Metrics and usage

Hoopilot tracks token usage, request counts, and latency in memory while the server runs, and can report your GitHub Copilot account quota (premium-request "credit" usage).

- `GET /metrics` returns Prometheus text (`text/plain; version=0.0.4`). It exposes request counters (`hoopilot_requests_total`), upstream call counters (`hoopilot_upstream_requests_total`), token counters by model and type (`hoopilot_tokens_total{model,type}`), a request-duration histogram (`hoopilot_request_duration_seconds`), an in-flight gauge, and—once `/v1/usage` has been fetched at least once—Copilot quota gauges (`hoopilot_copilot_quota_remaining{category}`, `_entitlement`, `_used`, `_percent_remaining`). Counters reset to zero on restart, which Prometheus handles natively.
- `GET /v1/usage` returns JSON combining the proxy metrics snapshot with live Copilot quota fetched from GitHub (cached for 60 seconds). If the quota cannot be read, `copilot` is `null` and `copilot_error` explains why, but the proxy metrics are still returned.
- `hoopilot usage` prints your Copilot plan and quota from the command line.

Token usage is read from the upstream `usage` object. For streaming chat completions, usage is only available when the client sends `stream_options: {"include_usage": true}`; Hoopilot never injects it, so streamed chat requests without that flag contribute request and latency metrics but not token counts. The Responses API always reports usage, so streamed Responses requests are fully accounted.

`/metrics` and `/v1/usage` are subject to the same `HOOPILOT_API_KEY` gate as the other routes.

## Authentication

Hoopilot supports one credential flow: GitHub Copilot OAuth browser login.

```powershell
npx @openhoo/hoopilot login
npx @openhoo/hoopilot
```

Direct bearer tokens, GitHub CLI token fallback, classic GitHub PATs, and fine-grained GitHub PATs are not supported.

Supported authentication-related settings:

- `HOOPILOT_AUTH_FILE`: OAuth credential store path.
- `HOOPILOT_GITHUB_CLIENT_ID`: GitHub OAuth app client ID override. The default uses the same GitHub Copilot OAuth app as opencode's Copilot provider.
- `HOOPILOT_GITHUB_DOMAIN`: GitHub domain override. Default: `github.com`.
- `COPILOT_API_BASE_URL`: upstream Copilot API base URL override. Default: `https://api.githubcopilot.com`.
- `HOOPILOT_GITHUB_API_BASE_URL`: GitHub REST API base URL used for the Copilot quota lookup. Default: `https://api.github.com`.

## Codex Auth Errors

Hoopilot does not return raw `403` responses to Codex for authentication or Copilot-entitlement failures. Local Hoopilot API-key problems return `401 invalid_api_key`; OAuth credential and upstream Copilot auth failures return `401 copilot_auth_error`.

In PowerShell, verify the browser login and local proxy before retrying Codex:

```powershell
npx @openhoo/hoopilot login
$env:HOOPILOT_API_KEY = "local-key"
npx @openhoo/hoopilot --port 4141
```

Then, in another PowerShell session:

```powershell
$env:OPENAI_API_KEY = "local-key"
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:OPENAI_API_KEY" } `
  http://127.0.0.1:4141/v1/models
codexx
```

If that returns `401 copilot_auth_error`, rerun `npx @openhoo/hoopilot login` and confirm the GitHub account has active Copilot access.

## CLI

```powershell
hoopilot [serve] [options]
hoopilot login [options]
hoopilot models [options]
hoopilot usage [options]
```

Commands:

```txt
serve                             Start the proxy server (default)
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
    --log-level <level>           trace, debug, info, warn, error, fatal, or silent
    --log-format <format>         json or pretty. Default: pretty
    --no-update-check             Do not check GitHub for a newer release
    --allow-unauthenticated       Allow non-loopback bind without --api-key
```

## Endpoints

- `GET /healthz`
- `GET /metrics`
- `GET /v1/models`
- `GET /v1/usage`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/completions`

`/v1/chat/completions` and `/v1/responses` are proxied to the matching Copilot endpoints as directly as possible. `/v1/completions` translates legacy completion requests and responses to the closest chat completions equivalent. `GET /metrics` and `GET /v1/usage` report proxy metrics and Copilot quota (see [Metrics and usage](#metrics-and-usage)).

## Development

```powershell
bun install
bun run check
```

Useful scripts:

```powershell
bun run test
bun run test:coverage
bun run typecheck
bun run build
bun run biome:fix
```

## Release

Commits merged to `main` are evaluated by hooversion after CI passes. When a release is produced, the release workflow creates the release commit, tag, and GitHub release automatically, publishes the package through npm trusted publishing, then cross-compiles standalone binaries for every supported platform (`scripts/build-binaries.sh`) and attaches them plus a `SHA256SUMS` manifest to the GitHub release. Build all binaries locally with `bun run build:binaries`.

Configure npm trusted publishing for `@openhoo/hoopilot` on npmjs.com before relying on automatic publication. The workflow uses GitHub Actions OIDC with `npm publish --access public --provenance`.

## License

MIT. See [LICENSE](LICENSE).
