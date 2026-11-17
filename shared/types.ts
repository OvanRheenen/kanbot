// Types shared between the backend and the frontend.

/**
 * Bumped whenever the backend and the dashboard must be updated together. The dashboard shows a
 * "rebuild/reload" banner when its compiled value differs from the backend's.
 */
export const API_VERSION = 10;

export type Priority = 'low' | 'medium' | 'high';
export type FeatureStatus = 'backlog' | 'build' | 'pr_open' | 'done';
export const FEATURE_STATUSES: FeatureStatus[] = ['backlog', 'build', 'pr_open', 'done'];
export type AgentStatus =
  | 'queued'
  | 'initialising'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 'lean' trims tools/skills/MCP/user config for lower token use; 'full' = same as an interactive session. */
export type AgentProfile = 'lean' | 'full';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * Run kinds:
 *  plan      planner writes an implementation plan (read-only)
 *  feature   developer implements the feature
 *  fix       developer fixes validation failures / review findings / user feedback (resumes its session)
 *  test      tester adds and runs tests (fresh session)
 *  review    reviewer reviews the diff (fresh session, read-only)
 *  validate  the orchestrator runs the project's validation commands (no agent)
 *  answer    an agent continues after the user answered its clarification questions
 *  followup  the user asked for more work on a finished feature
 *  refine    backlog chat: the writer agent turns an idea into a GitHub issue (read-only, runs in the main checkout)
 *  preflight developer prepares the pull request: merge the base branch, pick tests, update docs, write the PR body
 */
export type RunKind = 'plan' | 'feature' | 'fix' | 'test' | 'review' | 'validate' | 'answer' | 'followup' | 'refine' | 'preflight';
export type AgentRole = 'planner' | 'developer' | 'tester' | 'reviewer' | 'validator' | 'writer';
export type ClaudeRole = Exclude<AgentRole, 'validator'>;
export const CLAUDE_ROLES: ClaudeRole[] = ['writer', 'planner', 'developer', 'tester', 'reviewer'];
/** Model used by a role when neither the role, the project nor the global settings name one. */
export const ROLE_DEFAULT_MODEL: Record<ClaudeRole, string> = { writer: 'opus', planner: 'opus', developer: 'sonnet', tester: 'sonnet', reviewer: 'opus' };
export type FixReason = 'validation' | 'review' | 'user';

export interface PipelineConfig {
  /** Planner agent writes an implementation plan before any code is written. */
  plan: boolean;
  /** Pause for user approval of the plan. */
  planApproval: boolean;
  /** Run validation commands after each code change. */
  validate: boolean;
  /** Commands run by the orchestrator in the worktree. Empty = auto-detect (package.json, Cargo, Go). */
  validationCommands: string[];
  /** Tester agent adds and runs tests after development. */
  tester: boolean;
  /** Reviewer agent reviews the diff; requested changes go back to the developer. */
  reviewer: boolean;
  /** Pause for user approval before the feature is marked Done. */
  finalApproval: boolean;
  /** Max automatic fix rounds for validation failures. */
  maxFixLoops: number;
  /** Max review → fix rounds before the pipeline stops and asks for a human. */
  maxReviewLoops: number;
  /** Developer runs the PR preflight (merge base, tests by what changed, docs, PR body) before the PR is opened. */
  preflight: boolean;
  /** Post the planner's plan as a comment on the GitHub issue. */
  postPlanToIssue: boolean;
  /** Assign the PR to the token's user and request a review. */
  assignPr: boolean;
  /** GitHub logins asked to review the PR. Empty = the token's user. */
  prReviewers: string[];
  /** Changed paths that need a human step before merging (e.g. database migrations). */
  humanActionRules: HumanActionRule[];
  /** Create a GitHub pull request automatically when the pipeline completes. */
  autoCreatePr: boolean;
  prDraft: boolean;
  /** Git remote used for pushing and resolving the GitHub repository. */
  remote: string;
  /** Start the agent when a card is moved into Build. null = use the global `autoStartBuild` setting. */
  autoStart: boolean | null;
}

export interface RoleConfig {
  /** '' = inherit the project / global model. */
  model: string;
  effort: Effort | '';
}
export type RolesConfig = Partial<Record<ClaudeRole, RoleConfig>>;

