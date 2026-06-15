# hoopilot

[![npm version](https://img.shields.io/npm/v/%40openhoo%2Fhoopilot?label=npm)](https://www.npmjs.com/package/@openhoo/hoopilot)
[![CI](https://github.com/openhoo/hoopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/openhoo/hoopilot/actions/workflows/ci.yml)

OpenAI-compatible local proxy for GitHub Copilot accounts. It runs on Bun and exposes `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, and `/v1/models` for clients that can point at a custom OpenAI base URL.

This project uses GitHub Copilot's service endpoints and is not an official GitHub product. The upstream API can change without notice. Use it only with accounts and usage patterns you are allowed to use.

## Install

### npm (recommended when the registry is reachable)

```sh
npx @openhoo/hoopilot
```

Or install it globally:

```sh
npm install -g @openhoo/hoopilot
# or
bun add -g @openhoo/hoopilot
```

### Standalone binary (no npm, no runtime required)

When the npm registry is unreachable but GitHub is, install a prebuilt,
self-contained binary straight from the latest GitHub release. No Node.js or Bun
is needed to run it.

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.ps1 | iex
```

The installer detects your OS, CPU architecture (x64/arm64), and libc (glibc or
musl), downloads the matching binary, verifies its SHA-256 checksum, and installs
it to `~/.local/bin` (Linux/macOS) or `%LOCALAPPDATA%\Programs\hoopilot`
(Windows). Override the location with `HOOPILOT_INSTALL_DIR`, or pin a version:

```sh
curl -fsSL .../install.sh | sh -s -- --version 0.2.5 --dir ~/bin
```

```powershell
& ([scriptblock]::Create((irm .../install.ps1))) -Version 0.2.5
```

Prebuilt binaries are available for Linux (x64/arm64, glibc and musl), macOS
(Intel/Apple Silicon), and Windows (x64/arm64).

## Update

Standalone binaries update themselves in place from the latest GitHub release
(checksum-verified):

```sh
hoopilot update
```

npm installs report when a newer version is available and print the right command
(`npm install -g @openhoo/hoopilot@latest`). Either way, Hoopilot checks GitHub at
most once a day in the background and prints a one-line notice to stderr when an
update exists. Disable the check with `--no-update-check`, or by setting
`HOOPILOT_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER`; it is also skipped in CI and
when output is not a terminal.

## Run

```sh
npx @openhoo/hoopilot
```

By default Hoopilot listens on `127.0.0.1:4141`, uses `COPILOT_API_TOKEN` when provided, otherwise reads a GitHub CLI OAuth token from `COPILOT_GITHUB_TOKEN` or `gh auth token`, and uses that token with Copilot.

For a local API key:

```sh
HOOPILOT_API_KEY=local-key npx @openhoo/hoopilot --port 4141
```

Point OpenAI-compatible clients at:

```sh
OPENAI_BASE_URL=http://127.0.0.1:4141/v1
OPENAI_API_KEY=local-key
```

Use with Codex CLI after Hoopilot is running:

```sh
OPENAI_API_KEY=local-key codex -m claude-sonnet-4.6 -c 'openai_base_url="http://127.0.0.1:4141/v1"'
```

```powershell
$env:OPENAI_API_KEY="local-key"; codex -m claude-sonnet-4.6 -c 'openai_base_url="http://127.0.0.1:4141/v1"'
```

If no `HOOPILOT_API_KEY` is configured, Hoopilot accepts local requests without client authentication. Binding to a non-loopback host requires `HOOPILOT_API_KEY` unless `--allow-unauthenticated` is set.

## Authentication

Preferred options:

```sh
gh auth login
npx @openhoo/hoopilot
```

or:

```sh
COPILOT_GITHUB_TOKEN=$(gh auth token) npx @openhoo/hoopilot
```

Personal access tokens are not supported by GitHub Copilot's token exchange or chat endpoints. Hoopilot rejects classic and fine-grained PAT prefixes. Use `gh auth token` for the GitHub CLI OAuth path, or pass a short-lived Copilot bearer token with `COPILOT_API_TOKEN`.

Supported credential environment variables:

- `COPILOT_GITHUB_TOKEN` or `GITHUB_COPILOT_GITHUB_TOKEN`: GitHub CLI OAuth token for an account with Copilot access. Personal access tokens are rejected.
- `COPILOT_API_TOKEN`, `GITHUB_COPILOT_API_TOKEN`, or `GITHUB_COPILOT_TOKEN`: short-lived Copilot API bearer token.
- `COPILOT_API_BASE_URL`: upstream Copilot API base URL override.
- `COPILOT_TOKEN_EXCHANGE_URL`: GitHub token exchange endpoint override.

Auth modes:

```sh
npx @openhoo/hoopilot --auth-mode auto
npx @openhoo/hoopilot --auth-mode copilot-token
```

`auto` uses a direct Copilot token when one is configured, otherwise it uses GitHub's Copilot token exchange endpoint and falls back to the GitHub CLI OAuth token when the exchange endpoint is unavailable.

## CLI

```sh
hoopilot [serve] [options]
```

Options:

```txt
-p, --port <port>                 Port to listen on. Default: 4141
    --host <host>                 Host to listen on. Default: 127.0.0.1
    --api-key <key>               Require clients to send Authorization: Bearer <key>
    --auth-mode <mode>            auto, copilot-token
    --github-token <token>        GitHub CLI OAuth token for a Copilot account. PATs are rejected.
    --github-token-command <cmd>  Command used to read a GitHub token. Default: gh auth token
    --copilot-token <token>       Short-lived Copilot API bearer token
    --copilot-api-base-url <url>  Copilot API base URL override
    --no-gh                       Do not try gh auth token
    --allow-unauthenticated       Allow non-loopback bind without --api-key
```

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/completions`

`/v1/chat/completions` is proxied to Copilot as directly as possible. `/v1/responses` and `/v1/completions` translate requests and responses to the closest chat completions equivalent, including basic function-tool calls.

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

Commits merged to `main` are evaluated by hooversion after CI passes. When a release is produced, the release workflow creates the release commit, tag, and GitHub release automatically, publishes the package through npm trusted publishing, then cross-compiles standalone binaries for every supported platform (`scripts/build-binaries.sh`) and attaches them — plus a `SHA256SUMS` manifest — to the GitHub release. Build all binaries locally with `bun run build:binaries`.

Configure npm trusted publishing for `@openhoo/hoopilot` on npmjs.com before relying on automatic publication. The workflow uses GitHub Actions OIDC with `npm publish --access public --provenance`.

## License

MIT. See [LICENSE](LICENSE).
