# CLAUDE.md

## Rules (read these first, every session)

1. **Always read the documentation first. Never read code to learn the codebase.**
   Start with the doc index below and open only the topic doc(s) you need. The docs name the
   exact `file:line` of every important function. Open a source file only to *edit* the
   spot a doc points to. If the docs truly don't cover something, read the minimum code,
   then add what you learned to the docs.
2. **After implementing anything, update the documentation.** Edit every doc whose topic
   you touched: behavior, endpoints, schema, env vars, UI flows, and `file:line` refs that moved.
   If the topic has no doc yet, create `docs/<topic>.md` and add it to the index below.
3. Keep this file at **150 lines or fewer**. Put detail in `docs/`, not here.

## What this app is

**Kanbot** is a fork of [Kanbuild](https://github.com/kanbuild/kanbuild) (MIT): a local-first Kanban board where every ticket
is a GitHub issue. Columns: **Backlog → Build → PR Open → Done**. In the Backlog a writer agent drafts the issue with
the user in a chat (decision cards for open choices). Dragging a ticket into **Build** runs headless Claude Code agents
(`claude -p --output-format stream-json`) in the ticket's own git worktree, branched from the fresh base branch:
plan (Opus) → implement (Sonnet) → validate ⇄ fix → review (Opus) ⇄ fix until approved → PR preflight → open the PR → PR Open.
Human-only steps (migrations, tests that need Docker) become tags on the card. A merged PR moves the card to Done.
Agents never push, merge or apply migrations; the orchestrator pushes and opens the PR, the human merges.
Full flow: [docs/issue-pr-workflow.md](docs/issue-pr-workflow.md). Kanbuild's Electron app was removed; this is web only.

Monorepo layout (npm workspaces, Node ≥ 22.13 for `node:sqlite`):

| Path | What |
|---|---|
| `server/src/` | Express + ws backend, run directly with tsx (no build). Orchestrator, pipeline, agent runner, git, GitHub, SQLite |
| `server/test/` | vitest suites + `fixtures/fake-claude.mjs` (a fake `claude` CLI) and `fixtures/fake-github.mjs` (a fake GitHub API) |
| `web/src/` | Vite + React 18 + Tailwind dashboard (shadcn-style UI, custom store, no router) |
| `shared/types.ts` | Types shared by server and web, `API_VERSION`, WebSocket `ServerMessage` union |
| `docs/` | **The documentation. Read this instead of code.** |

## Commands

```bash
npm install                 # once
npm run dev                 # server :4317 (tsx watch) + Vite :5173 (proxies /api, /ws)
npm start                   # build web, then serve everything on http://127.0.0.1:4317
npm test                    # server vitest suites (needs git on PATH)
npm run typecheck           # tsc --noEmit for server and web
npm run build               # vite build -> web/dist
cd server && npx vitest run test/pipeline.test.ts   # a single test file
ORCH_CLAUDE_BIN=$PWD/server/test/fixtures/fake-claude.mjs npm start   # UI demo, no tokens spent
node server/test/fixtures/fake-github.mjs 4999 &                       # fake GitHub for demos (ORCH_GITHUB_API_URL)
```

## Documentation index

| Doc | Read it when you need… |
|---|---|
| [docs/issue-pr-workflow.md](docs/issue-pr-workflow.md) | **Start here for Kanbot's additions:** backlog chat, issue sync, PR Open/Done, human actions, preflight |
| [docs/architecture.md](docs/architecture.md) | Process model, data flow, data dir layout, **env vars**, startup/recovery, ports |
| [docs/data-model.md](docs/data-model.md) | SQLite schema, migrations, `shared/types.ts` types and enums, IDs, positions |
| [docs/api.md](docs/api.md) | Every REST endpoint, error conventions, WebSocket messages, localhost guard |
| [docs/pipeline.md](docs/pipeline.md) | Feature and run state machines, `nextStep` rules, cycles, fix loops, gates, retry/continue/follow-up/cancel |
| [docs/orchestrator-and-agents.md](docs/orchestrator-and-agents.md) | Scheduling (`tick`), prompt and session choice per run kind, detached runner, child env, stall watchdog, CLI flags (`launch.ts`), stream parser |
| [docs/prompts-and-reports.md](docs/prompts-and-reports.md) | Prompt builders, role markers, report JSON schemas, test-hang rules, `@file` refs, self-report parsing, markdown reports |
| [docs/git-worktrees-validation.md](docs/git-worktrees-validation.md) | Branch and worktree naming, changes and diffs, diff parser, fresh-base branching (no stacking), validation command detection and running, Terminal command runner |
| [docs/github-prs.md](docs/github-prs.md) | GitHub token, authenticated push, remote parsing, PR creation flow and PR body |
| [docs/capabilities-catalog.md](docs/capabilities-catalog.md) | MCP server and skill discovery, redaction, per-run MCP config and skills plugin, allow/deny rules |
| [docs/settings-projects-features.md](docs/settings-projects-features.md) | Global settings, project config and defaults, feature CRUD and moves, dependencies, editor, notifications, pricing |
| [docs/web-dashboard.md](docs/web-dashboard.md) | Frontend stack, store, WebSocket client, API client, every component, styling, UI gotchas |
| [docs/testing.md](docs/testing.md) | How tests are structured and run, isolation pattern, fake-claude knobs, what each suite covers |

## Critical invariants (don't break these)

- **Migrations are append-only.** Never edit an entry in `MIGRATIONS` (`server/src/db.ts`); append a new one.
  The current schema version is 6. Update `docs/data-model.md`.
- **Bump `API_VERSION`** (`shared/types.ts`, now 10) whenever the backend and dashboard must change together.
  The UI shows a reload banner on a mismatch.
- **Imports use explicit `.ts` extensions** (`allowImportingTsExtensions`). Shared types are imported as `@shared/types.ts` in web.
- **The pipeline is a pure function of the DB** (`pipeline.ts` `nextStep` over the cycle's runs and stored reports).
  Keep it that way so pipelines survive restarts. A run only updates its feature while it is `feature.currentRunId`.
- **Agents are detached processes** that survive backend restarts. `recover()` reattaches via log offsets and the exit file.
- **Child env hygiene:** `childEnv()` (`runner.ts`) strips `NODE_ENV`, Claude session vars, GitHub tokens and the
  server's own `NODE_OPTIONS`. Use it for any new child process (agent or validation).
- **Never** pass `--dangerously-skip-permissions`. Never force-push, merge, or delete branches or worktrees automatically.
- **Writer, planner and reviewer are read-only roles** (permission mode `default`, Edit/Write disallowed).
- **Agents never touch GitHub or remote databases.** `ALWAYS_DENIED` (`launch.ts`) blocks `git push`, `gh` and
  `supabase db push` for every role; keep new prompts consistent with `HARD_RULES` (`prompt.ts`).
- **One ticket = one branch = one PR**, from the fresh base branch. Never stack branches; dependencies wait until Done.
- **GitHub is the source of truth for ticket text.** Board edits go to the issue; a sync overwrites with GitHub's text.
- **Localhost only:** non-local `Host` or `Origin` gets a 403, and the WS upgrade is destroyed.
- **React:** hooks must run unconditionally (a past conditional `useStore` blanked the dashboard).
  Store selectors must return stable references (no fresh `[]` or `{}`).
- Env vars like `ORCH_DATA_DIR` and `ORCH_STALL_WARNING_MS` are read **at import time**. Tests set them,
  then use dynamic `await import()`.
- Costs are **estimates** (`pricing.ts`). Label them as such in the UI and reports.

## Conventions

- TypeScript strict everywhere. The server is ESM, run by tsx. There is no linter. Verify with `npm run typecheck` and `npm test`.
- Server errors: throw `HttpError(status, msg)` (`projects.ts`). Route handlers are wrapped in `h()` and respond `{error}`.
- Realtime: publish on `bus` (`events.ts`). Every message must be in the `ServerMessage` union and handled in `web/src/store.ts`.
- New settings: `DEFAULTS` + validation in `settings.ts`, the type in `shared/types.ts`, a field in `SettingsDialog.tsx`.
- New project config: DB column (new migration), `projects.ts` row mapping and cleaning, `Project` type, `ProjectDialog.tsx`.
- New pipeline step: `pipeline.ts` decision, `orchestrator.ts` `start()` prompt/resume, a `prompt.ts` builder,
  `RunKind`/labels in `shared/types.ts` and `web/src/components/status.tsx`, and `PipelineTab.tsx` steps.
- UI: shadcn-style primitives in `web/src/components/ui/`, `cn()` from `lib/utils.ts`, `confirm()` and `toast()` helpers.
- Commit messages: short imperative summary.
- Credit upstream: keep Kanbuild's copyright line in `LICENSE` and the Credits section in `README.md`.

## Docs maintenance checklist (run after every change)

1. Which docs cover the files you changed? Each doc lists its **Source files** at the top. Update them.
2. New endpoint → `docs/api.md`. New env var → `docs/architecture.md`. Schema change → `docs/data-model.md`.
   New UI behavior → `docs/web-dashboard.md`. New test file or fixture knob → `docs/testing.md`.
3. Fix any `file:line` refs that moved noticeably.
4. New topic with no doc → create `docs/<topic>.md` (start with a "Source files" line) and add a row to the index above.
5. Keep this file ≤ 150 lines (`wc -l CLAUDE.md`).
