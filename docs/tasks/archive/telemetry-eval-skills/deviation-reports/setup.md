# Deviation report — setup

Slice: `setup` (telemetry-eval-skills). Branch: `slice/telemetry-eval-skills-setup`
(commit `9e5c87e`). Compared against
`docs/tasks/telemetry-eval-skills/arch-spec.md` and
`docs/tasks/telemetry-eval-skills/slices/1-setup.md`.

The diff is exactly 5 new files under `skills/telemetry-eval-setup/`:

```
 skills/telemetry-eval-setup/SKILL.md                            | 170 +
 .../telemetry-eval-setup/resources/pyproject.toml              |  18 +
 .../resources/requirements.txt                                 |   4 +
 .../resources/scripts/smoke_test.py                            |  61 +
 .../resources/telemetry_eval/__init__.py                       | 109 +
```

No TS source touched; no other dirs touched.

## API surface changes

**Planned (arch-spec contract):**
```python
resolve_db_path() -> str            # env -> global settings -> project settings -> ~/.pi/telemetry.db; raise if missing
connect() -> sqlite3.Connection      # file:<path>?mode=ro, uri=True; write/DDL raises
duck() -> duckdb connection         # INSTALL sqlite; LOAD sqlite; ATTACH ... (TYPE sqlite, READ_ONLY)
scratch(path="scratch.db") -> conn  # read-write, separate file under project
```

**Actual:** the four helpers match the contract exactly.
- `resolve_db_path()` — `os.environ.get("PI_TELEMETRY_DB_PATH")` (empty treated as unset) →
  `pi-telemetry.dbPath` in `~/.pi/agent/settings.json` (global) → `pi-telemetry.dbPath` in
  `<cwd>/.pi/settings.json` (project) → `join(home,".pi","telemetry.db")`. Expands leading `~/`.
  Raises `FileNotFoundError` with the resolved path + a hint if `os.path.isfile(db_path)` is false;
  never creates the DB. (`__init__.py:43-77`)
- `connect()` — `sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)`. (`__init__.py:80-86`)
- `duck()` — `duckdb.connect()`; `INSTALL sqlite`; `LOAD sqlite`;
  `ATTACH '<path>' AS tel (TYPE sqlite, READ_ONLY)`. (`__init__.py:89-99`)
- `scratch(path="scratch.db")` — `os.path.join(expanduser("~/.pi/telemetry-eval"), path)`,
  `makedirs(..., exist_ok=True)`, `sqlite3.connect(scratch_path)` (read/write). (`__init__.py:102-109`)

**API-surface deviations:** none. Signatures and behavior conform.

**Sanctioned deviation (for the record, not a defect):** `resolve_db_path` uses
**global→project** precedence, intentionally different from `src/config.ts`'s
`loadMergedSettings` (`{...global, ...project}`, i.e. project→global). Per arch-spec
decision 1, the order follows the task/idea doc text. An eval script may therefore
resolve a different DB than the live pi process when a project `settings.json`
overrides the global one — this is an approved trade-off, not a bug.

## Abstraction usage

- **Read-only URI / path logic lives only in `telemetry_eval/__init__.py`.** The smoke
  test (`scripts/smoke_test.py`) uses `telemetry_eval.connect()` / `.duck()` only; it
  hand-rolls no URI or path. ✓
- **`follow resource "resources/..."` template pattern present** in `SKILL.md`
  (the Resource-templates + Environment-setup sections mirror `implement-task`'s
  `resources/feature.md` pattern). ✓
- **NixOS-safe interpreter resolution correct.** `SKILL.md` forbids `uv python install`,
  uses `command -v python3.13 || command -v python3.12 || command -v python3`, gates on a
  stable interpreter (stops and instructs `nix profile install nixpkgs#python313` if only a
  beta is found), and has a no-uv `python3 -m venv` fallback. Verified the materialized
  project's venv points at the **nix** system python
  (`/nix/store/.../python3-3.13.14`, via `~/.nix-profile/bin/python3.13`), not a
  uv-downloaded python-build-standalone — so the NixOS rule was honored in practice. ✓
- **Idempotent refresh-if-healthy present.** If `~/.pi/telemetry-eval/` is healthy
  (`pyproject.toml` OR `requirements.txt` AND `telemetry_eval/`), refresh deps (`uv sync`
  / `pip install -r`) and stop; don't overwrite user scripts. Broken dir (missing
  `telemetry_eval/`) is repaired by re-templating only the package. ✓ (matches slice doc
  edge case).
- **no-uv fallback present** (section 4) — `python3 -m venv .venv` +
  `pip install -r requirements.txt`. ⚠️ See FINDING below: the package is NOT installed
  in this path, so `import telemetry_eval` fails via the documented run command.

## Out-of-scope changes

**File set:** none out of scope — exactly the five files the slice lists; no TS, no
docs, no other skills authored (correctly deferred to slice 2).

**Two in-file additions the implementer self-reported:**

