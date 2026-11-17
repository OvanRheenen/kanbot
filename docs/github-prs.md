# GitHub integration and pull requests

Source files: `server/src/github.ts`, `server/src/pr.ts`, `server/src/issues.ts`, `server/src/humanActions.ts`

The orchestrator **pushes branches, opens PRs, and reads and writes issues**. It never merges, never force-pushes and never deletes branches. Agents never touch GitHub at all (see `ALWAYS_DENIED` in `launch.ts`).

## Token (`github.ts`)

**Sources**
- `getToken()` (line 18): `ORCH_GITHUB_TOKEN` (source `env`) wins over the file `DATA_DIR/github-token` (source `file`).
- The token file is mode 0600, re-applied with chmod after each write.

**Setting the token.** `setToken(token)` (line 36):
- An empty token deletes the file.
- Otherwise the token must match `/^[\w-]{20,255}$/` and pass `GET /user` before it is written.

**Status**
- `githubStatus()` returns `{configured, source, login}` with a cached login.
- `verifyToken()` re-checks the token.

**Exposure**
- Exposed via `GET`/`PUT /api/settings/github`. The token is never returned to the browser.
- The token is stripped from every child process's environment (`childEnv`).

## API client

- **`parseRemote(url)`** (line 68): handles scp-style `git@host:o/r.git`, `ssh://`, `https://` and `git://`. Returns `{host, owner, repo}`.
- **`apiBase(host)`** (line 77):
  - `ORCH_GITHUB_API_URL` if set.
  - Otherwise `https://api.github.com`.
  - For a GHE host: `https://<host>/api/v3`.
- **`ghFetch(method, path, body, token, host)`** (line 82):
  - Bearer token, `X-GitHub-Api-Version: 2022-11-28`, 20 s timeout.
  - Network failure → `GithubError(502, "Could not reach GitHub… network, VPN or proxy")`.
  - 401 → a friendly message.
  - Other errors include the `errors[]` details.
- **`findOpenPr(repo, branch)`**: `GET /repos/o/r/pulls?state=open&head=owner:branch`.
- **`createPullRequest(repo, {head, base, title, body, draft})`**, `getPull`, `updatePull`, `checksState(repo, sha)` (check runs → `failing` > `pending` > `passing`, null when there are none).
- Issues: `listOpenIssues` (pull requests filtered out, up to 500), `getIssue`, `createIssue`, `updateIssue`, `commentOnIssue`, `addAssignees`, `requestReviewers`.
- `tokenLogin()`: the token's user, cached.
- `fetchBranch(cwd, remote, branch)`: authenticated fetch into `refs/remotes/<remote>/<branch>` (2 min timeout).

## Authenticated push

- `askpassScript()` writes `DATA_DIR/git-askpass.sh` (mode 0700). It answers `x-access-token` for the username and `$ORCH_GIT_TOKEN` for the password.
- `gitWithToken(cwd, args)` sets `GIT_ASKPASS` and `ORCH_GIT_TOKEN` only for that one git process. The token never appears in argv or git config, and errors are redacted (`***`).
- **`pushBranch(cwd, remote, branch)`** (line 161): `git push <remote> refs/heads/b:refs/heads/b`. **Never forces.**
- `remoteUrl(cwd, remote)`: a missing remote → 400. `remoteHasBranch`: `ls-remote --heads`.

## Create PR flow (`pr.ts`)

**`createPrForFeature(featureId)`**. Called by `Orchestrator.complete()` when the pipeline finishes (`pipeline.autoCreatePr`,
default on, and a token exists), or by `POST /api/features/:id/pr` ("Create PR").

1. Preconditions: a token (else 400), no active agent (else 409), an existing branch and worktree (else 409).
2. `projectRepo(project)` (`issues.ts`) resolves `owner/repo` from the configured remote URL (`git config remote.<name>.url`,
   so `url.*.insteadOf` rewrites do not hide the GitHub repository). A non-GitHub remote → 400.
3. The base is always `project.baseBranch`. Branches are never stacked.
4. `preflightData` reads the latest cycle's developer reports: PR title and body from the newest report that has a `pr_body`,
   plus `human_actions` and `tests.not_run` from the preflight run onwards. Without a preflight, the body comes from `buildPrBody`.
5. Human actions = `actionsFromRules` (changed paths vs `pipeline.humanActionRules`) + `actionsFromReport`, merged with the stored
   ones by `mergeActions` (`humanActions.ts`). A rule action wins over an agent action with the same label; a step already
   ticked off stays ticked.
6. The body gets `Closes #<issue>` when it has no closing keyword for the ticket's issue, and a
   "Human action required before merging" checklist when any action is open.
7. Push the branch (never forced). Reuse the open PR for the branch (its title and body are updated) or create one with
   `draft = pipeline.prDraft` (default off). A 422 mentioning "draft" retries as a regular PR.
8. On a new PR with `pipeline.assignPr`: assign the token's user and request reviews from `pipeline.prReviewers`
   (empty = the token's user). GitHub refuses a review request from the PR's own author; that is logged as a warning.
9. Store `prUrl`, `prNumber`, `humanActions`, `pr {state: open}` and move a Build card to **PR Open**. Notification:
   attention when human actions are open, success otherwise.
10. Error mapping: `GithubError` 401/400 → HTTP 400; anything else → 502. When the automatic PR fails, the card stays in Build
    with an error event; "Create PR" or "Continue pipeline" retries.

The card reaches **Done** only through `refreshPr` (`issues.ts`) when the pull request is merged. See
[issue-pr-workflow.md](issue-pr-workflow.md).

**PR body fallback.** `buildPrBody(feature, project)` uses the reports from the **latest cycle**: Summary, Requirements and plan
(collapsed), Validation, Tests, Automated review, Documentation updated, Outstanding issues, footer.

## UI

- Settings dialog → GitHub fieldset: connect, replace or remove the token. It shows the login and the token source.
- Detail sheet header: "Create PR" (disabled without a token) or a "PR #N" link. The card footer also shows the PR link.

Tests: `server/test/pipeline.test.ts` covers this against a mock GitHub HTTP server (see [testing.md](testing.md)).