export interface HumanActionRule {
  /** Glob on repository-relative paths (`*` = within a folder, `**` = any depth). */
  pattern: string;
  label: string;
  /** What the human has to do. */
  detail: string;
  /** PR label that marks the step as done (e.g. `migration-applied`). '' = tick it off on the board. */
  doneLabel: string;
}

/** A step only a human may take before the PR can merge. Shown as a tag on the card. */
export interface HumanAction {
  id: string;
  source: 'rule' | 'agent' | 'tests' | 'github';
  label: string;
  detail: string;
  done: boolean;
}

/** State of the ticket's pull request, refreshed by the GitHub sync. */
export interface PrInfo {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  checks: 'pending' | 'passing' | 'failing' | null;
  labels: string[];
  syncedAt: string;
}

/** One open choice the writer agent wants the user to make. */
export interface DecisionCard {
  id: string;
  question: string;
  options: { label: string; description: string }[];
  /** The user's choice (an option label or free text); null while open. */
  answer: string | null;
}

/** The issue the writer agent drafted in the backlog chat. */
export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
  size: string;
  /** Issue numbers this ticket depends on. */
  dependsOn: number[];
  /** True once no decision is open and the draft may be published. */
  ready: boolean;
}

export interface ChatMessage {
  id: string;
  featureId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  decisions: DecisionCard[];
  runId: string | null;
  createdAt: string;
}

export type GateType = 'plan_approval' | 'clarification' | 'final_approval';
export interface Gate {
  type: GateType;
  /** Run that opened the gate. */
  runId: string;
  openedAt: string;
  /** plan_approval: the plan (markdown). */
  plan?: string;
  /** clarification: questions from the agent. */
  questions?: string[];
  /** clarification: suggested answers per question (decision cards); an empty list = free text only. */
  options?: string[][];
  /** clarification: role of the agent that asked. */
  role?: AgentRole;
  /** final_approval: short context (e.g. review still requesting changes). */
  note?: string;
}

export interface ValidationResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** Tail of combined stdout/stderr. */
  output: string;
}

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  file: string;
  line: number | null;
  message: string;
}
export interface ReviewResult {
  verdict: 'approve' | 'changes_requested';
  summary: string;
  findings: ReviewFinding[];
}

export interface DependencyRef {
  id: string;
  title: string;
  status: FeatureStatus;
}

export const ACTIVE_AGENT_STATUSES: AgentStatus[] = ['queued', 'initialising', 'running'];

export interface Project {
  id: string;
  name: string;
  description: string;
  path: string;
  baseBranch: string;
  worktreeRoot: string;
  /** Tools passed to `claude --allowedTools`. */
  allowedTools: string[];
  /** Optional model override (e.g. "sonnet", "opus"). Empty = Claude Code default. */
  model: string;
  /** Overrides; empty string = inherit global setting. */
  agentProfile: AgentProfile | '';
  effort: Effort | '';
  /** `owner/repo` on GitHub, resolved from the remote ('' until the first sync). */
  repoSlug: string;
  /** Optional MCP config (JSON string or file path) passed via --mcp-config. */
  mcpConfig: string;
  /** MCP servers (names from the catalog) the project's agents may use. Empty = profile default. */
  mcpServers: string[];
  /** Skills (catalog ids, `${source}:${name}`) the project's agents may use. Empty = profile default. */
  skills: string[];
  pipeline: PipelineConfig;
  roles: RolesConfig;
  createdAt: string;
}

export type McpScope = 'user' | 'local' | 'project' | 'plugin' | 'claude.ai';
export interface McpServerInfo {
  name: string;
  scope: McpScope;
  transport: 'stdio' | 'http' | 'sse' | 'ws' | 'unknown';
  /** Command or URL, with secrets redacted. */
  target: string;
  status: 'connected' | 'failed' | 'needs_auth' | 'pending' | null;
  /** False when the server cannot be exported to a generated --mcp-config (claude.ai connectors). */
  launchable: boolean;
  plugin?: string;
}
export type SkillSource = 'user' | 'project' | 'plugin';
export interface SkillInfo {
  /** `${source}:${name}` (plugin skills: `plugin:${plugin}:${name}`). */
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  plugin?: string;
  path: string;
}
export interface Catalog {
  mcpServers: McpServerInfo[];
  skills: SkillInfo[];
  fetchedAt: string;
  warnings: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Portion of cacheCreationTokens written with the 1-hour TTL (billed at 2x input instead of 1.25x). */
  cacheCreation1hTokens?: number;
}

