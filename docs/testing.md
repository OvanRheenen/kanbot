# Testing

Source files: `server/test/*.test.ts`, `server/test/fixtures/fake-claude.mjs`, `server/test/fixtures/fake-github.mjs`, `.github/workflows/ci.yml`

## Running

```bash
npm test                                          # server tests (vitest run)
cd server && npx vitest run test/pipeline.test.ts # one file
npm run typecheck                                 # server + web tsc (web's only check)
```

**Requirements:** `git` on PATH and Node ≥ 22.13. There is no vitest config file, so defaults apply: `*.test.ts`, and each file runs in its own worker. Scripts set `NODE_OPTIONS=--disable-warning=ExperimentalWarning`.

**Web:** no tests and no linter.


**CI:** `.github/workflows/ci.yml` runs typecheck, tests and the web/server builds on Ubuntu and macOS.

## Isolation pattern (e2e files)

1. At the top level, set env vars **before importing source**:
   - `process.env.ORCH_DATA_DIR` = a temp dir
   - `ORCH_CLAUDE_BIN` = the fake CLI
   - `ORCH_STALL_WARNING_MS` and the `FAKE_*` knobs as needed
2. In `beforeAll`, load modules with **dynamic `await import(...)`**. `DATA_DIR`, `RUNS_DIR` and `STALL_WARNING_MS` are fixed at import time.
3. Create real temp git repos and call module functions directly (not HTTP). Poll with a `waitFor()` helper.
4. `afterAll`: call `orchestrator.shutdown()` and remove the temp dir.

## Suites

| File | Type | Covers |
|---|---|---|
| `orchestrator.test.ts` | e2e | Concurrency 2 with 3 queued; worktree root `<repo>-worktrees`; `feature/` branches; reports (tests passed = 3, output tokens 1500, "## 8. Agent usage"); main checkout untouched; failure, retry (attempt 2, worktree reused), cancel; lean flags; follow-up with `--resume` (same session, cwd = worktree); metrics (turns 6, baseline 8200); auto-start off (`enterBuild` leaves the card ready with no run, `startFeature` runs it to Done, a project override `autoStart: true` beats the global setting, Done → Build waits again) |
| `pipeline.test.ts` | e2e | Full pipeline: plan → gate → approve with comment → dev → validation fails → fix → validate → tester → validate → done. Planner args read-only; session reuse (planner, dev and fix share one, tester is new). Diff scopes; max-fix-loop stop; retry re-runs validation; clarification gate and answers; reviewer `changes_once` → fix → re-review → final approval; per-role model and effort. **PR against a mock GitHub HTTP server** (`ORCH_GITHUB_API_URL`, token `ghp_testtoken_0123456789abcdef`, token file mode 600, push to a bare remote, PR reused, token never in events). Dependencies (cycle and self rejected, waits, stacks on the unmerged dependency branch, `baseRef`); `continuePipeline` after a lost gate; stall warning (1500 ms threshold, 2600 ms delay); gate survives `recover()` |
| `pipeline.unit.test.ts` | unit | `firstStep`/`nextStep`, `cleanPipeline` (including `autoStart` true/false/null and junk), `parseUnifiedDiff`, `findCycle`/`chooseBaseRef`, `parseRemote`, read-only role args, role prompts (markers, Jest flags, 300 s cap), `extractSelfReport` plan/questions/review, notification escaping and `shouldNotify`, `detectValidationCommands`/`installCommand`, `childEnv` (strips NODE_ENV, the ExperimentalWarning NODE_OPTIONS, CLAUDE_CODE_SESSION_ID and ORCH_GITHUB_TOKEN) |
| `unit.test.ts` | unit | `StreamParser` (session, usage deduped by message id, progress markers, chunking, metrics), pricing (`priceFor`, `estimateCost` incl. 1 h cache at 2× input), `extractSelfReport`, `slugify`, lean/full launch args, `previewCommand`/`resumeCommand` quoting, prompts, editor resolution, osascript Terminal command |
| `terminal.test.ts` | unit (real processes) | `terminal.ts`: output streamed + ANSI stripped, exit codes, child env has no `ORCH_GITHUB_TOKEN`, stop kills the group, empty/over-limit rejected, clear keeps running sessions, output cap + `outputStart`, `cleanOutput`; `cd` persistence (carries over, recorded on `exit 3`, no-cd keeps the dir, reset, deleted dir falls back to the root, symlinked root mapped back, per feature, temp file removed) |
| `capabilities.test.ts` | unit | Fake `ORCH_CLAUDE_HOME` (`.claude.json` user and local servers, repo `.mcp.json`, user/project/plugin skills, `installed_plugins.json` v2): discovery and scopes, redaction, `parseMcpList`, 0600 `mcp.json` and allow rules, connectors drop strict mode and deny the rest, lean skills plugin dir vs full, `rankFiles`, `extractFileRefs`, Referenced files section |

