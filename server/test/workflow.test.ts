import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The issue → PR workflow end to end, against a fake Claude Code and a fake GitHub REST API:
// backlog chat → decision card → GitHub issue → Build (plan → develop → review ⇄ fix → preflight) → PR Open
// (human-action tags) → merged → Done. Plus the issue sync (import, dependencies, closed elsewhere).

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-flow-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
process.env.ORCH_CLAUDE_BIN = path.join(here, 'fixtures/fake-claude.mjs');
process.env.FAKE_CLAUDE_DELAY_MS = '40';
const argsDir = path.join(tmp, 'args');
process.env.FAKE_CLAUDE_ARGS_DIR = argsDir;
const TOKEN = 'ghp_testtoken_0123456789abcdef';

const repo = path.join(tmp, 'Shop');
const bare = path.join(tmp, 'shop-remote.git');
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// ---- GitHub double: issues and pull requests share one number sequence, like the real thing.
interface Item { number: number; title: string; body: string; state: 'open' | 'closed'; labels: { name: string }[]; html_url: string; pull_request?: object; head?: { ref: string; sha: string }; base?: string; draft?: boolean; merged?: boolean; updated_at: string }
const items: Item[] = [];
const comments: { issue: number; body: string }[] = [];
const requests: { method: string; url: string; body: any }[] = [];
let checkRuns: { status: string; conclusion: string | null }[] = [];
const item = (n: number) => items.find((i) => i.number === n)!;
const labels = (names: string[] = []) => names.map((name) => ({ name }));

const gh = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    const url = req.url!;
    requests.push({ method: req.method!, url, body });
    const send = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    if (url === '/user') return send(200, { login: 'octo' });
    const base = '/repos/acme/shop';
    let m: RegExpMatchArray | null;
    if (req.method === 'GET' && url.startsWith(`${base}/issues?`)) return send(200, items.filter((i) => i.state === 'open'));
    if (req.method === 'POST' && url === `${base}/issues`) {
      const n = items.length + 1;
      const it: Item = { number: n, title: body.title, body: body.body, state: 'open', labels: labels(body.labels), html_url: `https://github.com/acme/shop/issues/${n}`, updated_at: '' };
      items.push(it);
      return send(201, it);
    }
    if ((m = url.match(/\/issues\/(\d+)$/))) {
      const it = item(Number(m[1]));
      if (!it) return send(404, { message: 'Not Found' });
      if (req.method === 'PATCH') Object.assign(it, { ...body, ...(body.labels ? { labels: labels(body.labels) } : {}) });
      return send(200, it);
    }
    if (req.method === 'POST' && (m = url.match(/\/issues\/(\d+)\/comments$/))) {
      comments.push({ issue: Number(m[1]), body: body.body });
      return send(201, { id: comments.length });
    }
    if (req.method === 'POST' && /\/issues\/\d+\/assignees$/.test(url)) return send(201, {});
    // GitHub refuses a review request from the PR's own author.
    if (req.method === 'POST' && /\/pulls\/\d+\/requested_reviewers$/.test(url)) return send(422, { message: 'Review cannot be requested from pull request author.' });
    if (req.method === 'GET' && url.startsWith(`${base}/pulls?`)) {
      return send(200, items.filter((i) => i.pull_request && i.state === 'open' && url.includes(encodeURIComponent(`acme:${i.head!.ref}`))));
    }
    if (req.method === 'POST' && url === `${base}/pulls`) {
      const n = items.length + 1;
      const pr: Item = { number: n, title: body.title, body: body.body, state: 'open', labels: [], html_url: `https://github.com/acme/shop/pull/${n}`, pull_request: {}, head: { ref: body.head, sha: 'abc123' }, base: body.base, draft: body.draft, merged: false, updated_at: '' };
      items.push(pr);
      return send(201, pr);
    }
    if ((m = url.match(/\/pulls\/(\d+)$/))) {
      const pr = item(Number(m[1]));
      if (req.method === 'PATCH') Object.assign(pr, body);
      return send(200, pr);
    }
    if (req.method === 'GET' && /\/commits\/abc123\/check-runs/.test(url)) return send(200, { check_runs: checkRuns });
    return send(404, { message: 'Not Found' });
  });
});

let m: any;
async function waitFor<T>(fn: () => T | undefined | false | null, ms = 30000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timeout');
}
const argsFor = (role: string) =>
  fs
    .readdirSync(argsDir)
    .map((n) => JSON.parse(fs.readFileSync(path.join(argsDir, n), 'utf8')))
    .filter((a) => a.role === role);
