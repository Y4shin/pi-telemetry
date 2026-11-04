---
"@y4shin/pi-telemetry": minor
---

Windows support.

- `dbPath` accepts a `~\` home prefix in addition to `~/`, resolved through
  `homedir()`. POSIX behaviour is unchanged; `%USERPROFILE%` and `$HOME` are
  still left verbatim because a settings file records text, not a shell.
- The bundled `telemetry-eval-setup` and `telemetry-eval-analyze` skills now
  give per-platform commands: `.venv\Scripts\python.exe` and
  `.venv\Scripts\pip.exe` on Windows, `.venv/bin/python` and `.venv/bin/pip`
  elsewhere, plus `py -3 -m venv .venv` and `$env:PYTHON` for Windows. Their
  NixOS `LD_LIBRARY_PATH` advice is now scoped to Linux.
- `npm test` quotes its glob with double quotes, so it also runs under
  `cmd.exe`, and `package.json` declares `engines.node >= 24`.
- The test suite builds fixture paths from `tmpdir()` instead of hardcoded
  `/tmp` paths, and the concurrent first-start test waits for its worker
  processes to exit instead of racing the assertion.
- Tests cover the new behaviour: the path expansion is asserted on both
  platforms, with OS-gated blocks that run in the matching CI job, and new
  guard tests fail if a shipped skill loses its Windows command form, if
  Linux-only advice loses its Linux scope, if the test glob loses its double
  quotes, or if `engines.node` or the CI matrix disappears.
- New CI workflow runs typecheck and tests on `windows-latest` and
  `ubuntu-latest`.
- `README.md` documents install, the bundled skills, supported platforms and
  the Windows caveats.
- The release helper is now `scripts/release.mjs` (Node standard library,
  runs on Linux, macOS and Windows); `scripts/release.sh` is a POSIX wrapper.