export interface Feature {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  status: FeatureStatus;
  position: number;
  branch: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  agentStatus: AgentStatus | null;
  currentRunId: string | null;
  /** Features that must be Done before this one starts. */
  dependsOn: string[];
  /** Dependencies that are not Done yet (computed). */
  blockedBy: DependencyRef[];
  /** Open approval / clarification checkpoint. */
  gate: Gate | null;
  /** Ref the feature branch was created from (base branch, or a dependency's branch when stacked). */
  baseRef: string | null;
  prUrl: string | null;
  prNumber: number | null;
  /** GitHub issue behind this ticket (null while it is still a local draft). */
  issueNumber: number | null;
  issueUrl: string | null;
  issueState: 'open' | 'closed' | null;
  labels: string[];
  /** T-shirt size from the issue's labels or body. */
  size: string | null;
  /** Steps only a human may take (migrations, tests that need Docker, …). */
  humanActions: HumanAction[];
  pr: PrInfo | null;
  /** Latest issue draft from the backlog chat. */
  draft: IssueDraft | null;
  /** Decision cards in the backlog chat that still need an answer. */
  openDecisions: number;
  /** Sums over all runs of the feature (pipelines run several agents). */
  totals?: { runs: number; costUsd: number; newTokens: number };
  createdAt: string;
  updatedAt: string;
  /** Snapshot of the current run, joined in by the API for card display. */
  run?: Run | null;
}

export type ProgressStage =
  | 'queued'
  | 'initialising'
  | 'planning'
  | 'implementing'
  | 'testing'
  | 'finalizing'
  | 'validating'
  | 'reviewing'
  | 'reporting'
  | 'done';

export interface RunMetrics {
  /** Number of API turns (unique assistant messages). */
  turns: number;
  /** Context size of the first turn: system prompt + tools + prompt, before any work. */
  baselineContextTokens: number;
  /** Largest context size of any single turn. */
  peakContextTokens: number;
  /** Tool calls denied by permissions (each one usually costs an extra turn). */
  permissionDenials: number;
}

export interface Run {
  id: string;
  featureId: string;
  attempt: number;
  kind: RunKind;
  role: AgentRole;
  /** Pipeline cycle: incremented each time the feature is (re)started or followed up. */
  cycle: number;
  /** For fix runs: what triggered the fix. */
  fixReason: FixReason | null;
  /** Instruction for follow-up / fix / answer runs. */
  message: string | null;
  /** Results of validator runs. */
  validation: ValidationResult[] | null;
  metrics: RunMetrics;
  status: AgentStatus;
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  error: string | null;
  /** 0-100, or null when progress cannot be meaningfully determined. */
  progress: number | null;
  stage: ProgressStage | null;
  currentActivity: string | null;
  usage: Usage;
  model: string | null;
  /** Cost reported by Claude Code itself (total_cost_usd), still an estimate. */
  reportedCostUsd: number | null;
  /** Cost computed by the orchestrator from token usage and the pricing table. */
  estimatedCostUsd: number | null;
  sessionId: string | null;
  commitHash: string | null;
  createdAt: string;
}

export type RunEventKind =
  | 'lifecycle'
  | 'system'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'warning'
  | 'error'
  | 'stderr';

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  kind: RunEventKind;
  summary: string;
  detail: string | null;
}

