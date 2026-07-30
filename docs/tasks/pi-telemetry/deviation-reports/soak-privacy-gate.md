## Deviation report — soak-privacy-gate

### API surface changes

- **Planned:** Arch spec slice 10: "No production exports. Adds
  `test/soak.test.ts` (env-gated `PI_TELEMETRY_SOAK=1`) and
  `test/privacy.test.ts`. Soak writer processes reuse the real `src/db.ts` /
  `src/buffer.ts`." The slice doc scope is entirely test-side (soak, privacy
  gate, full-suite gate).
- **Actual:** `src/db.ts` was **modified** — added `isBusyError()`,
  `syncSleep()` (Atomics.wait on a fresh SharedArrayBuffer), and an
  exponential-backoff retry loop (10 attempts, 50ms × 2ⁿ) inside
  `openDatabase()` for `database is locked` / `BUSY` errors during the
  initial pragma + DDL sequence. The worker acknowledges this was not in the
  slice doc or arch spec; it was triggered by the "idempotent-DDL check across
  concurrent first-starts" test scenario, which deadlocked without the retry.
- **Impact:** `openDatabase()` is the DB entry point used by every capture
  slice and the buffer. The change is backward-compatible (same signature,
  same return type, same behavior on success — only adds retry on BUSY), so
  no dependent slice breaks. However, it is an **unapproved production code
  change in a test-only slice** — per the skill's coherence rules, production
  changes outside a slice's scope should be reviewed. The retry is reasonable
  and improves real-world robustness; recommend accepting it but folding the
  review into the coherence phase.

### Abstraction usage

- Used/was specified: **yes.** Soak workers import the real `src/db.ts`
  `openDatabase()` and `src/buffer.ts` `createBuffer()` (per arch spec).
  Privacy test uses the L2 harness (`createL2Session` + `fauxProvider` from
  `@earendil-works/pi-ai`). `node:test` + `node:assert` only. `node:sqlite`
  `DatabaseSync` for verification queries. `node:child_process` `fork` for
  worker spawning. No new npm dependencies introduced.

### Out-of-scope changes

1. **`src/db.ts` production change** — exponential-backoff BUSY retry in
   `openDatabase()` (see above). Not in slice scope. The `syncSleep` helper
   uses `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` —
   a synchronous blocking sleep. Works on Node 24.18.0 (tsc + soak both pass)
   but SharedArrayBuffer can be disabled in sandboxed environments; minor
   portability risk.
2. **`ROWS_PER_WORKER` raised from 500 to 1000** — the original uncommitted
   soak scaffold used 500 rows/worker; the worker raised it to 1000 to
   amortize per-worker setup overhead and reach the 42k target. The target
   assertion itself was **not** weakened (still `>= 42_000`). However, the
   worker's claim of "reliably ~44–46k rows/s" is **not fully supported**:
   my measurements across 5 runs showed **40030, 40267, 48068, 56055 rows/s**
   — the throughput straddles the threshold (2 of 5 runs failed below 42k).
3. **`test/helpers/ddl-worker.ts` added** — new IPC fork helper for the
   separate idempotent-DDL concurrent first-start test. Additive, reasonable.
4. **`test/soak-debug.test.ts` removed** — debug scaffold cleaned up. Good.

### Testing strategy deviations

1. **Hard `assert.fail` on throughput makes the soak flaky.** The slice doc
   testing strategy explicitly says: "soak environment too slow/contended →
   distinguish target miss from environmental noise (repeat runs, report
   variance)" and the edge cases say "soak on a machine under load
   (documented as informational, not a hard CI failure)." The implementation
   does a **single run** and hard-fails (`assert.fail`) if below 42k rows/s.
   On this machine, throughput varies 40k–56k rows/s across runs — the test
   is **non-deterministic**: it can fail on the same machine depending on
   load. This contradicts the "repeat runs, report variance" and
   "informational, not a hard CI failure" guidance. **Recommendation:** run
   multiple iterations (e.g., 3) and pass if the median meets the target, or
   downgrade the throughput check to a console.warn + deviation-report path
   rather than a hard assert.fail.
2. **Measures rows/s, not commits/s.** SPEC §3/§9 states the design target as
   "~42k commits/s aggregate." The test measures **rows/s** (100,000 rows /
   wall time). With `bufferMaxRows=50`, each worker does ~20 commits (1000
   rows / 50), so 100 workers × ~20 = ~2000 commits in ~2.5s ≈ 800 commits/s
   — the 42k commits/s target is never directly measured. Rows/s is arguably
   more meaningful for this use case, but the semantic mismatch with SPEC's
   stated "commits/s" unit is worth noting. The acceptance criteria's "Soak
   reproduces the design target" is satisfied on a rows/s basis (some runs
   exceed 42k), but the SPEC's commits/s target is not validated.

