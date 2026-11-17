import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { CLAUDE_ROLES, ROLE_DEFAULT_MODEL, type ClaudeRole, type HumanActionRule, type PathValidation, type PipelineConfig, type Project, type RolesConfig } from '@shared/types.ts';
import { api, type LaunchPreview } from '@/api';
import { PROFILE_HELP } from './SettingsDialog';
import { upsertProject, useStore } from '@/store';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Input, Select, Textarea } from './ui/input';
import { toastError } from './toast';
import { CapabilitiesPicker } from './CapabilitiesPicker';

const NO_TOOLS: string[] = [];

const MIGRATION_RULE: HumanActionRule = {
  pattern: 'supabase/migrations/**',
  label: 'Migration',
  detail: 'Run `supabase db push --linked`, then add the `migration-applied` label to the pull request. Agents never do either.',
  doneLabel: 'migration-applied',
};

/** Mirrors the server's DEFAULT_PIPELINE (projects.ts): the issue → PR workflow. */
export const DEFAULT_PIPELINE: PipelineConfig = {
  plan: true,
  planApproval: false,
  validate: true,
  validationCommands: [],
  tester: false,
  reviewer: true,
  finalApproval: false,
  maxFixLoops: 2,
  maxReviewLoops: 5,
  preflight: true,
  postPlanToIssue: true,
  assignPr: true,
  prReviewers: [],
  humanActionRules: [MIGRATION_RULE],
  autoCreatePr: true,
  prDraft: false,
  autoStart: null,
  remote: 'origin',
};

/** One rule per line: `path glob | tag | what the human does | PR label that marks it done (optional)`. */
const rulesToText = (rules: HumanActionRule[]) => rules.map((r) => [r.pattern, r.label, r.detail, r.doneLabel].join(' | ').replace(/ \| $/, '')).join('\n');
const textToRules = (text: string): HumanActionRule[] =>
  text
    .split('\n')
    .map((line) => line.split('|').map((x) => x.trim()))
    .filter((p) => p[0] && p[1])
    .map(([pattern, label, detail = '', doneLabel = '']) => ({ pattern, label, detail, doneLabel }));

