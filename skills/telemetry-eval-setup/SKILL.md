---
name: telemetry-eval-setup
description: Bootstrap ~/.pi/telemetry-eval/ with telemetry_eval helpers and data-analysis dependencies.
---

# telemetry-eval-setup

Create or repair the Python analysis environment at `~/.pi/telemetry-eval/`.
This project contains the `telemetry_eval` package with read-only helpers
(`connect()`, `duck()`, `scratch()`) for analyzing the pi-telemetry SQLite
database.

## Idempotency

1. If `~/.pi/telemetry-eval/` already exists **and is healthy** (it has
   `pyproject.toml` **or** `requirements.txt`, **and** a `telemetry_eval/`
   directory), only refresh dependencies and stop. Do **not** recreate the
   directory, and do **not** overwrite any user scripts.

   - If `uv` is on `PATH` and `pyproject.toml` exists, run:
     ```bash
     cd ~/.pi/telemetry-eval && uv sync
     ```
   - Otherwise, if `requirements.txt` exists, run:
     ```bash
     cd ~/.pi/telemetry-eval && .venv/bin/pip install -r requirements.txt
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

Create and activate a Python virtual environment inside `~/.pi/telemetry-eval/`.
Choose the interpreter safely:

### 1. Detect NixOS

```bash
if test -f /etc/NIXOS || [ -n "$NIX_OS" ]; then
  # NixOS path
  IS_NIXOS=1
else
  IS_NIXOS=0
fi
```

### 2. NixOS with `uv`

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
running scripts:

```bash
export LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH:-/run/current-system/sw/share/nix-ld/lib}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

### 3. Non-NixOS with `uv`

```bash
cd ~/.pi/telemetry-eval
# Prefer Python 3.13
printf '3.13\n' > .python-version
uv venv
uv sync
```

If `uv sync` fails because `uv.lock` is missing, generate one first with
`uv lock` (or use `uv pip install -r requirements.txt`).

### 4. No `uv` on PATH

Use the system `python3` to create a `.venv` and install from
`requirements.txt`:

```bash
cd ~/.pi/telemetry-eval
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .   # install the local telemetry_eval package so `import telemetry_eval` resolves
```

If the only available system `python3` is a beta/unstable version (for
example, `3.15.0b4`), prefer a stable interpreter and stop to ask the user to
install one.

## Running scripts

After setup, run scripts from the project root:

```bash
cd ~/.pi/telemetry-eval
uv run python scripts/<name>.py
```

If `uv` is unavailable, use the venv interpreter:

```bash
cd ~/.pi/telemetry-eval
.venv/bin/python scripts/<name>.py
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
