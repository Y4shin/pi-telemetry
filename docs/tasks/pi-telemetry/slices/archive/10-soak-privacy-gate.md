---
kind: slice
slug: soak-privacy-gate
title: "Concurrency soak + privacy gate"
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: [query-telemetry-tool]
started_at:
completed_at:
---

# Concurrency soak + privacy gate

SPEC §9 acceptance gates: validate the §3 design target and the §7
privacy posture against the finished extension.

## Scope

- **Multi-process writer soak:** spawn ~100 concurrent writer processes
  against one shared DB; assert the §3 design target (~42k commits/s
  aggregate, 0 busy errors). Gated regression test (env-flagged, not
  part of the default fast suite). If the soak shows busy contention or
  throughput collapse → deviation report; only then consider a fallback
  (per-process DB / async write-behind) per the grilling decision.
- **Privacy gate:** default-config run exercising every capture path
  (sessions, runs, turns, LLM, tools, bash, session events, feedback);
  assert zero content strings in any table — lengths + hashes only.
- **Full-suite gate:** `npm test` and `npm run check` green; the whole
  SPEC §1 catalog verified end-to-end against a realistic scripted
  session driven through the SDK mock-provider harness (L2).

## Acceptance criteria

- Soak reproduces the design target, or a deviation report is filed
  with measurements and a recommendation.
- Privacy assertion is green under default config; content-flag-enabled
  runs are explicitly out of the assertion's scope.
- `npm test` (fast suite) excludes the soak; the soak is runnable via
  its documented env flag.

## Testing strategy

- **Layers:** whole extension; `test/soak.test.ts` (gated),
  `test/privacy.test.ts`.
- **Failure modes:** (1) soak environment too slow/contended →
  distinguish target miss from environmental noise (repeat runs,
  report variance); (2) privacy leak (content column accidentally
  populated) → test fails with the offending table/column named.
- **Key scenarios:** 100-writer soak; privacy run over an L2 scripted
  session touching all tables; idempotent-DDL check across concurrent
  first-starts.
- **Edge cases:** soak on a machine under load (documented as
  informational, not a hard CI failure); WAL file cleanup after soak.