const ROLE_HELP: Record<ClaudeRole, string> = {
  writer: 'Read-only, in the main checkout. Turns your idea into the GitHub issue in the Backlog chat.',
  planner: 'Read-only. Writes the implementation plan from the issue.',
  developer: 'Implements the ticket, fixes validation failures and review findings, and prepares the PR (same session as the planner).',
  tester: 'Fresh session. Adds and runs tests for the ticket.',
  reviewer: 'Fresh, read-only session. Reviews the diff and requests changes until there is nothing left.',
};

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 metal-raised ${disabled ? 'opacity-50' : ''}`}>
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  project?: Project | null;
  onSaved?: (p: Project) => void;
}) {
  const defaults = useStore((s) => s.settings?.defaultAllowedTools ?? NO_TOOLS);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [worktreeRoot, setWorktreeRoot] = useState('');
  const [model, setModel] = useState('');
  const [tools, setTools] = useState('');
  const [agentProfile, setAgentProfile] = useState('');
  const [effort, setEffort] = useState('');
  const [mcpConfig, setMcpConfig] = useState('');
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const globalProfile = useStore((s) => s.settings?.agentProfile ?? 'lean');
  const globalAutoStart = useStore((s) => s.settings?.autoStartBuild ?? true);
  const [pipeline, setPipeline] = useState<PipelineConfig>(DEFAULT_PIPELINE);
  const [validationText, setValidationText] = useState('');
  const [rulesText, setRulesText] = useState(rulesToText(DEFAULT_PIPELINE.humanActionRules));
  const [reviewersText, setReviewersText] = useState('');
  const [detected, setDetected] = useState<{ commands: string[]; source: string } | null>(null);
  const [roles, setRoles] = useState<RolesConfig>({});
  const [previewRole, setPreviewRole] = useState<ClaudeRole>('developer');
  const [preview, setPreview] = useState<LaunchPreview | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [validation, setValidation] = useState<PathValidation | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath(project?.path ?? '');
    setName(project?.name ?? '');
    setDescription(project?.description ?? '');
    setBaseBranch(project?.baseBranch ?? '');
    setWorktreeRoot(project?.worktreeRoot ?? '');
    setModel(project?.model ?? '');
    setTools((project?.allowedTools ?? defaults).join('\n'));
    setAgentProfile(project?.agentProfile ?? '');
    setEffort(project?.effort ?? '');
    setMcpConfig(project?.mcpConfig ?? '');
    setMcpServers(project?.mcpServers ?? []);
    setSkills(project?.skills ?? []);
    setPipeline(project?.pipeline ?? DEFAULT_PIPELINE);
    setValidationText((project?.pipeline.validationCommands ?? []).join('\n'));
    setRulesText(rulesToText((project?.pipeline ?? DEFAULT_PIPELINE).humanActionRules));
    setReviewersText((project?.pipeline.prReviewers ?? []).join(', '));
    setRoles(project?.roles ?? {});
    setDetected(null);
    setPreview(null);
    setShowPrompt(false);
    if (project) api.launchPreview(project.id).then(setPreview).catch(() => {});
    if (project) api.validationPreview(project.id).then(setDetected).catch(() => {});
    setValidation(null);
    if (project) api.validatePath(project.path).then(setValidation).catch(() => {});
  }, [open, project, defaults]);

  // Validate path as the user types (debounced).
  useEffect(() => {
    if (!open || project || !path.trim()) return;
    const t = setTimeout(async () => {
      try {
        const v = await api.validatePath(path);
        setValidation(v);
        if (v.isGitRepo) {
          setName((n) => n || v.suggestedName);
          setBaseBranch((b) => (b && v.branches.includes(b) ? b : v.currentBranch || v.branches[0] || ''));
          setWorktreeRoot((w) => w || v.suggestedWorktreeRoot);
        }
      } catch {
        /* ignore */
      }
    }, 350);
    return () => clearTimeout(t);
  }, [path, open, project]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const input = {
      name,
      description,
      baseBranch,
      worktreeRoot,
      model,
      agentProfile,
      effort,
      mcpConfig,
      mcpServers,
      skills,
      allowedTools: tools.split('\n').map((t) => t.trim()).filter(Boolean),
      pipeline: {
        ...pipeline,
        validationCommands: validationText.split('\n').map((t) => t.trim()).filter(Boolean),
        humanActionRules: textToRules(rulesText),
        prReviewers: reviewersText.split(/[\s,]+/).map((t) => t.trim().replace(/^@/, '')).filter(Boolean),
      },
      roles,
    };
    try {
      const p = project ? await api.updateProject(project.id, input) : await api.createProject({ ...input, path });
      upsertProject(p);
      onSaved?.(p);
      onOpenChange(false);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  const valid = project || (validation?.isGitRepo && validation.isWorktreeRoot && validation.branches.length > 0);
  const setP = (patch: Partial<PipelineConfig>) => setPipeline((p) => ({ ...p, ...patch }));
  const setRole = (role: ClaudeRole, patch: Partial<{ model: string; effort: string }>) =>
    setRoles((r) => ({ ...r, [role]: { model: r[role]?.model ?? '', effort: r[role]?.effort ?? '', ...patch } as RolesConfig[ClaudeRole] }));
  const shownPreview = preview?.roles?.[previewRole] ?? preview;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={save} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{project ? 'Project settings' : 'Add project'}</DialogTitle>
            <DialogDescription>Register an existing local Git repository. Nothing in the repository is modified.</DialogDescription>
          </DialogHeader>
          <Field
            label="Repository path"
            hint={
              validation && (
                <span className={`inline-flex items-center gap-1 ${valid ? 'text-emerald-600' : 'text-red-600'}`}>
                  {valid ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                  {valid ? `Git repository · ${validation.branches.length} branch(es)` : validation.error}
                </span>
              )
            }
          >
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Projects/Tiles" disabled={!!project} className="font-mono text-xs" required />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tiles" />
            </Field>
            <Field label="Base branch" hint="Worktrees are created from this branch">
              <Select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
                {(validation?.branches ?? (baseBranch ? [baseBranch] : [])).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
          <Field label="Worktree directory" hint="Each feature gets its own subdirectory here, e.g. Tiles-worktrees/feature-onboarding">
            <Input value={worktreeRoot} onChange={(e) => setWorktreeRoot(e.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="Model (optional)" hint="Passed to `claude --model`, e.g. opus, sonnet, claude-sonnet-5-5. Empty = Claude Code default.">
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" className="font-mono text-xs" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Agent profile" hint={agentProfile ? PROFILE_HELP[agentProfile as 'lean' | 'full'] : 'Uses the global setting.'}>
              <Select value={agentProfile} onChange={(e) => setAgentProfile(e.target.value)}>
                <option value="">Use global setting</option>
                <option value="lean">Lean</option>
                <option value="full">Full</option>
              </Select>
            </Field>
            <Field label="Effort" hint="Overrides the global effort.">
              <Select value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">Use global setting</option>
                {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <CapabilitiesPicker
            repoPath={project?.path ?? path}
            enabled={!!valid}
            profile={(agentProfile || globalProfile) as 'lean' | 'full'}
            mcpServers={mcpServers}
            skills={skills}
            onChange={(next) => {
              if (next.mcpServers) setMcpServers(next.mcpServers);
              if (next.skills) setSkills(next.skills);
            }}
          />
          <details className="metal-surface rounded-xl p-3" open={!!mcpConfig}>
            <summary className="cursor-pointer text-sm font-semibold">Advanced: extra MCP config</summary>
            <div className="pt-3">
              <Field label="MCP config (optional)" hint="JSON or a file path passed as an additional `claude --mcp-config`, on top of the servers selected above.">
                <Input value={mcpConfig} onChange={(e) => setMcpConfig(e.target.value)} placeholder=".mcp.json" className="font-mono text-xs" />
              </Field>
            </div>
          </details>
          <fieldset className="metal-surface space-y-3 rounded-xl p-3">
            <legend className="px-1 text-sm font-semibold">Pipeline</legend>
            <p className="text-[11px] text-muted-foreground">
              What happens after a ticket enters Build. Every step runs in the ticket&apos;s own worktree, on its own branch from the fresh base branch. Agents never push, merge or apply migrations.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="When a ticket enters Build" hint="Waiting cards show a ▶ button on the board.">
                <Select
                  value={pipeline.autoStart === null ? '' : pipeline.autoStart ? 'auto' : 'manual'}
                  onChange={(e) => setP({ autoStart: e.target.value === '' ? null : e.target.value === 'auto' })}
                >
                  <option value="">Use global setting (currently: {globalAutoStart ? 'start planning' : 'wait for ▶'})</option>
                  <option value="auto">Start planning automatically</option>
                  <option value="manual">Wait for ▶ Start</option>
                </Select>
              </Field>
              <Field label="After the plan" hint="Auto: the implementer starts as soon as the plan is written. Manual: you approve or comment on the plan first.">
                <Select value={pipeline.planApproval ? 'manual' : 'auto'} disabled={!pipeline.plan} onChange={(e) => setP({ planApproval: e.target.value === 'manual' })}>
                  <option value="auto">Implement automatically</option>
                  <option value="manual">Wait for my approval</option>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Toggle checked={pipeline.plan} onChange={(v) => setP({ plan: v })} label="1. Plan" hint="The planner reads the issue and the code and writes the plan. Nothing is changed yet." />
              <Toggle checked={pipeline.postPlanToIssue} disabled={!pipeline.plan} onChange={(v) => setP({ postPlanToIssue: v })} label="Post the plan on the issue" hint="As a comment on the GitHub issue." />
              <Toggle checked={pipeline.validate} onChange={(v) => setP({ validate: v })} label="2. Validate" hint="Kanbot runs the commands below after each code change; failures go back to the implementer." />
              <Toggle checked={pipeline.tester} onChange={(v) => setP({ tester: v })} label="Tester agent" hint="A separate agent adds and runs tests. Off: the implementer writes them." />
              <Toggle checked={pipeline.reviewer} onChange={(v) => setP({ reviewer: v })} label="3. Review loop" hint="The reviewer reads the diff; the implementer fixes its findings; repeat until nothing is left." />
              <Toggle checked={pipeline.preflight} onChange={(v) => setP({ preflight: v })} label="4. PR preflight" hint="Merge the base branch, run the tests the change needs, update docs, fill in the PR template. Uses the repo's pr-preflight skill when it has one." />
              <Toggle checked={pipeline.finalApproval} onChange={(v) => setP({ finalApproval: v })} label="Final approval" hint="Pause before the pull request is opened so you can read the diff." />
              <Toggle checked={pipeline.autoCreatePr} onChange={(v) => setP({ autoCreatePr: v })} label="5. Open the pull request" hint="Push the branch, open the PR and move the card to PR Open. Off: the card waits for Create PR." />
            </div>
            {pipeline.validate && (
              <Field
                label="Validation commands (one per line)"
                hint={
                  detected
                    ? detected.commands.length
                      ? `Empty = auto-detect: ${detected.commands.join(' · ')} (from ${detected.source}; dependencies are installed first if node_modules is missing).`
                      : 'Empty = auto-detect (nothing detected in this repository; validation is skipped).'
                    : 'Empty = auto-detect from package.json, Cargo.toml or go.mod.'
                }
              >
                <Textarea value={validationText} onChange={(e) => setValidationText(e.target.value)} rows={3} className="font-mono text-xs" placeholder={detected?.commands.join('\n') || 'pnpm lint\npnpm typecheck\npnpm test'} />
              </Field>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Max review rounds" hint="Then the card is flagged for you.">
                <Input type="number" min={0} max={10} value={pipeline.maxReviewLoops} onChange={(e) => setP({ maxReviewLoops: Number(e.target.value) })} />
              </Field>
              <Field label="Max validation fixes" hint="Automatic fix rounds.">
                <Input type="number" min={0} max={5} value={pipeline.maxFixLoops} onChange={(e) => setP({ maxFixLoops: Number(e.target.value) })} />
              </Field>
              <Field label="Git remote" hint="The GitHub repository.">
                <Input value={pipeline.remote} onChange={(e) => setP({ remote: e.target.value })} className="font-mono text-xs" />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="PR reviewers (GitHub logins)" hint="Empty = you. GitHub does not let a PR's author be its reviewer, so with your own token the PR is assigned to you instead.">
                <Input value={reviewersText} onChange={(e) => setReviewersText(e.target.value)} placeholder="you" disabled={!pipeline.assignPr} className="font-mono text-xs" />
              </Field>
              <div className="space-y-2 pt-5">
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={pipeline.assignPr} onChange={(e) => setP({ assignPr: e.target.checked })} /> Assign the PR to me and request review
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={pipeline.prDraft} onChange={(e) => setP({ prDraft: e.target.checked })} /> Open pull requests as drafts
                </label>
              </div>
            </div>
            <Field
              label="Human-action rules (one per line)"
              hint="path glob | tag | what you have to do | PR label that marks it done (optional). A pull request that touches a matching path gets the tag on its card and in its description."
            >
              <Textarea value={rulesText} onChange={(e) => setRulesText(e.target.value)} rows={3} className="font-mono text-xs" placeholder="supabase/migrations/** | Migration | Run supabase db push --linked | migration-applied" />
            </Field>
          </fieldset>
          <fieldset className="metal-surface space-y-2 rounded-xl p-3">
            <legend className="px-1 text-sm font-semibold">Agent roles</legend>
            <p className="text-[11px] text-muted-foreground">Model and effort per role. Empty = the project or global model if one is set, else the default shown.</p>
            {CLAUDE_ROLES.map((role) => (
              <div key={role} className="grid grid-cols-[6rem_1fr_8rem] items-center gap-2">
                <span className="text-sm font-medium capitalize" title={ROLE_HELP[role]}>
                  {role}
                </span>
                <Input value={roles[role]?.model ?? ''} onChange={(e) => setRole(role, { model: e.target.value })} placeholder={model || ROLE_DEFAULT_MODEL[role]} className="h-8 font-mono text-xs" />
                <Select value={roles[role]?.effort ?? ''} onChange={(e) => setRole(role, { effort: e.target.value })} className="h-8 text-xs">
                  <option value="">effort: inherit</option>
                  {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </fieldset>
          <Field
            label="Allowed tools (one per line)"
            hint="Passed to `claude --allowedTools`. Agents run with --permission-mode acceptEdits; anything not listed is denied (no unrestricted permissions)."
          >
            <Textarea value={tools} onChange={(e) => setTools(e.target.value)} rows={8} className="font-mono text-xs" />
          </Field>
          {shownPreview && (
            <div className="metal-inset space-y-1.5 rounded-xl p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                How agents are launched (saved settings)
                {preview?.roles && (
                  <select className="ml-auto h-6 rounded border bg-background px-1 text-[11px]" value={previewRole} onChange={(e) => setPreviewRole(e.target.value as ClaudeRole)}>
                    {CLAUDE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px]">{shownPreview.command}</pre>
              <button type="button" className="text-[11px] text-sky-600 hover:underline" onClick={() => setShowPrompt(!showPrompt)}>
                {showPrompt ? 'Hide' : 'Show'} the {previewRole} prompt template
              </button>
              {showPrompt && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]">{shownPreview.prompt}</pre>}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !valid}>
              {project ? 'Save' : 'Add project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