### Acceptance criteria check (slice doc)

- Soak reproduces the design target, or a deviation report is filed:
  **Partially.** The target IS reproduced on some runs (48k–56k rows/s) but
  the hard assertion fails on others (40k) due to environmental variance. The
  variance itself is the deviation. No separate deviation report with
  measurements/recommendation was filed by the worker (the hard assert.fail
  serves as the failure signal instead).
- Privacy assertion green under default config: **Yes.** Privacy test passes.
  Covers all 8 measurement tables (sessions, agent_runs, turns, llm_requests,
  tool_executions, bash_executions, session_events, feedback) — each asserted
  for row existence. The `findSentinels` function scans **every TEXT column in
  every table** (including telemetry_meta) for unique sentinels injected via
  prompt text, tool args, tool results, and bash commands. On failure, it
  reports the offending table.column + sentinel name. Content-flag-enabled
  runs are correctly excluded (only asserts `args_json`/`result_text` are
  NULL under default config). FEEDBACK_DATA sentinel is intentionally excluded
  from the leak scan (feedback.data is allowed to store content by design).
- `npm test` excludes soak; soak runnable via env flag: **Yes.** Fast suite
  shows 2 skipped (both soak tests); soak runs with `PI_TELEMETRY_SOAK=1`.
- Full-suite gate: **Yes.** `npm test` → 132 pass, 0 fail, 2 skipped.
  `npm run check` (tsc --noEmit) clean.
- Idempotent-DDL concurrent first-starts: **Yes** — separate test spawns 5
  workers, all exit 0, user_version=1, tables exist. (Requires the `src/db.ts`
  BUSY-retry fix to pass.)
- WAL cleanup: **Yes** — `finally` blocks call `cleanupSoakFiles()` (removes
  db, -wal, -shm) + `rmSync(tmp, recursive)`. Verified: no leftover temp dirs
  after a clean passing run. Leftover dirs from the original hung worker's
  pre-fix runs were found in /tmp but are not from the fixed test.
- `docs/tasks/state.yaml` NOT committed by worker: **Yes** — confirmed not
  in the slice's 4 commits (modified in working tree only).

### Fix verification (hang root cause)

- **Root cause confirmed:** the original parent never broadcast the `start`
  message to workers; they blocked forever on `process.once("message")`.
- **Fix is sound:** ready→start handshake with `fail()` that kills all
  children (SIGKILL) and rejects all pending promises on any pre-ready exit
  or error. Ready-phase timeout (30s) and execution-phase timeout (60s) both
  kill stray children. Verified: 0 stray soak/ddl processes after all runs.
  Spawn staggering (10ms) avoids thundering herd. `silent: true` on fork
  suppresses worker stdout noise.

### Task doc update needed?

**Yes** — append to `## Implementation notes`:
- `src/db.ts` `openDatabase()` gained exponential-backoff BUSY retry (10
  attempts) for concurrent first-start DDL contention — added during soak
  slice, not in original slice scope. Accept or review at coherence.
- Soak measures rows/s (not commits/s as SPEC §3 states); throughput varies
  40k–56k on this host; hard assert.fail makes it environmentally flaky.
- `ROWS_PER_WORKER` tuned to 1000 (from scaffold's 500) to amortize setup.

### User attention needed?

**Yes — two items:**

1. **`src/db.ts` production change** in a test-only slice. The BUSY retry is
   backward-compatible and justified (concurrent first-start DDL deadlock),
   but it's an unapproved production code change outside the slice's stated
   scope. Recommend accepting it at the coherence phase (it improves
   robustness for all callers), but the user should be aware.

2. **Hard throughput assertion is flaky.** The soak test fails
   non-deterministically (40k–56k rows/s variance vs 42k hard target) on the
   same machine. The slice doc's own testing strategy says to "distinguish
   target miss from environmental noise (repeat runs, report variance)" and
   treat load-under-run as "informational, not a hard CI failure." The
   implementation contradicts this. Recommend: either (a) run 3 iterations
   and pass on median, or (b) downgrade throughput to a console.warn +
   deviation-report rather than assert.fail. This decision affects whether
   the soak can serve as a reliable gated regression test.
