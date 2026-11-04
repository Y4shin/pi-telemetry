---
name: telemetry-eval-setup
description: Bootstrap ~/.pi/telemetry-eval/ with telemetry_eval helpers and data-analysis dependencies.
---

# telemetry-eval-setup

Create or repair the Python analysis environment at `~/.pi/telemetry-eval/`.
This project contains the `telemetry_eval` package with read-only helpers
(`connect()`, `duck()`, `scratch()`) for analyzing the pi-telemetry SQLite
database.

Works on Linux, macOS and Windows. Commands that start with `uv` are identical
on every platform. Commands that touch the virtual environment directly are
given in both forms:

- Linux / macOS: `.venv/bin/python`, `.venv/bin/pip`
- Windows: `.venv\Scripts\python.exe`, `.venv\Scripts\pip.exe`

`cd ~/.pi/telemetry-eval` works in `bash`, `zsh` and PowerShell. In `cmd.exe`
use `cd %USERPROFILE%\.pi\telemetry-eval`, because `cmd.exe` does not expand `~`.

## Idempotency

1. If `~/.pi/telemetry-eval/` already exists **and is healthy** (it has
   `pyproject.toml` **or** `requirements.txt`, **and** a `telemetry_eval/`
   directory), only refresh dependencies and stop. Do **not** recreate the
   directory, and do **not** overwrite any user scripts.

   - If `uv` is on `PATH` and `pyproject.toml` exists, run:
     ```bash
     cd ~/.pi/telemetry-eval && uv sync
     ```
   - Otherwise, if `requirements.txt` exists, install into the venv.

     Linux / macOS:
     ```bash
     cd ~/.pi/telemetry-eval && .venv/bin/pip install -r requirements.txt
     ```

     Windows (`cmd.exe` or PowerShell):
     ```
     cd %USERPROFILE%\.pi\telemetry-eval
     .venv\Scripts\pip.exe install -r requirements.txt
     ```

2. If `~/.pi/telemetry-eval/` exists but is **broken** (missing the
   `telemetry_eval/` package directory), repair it by re-templating **only**
   the package files (`telemetry_eval/__init__.py`). Do not overwrite user
   scripts or `pyproject.toml`/`requirements.txt` if they already exist.

3. Otherwise, create `~/.pi/telemetry-eval/` and populate it verbatim from
   the resource templates below.

## Resource templates

Copy the following resource files into `~/.pi/telemetry-eval/`, preserving
relative paths exactly:

```
follow resource "resources/pyproject.toml"
→ ~/.pi/telemetry-eval/pyproject.toml

follow resource "resources/requirements.txt"
→ ~/.pi/telemetry-eval/requirements.txt

follow resource "resources/telemetry_eval/__init__.py"
→ ~/.pi/telemetry-eval/telemetry_eval/__init__.py

follow resource "resources/scripts/smoke_test.py"
→ ~/.pi/telemetry-eval/scripts/smoke_test.py
```

## Environment setup

Create a Python virtual environment inside `~/.pi/telemetry-eval/`. Choose the
interpreter safely, and pick the branch that matches the host platform.

### 1. Detect NixOS (Linux only)

NixOS is a Linux distribution. Sections 1, 2 and the `LD_LIBRARY_PATH`
workaround further down apply to Linux hosts only; skip them on macOS and
Windows.

```bash
if test -f /etc/NIXOS || [ -n "$NIX_OS" ]; then
  # NixOS path
  IS_NIXOS=1
else
  IS_NIXOS=0
fi
```

### 2. NixOS with `uv` (Linux only)

On NixOS, **never** run `uv python install` (downloaded
python-build-standalone binaries do not run on NixOS because there is no FHS
`ld-linux`). Instead, use a stable system interpreter:

```bash
cd ~/.pi/telemetry-eval
PYTHON="$(command -v python3.13 || command -v python3.12 || command -v python3)"
```

Gate on a **stable** interpreter. If the only available interpreter is a
beta/unstable version (for example, `3.15.0b4`), stop and tell the user to
install a stable Python, e.g.:

```bash
nix profile install nixpkgs#python313
# or
nix-shell -p python313
```

Do **not** proceed with a beta interpreter.

If a stable interpreter is found, create the venv and sync dependencies:

```bash
uv venv --python "$PYTHON"
uv sync
```

If `uv sync` fails because `uv.lock` is missing, generate one first with
`uv lock` (or use `uv pip install -r requirements.txt`).

On some NixOS configurations the compiled wheels (numpy, pandas, duckdb,
etc.) cannot find `libstdc++.so.6` or `libz.so.1` because the venv python
loses the system library search path. If imports fail with a missing shared
library, set `LD_LIBRARY_PATH` to the nix-ld compatibility directory before
running scripts. This step is NixOS-specific; on macOS and Windows the dynamic
loader resolves those libraries itself, so there is nothing to set:

```bash
export LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH:-/run/current-system/sw/share/nix-ld/lib}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

### 3. Non-NixOS with `uv` (all platforms)

Prefer Python 3.13. Write a file `.python-version` in the project root that
contains the single line `3.13` (any editor, or `printf '3.13\n' > .python-version`
in a POSIX shell), then:

```bash
cd ~/.pi/telemetry-eval
uv venv
uv sync
```

`uv venv --python 3.13` selects the interpreter explicitly and means the same
thing on every platform. A POSIX shell can pin an interpreter in a variable
(`PYTHON="$(command -v python3.13)"`, then `uv venv --python "$PYTHON"`);
PowerShell uses `$env:PYTHON` instead:

```powershell
$env:PYTHON = (py -3 -c "import sys; print(sys.executable)")
uv venv --python "$env:PYTHON"
```

If `uv sync` fails because `uv.lock` is missing, generate one first with
`uv lock` (or use `uv pip install -r requirements.txt`).

### 4. No `uv` on PATH (per-platform)

Use the newest stable system Python to create a `.venv` and install from
`requirements.txt`.

Linux / macOS:

```bash
cd ~/.pi/telemetry-eval
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .   # install the local telemetry_eval package so `import telemetry_eval` resolves
```

Windows (`cmd.exe`; the same commands work in PowerShell):

```
cd %USERPROFILE%\.pi\telemetry-eval
py -3 -m venv .venv
.venv\Scripts\pip.exe install -r requirements.txt
.venv\Scripts\pip.exe install -e .
```

`py -3` is the Windows Python launcher and selects the newest Python 3; append a
version (`py -3.13`) to pin one.

If the only available system Python is a beta/unstable version (for
example, `3.15.0b4`), prefer a stable interpreter and stop to ask the user to
install one.

## Running scripts

After setup, run scripts from the project root. With `uv` on `PATH` the command
is the same on every platform:

```bash
cd ~/.pi/telemetry-eval
uv run python scripts/<name>.py
```

If `uv` is unavailable, use the venv interpreter.

Linux / macOS:

```bash
cd ~/.pi/telemetry-eval
.venv/bin/python scripts/<name>.py
```

Windows:

```
cd %USERPROFILE%\.pi\telemetry-eval
.venv\Scripts\python.exe scripts\<name>.py
```

## Read-only discipline

All helpers open the live telemetry database read-only:

- `telemetry_eval.connect()` uses SQLite URI mode:
  `sqlite3.connect("file:<path>?mode=ro", uri=True)`.
- `telemetry_eval.duck()` attaches the database as schema `tel` with
  `ATTACH '<path>' AS tel (TYPE sqlite, READ_ONLY)`.

Any write or DDL against the live connection raises. Derived data must be
written via `telemetry_eval.scratch()` to a separate file under
`~/.pi/telemetry-eval/`, never the live DB.
