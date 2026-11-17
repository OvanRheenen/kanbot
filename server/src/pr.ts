import fs from 'node:fs';
import { getFeature, moveFeature, patchFeatureState } from './features.ts';
import { collectChanges } from './git.ts';
import { GithubError, addAssignees, createPullRequest, findOpenPr, getToken, pushBranch, requestReviewers, tokenLogin, updatePull } from './github.ts';
import { actionsFromReport, actionsFromRules, mergeActions } from './humanActions.ts';
import { projectRepo } from './issues.ts';
import { notify } from './notify.ts';
import { HttpError, getProject } from './projects.ts';
import { addEvent, getReport, latestCycle, listCycleRuns } from './runs.ts';
import { ACTIVE_AGENT_STATUSES, type Feature, type Project, type Report } from '../../shared/types.ts';

/** Pull request description assembled from the latest pipeline cycle's reports. */
export function buildPrBody(feature: Feature, project: Project): string {
  const runs = listCycleRuns(feature.id, latestCycle(feature.id));
  const reports = runs.map((r) => ({ run: r, report: getReport(r.id) })).filter((x): x is { run: typeof x.run; report: Report } => !!x.report);
  const dev = reports.filter((x) => x.run.role === 'developer');
  const first = dev.find((x) => x.run.kind === 'feature' || x.run.kind === 'followup') ?? dev[0];
  const lastDev = dev[dev.length - 1];
  const plan = [...reports].reverse().find((x) => x.run.role === 'planner' && x.report.self.plan);
  const tester = [...reports].reverse().find((x) => x.run.role === 'tester');
  const review = [...reports].reverse().find((x) => x.run.role === 'reviewer' && x.report.self.review);
  const validation = [...runs].reverse().find((r) => r.role === 'validator' && r.validation);

  const out: string[] = [];
  out.push('## Summary');
  out.push(first?.report.self.summary || feature.title);
  if (first?.report.self.implementationDetails) out.push('', first.report.self.implementationDetails.slice(0, 4000));
  if (feature.description.trim()) {
    out.push('', '<details><summary>Requirements</summary>', '', feature.description.trim().slice(0, 6000), '', '</details>');
  }
  if (plan) out.push('', '<details><summary>Implementation plan</summary>', '', plan.report.self.plan.slice(0, 8000), '', '</details>');

  if (validation?.validation?.length) {
    out.push('', '## Validation');
    for (const v of validation.validation) out.push(`- ${v.exitCode === 0 && !v.timedOut ? '✅' : '❌'} \`${v.command}\``);
  }
  const tests = (tester ?? lastDev)?.report.self.tests;
  if (tests && (tests.executed.length || tests.passed !== null)) {
    out.push('', '## Tests');
    if (tester?.report.self.summary) out.push(tester.report.self.summary);
    out.push(`- Passed: ${tests.passed ?? 'n/a'} · Failed: ${tests.failed ?? 'n/a'}`);
    if (tests.executed.length) out.push(`- Ran: ${tests.executed.map((c) => `\`${c}\``).join(', ')}`);
  }
  if (review?.report.self.review) {
    const r = review.report.self.review;
    out.push('', `## Automated review: ${r.verdict === 'approve' ? 'approved' : 'changes requested'}`);
    if (r.summary) out.push(r.summary);
    if (r.findings.length) out.push(`- ${r.findings.length} finding(s): ${r.findings.map((f) => f.severity).join(', ')}`);
  }
  const docs = [...new Set(reports.flatMap((x) => x.report.self.docsUpdated))];
  if (docs.length) out.push('', '## Documentation updated', ...docs.map((d) => `- \`${d}\``));
  const issues = lastDev?.report.self.outstandingIssues ?? [];
  if (issues.length) out.push('', '## Outstanding issues', ...issues.map((i) => `- ${i}`));
  out.push('', '---', `_Implemented by Claude Code agents via Kanbot (project ${project.name}). Review before merging._`);
  return out.join('\n');
}

/** What the latest cycle's PR preflight reported: title, body, manual steps, tests it could not run. */
function preflightData(feature: Feature) {
  const runs = listCycleRuns(feature.id, latestCycle(feature.id)).filter((r) => r.role === 'developer' && r.status === 'completed');
  const reports = runs.map((r) => getReport(r.id)).filter((r): r is Report => !!r);
  const withBody = [...reports].reverse().find((r) => r.self.prBody);
  const lastPre = [...runs].reverse().findIndex((r) => r.kind === 'preflight');
  // Reports from the preflight onwards (the preflight itself and any answer / fix runs after it).
  const since = lastPre >= 0 ? reports.slice(reports.length - 1 - lastPre) : [];
  return {
    title: withBody?.self.prTitle ?? '',
    body: withBody?.self.prBody ?? '',
    humanActions: since.flatMap((r) => r.self.humanActions),
    testsNotRun: [...new Set(since.flatMap((r) => r.self.tests.notRun))],
  };
}

