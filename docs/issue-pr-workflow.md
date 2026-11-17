# Issue → PR workflow

Source files: `server/src/issues.ts` (issue sync, PR refresh, publishing), `server/src/chat.ts` (chat store),
`server/src/humanActions.ts` (human-action rules), `server/src/orchestrator.ts` (`chat`, `startChat`, `finishRefine`,
`freshBase`, `postPlan`, `complete`), `server/src/pr.ts`, `server/src/prompt.ts` (`buildRefinePrompt`, `buildRefineReplyPrompt`,
`buildPreflightPrompt`), `web/src/components/TicketPanel.tsx`

This is what Kanbot adds to Kanbuild. A ticket is a GitHub issue; it travels **Backlog → Build → PR Open → Done**.

```
Backlog   chat with the writer agent → decision cards → GitHub issue (created or updated)
Build     plan (Opus) → [plan gate if manual] → implement (Sonnet) → validate ⇄ fix
          → review (Opus) ⇄ fix (Sonnet) until approved (max rounds) → PR preflight (Sonnet) → validate
PR Open   branch pushed, PR opened, human-action tags; CI state and labels followed by the sync
Done      the pull request was merged by the human (or the issue was closed on GitHub)
```

## Source of truth

- **GitHub issues are the tickets.** `syncProject` imports every open issue (pull requests are filtered out) as a Backlog
  card, and overwrites title, body and labels of known tickets with GitHub's.
- Edits on the board go to GitHub: `PATCH /features/:id` with a changed title or description calls `publishIssue`.
- A ticket without `issueNumber` is a **local draft**. It becomes an issue when the writer's draft is ready, when
  "Create issue now" is clicked, or when the card is moved into Build (the route publishes it first when a token exists).
- Without a token the board still works: tickets stay local, the pipeline runs, and the card waits in Build for "Create PR".
- The SQLite database only adds what GitHub does not hold: runs, chat, drafts, human-action ticks, column positions.

## Backlog chat (`refine` runs, role `writer`)

- `POST /projects/:id/features {brainstorm: true}` creates the ticket and calls `orchestrator.startChat`: the ticket's text
  becomes the first user message and a `refine` run is queued. `POST /features/:id/chat {message, answers}` continues it;
  `answers` maps decision-card ids to the chosen option (or free text) and is recorded on the cards by `answerDecisions`.
- A refine run:
  - belongs to **cycle 0**, so it never appears in a build pipeline (`nextStep` returns `idle` for it);
  - runs in the **main checkout** (`project.path`), read-only (`isReadOnlyRole('writer')`), with no worktree;
  - does **not** take an agent slot (like validation), so the chat stays responsive while builds run;
  - resumes the ticket's own Claude Code session (`features.chat_session_id`), separate from the build session.
- The writer's final JSON: `{reply, decisions[], issue{title, body, size, labels, depends_on}, ready}`.
  `finishRefine` posts `reply` and the decision cards as an assistant message, stores `issue` as `feature.draft`
  (and as the ticket's title and text while no issue exists), and, when `ready` is true and no decision is open, calls
  `publishIssue`. Open decisions raise an attention notification and a "n decisions" chip on the card.
- The prompt tells the writer to follow the repository's own issue-writing skill (`.claude/skills/write-issue/SKILL.md`) when
  it exists, by reading it; otherwise to use the sections Why / What / Edge cases / Data / Acceptance, a size, and
  "Depends on #n". It must name real files and settle what it can settle itself.
- `publishIssue` creates or updates the issue. It appends `**Size:** X` when neither a size label nor a size line is present,
  appends `Depends on #n` for draft dependencies missing from the body, and keeps existing labels when updating.
- The chat is only available in the Backlog. A ticket with open decisions cannot be moved into Build (409).

## Issue sync (`syncProject`)

1. `projectRepo`: `owner/repo` from the remote; stored as `project.repoSlug`.
2. Open issues, oldest first: unknown → new Backlog ticket; known → `applyIssue` copies title, body, labels and state.
   A ticket in Done whose issue was reopened (and whose PR was not merged) goes back to Backlog.
3. `Depends on #n` / `Blocked by #n` lines in the body set the ticket's dependencies (`dependsOnIssues`,
   `setDependenciesByIssue`). A body without such a line leaves hand-made dependencies alone.
