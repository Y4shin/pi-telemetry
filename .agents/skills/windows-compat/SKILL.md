---
name: windows-compat
description: Use when adding, auditing or repairing cross-platform (Windows, win32) support in this repository - porting POSIX-only path, shell, virtualenv, home-directory or argument-quoting assumptions, fixing venv paths such as .venv/bin/python, or building and reading a CI matrix that runs windows-latest next to ubuntu-latest. Covers the pi extension TypeScript, the bundled telemetry-eval Python helper, the instruction text inside the shipped SKILL.md files, npm scripts, tests and release tooling. Do NOT use for general refactoring, performance work, a defect that reproduces identically on every platform, or a release-pipeline change unrelated to platform support.
compatibility: Node >= 24 on Windows, macOS and Linux (node:sqlite and native TypeScript type-stripping need Node 24). Python 3.12+ is required only by the bundled telemetry-eval skills.
---

# Windows compatibility

The target is Windows support with no behaviour change on Linux or macOS.
A change is done when every surface below works on Windows, the POSIX result is
byte-identical, and `npm run check` plus `npm test` are green.

## The rule for shipped instructions

Text inside a shipped `SKILL.md` or its resources is executed by whatever agent
reads it, on whatever OS the user runs. That text must never emit a bare POSIX
interpreter path (`.venv/bin/python`, `.venv/bin/pip`) or bare POSIX-only syntax
(`VAR=value cmd`, `"$VAR"`, `source .venv/bin/activate`) as the only form,
because the reader may be a Windows agent in PowerShell or `cmd.exe` with no
POSIX shell.

Pick the form in this order:

1. **Interpreter-agnostic.** `uv run python scripts/x.py` is identical on every
   platform. Prefer it whenever `uv` is part of the flow.
2. **Platform-branched.** State both forms and the condition that selects one,
   e.g. "`uv run python …` when `uv` is on `PATH`, otherwise `.venv\Scripts\python.exe`
   on Windows and `.venv/bin/python` elsewhere". The branch must be checkable by
   the reader: `uv` on `PATH`, or the existence of `.venv/bin` vs `.venv\Scripts`.
3. **Never** a POSIX-only form standing alone.

The same rule applies to the environment blocks inside those skills: a NixOS or
`LD_LIBRARY_PATH` workaround is Linux-only and must say so, or a Windows agent
will try to apply it.

## Surfaces and how to verify each