const closesIssue = (body: string, n: number) => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+#${n}\\b`, 'i').test(body);

/**
 * Push the ticket's branch and open (or update) its GitHub pull request into the project's base branch,
 * then move the card to PR Open. Never merges, never force-pushes, never stacks on another feature branch.
 */
export async function createPrForFeature(featureId: string): Promise<Feature> {
  if (!getToken()) throw new HttpError(400, 'No GitHub token configured. Add one in Settings → GitHub.');
  const feature = getFeature(featureId);
  if (feature.agentStatus && ACTIVE_AGENT_STATUSES.includes(feature.agentStatus)) {
    throw new HttpError(409, 'Wait for the agent to finish before creating a pull request');
  }
  if (!feature.branch || !feature.worktreePath || !fs.existsSync(feature.worktreePath)) {
    throw new HttpError(409, 'This ticket has no branch/worktree to create a pull request from');
  }
  const project = getProject(feature.projectId);
  const remote = project.pipeline.remote || 'origin';
  try {
    const repo = await projectRepo(project);
    const base = project.baseBranch;
    const runId = feature.currentRunId;
    const log = (msg: string, kind: 'lifecycle' | 'warning' = 'lifecycle') => runId && addEvent(runId, kind, msg);

    const changes = await collectChanges(feature.worktreePath, feature.branch, feature.baseRef || base);
    if (changes.hasUncommittedChanges) log('The worktree has uncommitted changes; they are not part of the pull request', 'warning');
    const pre = preflightData(feature);
    const humanActions = mergeActions(feature.humanActions, [
      ...actionsFromRules(project.pipeline.humanActionRules, changes.files.map((f) => f.path)),
      ...actionsFromReport(pre.humanActions, pre.testsNotRun),
    ]);

    const title = pre.title || feature.title;
    let body = pre.body || buildPrBody(feature, project);
    if (feature.issueNumber && !closesIssue(body, feature.issueNumber)) body += `\n\nCloses #${feature.issueNumber}`;
    const open = humanActions.filter((a) => !a.done);
    if (open.length) {
      body += `\n\n## ⚠️ Human action required before merging\n${open.map((a) => `- [ ] **${a.label}**: ${a.detail}`).join('\n')}`;
    }

    log(`Pushing ${feature.branch} to ${remote}`);
    await pushBranch(feature.worktreePath, remote, feature.branch);
    let pr = await findOpenPr(repo, feature.branch);
    let draft = project.pipeline.prDraft;
    if (!pr) {
      const req = { head: feature.branch, base, title, body, draft };
      try {
        pr = await createPullRequest(repo, req);
      } catch (err) {
        // Draft PRs aren't available on every plan; fall back to a regular PR.
        if (err instanceof GithubError && err.status === 422 && /draft/i.test(err.message) && req.draft) {
          draft = false;
          pr = await createPullRequest(repo, { ...req, draft: false });
        } else throw err;
      }
      log(`Pull request #${pr.number} created: ${pr.html_url}`);
      if (project.pipeline.assignPr) {
        const login = await tokenLogin();
        if (login) {
          await addAssignees(repo, pr.number, [login]).catch((err) => log(`Could not assign the pull request to ${login}: ${err.message}`, 'warning'));
          const reviewers = project.pipeline.prReviewers.length ? project.pipeline.prReviewers : [login];
          await requestReviewers(repo, pr.number, reviewers).catch((err) =>
            log(
              reviewers.length === 1 && reviewers[0] === login
                ? `Review not requested from ${login}: GitHub does not let a pull request's author review it. The PR is assigned to you instead.`
                : `Could not request a review from ${reviewers.join(', ')}: ${err.message}`,
              'warning',
            ),
          );
        }
      }
    } else {
      draft = !!pr.draft;
      await updatePull(repo, pr.number, { title, body }).catch((err) => log(`Could not update the pull request description: ${err.message}`, 'warning'));
      log(`Pull request #${pr.number} already open; branch and description updated: ${pr.html_url}`);
    }
    patchFeatureState(feature.id, {
      prUrl: pr.html_url,
      prNumber: pr.number,
      humanActions,
      pr: { state: 'open', draft, checks: null, labels: [], syncedAt: new Date().toISOString() },
      gate: null,
    });
    if (feature.status === 'build') moveFeature(feature.id, 'pr_open');
    if (open.length) {
      notify({ title: `PR #${pr.number} needs you: ${open.map((a) => a.label).join(', ')}`, body: feature.title, level: 'attention', featureId: feature.id, projectId: feature.projectId });
    } else {
      notify({ title: `Pull request #${pr.number} ready for review`, body: feature.title, level: 'success', featureId: feature.id, projectId: feature.projectId });
    }
    return getFeature(feature.id);
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    if (err instanceof GithubError) throw new HttpError(err.status === 401 || err.status === 400 ? 400 : 502, err.message);
    throw new HttpError(502, err.message);
  }
}
