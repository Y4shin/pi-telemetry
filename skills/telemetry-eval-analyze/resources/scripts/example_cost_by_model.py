#!/usr/bin/env python3
"""Example eval: total cost and token usage per model from the turns table."""

import sys

import pandas as pd

from telemetry_eval import connect


SQL = """
SELECT
    model,
    SUM(cost_total_usd) AS cost_total_usd,
    SUM(input_tokens)   AS input_tokens,
    SUM(output_tokens)  AS output_tokens,
    SUM(total_tokens)   AS total_tokens
FROM turns
GROUP BY model
ORDER BY cost_total_usd DESC
"""


def main() -> int:
    con = connect()
    try:
        df = pd.read_sql_query(SQL, con=con)
    finally:
        con.close()

    if df.empty:
        print("No turns found in the telemetry database.")
        return 0

    print(df)
    return 0


if __name__ == "__main__":
    sys.exit(main())
