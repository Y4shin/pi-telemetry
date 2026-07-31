---
name: telemetry-eval-analyze
description: Write read-only eval scripts against ~/.pi/telemetry.db using pandas and telemetry_eval helpers.
---

# telemetry-eval-analyze

Analyze the pi-telemetry SQLite database at `~/.pi/telemetry.db` with
read-only Python scripts. Use the shared `telemetry_eval` helpers for all
database access and follow the schema primer for table relationships.

## Preflight

Before writing or running any eval, confirm the analysis project exists:

- If `~/.pi/telemetry-eval/` is missing **both** `pyproject.toml` **and**
  `requirements.txt`, STOP and point the user to `/skill:telemetry-eval-setup`.
- Do **not** create the project, virtual environment, or helpers here.

## Import the shared helpers

Every script starts with:

```python
from telemetry_eval import connect, duck
```

Never hand-roll the read-only URI or database-path logic. Always use
`connect()` for SQLite and `duck()` for DuckDB. Derived or scratch writes go
only through `telemetry_eval.scratch()` to a separate scratch file, never the
live database.

## Canonical pandas pattern

```python
import pandas as pd

sql = """SELECT ... FROM ..."""
df = pd.read_sql_query(sql, con=connect())
```

For DuckDB, use `duck()` and `con.execute(...).fetchdf()`:

```python
import duckdb

con = duck()
df = con.execute("SELECT ... FROM tel.turns ...").fetchdf()
```

## Schema reference

For table relationships, primary keys, foreign keys, join keys, and the
`unix_ms` timestamp convention, delegate to:

```
follow resource "resources/schema.md"
```

## Script layout

- Long-held named evals go in `~/.pi/telemetry-eval/scripts/<name>.py`.
- One-offs can be ad-hoc files at the project root or inline via
  `uv run python -c "..."` (or `.venv/bin/python -c "..."` when `uv` is
  unavailable).
- Run named scripts from the project root:

  ```bash
  cd ~/.pi/telemetry-eval
  uv run python scripts/<name>.py
  ```

## NixOS note

On NixOS, compiled wheels (numpy, pandas, duckdb) may fail to load shared
libraries unless the nix-ld compatibility directory is on
`LD_LIBRARY_PATH`. If imports or script runs fail with missing
`libstdc++.so.6`/`libz.so.1`/similar, set it before running:

```bash
export LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH:-/run/current-system/sw/share/nix-ld/lib}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

The setup skill documents the environment preparation; do not duplicate setup
steps here.

## Read-only discipline

- Always use `connect()` for a read-only SQLite connection to the live DB.
- Always use `duck()` for a read-only DuckDB attach (`tel.*` schema).
- Never call `sqlite3.connect` directly on the live database file.
- Never write or run DDL against the live DB. Derived/scratch output belongs
  in `telemetry_eval.scratch()`, never the telemetry database itself.
