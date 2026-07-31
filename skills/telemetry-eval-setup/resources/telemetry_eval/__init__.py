"""Read-only helpers for the pi-telemetry SQLite database."""

import json
import os
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import duckdb

__all__ = ["resolve_db_path", "connect", "duck", "scratch"]


def _expand_path(path: str) -> str:
    """Expand a leading ``~/`` to the user's home directory."""
    if path.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), path[2:])
    return path


def _read_settings(path: str) -> dict:
    """Load a JSON settings file, returning an empty dict if missing/invalid."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def resolve_db_path() -> str:
    """Resolve the telemetry database path.

    Precedence:
      1. ``PI_TELEMETRY_DB_PATH`` environment variable
      2. ``pi-telemetry.dbPath`` in ``~/.pi/agent/settings.json`` (global)
      3. ``pi-telemetry.dbPath`` in ``<cwd>/.pi/settings.json`` (project)
      4. Default ``~/.pi/telemetry.db``

    ``~/`` is expanded via ``os.path.expanduser``. Missing settings files are
    ignored. A clear error is raised if the resolved file does not exist;
    the database is never created implicitly.
    """
    env_path = os.environ.get("PI_TELEMETRY_DB_PATH")
    if env_path:
        db_path = env_path
    else:
        home = os.path.expanduser("~")
        global_settings = _read_settings(os.path.join(home, ".pi", "agent", "settings.json"))
        project_settings = _read_settings(os.path.join(os.getcwd(), ".pi", "settings.json"))

        global_db_path = global_settings.get("pi-telemetry", {}).get("dbPath")
        project_db_path = project_settings.get("pi-telemetry", {}).get("dbPath")

        db_path = global_db_path or project_db_path or os.path.join(home, ".pi", "telemetry.db")

    db_path = _expand_path(db_path)

    if not os.path.isfile(db_path):
        raise FileNotFoundError(
            f"Telemetry database not found at resolved path: {db_path}\n"
            "Check PI_TELEMETRY_DB_PATH or pi-telemetry.dbPath in settings.json."
        )

    return db_path


def connect() -> sqlite3.Connection:
    """Return a read-only SQLite connection to the live telemetry database.

    Uses ``file:<path>?mode=ro`` URI mode so the connection is WAL-aware and
    sees the latest committed rows. Any write or DDL statement raises.
    """
    db_path = resolve_db_path()
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


def duck() -> "duckdb.DuckDBPyConnection":
    """Return a DuckDB connection with the live telemetry DB attached read-only.

    The SQLite database is attached as schema ``tel``. Queries against
    ``tel.*`` are read-only; writes raise.
    """
    import duckdb as _duckdb

    db_path = resolve_db_path()
    con = _duckdb.connect()
    con.execute("INSTALL sqlite")
    con.execute("LOAD sqlite")
    # DuckDB's sqlite ATTACH syntax requires single quotes around the path.
    con.execute(f"ATTACH '{db_path}' AS tel (TYPE sqlite, READ_ONLY)")
    return con


def scratch(path: str = "scratch.db") -> sqlite3.Connection:
    """Return a read-write SQLite connection to a scratch file.

    The scratch database lives under ``~/.pi/telemetry-eval`` and is never the
    live telemetry database.
    """
    project_dir = os.path.expanduser("~/.pi/telemetry-eval")
    os.makedirs(project_dir, exist_ok=True)
    scratch_path = os.path.join(project_dir, path)
    return sqlite3.connect(scratch_path)