4. Tickets whose issue is no longer in the open list are fetched one by one; a closed issue moves a **Backlog** card to Done.
5. Tickets in Build or PR Open with a PR number go through `refreshPr`.

Runs on `POST /projects/:id/sync` (the Sync button) and from the background loop (`settings.syncIntervalSec`, default 60 s).
One sync per project at a time (409 otherwise).

## PR Open and Done (`refreshPr`)

- `pr.state`: `merged` (→ card moves to **Done**, success notification), `closed` (stays in PR Open with a "PR closed" tag,
  attention notification once), or `open`.
- `pr.checks`: combined check runs of the head commit. A change to `failing` notifies once. A token without the Checks
  permission simply gets no CI tag.
- Human actions follow the PR's labels (below).
- Moving a card to PR Open by hand is refused unless it has a PR. Moving an open PR's card to Done by hand asks first.

## Human actions

A human action is a step only the human may take before the PR merges. Open ones show as a bold amber
"YOU: <label>" tag on the card, as a panel at the top of the ticket, in the PR description, and in the PR notification.

| Source | Where it comes from |
|---|---|
| `rule` | `pipeline.humanActionRules`: a changed path matches a rule's glob (`**` any depth, `*` within a folder; a folder pattern matches everything below it). Default rule: `supabase/migrations/**` → "Migration", done-label `migration-applied` |
| `agent` | The preflight report's `human_actions` (for example "check the preview on a real phone") |
| `tests` | The preflight report's `tests.not_run` (for example tests that need Docker) → "Run tests locally" |
| `github` | A PR label matching `cannot auto-merge`, `needs human`, `human action` or `manual step`, unless an existing action's label is contained in it |

- A rule with a `doneLabel` is ticked when that label is on the PR and unticked when it is not (`applyDoneLabels`).
  Other actions are ticked by hand (`PATCH /features/:id/human-actions`).
- Agents can never perform these steps: `ALWAYS_DENIED` (`launch.ts`) blocks `git push`, `gh` and every `supabase db push`
  form in all roles, GitHub tokens are stripped from agent environments (`childEnv`), and every code-changing prompt repeats
  the hard rules.

## Build specifics

- **Fresh base, never stacked.** See [git-worktrees-validation.md](git-worktrees-validation.md).
- **Models.** `ROLE_DEFAULT_MODEL` gives Opus to the writer, planner and reviewer and Sonnet to the developer and tester,
  unless the role, the project or the global settings name a model.
- **Plan.** With `planApproval` off (the default, "Implement automatically") the developer resumes the planner's session as
  soon as the plan is written. The plan is posted as a comment on the issue (`postPlan`, `pipeline.postPlanToIssue`).
- **Review loop.** Up to `maxReviewLoops` (default 5) review ⇄ fix rounds; then the pipeline stops with
  "Needs a human" (or opens the final-approval gate when that is on).
- **PR preflight** (`preflight` run, developer, resumed session). The base is fetched first. The prompt tells the agent to
  follow the repository's `.claude/skills/pr-preflight/SKILL.md` when it exists (reporting instead of pushing or asking in a
  chat), else: merge `<remote>/<base>`, pick and run tests by what changed, update what CLAUDE.md requires, fill in the
  repository's PR template, and list human actions. Questions (such as a "What's new" entry) come back as a clarification
  gate; a question may carry options, shown as buttons. After the preflight only validation runs again.
- **Completion.** `complete()` opens the PR (see [github-prs.md](github-prs.md)). Without a token, or with `autoCreatePr` off,
  the card stays in Build as "Ready for PR".

## Tests

`server/test/workflow.test.ts` runs all of this against the fake Claude and an in-process GitHub double.
`server/test/fixtures/fake-github.mjs` is a standalone double for UI demos (see [testing.md](testing.md)).
