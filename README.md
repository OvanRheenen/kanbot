# Kanbot

A local-first Kanban board for building software with **Claude Code** agents, driven by **GitHub issues**.
Every ticket is an issue. It moves through four columns:

| Column | What happens |
|---|---|
| **Backlog** | Your open issues, synced from GitHub. For a new idea, chat with a writer agent (Opus). It reads the code, writes the issue with real file names and Why / What / Edge cases / Data / Acceptance sections, a size and any "Depends on", and asks you about real choices as **decision cards**. Once nothing is open, it creates or updates the issue on GitHub. |
| **Build** | Drag a ticket here. In the ticket's own git worktree, on a fresh branch from `main`: a planner (Opus) plans it and posts the plan on the issue; an implementer (Sonnet) builds it; a reviewer (Opus) and the implementer go back and forth until nothing is left; a PR preflight merges `main`, runs the tests the change needs, updates docs and fills in your PR template. Tickets build in parallel. |
| **PR Open** | The branch is pushed and a pull request opened, assigned to you and closing the issue. Steps only you may take, such as applying a database migration or running tests that need Docker, show as bold **YOU:** tags. CI state and PR labels are followed. |
| **Done** | You merged the pull request. Agents never merge. |

Kanbot is a fork of **[Kanbuild](https://github.com/kanbuild/kanbuild)** by nelsonng2002. The board, the agent runner,
worktrees, the pipeline state machine, the diff viewer, the Terminal tab and most of the dashboard are Kanbuild's work.
See [Credits](#credits) for what Kanbot changed.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`; no native modules to compile)
- `git`
- [Claude Code](https://code.claude.com) CLI on your `PATH` (`claude`), already authenticated
- macOS or Linux (agents are launched through `/bin/sh`)
- A local clone of a GitHub repository, and a GitHub **personal access token** (fine-grained: *Contents*, *Issues* and
  *Pull requests* read & write, plus *Checks* read for the CI tag; classic: `repo`)

## Getting started

```bash
npm install
```

```bash
npm run build && npm start
```

Open <http://localhost:4317>. For development with hot reload, run `npm run dev` instead (backend on :4317, Vite on <http://localhost:5173>).

1. **Settings → GitHub**: paste your token. It is checked, stored with `0600` permissions, and never shown to agents.
2. **Add project**: the path of your local clone. Kanbot reads `owner/repo` from its `origin` remote.
3. **Sync**: open issues appear in the Backlog. The board syncs every minute after that (Settings).
4. **New ticket**: type what you want. With *Brainstorm* on, the writer agent drafts the issue with you in the ticket's chat.
5. Drag the ticket into **Build**. Open it to follow the plan, the review rounds and the diff live.
6. When it reaches **PR Open**, do the tagged steps, review and merge on GitHub. The card moves to **Done**.

Per project (**Project settings → Pipeline**) you choose whether implementation starts automatically after the plan or waits
for your approval, the number of review rounds, the validation commands, PR reviewers, and the **human-action rules**
(by default: a change under `supabase/migrations/` gets a "Migration" tag that clears when the PR gets the
`migration-applied` label).

The rest of this README is Kanbuild's technical reference, updated where Kanbot behaves differently.
The full Kanbot flow is in [docs/issue-pr-workflow.md](docs/issue-pr-workflow.md).

## How it works

```
React (Vite, Tailwind, shadcn/ui, dnd-kit)
   │  REST + WebSocket (/api, /ws) on 127.0.0.1
Node.js backend (Express, ws, node:sqlite)
   ├─ Project / Feature managers         server/src/projects.ts, features.ts
   ├─ Agent orchestrator + queue         server/src/orchestrator.ts
   ├─ Pipeline state machine             server/src/pipeline.ts
   ├─ Validation runner                  server/src/validation.ts
   ├─ MCP/skill catalog + launch wiring  server/src/catalog.ts, capabilities.ts
   ├─ Repository file search (@refs)     server/src/files.ts
   ├─ Dependencies / stacking            server/src/dependencies.ts
   ├─ Diff parser                        server/src/diffParse.ts
   ├─ Notifications                      server/src/notify.ts
   ├─ GitHub (token, push, PRs)          server/src/github.ts, pr.ts
   ├─ Process runner + log tailer        server/src/runner.ts
   ├─ stream-json parser (progress/usage)server/src/streamParser.ts
   ├─ Pricing / cost estimates           server/src/pricing.ts
   ├─ Report generator                   server/src/report.ts
   └─ Git worktree manager               server/src/git.ts
        │
        ├─ claude -p … --output-format stream-json   (one detached process per feature)
        └─ ~/.kanbot/  (SQLite DB + per-run logs)
```

### Agent lifecycle

When a card enters Build, Kanbot does the following for each agent step of the pipeline:

1. Creates a run in the **Queued** state. The queue is stored in SQLite and runs in FIFO order, up to the concurrency limit (default **2**, set under Settings).
2. Enters **Initialising**: it fetches the base branch, creates `feat/<issue>-<slug>` from `origin/<base>` and adds the worktree `<repo>-worktrees/feat-<issue>-<slug>`.
3. Enters **Running**: it launches `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools …` with the worktree as its working directory.
   - The prompt contains only the feature's requirements and instructions for how to work: commit the changes, print progress milestones, and end with a JSON report.
   - Claude Code finds the project context itself (`CLAUDE.md` files, `agent-docs/`, READMEs, the code).
4. Reads the NDJSON stream as it arrives and pulls out the session ID, model, current activity, tool events, token usage and milestones.
5. On exit, collects the git changes (commits, created/modified/deleted files, uncommitted work) and parses the agent's JSON self-report. It then builds the markdown implementation report.
6. Sets the run to **Completed**, **Failed** (the card stays in Build with **Retry**) or **Cancelled**. When a run completes, the pipeline decides the next step: another run, a checkpoint, or Done (see below).

### Pipeline and agent roles

Each pipeline step is a separate run, shown in the **Pipeline** tab with its own status, activity, cost and report:

```
plan → (approve plan, optional) → develop → validate ⇄ fix → (tests) → review ⇄ fix → PR preflight → validate → (final approval) → PR Open → merged by you → Done
                any agent may stop with questions → (your answers) → the same session continues
```

| Role | What it does | Session | Permissions |
|---|---|---|---|
| **Writer** | Backlog chat: drafts the GitHub issue and asks decision cards (Opus by default) | Its own per-ticket session, in the main checkout | read-only |
| **Planner** | Reads only what it needs and writes an implementation plan | New; the developer then **resumes it**, so the plan and exploration are not re-read | read-only |
| **Developer** | Implements the plan; fixes validation failures, review findings and your feedback | One session for plan → implement → fixes | edits + project allowlist |
| **Validator** | Kanbot runs the validation commands itself, with no agent and no tokens | — | — |
| **Tester** | Adds and runs tests for the feature | New, independent | edits + project allowlist |
| **Reviewer** | Reviews `git diff <base>...HEAD` against the requirements and returns a verdict and findings | New, independent | read-only |

- **Read-only roles** run with `--permission-mode default`, `--tools Read,Glob,Grep,Bash`, `--disallowedTools Edit,Write,NotebookEdit` and a read-only command allowlist (git diff/log/show, ls, cat, grep…).
- **Toggling steps:** under **Project settings → Pipeline** you can switch each step on or off. Kanbot's defaults: plan (implementation starts without waiting for approval), validation, reviewer, PR preflight and an automatic pull request. Tester and final approval are off.
- **Fix rounds:** validation failures go back to the developer up to *max validation fixes* (default 2), review findings up to *max review rounds* (default 5). After that the pipeline stops with the results visible. If final approval is on and the reviewer still wants changes, you decide instead.
- **Roles:** each role can have its own model and effort (for example the reviewer on `sonnet`, effort `low`).
- **Retry** re-runs only the step that failed, not the whole pipeline. Every decision is derived from the run history stored in SQLite, so pipelines survive backend restarts.

**Validation commands** are configured per project. When none are configured they're auto-detected:

- `package.json` scripts: `typecheck`, `test`, `build` (npm/pnpm/yarn by lockfile); dependencies are installed first if the worktree has no `node_modules`, without writing a lockfile;
- `cargo test`;
- `go vet` / `go test`.

They run with a timeout of 10 minutes per command, stop at the first failure, and the output tail is sent to the developer's fix prompt.

**Measured on a real run** (Claude Code CLI 2.1, the "Power function" feature on a tiny Node repo, default pipeline, lean profile):

| Run | Turns | Context/turn | Est. cost |
|---|---|---|---|
| Plan (planner) | 3 | 7.5k → 8.0k | $0.058 |
| Develop (resumed the planner's session) | 5 | 10.8k → 13.9k | $0.172 |
| Validation ×2 (`npm test`) | — | — | $0 |
| Tests (tester, new session) | 6 | 8.4k → 12.1k | $0.105 |
| **Total** (66 s) | | | **$0.335** |

A reviewer on `claude-sonnet-5-5` with effort `low` reviewed the next feature in 2 turns for $0.032.

### Tests that hang

Agents run the project's tests themselves, so a test command that never exits stalls the whole run. Watch mode, open handles and watchman's macOS file-access prompt are the usual causes. Several things guard against this:

- **Prompt rules:** agents are told to use the project's validation commands, never start watch mode or dev servers, pass `--watchAll=false --watchman=false --forceExit --maxWorkers=2` to Jest, and cap each command at 5 minutes. A command that hangs gets reported instead of retried with a longer timeout.
- **Watchdog:** if an agent produces no output for 5 minutes (`ORCH_STALL_WARNING_MS`), its run gets a warning and you get a notification, so you can cancel it.
- **Monorepos:** only the repository root is auto-detected. If the app lives in a subfolder, set the validation commands yourself (Project settings → Pipeline), for example `cd mobile && npx jest --watchAll=false --watchman=false --forceExit --maxWorkers=2`. Agents are then told to use the same commands.

### Approval checkpoints and clarification questions

When the pipeline pauses, the card shows a highlighted chip and the sidebar shows "*n* waiting":

- **Approve plan:** read the plan (markdown). **Approve and implement**, optionally with comments for the developer, or **Request plan changes**, which revises the plan in the same session.
- **Needs your input:** any agent may stop and list questions (`needs_clarification` in its report) when a wrong guess would waste significant work. You answer in the panel, and the agent's own session resumes with your answers.
- **Awaiting approval** (final, optional): review the diff, then **Approve → open PR** or **Request changes**, which starts a developer fix run.

**Stop pipeline** closes a checkpoint. Checkpoints are stored in the database and survive restarts.

### Ticket dependencies

A ticket's **Depends on** comes from "Depends on #12" lines in its issue, or from the ticket dialog; cycles are rejected.
A dependent ticket can be moved to Build at any time. It waits with "Blocked by …" until its dependencies are **Done**
(merged), then branches from the fresh base like any other ticket. Kanbot never stacks branches: one ticket, one branch,
one pull request into the base branch.

### Diff viewer

The **Changes** tab shows the worktree's diff relative to its merge-base with the base, including uncommitted and untracked files. It has:

- unified or split view;
- a file list;
- scope: all changes, committed only, uncommitted only, or a single commit;
- collapsible files, with large diffs loaded per file.

Clicking a review finding (`file:line`) jumps to that line.

### Desktop notifications

You're notified when a checkpoint opens, a step fails, a pipeline completes or a PR is created. In **Settings → Notifications** choose *Everything*, *Only when I need to act* or *Off*, and enable browser notifications. When the tab is in the background you get a desktop notification, which opens the card when clicked; otherwise you get a toast. On macOS the backend also shows a system notification (via `osascript`) when no dashboard tab is open.

### GitHub issues and pull requests

- The token is checked against `GET /user` and stored in `~/.kanbot/github-token` with mode `0600`. `ORCH_GITHUB_TOKEN` overrides it.
- It is never returned to the browser, never passed to agents or validation commands, and never written to logs.
- Issues are the tickets: a sync imports open issues and overwrites ticket text with GitHub's; edits on the board update the issue.
- When the pipeline finishes, Kanbot pushes the branch (`GIT_ASKPASS` helper, never forced) and opens a pull request into
  the base branch with the preflight's title and body, `Closes #<issue>`, and a checklist of human actions. It assigns
  the PR to you and requests reviewers if configured. An open PR for the branch is reused and its description updated.
- PRs are never merged by Kanbot. A merged PR moves the card to Done on the next sync.

### Agent profiles and token use

Every API turn re-sends the agent's whole context, so the token count grows with *turns × context size*. Most of it is **cache re-reads**, which are billed at roughly 5–10% of the input price. The dashboard keeps these apart:

- **New tokens:** input + cache write + output.
- **Cache re-reads**, shown separately.
- **Turns**, and the **context per turn** at the start and at its peak.
- **Denied tool calls**: each one usually costs an extra turn.

Agents run the normal Claude Code harness in headless mode (`claude -p`). The profile decides how much of your configuration they load:

| Profile | What the agent gets | Context per turn at start (measured) |
|---|---|---|
| **lean** (default) | `--tools Read,Edit,Write,Glob,Grep,Bash`, `--disable-slash-commands`, `--strict-mcp-config` (no user MCP servers), and `--setting-sources project,local`. The repository's CLAUDE.md and `.claude/settings.json` still load; `~/.claude` plugins, hooks and global CLAUDE.md do not. | ~7.7k tokens |
| **full** | Exactly what an interactive session gets: all built-in tools, skills, plugins, MCP servers, hooks and the global CLAUDE.md. | ~35k tokens |

**Settings** also has effort (`--effort`, default `medium`) and a per-run hard budget (`--max-budget-usd`). Projects can override the profile and effort, and pass their own MCP servers with `--mcp-config`. Project settings show the exact command line agents will run.

The prompt defers to the repository's own documentation workflow. CLAUDE.md decides which docs, such as `agent-docs/`, the agent reads and keeps up to date. The prompt asks the agent to read only the relevant docs, prefer them over exploring the code, and report `docs_updated`. It also lists the allowed shell commands, so the agent doesn't waste turns on commands that will be denied.

### MCP servers and skills

**Project settings → MCP servers & skills** lists what your local Claude Code knows about:

- MCP servers from `~/.claude.json` (user and local scope), the repository's `.mcp.json`, installed plugins and `claude mcp list` (which adds connection status and claude.ai connectors);
- skills from `~/.claude/skills`, the repository's `.claude/skills` and installed plugins.

Search the lists and tick the servers and skills this project's agents may use. If nothing is selected, the profile default applies: lean loads no MCP servers or skills, and full loads everything. Selected servers are written to a per-run `--mcp-config` file (mode 0600, stored with the run) and loaded with `--strict-mcp-config`, and their tools are added to `--allowedTools`. claude.ai connectors can't be exported to a file. Selecting one therefore drops `--strict-mcp-config`, and the servers you didn't select are blocked through `--disallowedTools` instead. In the lean profile, selected user and plugin skills are loaded through a session-only `--plugin-dir` (`orch-skills:<name>`), and the `Skill` tool is enabled. The launch preview shows the resulting command.

### Referencing files in descriptions

Type `@` in a feature description or follow-up message to search the repository's files (`git ls-files`, including untracked files that aren't ignored). Press ↑/↓ and then Enter to insert `@path/to/file`. Referenced files appear as chips under the text. The prompt also gets a **Referenced files** list that tells the agent to read those files first, with a note on any path that doesn't exist in the base checkout.

### Continuing a session

Each run records its Claude Code session ID. From a card's **Overview** tab you can continue in two ways:

- **Send follow-up** runs `claude -p "<message>" --resume <sessionId>` in the same worktree, in the background. You get the same live monitoring, a new report, and "Follow-up #n" in the run history.
- **Continue in terminal** gives you `cd <worktree> && claude --resume <sessionId>` to copy. On macOS, **Open in Terminal** opens Terminal.app with that command. Sessions must be resumed from the worktree directory.

When Kanbot itself is started from inside a Claude Code session, the agents would inherit that session's ID. Kanbot strips those session variables, so every agent gets its own session.

### Open in editor

Pick an editor preset in Settings: VS Code (default), Cursor, Zed, WebStorm, IntelliJ, Finder, or a custom command. Kanbot looks for the editor's CLI in these places, in order:

1. Your `PATH`.
2. `/usr/local/bin`, `/opt/homebrew/bin`, and the CLI inside the app bundle.
3. On macOS, it falls back to `open -a "<App>"`.

So VS Code opens even if the `code` shell command isn't installed.

### Background execution and recovery

Agents run as **detached** process groups. Their stdout and stderr go straight to files under `~/.kanbot/runs/<runId>/`, and a small shell wrapper records the exit code. This means:

- Closing the browser has no effect on running agents.
- Stopping or restarting the backend has no effect on them either. On startup the backend reconciles each unfinished run:
  - If the process is still alive, it reattaches the log tailer and rebuilds the parser state from the log.
  - If the process finished while the backend was down, it finalizes the run normally from the log and exit code.
  - If the process died without a result, it marks the run **Failed** ("terminated unexpectedly").
  - Queued runs, and runs that were still initialising, go back into the queue.
- **Cancel** sends SIGTERM to the agent's process group, then SIGKILL after 5 seconds.

### Progress

Claude Code does not report a completion percentage, so the progress bar uses the milestone markers the agent is asked to print:

| Marker | Progress |
|---|---|
| `[[PROGRESS:planning]]` | 15% |
| `[[PROGRESS:implementing]]` | 40% |
| `[[PROGRESS:testing]]` | 70% |
| `[[PROGRESS:finalizing]]` | 90% |

Until the first marker arrives, the bar is **indeterminate** rather than showing an invented percentage. The current stage and activity come from tool events, for example "Editing src/app.ts" or "Running: npm test".

### Tokens and cost

Usage comes from Claude Code's structured metadata: per-message `usage`, then the final `result.modelUsage`. It covers input, output, cache write (split by 5-minute and 1-hour TTL) and cache read tokens.

Each run shows two cost figures:

- **Estimated cost**: computed from the pricing table in `server/src/pricing.ts`, which has per-model list prices including cache pricing.
- **Reported cost**: Claude Code's own `total_cost_usd`.

Both are **estimates, not actual charges**. Claude subscription plans (Pro/Max/Team) are not billed per token.

### Safety

- The backend listens on `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not localhost, which protects against DNS rebinding and cross-site requests.
- Agents run with `--permission-mode acceptEdits` and a per-project **allowlist** of tools (editable in Project settings). Anything not on the list is denied. Kanbot never uses `--dangerously-skip-permissions`.
- Every agent works in its own worktree, so the original working directory is never touched.
- Branches are **never merged** automatically, and completed worktrees are kept for review. The orchestrator opens pull requests (unless automatic PRs are off) and never force-pushes.
- Agents can't push, run `gh` or apply Supabase migrations: those commands are denied for every role, GitHub tokens are stripped from their environment, and every prompt repeats the rule.
- The writer, planner and reviewer run read-only. Validation commands run in the worktree with the agent session variables and the GitHub token stripped from their environment.
- The GitHub token is stored with `0600` permissions. It is never sent to the browser, never passed to agents and never logged.
- Removing a worktree is refused if it has uncommitted changes, unless you explicitly confirm a second prompt.
- Deleting a feature or removing a project only removes dashboard data. Repositories, branches and worktrees on disk stay.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ORCH_PORT` | `4317` | Backend port |
| `ORCH_HOST` | `127.0.0.1` | Bind address (keep it local) |
| `ORCH_DATA_DIR` | `~/.kanbot` | SQLite DB and run logs |
| `ORCH_CLAUDE_BIN` | `claude` | Claude Code binary (overrides the Settings value) |
| `ORCH_GITHUB_TOKEN` | — | GitHub token (overrides the one stored from Settings) |
| `ORCH_GITHUB_API_URL` | `https://api.github.com` | GitHub API base (GitHub Enterprise: `https://<host>/api/v3`, detected from the remote) |

Under **Settings**, the app also lets you set the agent profile, effort, a budget per run, the concurrency limit, the default model, the editor and the Claude binary. **Project settings** cover the base branch, the worktree directory, a model override and the allowed tools.

## Testing

```bash
npm test
```

The test suite includes end-to-end tests of the orchestrator against temporary git repositories. They use `server/test/fixtures/fake-claude.mjs`, a stand-in that emits realistic `stream-json` and plays each role: read-only planner and reviewer, developer and tester that commit files. The tests cover:

- the concurrency limit and queue, worktree isolation, reports, and failure, retry and cancel;
- the full pipeline: plan → approval → develop → failing validation → fix → tester → Done, with the session reused across the planner, developer and fixes;
- the fix-round limit, and retrying the failed step;
- clarification questions and answers resuming the same session;
- review → fix → re-review → final approval → a PR opened against a mock GitHub API, with the branch pushed to a bare remote;
- dependencies: waiting until Done, never stacking;
- the issue → PR workflow: backlog chat and decision cards, issue creation, plan → develop → review ⇄ fix → preflight → PR Open with human-action tags, CI and label tracking, merge → Done, and the issue sync;
- checkpoints surviving a restart;
- the diff API.

Unit tests cover the pipeline state machine, the diff parser, cycle detection, remote parsing, role arguments, prompts, notification escaping and validation detection.

To try the UI without spending tokens, run:

```bash
node server/test/fixtures/fake-github.mjs 4999 &
```

```bash
ORCH_GITHUB_API_URL=http://127.0.0.1:4999 ORCH_CLAUDE_BIN=$PWD/server/test/fixtures/fake-claude.mjs npm start
```

## API

Kanbot adds `POST /api/projects/:id/sync`, `GET/POST /api/features/:id/chat`, `POST /api/features/:id/chat/start`,
`POST /api/features/:id/issue` and `PATCH /api/features/:id/human-actions` (see [docs/api.md](docs/api.md)).


- `PUT /api/features/:id/dependencies` (`{ dependsOn: [...] }`)
- `POST /api/features/:id/gate` (`{ action: approve | reject | answer, comment?, answers? }`)
- `GET /api/features/:id/diff?scope=all|committed|uncommitted|commit:<sha>&file=`
- `POST /api/features/:id/pr`
- `GET/PUT /api/settings/github`, `POST /api/notifications/test`
- `GET /api/projects/:id/validation-preview`
- `GET/POST /api/projects`
- `PATCH/DELETE /api/projects/:id`
- `POST /api/projects/validate`
- `GET/POST /api/projects/:id/features`
- `POST /api/projects/:id/reorder`
- `GET/PATCH/DELETE /api/features/:id`. A `PATCH` with `status: "build"` starts the pipeline.
- `POST /api/features/:id/{cancel,retry,open,reveal,open-terminal}`
- `POST /api/features/:id/followup` (`{ message }`)
- `GET /api/features/:id/session`
- `GET /api/projects/:id/launch-preview`
- `POST /api/catalog` (`{ path, refresh? }`): MCP servers and skills discovered from Claude Code
- `GET /api/projects/:id/files?q=&limit=`: repository file search for `@` references
- `GET /api/features/:id/{runs,changes}`
- `DELETE /api/features/:id/worktree[?force=true]`
- `GET /api/runs/:id/{events,report}`
- `GET/PUT /api/settings`
- WebSocket `/ws`, which pushes `feature.updated`, `run.updated`, `run.event`, `notification` and similar messages.

## Credits

Kanbot is a fork of [Kanbuild](https://github.com/kanbuild/kanbuild) by [nelsonng2002](https://github.com/nelsonng2002),
used under the MIT License. The git history of Kanbuild is kept in this repository, so every upstream commit keeps its
author. Upstream is configured as the `upstream` remote; improvements that are not Kanbot-specific are worth offering back.

What Kanbot changed:

- GitHub issues as the source of truth, with a background sync and a Sync button.
- The backlog chat: a writer agent drafts issues, asks decision cards, and creates or updates the issue.
- The **PR Open** column, PR state, CI and label tracking, and Done on merge.
- The default pipeline: plan (Opus) → implement (Sonnet) → review ⇄ fix until approved → PR preflight → open the PR.
- Human-action tags (path rules such as Supabase migrations, tests the agent could not run, PR labels).
- Branches always from the fresh base branch; no stacking.
- Agents denied `git push`, `gh` and `supabase db push`.
- Kanbuild's macOS (Electron) app and its release workflow were removed; Kanbuild's logo was replaced with Kanbot's own mark.

## License

[MIT](LICENSE). The license keeps Kanbuild's copyright notice next to Kanbot's, as the MIT License requires.
