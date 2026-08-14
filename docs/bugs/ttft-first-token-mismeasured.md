---
title: TTFT mis-measured — message_update of any type is treated as the first token
status: open
severity: major
reported: 2026-08-14
confirmed_by: telemetry-signals-inventory review + DB + source inspection
fix_commit:
promoted_to: ttft-first-token-fix
---

# TTFT mis-measured: first message_update of any type is treated as first token

## Observed

`llm_requests.ttft_ms` is structurally wrong. Distribution over 8,276 live
rows in `~/.pi/telemetry.db`:

- 6,883 (83%) are `0`.
- 1,269 (15%) are positive (plausible).
- 122 (1.5%) are `NULL` (genuinely unmeasured — no `message_update` fired).

A `0` ms first-token time is physically impossible for networked providers,
and the data proves the zero is a measurement artifact: **6,425 zero-ttft rows
have positive `stream_ms`**, 2,984 of which ran **≥1 second** with positive
`output_tokens` — a request cannot stream for seconds with a 0 ms first token.
All zero rows route through one gateway (`provider='requesty'`, proxied from
sference/tensorx/nebius/inceptron).

Evidence (live DB, 2026-08-14):

```sql
SELECT ttft_ms, stream_ms, duration_ms, output_tokens
FROM llm_requests WHERE ttft_ms=0 AND stream_ms > 1000 LIMIT 20;
-- returns multi-second streams with ttft=0
```

## Expected

`ttft_ms` records `message_start` → first **content** event
(`assistantMessageEvent.type === 'text_delta'`), matching SPEC §1.4
("message_start → first message_update") where the spirit is "first token,"
not "first update of any kind." `0` is no longer a valid value for a networked
request; genuinely-unmeasured requests stay `NULL`.

## Root cause

`src/capture/llm.ts:105-120` — the `message_update` handler sets
`req.firstUpdateMs = now` on the **first `message_update` of any type** and
ignores `event.assistantMessageEvent.type`:

```ts
pi.on("message_update", async (event) => {
  guard(t, () => {
    ...
    if (req.firstUpdateMs === null) {
      req.firstUpdateMs = now;
      const ttftMs = now - req.startMs;
      t.enqueue("UPDATE llm_requests SET ttft_ms = ? WHERE request_id = ?", ...);
    }
  });
});
```

For the `requesty` gateway the first `message_update` is a synthetic/empty
event (role marker, usage ping, or keepalive) fired in the same `Date.now()`
millisecond as `message_start`, so `ttft = now - startMs = 0`. Real text
(`text_delta`) arrives later. Every existing test in `test/llm.test.ts`
happens to pass `{ type: "text_delta", ... }`, so the `type` field is present
but unused.

## Suspected area

`src/capture/llm.ts` — the `message_update` handler (lines 105-120).

## Fix

Two slices (see `docs/tasks/ttft-first-token-fix/`):

1. **`ttft-gate-text-delta`** — gate `firstUpdateMs` on
   `assistantMessageEvent.type === "text_delta"`. Forward-only; existing rows
   untouched. If no `text_delta` arrives, `ttft_ms` stays `NULL`.
2. **`ttft-null-mismeasured-history`** — version-gated migration (v4 → v5)
   that sets `ttft_ms = NULL WHERE ttft_ms = 0`, so historical percentiles and
   `ttft_by_model` queries are no longer polluted. Runs once on upgrade from
   `<= 0.4.0`; no-op on fresh DBs.

## Notes

- The inventory doc's framing ("~99% of ttft_ms are 0; measurement gap") was
  wrong on both count (83%, not 99%) and cause (definition bug, not a
  measurement gap). See the review verdict.
