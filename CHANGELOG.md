# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Ollama Cloud (`ollama-cloud`) view backed by `GET https://ollama.com/api/balance`: included monthly credits with purchased credits merged into the dollar row on credit plans, legacy 5h/1w percentage limits otherwise, reset countdowns from the API, and ⚠ when ≤10% remains. Auth reuses the OpenCode-stored `ollama-cloud` key or `OLLAMA_API_KEY`.
- Behaviour-level coverage for `providerUsage` accumulated totals across multiple sessions and tolerant message lists.

### Fixed

- The sidebar footer no longer renders blank when the only configured provider is Ollama Cloud.

## [1.0.0-alpha.6] - 2026-09-27

### Changed

- Widened the `@opencode/plugin` range from `^2.0.15` to `^2.0.3`, matching
  what the plugin actually supports. Verified by typecheck and runtime import
  against 2.0.3, 2.0.10 and 2.0.18. **2.0.3 is the floor**: earlier 2.x
  releases ship no `./tui` subpath export, so the TUI entrypoint cannot
  resolve `@opencode/plugin/tui`.

### Added

- A runtime host-compat probe in CI: packs the real tarball, installs it into a
  clean project, and imports both entrypoints under Bun. Typecheck cannot catch
  a peer-only runtime dependency, because the dev tree always resolves it.

## [1.0.0-alpha.5] - 2026-09-27

### Changed

- Widened the `@opencode/plugin` dependency from an exact `2.0.15` pin to
  `^2.0.15`. The exact pin forced a second nested copy of the host package
  whenever the runtime was on a different patch, and `Plugin.define` identity
  could diverge from the runtime's own. The range means the host the runtime
  provides is the one that gets used.
- Aligned the `@opentui/*` peer ranges with the other plugins (`^0.5.10` →
  `^0.5.11`).
- `solid-js` moved from a peer to a dependency: the kit's barrel export pulls in
  its signal primitives, so a peer-only declaration left it uninstalled.

## [1.0.0-alpha.4] - 2026-09-27

### Breaking

- Requires an OpenCode v2 host. The TUI/context types moved from the legacy
  `@opencode-ai/plugin` package to `@opencode/plugin@2.0.15`, so this plugin
  no longer loads on a v1 runtime.

### Changed

- Sidebar rendering and keymap wiring use the v2 `ui.slot` / `keymap.layer`
  contract.

### Fixed

- API keys are read from OpenCode 2's SQLite `credential` table via
  `opencode-plugin-kit@^1.0.0-alpha.6`. v2 no longer keeps them in
  `auth.json`, so on a v2 host the footer previously reported no connected
  providers and rendered empty. Covered by a cold-start regression test.

## [0.1.0] - 2026-09-08

### Added

- Sidebar footer showing live provider quota and usage
- Per-provider usage tracking (Go plan quota + Zen free-tier breakdown)
- View picker with provider-key gating and session-following auto-pick
- Polling fetcher with multi-key fallback, degrading to the last-known-good cache on parse failure

[Unreleased]: https://github.com/ranjithraj/opencode-usage-quota-tracker/compare/v1.0.0-alpha.6...HEAD
[0.1.0]: https://github.com/ranjithraj/opencode-usage-quota-tracker/releases/tag/v0.1.0
[1.0.0-alpha.4]: https://github.com/ranjithraj/opencode-usage-quota-tracker/releases/tag/v1.0.0-alpha.4
[1.0.0-alpha.5]: https://github.com/ranjithraj/opencode-usage-quota-tracker/releases/tag/v1.0.0-alpha.5
[1.0.0-alpha.6]: https://github.com/ranjithraj/opencode-usage-quota-tracker/releases/tag/v1.0.0-alpha.6
