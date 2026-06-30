# @openhoo/hoopilot Changelog

## 2.1.10 (2026-06-30)

### Bug Fixes

- polish proxy validation and header handling (db4bf71)

## 2.1.9 (2026-06-30)

### Performance

- default to low resource usage (fa94d52)

## 2.1.8 (2026-06-30)

### Other Changes

- **deps:** update actions/attest digest to a1948c3 (0abc30c)

### Bug Fixes

- beautify terminal logs (eafb9fd)

## 2.1.7 (2026-06-30)

### Other Changes

- document docker compose hosting (7686601)

### Bug Fixes

- address architecture review findings (321bfc1)
- repair docker ci smoke auth fixture (c0e880e)

## 2.1.6 (2026-06-30)

### Bug Fixes

- quiet dashboard usage polling (f12b4fa)

## 2.1.5 (2026-06-30)

### Bug Fixes

- address review findings (3209f5b)

## 2.1.4 (2026-06-30)

### Bug Fixes

- time out stalled Copilot streams (ac75c84)

## 2.1.3 (2026-06-30)

### Bug Fixes

- preserve input cache behavior (174a24c)

## 2.1.2 (2026-06-30)

### Bug Fixes

- handle Codex responses compaction (19d7444)

## 2.1.1 (2026-06-24)

### Bug Fixes

- **codexx:** disable Codex's managed network proxy so requests reach Hoopilot (dd1cdb3)

## 2.1.0 (2026-06-24)

### Features

- **docker:** keyless loopback quick start for compose and docker run (0833d91)

## 2.0.0 (2026-06-24)

### Other Changes

- improve README accuracy, add TOC and requirements (a8c4b1c)
- consolidate shared helpers, tighten types, fix latent bugs (fcc8964)
- **server:** migrate HTTP layer from Bun.serve to Elysia (1058c49)
- **server:** address Elysia review findings (86b1c35)

### Breaking Changes

- adopt Elysia HTTP framework and ESM-only packaging (e58234e)
  - BREAKING: @openhoo/hoopilot is now published ESM-only. The CommonJS

## 1.3.0 (2026-06-24)

### Features

- **dashboard:** serve a self-contained live usage/status dashboard (918261c)

## 1.2.0 (2026-06-23)

### Features

- **metrics:** count token-usage extraction outcomes (a027e8b)

## 1.1.0 (2026-06-23)

### Features

- **metrics:** track GitHub REST API rate-limit usage (f835aec)

## 1.0.0 (2026-06-23)

### Other Changes

- polish README (9a30655)

### Breaking Changes

- **security:** require auth on non-loopback binds and block cross-origin browser access (ce4aafe)
  - BREAKING: the Docker image now refuses to start without a strong, unique

## 0.10.0 (2026-06-23)

### Features

- **cli:** print login token for env piping (9f2123f)

## 0.9.3 (2026-06-23)

### Other Changes

- reduce Docker image size (12d5b8f)

### Bug Fixes

- **docker:** smooth container auth flow (23a8b39)

## 0.9.2 (2026-06-23)

### Other Changes

- **release:** split binary upload and image push into separate jobs (d3e90b1)

### Bug Fixes

- **server:** support codex responses compaction (931f17e)

## 0.9.1 (2026-06-23)

### Bug Fixes

- **release:** publish the GHCR image in its own job (2437bbf)

## 0.9.0 (2026-06-23)

### Features

- **docker:** run hoopilot as a service and publish image to GHCR (b2990a2)

## 0.8.4 (2026-06-23)

### Bug Fixes

- **server:** buffer Windows standalone streams (45b3d04)

## 0.8.3 (2026-06-23)

### Bug Fixes

- **release:** keep binary target list parseable (33f53c4)

## 0.8.2 (2026-06-23)

### Bug Fixes

- **release:** build Windows x64 binary with baseline runtime (01f9900)

## 0.8.1 (2026-06-23)

### Bug Fixes

- **release:** build standalone binaries after npm build (55e7d69)

## 0.8.0 (2026-06-17)

### Bug Fixes

- **server:** expose request ids over cors (1fb989b)
- **server:** reject non-object json requests (e8d113c)
- **auth:** validate github domain overrides (4880372)
- **cli:** honor subcommand version flags (8c45483)

### Features