## Fake Claude CLI (`fixtures/fake-claude.mjs`)

An executable stand-in for `claude`. To demo the UI with no token spend:
```bash
ORCH_CLAUDE_BIN=$PWD/server/test/fixtures/fake-claude.mjs npm start
```

**Arguments it reads**
- `-p` → the prompt.
- Role from `<!-- orchestrator-role: X -->` (default developer).
- Fix reason from `<!-- orchestrator-fix: X -->`.
- Title from `**Title:** ...`.
- `--resume <sid>` → reuse that session; otherwise `sess-<random>`.
- `--model` → the model (default `claude-sonnet-5-5`).

**Output (stream-json)**
1. `system/init`.
2. Assistant messages with `[[PROGRESS:…]]` markers and Read/Write/Bash tool uses with results. Each message reports usage of 1200 in, 300 out, 2000 cache creation, 5000 cache read.
3. A final fenced JSON report.
4. `result`: cost 0.0123, 5 turns, `modelUsage` 6000 in / 1500 out.

It exits 0, or 1 on failure; SIGTERM → exit 143.

**Behaviour by role**
- **planner:** a plan mentioning `feature-<slug>.txt`.
- **reviewer:** reads `git log`, then a verdict. `changes` adds a major finding on `feature-<slug>.txt`; `approve` adds a nit.
- **developer and tester:** write and commit a file:

  | Run | File | Commit message |
  |---|---|---|
  | tester | `test-<slug>.test.txt` | `test: <title>` |
  | fix | `fix-<reason>.txt` | `fix(<reason>): <title>` |
  | other | `feature-<slug>.txt` | `feat: <title>` |

  The developer also edits `src/math.js` if it exists. Reports: tests passed 3, `docs_updated: ['agent-docs/features.md']`.

**Env knobs**

| Var | Effect |
|---|---|
| `FAKE_CLAUDE_DELAY_MS` | Delay between steps (default 150) |
| `FAKE_CLAUDE_FAIL=1` | `error_during_execution`, `is_error`, exit 1 |
| `FAKE_CLAUDE_CLARIFY=<role>` | That role returns `needs_clarification` until the prompt contains "Answers to your questions" |
| `FAKE_REVIEW_VERDICT` | `approve` (default), `changes`, or `changes_once` (requests changes until a `fix(review)` commit exists) |
| `FAKE_CLAUDE_ARGS_DIR` | Writes `{args, cwd, role}` JSON per invocation, so tests can assert CLI flags |

If you change prompt markers, report schemas or CLI flags, update the fake and its tests together.

## Added by Kanbot

- **`workflow.test.ts`** (e2e): backlog chat → decision card → issue created; Build with the default pipeline
  (plan → develop → review ⇄ fix → preflight) → PR Open with human-action tags; PR refresh (CI, `migration-applied`,
  merged → Done); issue import, dependencies, edits and closes from GitHub; no token → "Ready for a pull request" →
  `continuePipeline`. It has its own GitHub double with issues and pull requests in one number sequence.
- **`pipeline.unit.test.ts`**: "issue → PR workflow steps" covers the default decisions, the review loop limit and the
  preflight. The older suites pin the classic pipeline explicitly (`preflight: false`, `autoCreatePr: false`, …), and wait
  for "Ready for a pull request" where they used to wait for Done.
- Test repositories redirect the GitHub URL to a local bare repository with `url.<bare>.insteadOf`, so fetch and push stay local.
- **fake-claude knobs:** `FAKE_WRITER_DECISION=1` (the writer asks one decision first), `FAKE_TESTS_NOT_RUN` (a command the
  preflight reports as not run). The writer role drafts an issue; a developer prompt with the preflight marker reports
  `pr_title`, `pr_body` and `human_actions`; a title containing "migration" makes the developer add
  `supabase/migrations/…`. A resumed session remembers its ticket's title. Invocations without `-p` exit at once.
- **`fake-github.mjs`**: standalone GitHub double for UI demos:

  ```bash
  node server/test/fixtures/fake-github.mjs 4999 &
  ```

  ```bash
  ORCH_GITHUB_API_URL=http://127.0.0.1:4999 ORCH_CLAUDE_BIN=$PWD/server/test/fixtures/fake-claude.mjs npm start
  ```

  Demo controls: `POST /_demo/merge/<pr>`, `POST /_demo/label/<pr>/<label>`, `POST /_demo/checks/<success|failure|pending>`.