export interface FileChange {
  path: string;
  change: 'created' | 'modified' | 'deleted' | 'renamed';
  committed: boolean;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface Changes {
  branch: string | null;
  baseBranch: string;
  worktreePath: string | null;
  headCommit: string | null;
  commits: CommitInfo[];
  files: FileChange[];
  hasUncommittedChanges: boolean;
  worktreeExists: boolean;
}

export interface TestResults {
  executed: string[];
  passed: number | null;
  failed: number | null;
  notRun: string[];
  output: string;
}

export interface BuildResult {
  status: 'passed' | 'failed' | 'not_run' | 'unknown';
  output: string;
}

/** Structured self-report the agent emits at the end of its run. */
export interface AgentSelfReport {
  summary: string;
  implementationDetails: string;
  tests: TestResults;
  build: BuildResult;
  outstandingIssues: string[];
  docsUpdated: string[];
  /** Planner: implementation plan (markdown). */
  plan: string;
  /** Questions the agent needs answered before it can continue. */
  needsClarification: string[];
  /** Suggested answers per question (same order as needsClarification). */
  clarificationOptions: string[][];
  /** Writer: chat reply, open decisions and the issue draft. */
  reply: string;
  decisions: Omit<DecisionCard, 'answer'>[];
  issue: IssueDraft | null;
  /** Preflight: pull request title and body, and manual steps the human must take before merging. */
  prTitle: string;
  prBody: string;
  humanActions: { label: string; detail: string }[];
  /** Reviewer: verdict and findings. */
  review: ReviewResult | null;
  reported: boolean;
}

export interface Report {
  runId: string;
  featureId: string;
  generatedAt: string;
  status: AgentStatus;
  self: AgentSelfReport;
  changes: Changes;
  usage: Usage;
  estimatedCostUsd: number | null;
  reportedCostUsd: number | null;
  durationMs: number | null;
  model: string | null;
  metrics?: RunMetrics;
  kind?: RunKind;
  role?: AgentRole;
  markdown: string;
}

export interface Settings {
  concurrency: number;
  agentProfile: AgentProfile;
  /** '' = Claude Code default. */
  effort: Effort | '';
  /** Hard spending cap per run (claude --max-budget-usd); 0 = none. */
  maxBudgetUsd: number;
  defaultModel: string;
  editorCommand: string;
  claudeBinary: string;
  /** Which events produce notifications. */
  notifications: 'all' | 'attention' | 'off';
  /** macOS system notifications (osascript) when no dashboard tab is open. */
  systemNotifications: boolean;
  /** Start the agent when a card is moved into Build. Off: cards wait in Build for an explicit start. Projects can override. */
  autoStartBuild: boolean;
  /** Seconds between GitHub syncs (issues in, PR state). 0 = manual sync only. */
  syncIntervalSec: number;
}

export interface GithubStatus {
  configured: boolean;
  source: 'env' | 'file' | null;
  login: string | null;
}

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  level: 'info' | 'success' | 'attention' | 'error';
  featureId: string | null;
  projectId: string | null;
  ts: string;
}

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'meta';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  /** Hunks omitted because the diff is large; fetch the file on its own. */
  truncated: boolean;
  hunks: DiffHunk[];
}
export interface DiffResult {
  scope: string;
  base: string | null;
  files: DiffFile[];
  truncated: boolean;
}

export interface PathValidation {
  exists: boolean;
  isGitRepo: boolean;
  isWorktreeRoot: boolean;
  branches: string[];
  currentBranch: string | null;
  suggestedName: string;
  suggestedWorktreeRoot: string;
  error?: string;
}

export type ServerMessage =
  | { type: 'feature.updated'; feature: Feature }
  | { type: 'feature.deleted'; featureId: string; projectId: string }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.event'; event: RunEvent }
  | { type: 'project.updated'; project: Project }
  | { type: 'project.deleted'; projectId: string }
  | { type: 'settings.updated'; settings: Settings }
  | { type: 'notification'; notification: AppNotification }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'terminal.updated'; session: TerminalSession }
  | { type: 'terminal.output'; sessionId: string; featureId: string; offset: number; chunk: string };

/** A shell command run from the dashboard's Terminal tab in a feature's worktree (in memory, not persisted). */
export interface TerminalSession {
  id: string;
  featureId: string;
  cwd: string;
  command: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: string | null;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Directory the shell ended in (set on a normal exit); the feature's next command starts there. */
  endCwd: string | null;
  /** Buffered output (ANSI stripped), capped; `outputStart` = how many chars were dropped from the front. */
  output: string;
  outputStart: number;
}

/** `GET /features/:id/terminal`: sessions plus where the next command runs. */
export interface TerminalState {
  sessions: TerminalSession[];
  cwd: string | null;
  root: string | null;
}
