#!/usr/bin/env python3
"""Acceptance smoke test for the telemetry-eval project."""

import sys

try:
    import pandas
    import duckdb
    import telemetry_eval
except Exception as exc:
    print(f"FAIL: required import failed: {exc}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    print("telemetry-eval smoke test")

    # 1. Imports succeeded (caught above if they fail).
    print("  [1/4] imports ok")

    # 2. Read-only sqlite connection returns rows.
    con = telemetry_eval.connect()
    try:
        row = con.execute("SELECT count(*) FROM sessions").fetchone()
        if row is None or row[0] is None:
            print("FAIL: SELECT count(*) FROM sessions returned no row", file=sys.stderr)
            return 1
        print(f"  [2/4] sqlite read-only count(sessions)={row[0]}")
    finally:
        con.close()

    # 3. Write/DDL on the live-DB connection must raise.
    con = telemetry_eval.connect()
    try:
        try:
            con.execute("CREATE TABLE _smoke_should_fail (id INTEGER)")
        except Exception:
            print("  [3/4] sqlite write blocked as expected")
        else:
            print("FAIL: write/DDL succeeded on read-only sqlite connection", file=sys.stderr)
            return 1
    finally:
        con.close()

    # 4. DuckDB attaches read-only and returns rows.
    dcon = telemetry_eval.duck()
    try:
        row = dcon.execute("SELECT * FROM tel.turns LIMIT 1").fetchone()
        if row is None:
            print("FAIL: SELECT * FROM tel.turns LIMIT 1 returned no row", file=sys.stderr)
            return 1
        print("  [4/4] duckdb read-only attach ok")
    finally:
        dcon.close()

    print("PASS: all smoke tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