1. **`[build-system]` + `[tool.setuptools]` in `pyproject.toml`.** `requires=["setuptools>=61"]`,
   `packages=["telemetry_eval"]`. This is the mechanism that makes
   `from telemetry_eval import connect` work when running `uv run python scripts/x.py`
   (script-file mode puts `scripts/` on `sys.path[0]`, NOT the project root, so the
   package must be installed site-packages). It conforms to the spec's intent ("a
   `telemetry_eval` package entry so `from telemetry_eval import connect` works"); it
   is a justified implementation choice, not a deviation. Verified: uv-path smoke test
   exits 0 (`uv run` installed the package — `telemetry_eval.egg-info` present).

2. **`LD_LIBRARY_PATH` / nix-ld note in `SKILL.md`.** The NixOS-system-python path
   requires `LD_LIBRARY_PATH` pointed at the nix-ld lib dir or the pip wheels
   (`numpy`, `duckdb`, …) cannot load `libstdc++.so.6`/`libz.so.1`.
   `export LD_LIBRARY_PATH="${NIX_LD_LIBRARY_PATH:-/run/current-system/sw/share/nix-ld/lib}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`.
   **Verified necessary:** running `uv run python scripts/smoke_test.py` WITHOUT
   `LD_LIBRARY_PATH` → `FAIL: required import failed: … numpy … libstdc++.so.6: cannot
   open shared object file`; WITH it → all 4 assertions PASS
   (`[1/4] imports`, `[2/4] count(sessions)=22`, `[3/4] write blocked`,
   `[4/4] duckdb ro attach ok`). The note prefers the standard `NIX_LD_LIBRARY_PATH`
   env var over a hardcoded path — robust. This is a justified in-scope extension of
   "NixOS-safe interpreter resolution" (the mandated nix system python needs it for the
   deps), not a scope violation.

## Divergence from the slice doc's acceptance criteria

- ✅ Skill creates `~/.pi/telemetry-eval/` with `pyproject.toml` + `telemetry_eval/` +
  `scripts/smoke_test.py` (verified on disk).
- ✅ `smoke_test.py` exits 0 (uv path): imports clean; `connect()` `SELECT count(*)
  FROM sessions` returns a row; a `CREATE TABLE` write raises; `duck()` attaches
  read-only and `SELECT * FROM tel.turns LIMIT 1` works (all four reproduced).
- ✅ Idempotent refresh-if-healthy and broken-dir repair documented.
- ✅ On NixOS the skill never invokes `uv python install` (verified: venv python is the
  nix 3.13.14 interpreter; worker command log shows `uv venv --python "$(command -v
  python3.13)"`, no `uv python install`).

**FINDING (medium) — the documented no-uv fallback path breaks `import telemetry_eval`.**
The `[build-system]` addition fixed the **uv** path (`uv sync` installs the local
package into site-packages) but the **no-uv** path does not: `pip install -r
requirements.txt` installs only the four deps, and `SKILL.md` runs scripts via
`.venv/bin/python scripts/<name>.py` (script-file mode → `sys.path[0] = scripts/`,
project root NOT on `sys.path`). **Airtight confirmation:** a throwaway no-uv-style
venv (deps only, package not installed), run exactly as documented
(`.venv/bin/python scripts/s.py` from the project root) →
`ModuleNotFoundError: No module named 'telemetry_eval'`. Contrast: `.venv/bin/python -m
scripts.s` and `PYTHONPATH=. .venv/bin/python scripts/s.py` both succeed (not documented).

This breaks the slice doc's "Key scenarios" item: *"no-uv path builds `.venv` from
`requirements.txt`"* — which implicitly requires `from telemetry_eval import connect`
to work. It was NOT exercised on this box (uv is present; the uv path is verified green,
satisfying the operative acceptance). Severity medium (a documented acceptance path is
broken), urgency low (target machine has uv). **Recommended fix:** add
`.venv/bin/pip install -e .` (the build-system already supports it via setuptools) to
the no-uv setup section in `SKILL.md`, so the local package is installed in that path
too. (Alternatively document `PYTHONPATH=.` or `python -m scripts.<name>`.)

## Task doc update needed?

**Yes.** Append to `## Implementation notes`:

> Setup slice landed (5 files, `skills/telemetry-eval-setup/`). `[build-system]` +
> `[tool.setuptools]` added to `pyproject.toml` so `uv sync` installs the local
> `telemetry_eval` package (needed because `uv run python scripts/x.py` doesn't put the
> project root on `sys.path`). NixOS requires `LD_LIBRARY_PATH`→nix-ld for the nix system
> python to load pip wheels (`libstdc++.so.6`); documented in `SKILL.md`. **Known gap:**
> the no-uv fallback path (`pip install -r requirements.txt`) does NOT install the local
> package, so `import telemetry_eval` fails via `.venv/bin/python scripts/<name>.py`.
> Recommend adding `pip install -e .` to the no-uv setup before finalization.

## User attention needed?

**No** (no scope change; no API-surface change). However the no-uv gap above is a
medium latent issue on a documented acceptance path; the parent should decide whether
to apply the small recommended fix (`pip install -e .` in the no-uv section) before or
during the analyze slice / coherence step. Not a blocker for landing this slice — the
operative (uv) path on the target machine is verified green.
