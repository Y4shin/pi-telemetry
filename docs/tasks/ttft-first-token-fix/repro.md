# Reproduction — TTFT mis-measured (first message_update of any type treated as first token)

## Symptom

`~/.pi/telemetry.db` `llm_requests.ttft_ms` is `0` for 83% of rows, including
rows that streamed for seconds — physically impossible for a networked
provider. The zero comes from treating the first `message_update` of *any*
type as the first token.

## Investigation

### 1. Live DB confirms the symptom

```bash
python3 - <<'PY'
import sqlite3
con = sqlite3.connect("/home/pplattner/.pi/telemetry.db")
print("ttft bands:", list(con.execute("""
  SELECT CASE WHEN ttft_ms IS NULL THEN 'null'
              WHEN ttft_ms=0 THEN 'zero' ELSE 'positive' END, COUNT(*)
  FROM llm_requests GROUP BY 1""")))
print("zero with positive stream_ms:", con.execute(
  "SELECT COUNT(*) FROM llm_requests WHERE ttft_ms=0 AND stream_ms IS NOT NULL").fetchone())
print("zero with stream_ms>=1000:", con.execute(
  "SELECT COUNT(*) FROM llm_requests WHERE ttft_ms=0 AND stream_ms>=1000").fetchone())
print("zero with positive output_tokens:", con.execute(
  "SELECT COUNT(*) FROM llm_requests WHERE ttft_ms=0 AND output_tokens>0").fetchone())
PY
# -> ttft bands: [('zero', 6883), ('positive', 1269), ('null', 122)]
# -> zero with positive stream_ms: (6425,)
# -> zero with stream_ms>=1000: (2984,)
# -> zero with positive output_tokens: (6848,)
```

A 0 ms first-token time with a multi-second stream and positive output is
impossible → the 0 is a measurement artifact.

### 2. Root cause in source

`src/capture/llm.ts:105-120` sets `firstUpdateMs` on the first
`message_update` of any type, ignoring `event.assistantMessageEvent.type`:

```ts
pi.on("message_update", async (event) => {
  guard(t, () => {
    const message = event.message as AssistantMessage;
    if (message.role !== "assistant") return;
    const signature = getMessageSignature(message);
    const req = inFlightRequests.get(signature);
    if (!req) return;
    const now = t.now();
    if (req.firstUpdateMs === null) {
      req.firstUpdateMs = now;
      const ttftMs = now - req.startMs;
      t.enqueue("UPDATE llm_requests SET ttft_ms = ? WHERE request_id = ?",
        [ttftMs, req.requestId]);
    }
  });
});
```

The `event.assistantMessageEvent` is available (the existing streaming test
passes `{ type: "text_delta", ... }`) but its `type` is never checked. For the
`requesty` gateway, the first `message_update` is a synthetic event in the
same millisecond as `message_start`, so `ttft = 0`.

### 3. The fix (slice 1: `ttft-gate-text-delta`)

Gate `firstUpdateMs` on `assistantMessageEvent.type === "text_delta"`:

```ts
if (req.firstUpdateMs === null && event.assistantMessageEvent?.type === "text_delta") {
  req.firstUpdateMs = now;
  ...
}
```

If no `text_delta` ever arrives, `ttft_ms` stays `NULL` (already the
documented "unmeasured" state; `stream_ms` falls back to `NULL` too via the
existing `firstUpdateMs !== null ? ... : null` branch).

### 4. Regression test (the test rule for slice 1)

In `test/llm.test.ts`, add a test that fires:

1. `message_start`
2. a **non-`text_delta`** `message_update` at the same ms as `message_start`
   (simulating the synthetic first update from the `requesty` gateway)
3. a `text_delta` `message_update` later (clock advanced)
4. `message_end`

Assert `ttft_ms` reflects the `text_delta` delta, **not** `0`.

Against the unfixed code, this test sees `ttft_ms = 0` (the synthetic update
wins). Against the fixed code, it sees the `text_delta` delta. This is the
RED → GREEN rule for slice 1.

### 5. History migration (slice 2: `ttft-null-mismeasured-history`)

A version-gated migration (v4 → v5) nulls the mis-measured zeros:

```sql
UPDATE llm_requests SET ttft_ms = NULL WHERE ttft_ms = 0;
```

Aggressive by design: networked TTFT is never 0 ms, and the review found zero
genuine sub-ms values. The 455 fully-degenerate rows (`stream_ms IS NULL`, no
generation) are nulled too — `0` falsely claims a token arrived; `NULL`
correctly says it didn't. Gated on `user_version < 5`; no-op on fresh DBs.

## Verdict

Real bug — a definition error in the TTFT capture. Slice 1 fixes the capture
forward; slice 2 corrects the historical data once on upgrade.