const modelOf = (role: string) => {
  const a = argsFor(role)[0].args;
  return a[a.indexOf('--model') + 1];
};

beforeAll(async () => {
  fs.mkdirSync(repo);
  sh(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Shop\n');
  sh(repo, 'add', '-A');
  sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  sh(tmp, 'init', '--bare', '-b', 'main', bare);
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  sh(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/shop.git');
  sh(repo, 'push', 'origin', 'main');
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
  process.env.ORCH_GITHUB_API_URL = `http://127.0.0.1:${(gh.address() as any).port}`;
  m = {
    projects: await import('../src/projects.ts'),
    features: await import('../src/features.ts'),
    runs: await import('../src/runs.ts'),
    orch: await import('../src/orchestrator.ts'),
    github: await import('../src/github.ts'),
    issues: await import('../src/issues.ts'),
    chat: await import('../src/chat.ts'),
    settings: await import('../src/settings.ts'),
  };
  m.settings.updateSettings({ concurrency: 2, systemNotifications: false });
  await m.github.setToken(TOKEN);
});

afterAll(() => {
  m.orch.orchestrator.shutdown();
  gh.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const feature = (id: string) => m.features.getFeature(id);
const roles = (id: string) => m.runs.listRunsForFeature(id).reverse().map((r: any) => `${r.kind}:${r.role}:${r.status}`);

describe('issue → PR workflow', () => {
  let ticketId: string;

  it('brainstorms a ticket in the backlog chat and creates the GitHub issue once the decision is made', async () => {
    const project = await m.projects.createProject({ path: repo, pipeline: { validate: false } });
    process.env.FAKE_WRITER_DECISION = '1';
    const f = m.features.createFeature(project.id, { title: 'Add orders migration', description: 'We need to store orders. Add orders migration' });
    ticketId = f.id;
    m.orch.orchestrator.startChat(f.id);

    // The writer drafts the issue but one choice is the user's: a decision card, no issue yet.
    const asked = await waitFor(() => feature(f.id).openDecisions === 1 && feature(f.id));
    expect(asked.status).toBe('backlog');
    expect(asked.agentStatus).toBeNull();
    expect(asked.draft).toMatchObject({ ready: false, size: 'S' });
    expect(asked.issueNumber).toBeNull();
    const chat = m.chat.listChat(f.id);
    expect(chat.map((c: any) => c.role)).toEqual(['user', 'assistant']);
    expect(chat[1].decisions[0]).toMatchObject({ id: 'd1', question: 'Which export format?', answer: null });
    expect(chat[1].decisions[0].options.map((o: any) => o.label)).toEqual(['CSV', 'JSON']);
    // The writer reads the main checkout, read-only, and does not take a build slot.
    const writer = argsFor('writer')[0];
    expect(fs.realpathSync(writer.cwd)).toBe(fs.realpathSync(repo));
    expect(writer.args[writer.args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(modelOf('writer')).toBe('opus');
    expect(feature(f.id).worktreePath).toBeNull();
    expect(() => m.orch.orchestrator.chat(f.id, '  ')).toThrow(/Write a message or pick an option/);

    // Picking an option answers in the same Claude Code session; the ready draft becomes the GitHub issue.
    m.orch.orchestrator.chat(f.id, '', { d1: 'CSV' });
    delete process.env.FAKE_WRITER_DECISION;
    const issued = await waitFor(() => feature(f.id).issueNumber && feature(f.id));
    expect(issued.issueNumber).toBe(1);
    expect(issued.issueUrl).toBe('https://github.com/acme/shop/issues/1');
    expect(issued.openDecisions).toBe(0);
    expect(issued.labels).toEqual(['enhancement']);
    expect(issued.size).toBe('S');
    expect(item(1).body).toContain('## Acceptance');
    expect(issued.description).toBe(item(1).body);
    const second = argsFor('writer')[1];
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(argsFor('writer')[0].args.includes('--resume') ? '' : m.runs.listRunsForFeature(f.id).reverse()[0].sessionId);
    expect(second.args[1]).toContain('Which export format? → CSV');
    const after = m.chat.listChat(f.id);
    expect(after.map((c: any) => c.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'system']);
    expect(after[1].decisions[0].answer).toBe('CSV');
    expect(after[4].text).toContain('Issue #1 created');
    // Chat runs live in cycle 0 and never count as pipeline steps.
    expect(m.runs.latestCycle(f.id)).toBe(0);
  }, 60000);

  it('builds the ticket: plan → develop → review ⇄ fix → preflight → PR Open with human-action tags', async () => {
    process.env.FAKE_REVIEW_VERDICT = 'changes_once';
    process.env.FAKE_TESTS_NOT_RUN = 'pnpm e2e:backend';
    m.orch.orchestrator.enterBuild(ticketId);
    const open = await waitFor(() => feature(ticketId).status === 'pr_open' && feature(ticketId), 60000);
    delete process.env.FAKE_REVIEW_VERDICT;
    delete process.env.FAKE_TESTS_NOT_RUN;

    expect(roles(ticketId).slice(2)).toEqual([
      'plan:planner:completed',
      'feature:developer:completed',
      'review:reviewer:completed',
      'fix:developer:completed',
      'review:reviewer:completed',
      'preflight:developer:completed',
    ]);
    // Opus plans and reviews, Sonnet implements.
    expect(modelOf('planner')).toBe('opus');
    expect(modelOf('reviewer')).toBe('opus');
    expect(modelOf('developer')).toBe('sonnet');
    // One ticket, one branch from the fresh base, named after the issue.
    expect(open.branch).toBe('feat/1-add-orders-migration');
    expect(open.baseRef).toBe('origin/main');
    // The branch has no upstream: a bare `git push` in the worktree cannot hit main.
    expect(() => sh(repo, 'config', '--get', `branch.${open.branch}.merge`)).toThrow();
    // Agents are never allowed to push, use gh or apply migrations.
    const dev = argsFor('developer')[0].args;
    const denied = dev[dev.indexOf('--disallowedTools') + 1];
    expect(denied).toContain('Bash(git push:*)');
    expect(denied).toContain('Bash(supabase db push:*)');
    expect(denied).toContain('Bash(gh:*)');
    expect(argsFor('planner')[0].args[1]).toContain('GitHub issue:** #1');
    // No plan gate in this project: the developer continues the planner's session right away.
    expect(dev[1]).toContain('Implement it now');
    expect(dev[dev.indexOf('--resume') + 1]).toBe(m.runs.listRunsForFeature(ticketId).reverse()[2].sessionId);

    // The plan is posted on the issue.
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ issue: 1 });
    expect(comments[0].body).toContain('## Implementation plan');

    // The PR: title and body from the preflight, into main, not a draft, closing the issue.
    expect(open.prNumber).toBe(2);
    const pr = item(2);
    expect(pr).toMatchObject({ title: 'PR for issue #1', base: 'main', draft: false });
    expect(pr.head!.ref).toBe(open.branch);
    expect(pr.body).toContain('Closes #1');
    expect(pr.body).toContain('pnpm e2e:backend: not run');
    expect(pr.body).toContain('Human action required before merging');
    expect(sh(bare, 'branch', '--list', open.branch)).toContain(open.branch);
    expect(requests.find((r) => r.url.endsWith('/issues/2/assignees'))?.body).toEqual({ assignees: ['octo'] });
    const events = m.runs.listRunsForFeature(ticketId).flatMap((r: any) => m.runs.listEvents(r.id));
    expect(events.some((e: any) => /does not let a pull request's author review it/.test(e.summary))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(TOKEN);

    // Human-action tags: the migration (path rule; the agent's duplicate is folded in) and the tests that need Docker.
    expect(open.humanActions.map((a: any) => [a.id, a.label, a.done])).toEqual([
      ['rule:migration', 'Migration', false],
      ['tests:not-run', 'Run tests locally', false],
    ]);
    expect(open.humanActions[0].detail).toContain('supabase db push --linked');
    expect(open.humanActions[0].detail).toContain('supabase/migrations/0001_add-orders-migration.sql');
    expect(open.humanActions[1].detail).toContain('pnpm e2e:backend');
    expect(open.pr).toMatchObject({ state: 'open', draft: false });
  }, 90000);

  it('follows the pull request: CI state, the migration-applied label, merged → Done', async () => {
    const project = m.projects.listProjects()[0];
    item(2).labels = labels(['migration: cannot auto-merge']);
    checkRuns = [{ status: 'completed', conclusion: 'failure' }];
    await m.issues.syncProject(project.id);
    let f = feature(ticketId);
    expect(f.status).toBe('pr_open');
    expect(f.pr).toMatchObject({ state: 'open', checks: 'failing', labels: ['migration: cannot auto-merge'] });
    // The guard's label is the same step as the Migration tag: no second tag.
    expect(f.humanActions.map((a: any) => a.label)).toEqual(['Migration', 'Run tests locally']);
    expect(f.humanActions[0].done).toBe(false);

    // The human pushed the migration and added the label; the tag is ticked off. Tests are ticked on the board.
    item(2).labels = labels(['migration: cannot auto-merge', 'migration-applied']);
    checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await m.issues.syncProject(project.id);
    f = feature(ticketId);
    expect(f.pr.checks).toBe('passing');
    expect(f.humanActions[0].done).toBe(true);
    expect(f.humanActions[1].done).toBe(false);

    // Merged by the human (agents never merge): the card moves to Done; the issue is closed by "Closes #1".
    Object.assign(item(2), { state: 'closed', merged: true });
    item(1).state = 'closed';
    const r = await m.issues.syncProject(project.id);
    expect(r.merged).toBe(1);
    f = feature(ticketId);
    expect(f.status).toBe('done');
    expect(f.pr.state).toBe('merged');
    expect(f.issueState).toBe('closed');
  }, 30000);

  it('imports issues from GitHub, links "Depends on", and follows edits and closes made elsewhere', async () => {
    const project = m.projects.listProjects()[0];
    items.push(
      { number: 3, title: 'Checkout page', body: '## What\nBuild it.\n\nDepends on #4\n\n**Size:** M', state: 'open', labels: labels(['size: L']), html_url: 'https://github.com/acme/shop/issues/3', updated_at: '' },
      { number: 4, title: 'Cart model', body: 'Model the cart.', state: 'open', labels: [], html_url: 'https://github.com/acme/shop/issues/4', updated_at: '' },
    );
    const r = await m.issues.syncProject(project.id);
    expect(r).toMatchObject({ imported: 2, repo: 'acme/shop' });
    expect(m.projects.getProject(project.id).repoSlug).toBe('acme/shop');
    const checkout = m.features.findByIssue(project.id, 3);
    const cart = m.features.findByIssue(project.id, 4);
    expect(checkout).toMatchObject({ status: 'backlog', title: 'Checkout page', size: 'L', labels: ['size: L'] });
    expect(checkout.blockedBy.map((d: any) => d.title)).toEqual(['Cart model']);
    // Pull requests are not tickets.
    expect(m.features.findByIssue(project.id, 2)).toBeNull();

    // Edited on GitHub: GitHub wins. A second sync changes nothing else.
    item(3).title = 'Checkout page v2';
    expect(await m.issues.syncProject(project.id)).toMatchObject({ imported: 0, updated: 1 });
    expect(feature(checkout.id).title).toBe('Checkout page v2');
    expect(await m.issues.syncProject(project.id)).toMatchObject({ imported: 0, updated: 0, closed: 0 });

    // Edited on the board: the issue follows.
    m.features.updateFeatureFields(cart.id, { description: 'Model the cart, with totals.' });
    m.features.patchFeatureState(cart.id, { draft: null });
    await m.issues.publishIssue(cart.id);
    expect(item(4).body).toBe('Model the cart, with totals.');

    // Closed on GitHub without a PR: the Backlog card moves to Done, which unblocks its dependent.
    item(4).state = 'closed';
    expect(await m.issues.syncProject(project.id)).toMatchObject({ closed: 1 });
    expect(feature(cart.id).status).toBe('done');
    expect(feature(checkout.id).blockedBy).toEqual([]);
  }, 30000);

  it('waits in Build for "Create PR" when there is no token, then continues', async () => {
    const project = m.projects.listProjects()[0];
    await m.projects.updateProject(project.id, { pipeline: { plan: false, reviewer: false, preflight: false } });
    await m.github.setToken('');
    const f = m.features.createFeature(project.id, { title: 'Local only' });
    m.orch.orchestrator.enterBuild(f.id);
    const ready = await waitFor(() => feature(f.id).agentStatus === 'completed' && feature(f.id).run?.currentActivity === 'Ready for a pull request' && feature(f.id));
    expect(ready.status).toBe('build');
    await m.github.setToken(TOKEN);
    // "Continue pipeline" retries the last decision: open the PR.
    m.orch.orchestrator.continuePipeline(f.id);
    const open = await waitFor(() => feature(f.id).status === 'pr_open' && feature(f.id));
    expect(open.branch).toMatch(/^feat\/local-only-/);
    expect(item(open.prNumber).title).toBe('Local only');
    expect(open.humanActions).toEqual([]);
  }, 60000);
});