- **server:** add Claude Code routes (577dc19)

## 0.7.5 (2026-06-17)

### Bug Fixes

- align copilot quota metrics with live api (b88aeb4)

## 0.7.4 (2026-06-17)

### Bug Fixes

- harden legacy completions compatibility (605e0e3)
- reject lossy responses chat conversion (d82aec4)

## 0.7.3 (2026-06-17)

### Bug Fixes

- reject stray cli arguments clearly (df8c2d3)
- bound client request ids (2b23d43)
- honor explicit copilot base urls (bba9834)
- avoid ambient openai key in codexx (c36c193)
- avoid repo-local auth fallback (3507a14)
- bracket ipv6 server urls (1d5cd50)
- surface streamed completion errors (1ae8817)
- cap proxied request bodies (d3cdbe8)
- restrict token upstream hosts (9a54c02)

### Other Changes

- align codexx cli references (7f53230)
- validate release package artifacts (51ae830)
- cover utility hardening helpers (cfcc585)

## 0.7.2 (2026-06-17)

### Bug Fixes

- guard copilot token targets (b4ed6b4)
- block browser-origin proxy abuse (e4d35e3)
- preserve equals in cli options (454c8f0)
- report invalid auth files (a6899b8)
- validate port ranges (9545072)
- convert streamed completions chunks (aafa600)
- align responses stream events (c08f0a1)
- preserve upstream error objects (1ecc72d)
- complete converted response usage (534bc07)
- delegate standalone codexx shims (4aedc0e)
- support api key files (8bd0793)
- satisfy strict review typings (98b4fc4)

### Other Changes

- refresh env and install examples (1d4d9c0)
- skip stale release runs (7882cd4)
- track release hooversion updates (b8866a9)

## 0.7.1 (2026-06-16)

### Bug Fixes

- polish request handling and codexx wrappers (cadc9a1)

## 0.7.0 (2026-06-16)

### Features

- add Copilot credit and token usage metrics (769c05b)

## 0.6.1 (2026-06-16)

### Bug Fixes

- correct streaming item ids and harden proxy I/O (fb27ce3)

## 0.6.0 (2026-06-15)

### Features

- add hoopilot models command (bb613f1)

## 0.5.8 (2026-06-15)

### Bug Fixes

- align copilot oauth login with opencode (26789af)

## 0.5.7 (2026-06-15)

### Bug Fixes

- route codexx gpt-5.5 through responses (b3cd1a2)

## 0.5.6 (2026-06-15)

### Bug Fixes

- fall back from unsupported copilot models (f9d353b)

## 0.5.5 (2026-06-15)

### Bug Fixes

- disable codex websocket probing for codexx (58d8d94)

## 0.5.4 (2026-06-15)

### Bug Fixes

- accept responses path aliases (f16a2e1)

## 0.5.3 (2026-06-15)

### Bug Fixes

- stop locked hoopilot exe during reinstall (5106974)

## 0.5.2 (2026-06-15)

### Bug Fixes

- make windows installer reinstall cleanly (ff108d9)

## 0.5.1 (2026-06-15)

### Bug Fixes

- install codexx standalone wrapper (844c729)

## 0.5.0 (2026-06-15)

### Bug Fixes

- make self-update download write reliable (0a8d1fd)
- exclude codexx cli from coverage (a89ddea)

### Features

- add codexx hoopilot wrapper (e106352)

## 0.4.0 (2026-06-15)

### Features

- use GitHub App OAuth for Copilot login (10b34a4)
- add structured logging (7447514)

## 0.3.1 (2026-06-15)

### Bug Fixes

- harden installer checksum lookup (dcb7118)

## 0.3.0 (2026-06-15)

### Features

- add binary install and self-update (445373e)

## 0.2.4 (2026-06-12)

### Bug Fixes

- remove unsupported PAT auth path (675ed55)

## 0.2.3 (2026-06-12)

### Bug Fixes

- force npm oidc publishing (ee8ee3e)

## 0.2.2 (2026-06-12)

### Bug Fixes

- publish with npm trusted publishing (e8b1415)

## 0.2.1 (2026-06-12)

### Bug Fixes

- gate npm publish until enabled (74100f6)

## 0.2.0 (2026-06-12)

### Features

- add copilot openai proxy (01ae203)

All notable changes to this package will be documented in this file.
