import type { HumanAction, HumanActionRule } from '../../shared/types.ts';

/** Glob → RegExp: `**` any depth, `*` within one path segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.trim().replace(/^\.?\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A folder pattern ("supabase/migrations" or "supabase/migrations/") matches everything below it.
  return new RegExp(`^${re.replace(/\/$/, '')}(?:/.*)?$`);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'action';

/** Human steps required by the project's path rules for a set of changed files. */
export function actionsFromRules(rules: HumanActionRule[], files: string[]): HumanAction[] {
  const out: HumanAction[] = [];
  for (const rule of rules) {
    const re = globToRegExp(rule.pattern);
    const hits = files.filter((f) => re.test(f));
    if (!hits.length) continue;
    const shown = hits.slice(0, 5).map((f) => `\`${f}\``).join(', ');
    out.push({
      id: `rule:${slug(rule.label)}`,
      source: 'rule',
      label: rule.label,
      detail: `${rule.detail}${rule.detail ? ' ' : ''}Touched: ${shown}${hits.length > 5 ? ` and ${hits.length - 5} more` : ''}.`,
      done: false,
    });
  }
  return out;
}

/** Steps the preflight agent reported, plus one for the tests it could not run. */
export function actionsFromReport(humanActions: { label: string; detail: string }[], testsNotRun: string[]): HumanAction[] {
  const out: HumanAction[] = humanActions.map((a) => ({ id: `agent:${slug(a.label)}`, source: 'agent' as const, label: a.label.slice(0, 60), detail: a.detail, done: false }));
  if (testsNotRun.length) {
    out.push({ id: 'tests:not-run', source: 'tests', label: 'Run tests locally', detail: `Not run by the agent: ${testsNotRun.join('; ')}`, done: false });
  }
  return out;
}

/**
 * Merge freshly computed actions into the stored ones. Same id = same step: a step the human already
 * ticked off stays done. A rule action wins over an agent action with the same label (no duplicate tags).
 */
export function mergeActions(existing: HumanAction[], fresh: HumanAction[]): HumanAction[] {
  const out: HumanAction[] = [];
  const seenLabels = new Set<string>();
  const order = (a: HumanAction) => (a.source === 'rule' ? 0 : a.source === 'github' ? 1 : a.source === 'tests' ? 2 : 3);
  for (const a of [...fresh].sort((x, y) => order(x) - order(y))) {
    const key = a.label.toLowerCase();
    if (seenLabels.has(key) || out.some((o) => o.id === a.id)) continue;
    seenLabels.add(key);
    const prev = existing.find((e) => e.id === a.id);
    out.push({ ...a, done: prev?.done ?? a.done });
  }
  return out;
}

/** Apply the pull request's labels: a rule's `doneLabel` on the PR ticks that rule's action off. */
export function applyDoneLabels(actions: HumanAction[], rules: HumanActionRule[], prLabels: string[]): HumanAction[] {
  const have = new Set(prLabels.map((l) => l.toLowerCase()));
  return actions.map((a) => {
    if (a.source !== 'rule') return a;
    const rule = rules.find((r) => `rule:${slug(r.label)}` === a.id);
    if (!rule?.doneLabel) return a;
    return { ...a, done: have.has(rule.doneLabel.toLowerCase()) };
  });
}
