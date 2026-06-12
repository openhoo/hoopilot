# hoopilot

[![npm version](https://img.shields.io/npm/v/%40openhoo%2Fhoopilot?label=npm)](https://www.npmjs.com/package/@openhoo/hoopilot)
[![CI](https://github.com/openhoo/hoopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/openhoo/hoopilot/actions/workflows/ci.yml)

OpenAI-compatible local proxy for GitHub Copilot accounts. It runs on Bun and exposes `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, and `/v1/models` for clients that can point at a custom OpenAI base URL.

This project uses GitHub Copilot's service endpoints and is not an official GitHub product. The upstream API can change without notice. Use it only with accounts and usage patterns you are allowed to use.

## Run

```sh
npx @openhoo/hoopilot
```

Before the npm package is published, run the same binary directly from GitHub:

```sh
npx github:openhoo/hoopilot
```

By default Hoopilot listens on `127.0.0.1:4141`, reads a GitHub token from `COPILOT_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`, and exchanges it for a Copilot API token when GitHub supports the exchange endpoint for the account.

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

You can also [create a fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for the GitHub account that has Copilot access. GitHub's [personal access token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) explains how fine-grained tokens and permissions work.

```sh
COPILOT_GITHUB_TOKEN=github_pat_... HOOPILOT_API_KEY=local-key npx @openhoo/hoopilot
```

Supported credential environment variables:

- `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN`: GitHub OAuth token for an account with Copilot access.
- `COPILOT_API_TOKEN`, `GITHUB_COPILOT_API_TOKEN`, or `GITHUB_COPILOT_TOKEN`: short-lived Copilot API bearer token.
- `COPILOT_API_BASE_URL`: upstream Copilot API base URL override.
- `COPILOT_TOKEN_EXCHANGE_URL`: GitHub token exchange endpoint override.

Auth modes:

```sh
npx @openhoo/hoopilot --auth-mode auto
npx @openhoo/hoopilot --auth-mode github-token
npx @openhoo/hoopilot --auth-mode direct-github-token
npx @openhoo/hoopilot --auth-mode copilot-token
```

`auto` first tries the GitHub Copilot token exchange endpoint, then falls back to direct GitHub-token mode against the individual Copilot API base URL. Use `github-token` when you want exchange failures to fail fast.

## CLI

```sh
hoopilot [serve] [options]
```

Options:

```txt
-p, --port <port>                 Port to listen on. Default: 4141
    --host <host>                 Host to listen on. Default: 127.0.0.1
    --api-key <key>               Require clients to send Authorization: Bearer <key>
    --auth-mode <mode>            auto, github-token, direct-github-token, copilot-token
    --github-token <token>        GitHub OAuth token for a Copilot account
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

Commits merged to `main` are evaluated by hooversion after CI passes. When a release is produced, the release workflow creates the release commit, tag, and GitHub release automatically, then publishes the package through npm trusted publishing.

Configure npm trusted publishing for `@openhoo/hoopilot` on npmjs.com, then set the GitHub repository variable `NPM_PUBLISH_ENABLED=true` before relying on automatic npm publication. Release commits and GitHub releases can still be created before npm publication is enabled.

## License

MIT. See [LICENSE](LICENSE).
