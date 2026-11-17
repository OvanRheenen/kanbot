import { addChatMessage } from './chat.ts';
import { createFeature, dependsOnIssues, findByIssue, getFeature, listFeatures, moveFeature, patchFeatureState, setDependenciesByIssue, sizeOf } from './features.ts';
import {
  GithubError,
  checksState,
  createIssue,
  getIssue,
  getPull,
  getToken,
  labelNames,
  listOpenIssues,
  parseRemote,
  remoteUrl,
  updateIssue,
  type GhIssue,
  type RemoteRepo,
} from './github.ts';
import { applyDoneLabels } from './humanActions.ts';
import { notify } from './notify.ts';
import { HttpError, getProject, listProjects, setRepoSlug } from './projects.ts';
import { getSettings } from './settings.ts';
import type { Feature, HumanAction, PrInfo, Project } from '../../shared/types.ts';

/** The project's GitHub repository, from its configured remote. */
export async function projectRepo(project: Project): Promise<RemoteRepo> {
  const remote = project.pipeline.remote || 'origin';
  let url: string;
  try {
    url = await remoteUrl(project.path, remote);
  } catch (err: any) {
    throw new HttpError(400, err.message);
  }
  const repo = parseRemote(url);
  if (!repo) throw new HttpError(400, `Remote "${remote}" (${url}) is not a GitHub repository URL`);
  setRepoSlug(project.id, `${repo.owner}/${repo.repo}`);
  return repo;
}

function asHttp(err: any): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof GithubError) throw new HttpError(err.status === 401 || err.status === 400 ? 400 : 502, err.message);
  throw new HttpError(502, err?.message ?? String(err));
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Copy the issue's state from GitHub onto the ticket. Returns true when something changed. */
function applyIssue(f: Feature, issue: GhIssue): boolean {
  const body = issue.body ?? '';
  const labels = labelNames(issue.labels);
  if (f.title === issue.title && f.description === body && sameList(f.labels, labels) && f.issueState === issue.state && f.issueUrl === issue.html_url && f.issueNumber === issue.number) {
    return false;
  }
  patchFeatureState(f.id, { title: issue.title, description: body, labels, issueState: issue.state, issueUrl: issue.html_url, issueNumber: issue.number });
  return true;
}

/**
 * Create the GitHub issue for a ticket, or update it, from the writer's draft (or the ticket's own text
 * when there is no draft). GitHub is the source of truth afterwards.
 */
export async function publishIssue(featureId: string): Promise<Feature> {
  if (!getToken()) throw new HttpError(400, 'No GitHub token configured. Add one in Settings → GitHub.');
  const f = getFeature(featureId);
  const project = getProject(f.projectId);
  try {
    const repo = await projectRepo(project);
    const draft = f.draft;
    const title = (draft?.title || f.title).trim();
    let body = (draft ? draft.body : f.description).trim();
    const labels = [...new Set([...(f.issueNumber ? f.labels : []), ...(draft?.labels ?? [])])];
    if (draft?.size && !sizeOf(labels, body)) body += `\n\n**Size:** ${draft.size}`;
    const missingDeps = (draft?.dependsOn ?? []).filter((n) => !dependsOnIssues(body).includes(n));
    if (missingDeps.length) body += `\n\nDepends on ${missingDeps.map((n) => `#${n}`).join(', ')}`;
    const issue = f.issueNumber
      ? await updateIssue(repo, f.issueNumber, { title, body, ...(labels.length ? { labels } : {}) })
      : await createIssue(repo, { title, body, ...(labels.length ? { labels } : {}) });
    // GitHub drops labels the token may not create; keep what it reports, but never lose the body we sent.
    applyIssue(getFeature(featureId), { ...issue, body: issue.body ?? body });
    setDependenciesByIssue(featureId, dependsOnIssues(body));
    if (!f.issueNumber) {
      addChatMessage(featureId, 'system', `Issue #${issue.number} created on GitHub: ${issue.html_url}`);
      notify({ title: `Issue #${issue.number} created`, body: title, level: 'success', featureId, projectId: f.projectId });
    } else addChatMessage(featureId, 'system', `Issue #${issue.number} updated on GitHub.`);
    return getFeature(featureId);
  } catch (err) {
    asHttp(err);
  }
}

/** PR labels that mean "a human has to do something", when no rule already covers them. */
const HUMAN_LABEL = /cannot auto-merge|needs[- ]human|human[- ]action|manual step/i;