| Surface | What couples it to a platform | Verification |
|---|---|---|
| Extension TypeScript (`index.ts`, `src/**`) | Path building and separators, home directory lookup, `resolve()` of user-supplied strings, case-insensitive filesystems | `npm run check`; a unit test that drives the path expansion through `loadConfig` |
| Bundled Python helper (`skills/*/resources/**`) | `os.path` joins, `expanduser`, venv layout, shebang lines | `python -m py_compile` on each changed file (`py -3 -m py_compile` on Windows); a test asserting the same expansion result as the TypeScript side |
| Shipped skill instruction text (`skills/*/SKILL.md`) | Shell syntax, interpreter paths, Linux-only environment blocks | The grep gate below, plus reading each command as if typed in PowerShell |
| npm scripts (`package.json`) | Argument quoting and glob expansion by the invoking shell; missing `engines` | `npm test`, `npm run check`, `npm ci` |
| Tests (`test/**`) | Hardcoded absolute paths, `.` vs `\` inside JSON strings, open handles before directory removal | `npm test`; `grep -rn "/tmp/" test/` returns nothing |
| CI (`.github/workflows/`) | Runner OS, default shell, cache behaviour | The matrix lists both `windows-latest` and `ubuntu-latest`; both jobs green |
| Release tooling (`scripts/release.*`) | POSIX shell, `find`/`sed`/GNU coreutils, `/dev/null` | The guard paths run under `node`; a POSIX-only entry point is documented as such |

## Per-platform forms

| Need | Linux / macOS (sh) | Windows PowerShell | Windows `cmd.exe` |
|---|---|---|---|
| venv interpreter | `.venv/bin/python` | `.venv\Scripts\python.exe` | `.venv\Scripts\python.exe` |
| venv installer | `.venv/bin/pip` | `.venv\Scripts\pip.exe` | `.venv\Scripts\pip.exe` |
| create the venv | `python3 -m venv .venv` | `py -3 -m venv .venv` | `py -3 -m venv .venv` |
| act on the venv | `source .venv/bin/activate` | `.venv\Scripts\Activate.ps1` | `.venv\Scripts\activate.bat` |
| set a variable | `PYTHON=python3.13` | `$env:PYTHON = "C:\Python313\python.exe"` | `set PYTHON=C:\Python313\python.exe` |
| read a variable | `"$PYTHON"` | `"$env:PYTHON"` | `"%PYTHON%"` |
| home directory | `$HOME`, `~/x` | `$env:USERPROFILE`, `~\x` | `%USERPROFILE%`, `~\x` |
| temp directory | `/tmp` | `$env:TEMP` | `%TEMP%` |
| append a library path | `export LD_LIBRARY_PATH=…` | not applicable; Windows resolves DLLs beside the executable or on `PATH` | same |
| interpreter-agnostic | `uv run python x.py` | `uv run python x.py` | `uv run python x.py` |

Windows accepts `/` in most APIs, and `.venv/Scripts/python.exe` usually works in
PowerShell. Still write the `\` form in shipped instructions: the reader should
not need to know which separators survive which shell.

## Procedure

1. **Inventory.** Collect every platform-coupled line before changing one:

   ```bash
   grep -rn "\.venv/bin\|python3 \|LD_LIBRARY_PATH\|/tmp/\|source " skills/ test/ scripts/
   grep -rn "homedir\|HOME\|USERPROFILE\|resolve(" src/ index.ts
   grep -rn "runs-on\|shell:" .github/workflows/
   ```

2. **Classify each hit** as runtime code, shipped instruction, test fixture, or
   tooling/CI. The fix differs per class, and a hit that looks like one class is
   often another (a path in a fixture is a test concern, not a runtime concern).

3. **Fix by class.**
   - Runtime code: build paths with `node:path` (`join`, `resolve`) and expand a
     home-relative prefix with `homedir()`. Nothing in the runtime path may read
     `process.env.HOME`, which is normally unset on Windows.
   - Shipped instruction: apply the interpreter rule above.
   - Test fixture: one exported constant built with `join(tmpdir(), …)`, imported
     by every test that needs it. Never a literal POSIX absolute path.
   - Tooling/CI: Node with the standard library, or an explicitly documented
     POSIX-only entry point. CI gets a matrix, not a single runner.

4. **Prove POSIX is unchanged.** For each behaviour change, add a test that pins
   the existing POSIX result, and name the platform the new branch covers.

5. **Verify each surface** with its row in the table, then run the full gates.

6. **Add a CI matrix job** for `windows-latest` and `ubuntu-latest` that runs
   install, `npm run check` and `npm test`. Do not fold it into the release
   pipeline, whose job graph and privilege split are a release contract.

## Gates

Run from the repository root:

```bash
npm run check
npm test
grep -rn "/tmp/" test/            # expect no output
grep -rn "\.venv/bin/" skills/    # every remaining hit needs a platform branch next to it
```

Sanity-check the Windows semantics of a change without a Windows host:

```bash
node -p "[require('node:path').win32.resolve('/tmp/proj'), require('node:path').win32.join('C:/Users/me','.pi','telemetry.db')].join(' ')"
```

Outer double quotes with inner single quotes is the one shape that survives
`cmd.exe`, PowerShell and a POSIX shell unchanged.

## Gotchas

- `path.resolve("/tmp/proj")` on Windows yields `<drive>:\tmp\proj`, so an
  assertion against the literal string fails even though the code is correct.
- Windows argument parsing treats `"…"` as quoting and `'…'` as ordinary
  characters. A single-quoted glob in an npm script therefore reaches Node with
  the quotes attached and matches nothing. Use double quotes.
- `os.homedir()` / `path.join` are the portable primitives. A user-supplied
  string such as `%USERPROFILE%\x` or `$HOME/x` arrives verbatim from a settings
  file and different shells would expand it differently, so expand only the
  explicit `~/` and `~\` prefixes and leave everything else untouched.
- A Windows venv has no `bin/` directory. `.venv\Scripts\` holds `python.exe` and
  `pip.exe`, and activation differs per shell.
- `node:sqlite` and native `.ts` type-stripping need Node 24. Declare
  `engines.node` so a Windows user on an older Node gets a warning at install
  time instead of a stack trace at runtime.
- Deleting a directory that still holds an open SQLite file fails on Windows with
  `EBUSY`. Close the database first, and pass `maxRetries` when cleanup races a
  closing handle.
- Keep backslash paths inside inline code or fenced blocks. Outside them a
  renderer can treat `\S`-style sequences as escapes.
- Filesystem case-insensitivity and path length limits differ; compare paths that
  were built the same way rather than one built path and one literal.

## Checks that need a real Windows host

The suite under `cmd.exe` and PowerShell, `uv` and venv creation there, and the
release script's push flow cannot be proven from Linux or macOS. Run them in the
CI matrix, or on a Windows machine, before claiming support. Anything unverified
stays an open item in the report, not an assumption.
