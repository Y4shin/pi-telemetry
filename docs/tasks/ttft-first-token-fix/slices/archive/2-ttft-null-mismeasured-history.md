---
kind: slice
slug: ttft-null-mismeasured-history
title: Null historically mis-measured ttft_ms values on upgrade from <= 0.4.0
task: ../task.md
mode: afk
status: done
size: s
blocked_by:
  - ttft-gate-text-delta
---

## End-to-end behavior

On the first DB open after this extension version lands, a one-time
forward migration sets `ttft_ms = NULL` for the rows that the pre-fix capture
code mis-measured, so historical percentiles and `ttft_by_model` queries are
no longer polluted by false zeros.

## Acceptance criteria

- [ ] New migration (version 5) in `src/db.ts` `MIGRATIONS`, gated on
      `user_version < 5`, idempotent, runs once.
- [ ] `UPDATE llm_requests SET ttft_ms = NULL WHERE <mis-measured predicate>`.
- [ ] Fresh DBs (empty `llm_requests`) are a no-op — the migration must not
      fail or loop on an empty table.
- [ ] After migration, `SELECT COUNT(*) FROM llm_requests WHERE ttft_ms = 0`
      returns 0 (no physically-impossible zeros remain).
- [ ] Genuine fast TTFTs are preserved — the predicate must not null
      legitimate sub-10ms values (verify there are none to protect, but the
      guard is the predicate, not trust).

## Mis-measured predicate (the Fog item 2 decision)

The pre-fix code wrote `ttft_ms = 0` in two situations, both physically
impossible for a networked request and both to be nulled:

1. **Synthetic first-update (the 6,425 rows):** `ttft_ms = 0 AND stream_ms IS
   NOT NULL` — a real stream happened, so a true 0 ms first token is
   impossible. Null these.
2. **Fully-degenerate (the 455 rows):** `ttft_ms = 0 AND stream_ms IS NULL`
   (no generation at all — `duration_ms=0`/`NULL`, no first token ever
   arrived). Null these too: `0` claims a token arrived, `NULL` correctly
   says it didn't.

**Combined predicate:** `UPDATE llm_requests SET ttft_ms = NULL WHERE
ttft_ms = 0`.

This is deliberately aggressive: it nuls every zero, including any
hypothetical genuine sub-millisecond TTFT. Justification: networked round
trip is never 0 ms, and the review found zero rows where a 0 could be real
(the 122 already-NULL rows are the real "no measurement" set). Record this
justification as a comment in the migration SQL.

## Test plan

**Seam:** `test/db.test.ts` / `test/duplicate-key-resilience.test.ts` migration
      harness — seed a temp DB at `user_version = 4` with zero-ttft rows,
      `openDatabase`, assert they become `NULL` and `user_version` advances
      to 5.
**Failure mode:** the migration's `UPDATE` doesn't run (e.g., the version
      gate skips it) → zeros remain → test fails.
**Scenarios:**
  - DB at v4 with `ttft_ms = 0 AND stream_ms > 1000` rows → nulled.
  - DB at v4 with `ttft_ms = 0 AND stream_ms IS NULL` rows → nulled.
  - DB at v4 with a positive `ttft_ms` row → preserved.
  - Fresh DB (empty `llm_requests`) at v0 → migration runs, no-op, v5 set.
  - Re-open a v5 DB → migration does not re-run.
**Edge cases:** very large `llm_requests` table — the `UPDATE` is one
  statement; ensure it doesn't hold an exclusive lock long enough to trip
  `busy_timeout`. If it can, run it in batches (the existing `buffer.ts`
  batch pattern is a reference, but a migration is a one-shot open path).

## Constraints and dependencies

- Depends on `ttft-gate-text-delta` so the *new* capture is correct before
  correcting *old* data.
- Never touch `~/.pi/telemetry.db` from a test — temp/`:memory:` only
  (project convention, SPEC §3).
- Keep the migration comment referencing this task + the review's evidence
  (6,425 + 455 rows) for future archaeology.
