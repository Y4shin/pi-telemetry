# @y4shin/pi-telemetry

Local-first observability for [Pi](https://github.com/earendil-works/pi-coding-agent).
The extension records sessions, runs, turns, LLM requests, tool executions,
skill invocations and feedback into a local SQLite database at
`~/.pi/telemetry.db`, and exposes the data through `/tm` commands and a
`query_telemetry` tool. Nothing leaves the machine.

## Requirements

- Pi with extension support.
- Node.js 24 or newer. The extension uses `node:sqlite` and the test suite runs
  TypeScript through Node's native type-stripping; `package.json` declares
  `engines.node >= 24`.
- Python 3.12+ only if you use the bundled `telemetry-eval-*` skills.

## Install

```bash
pi install npm:@y4shin/pi-telemetry
```

Restart Pi, then check that capture is working:

```bash
/tm status
```

## What it records

The database is documented in [`SPEC.md`](./SPEC.md). In short: one row per
session, agent run, turn, LLM request, tool execution, skill invocation and
lifecycle event, plus a `telemetry_meta` table for write failures and warnings.
Prompt, tool-argument and tool-result content is **off** by default; the
content flags opt in and print a warning when enabled.

Query it three ways:

```bash
/tm session            # current session summary
/tm cost [today|week|all]
/tm sql "SELECT ..."   # guarded read-only SQL
```

or ask Pi to call the `query_telemetry` tool, which offers named presets
(`session_cost`, `daily_cost`, `tool_failures`, `feedback`, `ttft_by_model`,
`context_growth`, `agent_tree`, `skill_cost`, `skill_versions`,
`retry_count`) before raw read-only SQL.

## Bundled skills

Two skills are shipped with the package and installed next to it:

- **`telemetry-eval-setup`** builds a Python analysis project at
  `~/.pi/telemetry-eval/` (uv when available, otherwise a `.venv`), containing
  the `telemetry_eval` package with read-only `connect()`, `duck()` and
  `scratch()` helpers.
- **`telemetry-eval-analyze`** writes read-only pandas/DuckDB eval scripts
  against `~/.pi/telemetry.db` using those helpers and a schema primer.

The environment contract is fixed: the project lives at
`~/.pi/telemetry-eval/`, its helpers never write to the live database, and
derived data goes to a separate scratch file there. Both skills are
platform-branched: `uv run python …` works everywhere, and the venv
interpreter is `.venv/bin/python` on Linux/macOS, `.venv\Scripts\python.exe` on
Windows.

## Configuration

Settings live under the `pi-telemetry` key in `.pi/settings.json` (project) or
`~/.pi/agent/settings.json` (global). Environment variables override them.

| Key | Env var | Default |
|---|---|---|
| `enabled` | `PI_TELEMETRY_ENABLED` | `true` |
| `dbPath` | `PI_TELEMETRY_DB_PATH` | `~/.pi/telemetry.db` |
| `bufferFlushMs` | `PI_TELEMETRY_BUFFER_FLUSH_MS` | `2000` |
| `bufferMaxRows` | `PI_TELEMETRY_BUFFER_MAX_ROWS` | `50` |
| `feedbackMaxBytes` | `PI_TELEMETRY_FEEDBACK_MAX_BYTES` | `65536` |
| `capture.toolArgs` | `PI_TELEMETRY_CAPTURE_TOOL_ARGS` | `false` |
| `capture.toolResults` | `PI_TELEMETRY_CAPTURE_TOOL_RESULTS` | `false` |
| `capture.toolErrorRaw` | `PI_TELEMETRY_CAPTURE_TOOL_ERROR_RAW` | `false` |

A `dbPath` that starts with `~/` or `~\` is expanded against the user's home
directory, so `~\telemetry.db` works on Windows and `~/.pi/telemetry.db`
everywhere. Other shell syntax is **not** expanded: `%USERPROFILE%\telemetry.db`
and `$HOME/telemetry.db` are taken literally, because the file records text and
the shell that wrote it is unknown. Write the absolute path or the tilde form.

## Supported platforms

Linux, macOS and Windows. CI runs `npm run check` and `npm test` on
`ubuntu-latest` and `windows-latest` (`.github/workflows/ci.yml`), and the
release pipeline packs and stages the published artifact on `ubuntu-latest`.

Windows notes:

- The bundled eval skills print per-platform commands. A Windows virtual
  environment keeps its interpreter in `.venv\Scripts\python.exe` and its
  installer in `.venv\Scripts\pip.exe`; there is no `bin/` directory. Activation
  is `.venv\Scripts\Activate.ps1` in PowerShell or
  `.venv\Scripts\activate.bat` in `cmd.exe`.
- `cmd.exe` does not expand `~`, so `cd %USERPROFILE%\.pi\telemetry-eval`
  replaces `cd ~/.pi/telemetry-eval` there. PowerShell accepts the tilde.
- `py -3 -m venv .venv` is the Windows venv creation command when `uv` is
  absent.
- The NixOS `LD_LIBRARY_PATH` advice in the eval skills is Linux-only; Windows
  resolves native libraries itself, so there is nothing to set.
- `npm test` quotes its glob with double quotes so `cmd.exe` passes the pattern
  through unmodified.

## Development

```bash
npm ci
npm run check    # tsc --noEmit
npm test         # node --test "test/**/*.test.ts"
```

The suite needs Node 24 and uses only Node built-ins (`node:test`,
`node:sqlite`). Fixtures build temporary paths with
`join(tmpdir(), …)` rather than hardcoding `/tmp`, so the same assertions hold
on Windows. See [`docs/testing.md`](./docs/testing.md) for the harness
conventions.

## Release

Versions are cut with [changesets](https://github.com/changesets/changesets).
Add a `.changeset/*.md` entry in the pull request, then:

```bash
npm run version          # apply the changesets: bump package.json, write CHANGELOG.md
npm run release -- --yes # commit, tag, push; CI verifies and stages on npm
```

`npm run release` runs on Linux, macOS and Windows (Node standard library only).
`./scripts/release.sh` remains as a POSIX wrapper around the same script. Pushing
the `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which verifies the
tag against `package.json`, packs the tarball and **stages** it; a maintainer
approves it with 2FA before it reaches the registry.

## License

MIT