function githubLabelActions(existing: HumanAction[], prLabels: string[]): HumanAction[] {
  const kept = existing.filter((a) => a.source !== 'github');
  const out = [...kept];
  for (const label of prLabels) {
    if (!HUMAN_LABEL.test(label)) continue;
    if (kept.some((a) => label.toLowerCase().includes(a.label.toLowerCase()))) continue;
    const id = `github:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const prev = existing.find((a) => a.id === id);
    out.push({ id, source: 'github', label, detail: `The pull request carries the label "${label}".`, done: prev?.done ?? false });
  }
  return out;
}

/** Refresh one ticket's pull request: merged → Done; labels and CI state → tags. */
export async function refreshPr(feature: Feature, project: Project, repo: RemoteRepo): Promise<Feature> {
  if (!feature.prNumber) return feature;
  const pull = await getPull(repo, feature.prNumber);
  const state: PrInfo['state'] = pull.merged || pull.merged_at ? 'merged' : pull.state;
  const labels = labelNames(pull.labels);
  let checks: PrInfo['checks'] = feature.pr?.checks ?? null;
  if (state === 'open' && pull.head?.sha) {
    try {
      checks = await checksState(repo, pull.head.sha);
    } catch {
      /* checks are optional: a token without the permission still gets the rest */
    }
  }
  const pr: PrInfo = { state, draft: !!pull.draft, checks, labels, syncedAt: new Date().toISOString() };
  const humanActions = githubLabelActions(applyDoneLabels(feature.humanActions, project.pipeline.humanActionRules, labels), labels);
  const prev = feature.pr;
  patchFeatureState(feature.id, { pr, humanActions });
  if (state === 'merged' && feature.status !== 'done') {
    moveFeature(feature.id, 'done');
    notify({ title: `Pull request #${feature.prNumber} merged`, body: feature.title, level: 'success', featureId: feature.id, projectId: feature.projectId });
  } else if (state === 'closed' && prev?.state !== 'closed') {
    notify({ title: `Pull request #${feature.prNumber} closed without merging`, body: feature.title, level: 'attention', featureId: feature.id, projectId: feature.projectId });
  } else if (checks === 'failing' && prev?.checks !== 'failing') {
    notify({ title: `CI failing on pull request #${feature.prNumber}`, body: feature.title, level: 'attention', featureId: feature.id, projectId: feature.projectId });
  }
  return getFeature(feature.id);
}

export interface SyncResult {
  imported: number;
  updated: number;
  closed: number;
  merged: number;
  repo: string;
}

const syncing = new Set<string>();

/**
 * Pull the repository's state onto the board: open issues become Backlog tickets (GitHub's text wins),
 * issues closed elsewhere move to Done, and open pull requests are refreshed (merged → Done).
 */
export async function syncProject(projectId: string): Promise<SyncResult> {
  if (!getToken()) throw new HttpError(400, 'No GitHub token configured. Add one in Settings → GitHub.');
  const project = getProject(projectId);
  if (syncing.has(projectId)) throw new HttpError(409, 'A sync is already running for this project');
  syncing.add(projectId);
  const result: SyncResult = { imported: 0, updated: 0, closed: 0, merged: 0, repo: '' };
  try {
    const repo = await projectRepo(project);
    result.repo = `${repo.owner}/${repo.repo}`;
    const issues = await listOpenIssues(repo);
    const open = new Set<number>();
    // Oldest first, so imported tickets keep the issue order in the Backlog.
    for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
      open.add(issue.number);
      let f = findByIssue(projectId, issue.number);
      if (!f) {
        f = createFeature(projectId, { title: issue.title, description: issue.body ?? '' });
        applyIssue(f, issue);
        result.imported++;
      } else {
        const reopened = f.issueState === 'closed' && f.status === 'done' && f.pr?.state !== 'merged';
        if (applyIssue(f, issue)) result.updated++;
        if (reopened) moveFeature(f.id, 'backlog');
      }
    }
    for (const issue of issues) {
      const f = findByIssue(projectId, issue.number);
      if (f) setDependenciesByIssue(f.id, dependsOnIssues(issue.body ?? ''));
    }
    for (const f of listFeatures(projectId)) {
      if (f.issueNumber && f.issueState !== 'closed' && !open.has(f.issueNumber)) {
        const issue = await getIssue(repo, f.issueNumber);
        if (issue.state === 'closed') {
          applyIssue(f, issue);
          result.closed++;
          // Closed on GitHub without going through the board: nothing left to build.
          if (f.status === 'backlog') moveFeature(f.id, 'done');
        }
      }
      if (f.prNumber && (f.status === 'pr_open' || f.status === 'build') && f.pr?.state !== 'merged') {
        const after = await refreshPr(f, project, repo);
        if (after.pr?.state === 'merged') result.merged++;
      }
    }
    return result;
  } catch (err) {
    asHttp(err);
  } finally {
    syncing.delete(projectId);
  }
}

let loop: NodeJS.Timeout | null = null;
let lastSync = 0;
let running = false;
let lastError = '';

/** Background sync of every project, every `syncIntervalSec` seconds (0 = off). `after` runs when a sync changed the board. */
export function startSyncLoop(after: () => void) {
  if (loop) return;
  loop = setInterval(async () => {
    const every = getSettings().syncIntervalSec;
    if (running || !every || !getToken() || Date.now() - lastSync < every * 1000) return;
    running = true;
    try {
      for (const p of listProjects()) {
        try {
          const r = await syncProject(p.id);
          if (r.imported || r.closed || r.merged) after();
          lastError = '';
        } catch (err: any) {
          // Report a failing sync once, not every minute.
          if (err.message !== lastError) console.warn(`[sync] ${p.name}: ${err.message}`);
          lastError = err.message;
        }
      }
    } finally {
      lastSync = Date.now();
      running = false;
    }
  }, 5000);
  loop.unref?.();
}

export function stopSyncLoop() {
  if (loop) clearInterval(loop);
  loop = null;
}
