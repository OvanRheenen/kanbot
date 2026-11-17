import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import { CheckCircle2, CircleDot, Coins, GitBranch, GitPullRequest, Hand, Link2, MessageCircleQuestion, PencilLine, Play, Timer, XCircle, Zap } from 'lucide-react';
import type { Feature } from '@shared/types.ts';
import { cn, formatCost, formatDuration, formatTokens } from '@/lib/utils';
import { useNow } from '@/hooks';
import { api } from '@/api';
import { upsertFeature } from '@/store';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { toast, toastError } from './toast';
import { AgentStatusBadge, PipelineChip, hasOpenDecisions, openHumanActions, isReadyToStart, isWaiting, PriorityBadge, RunProgress, isActive, newTokens, runCost, runDurationMs, runLabel, totalTokens } from './status';

/** First lines of an issue body as plain text: headings, emphasis, code ticks and task boxes removed. */
const plainText = (md: string) =>
  md
    .slice(0, 400)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function FeatureCardView({ feature, dragging, onClick }: { feature: Feature; dragging?: boolean; onClick?: () => void }) {
  const run = feature.run;
  const active = isActive(feature.agentStatus);
  const now = useNow(active && feature.agentStatus !== 'queued');
  const showAgent = (feature.status !== 'backlog' && feature.status !== 'done') || !!feature.agentStatus || !!feature.prUrl;
  const humans = openHumanActions(feature);
  const humansDone = feature.status !== 'done' ? feature.humanActions.filter((a) => a.done) : [];
  const decisions = hasOpenDecisions(feature);
  // PR Open and Done: the agents are finished, so the card shows the PR instead of the last run's status.
  const settled = (feature.status === 'pr_open' || feature.status === 'done') && !active && feature.agentStatus !== 'failed';
  const duration = runDurationMs(run, now);
  const blocked = feature.blockedBy.length > 0 && feature.status !== 'done';
  const multi = (feature.totals?.runs ?? 0) > 1;
  const ready = isReadyToStart(feature);
  const [starting, setStarting] = useState(false);
  const start = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStarting(true);
    try {
      upsertFeature(await api.startFeature(feature.id));
      toast(`Agent queued for "${feature.title}"`);
    } catch (err) {
      toastError(err);
    } finally {
      setStarting(false);
    }
  };
  return (
    <div
      onClick={onClick}
      className={cn(
        'metal-surface sheen group relative cursor-pointer rounded-xl p-3 text-card-foreground transition-[transform,box-shadow] duration-200 hover:-translate-y-px hover:shadow-lg',
        dragging && 'animate-lift shadow-glow',
        active && feature.agentStatus !== 'queued' && 'running-edge',
        feature.agentStatus === 'failed' && 'border-red-300 dark:border-red-900/80',
        (isWaiting(feature) || decisions) && 'shadow-gold-glow',
        humans.length > 0 && 'border-amber-400 dark:border-amber-600',
        blocked && feature.status === 'backlog' && 'border-dashed',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium leading-snug tracking-tight">
          {feature.issueNumber && <span className="mr-1.5 font-mono text-xs font-normal text-muted-foreground">#{feature.issueNumber}</span>}
          {feature.title}
        </h3>
        {feature.size ? (
          <Badge variant="outline" className="shrink-0 font-mono" title="Size">
            {feature.size}
          </Badge>
        ) : (
          feature.priority !== 'medium' && <PriorityBadge priority={feature.priority} />
        )}
      </div>
      {humans.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {humans.map((a) => (
            <span
              key={a.id}
              title={a.detail}
              className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-black shadow-sm"
            >
              <Hand className="h-3 w-3" /> You: {a.label}
            </span>
          ))}
        </div>
      )}
      {(decisions || (!feature.issueNumber && feature.status === 'backlog') || feature.labels.length > 0 || humansDone.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {decisions && (
            <Badge variant="gold" title="The writer agent needs you to choose before the issue is final">
              <MessageCircleQuestion className="h-3 w-3" /> {feature.openDecisions === 1 ? '1 decision' : `${feature.openDecisions} decisions`}
            </Badge>
          )}
          {!feature.issueNumber && feature.status === 'backlog' && (
            <Badge variant="outline" className="text-muted-foreground" title="Not on GitHub yet">
              <PencilLine className="h-3 w-3" /> Draft
            </Badge>
          )}
          {feature.labels
            .filter((l) => !/^size\b/i.test(l))
            .slice(0, 3)
            .map((l) => (
              <Badge key={l} variant="gray">
                {l}
              </Badge>
            ))}
          {humansDone.map((a) => (
            <Badge key={a.id} variant="green" title={a.detail}>
              <CheckCircle2 className="h-3 w-3" /> {a.label}
            </Badge>
          ))}
        </div>
      )}
      {feature.description && feature.status === 'backlog' && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{plainText(feature.description)}</p>
      )}
      {feature.status === 'backlog' && feature.dependsOn.length > 0 && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground" title="Starts after these features are Done">
          <Link2 className="h-3 w-3" />
          {blocked ? `Waits for ${feature.blockedBy.map((d) => d.title).join(', ')}` : 'Dependencies done'}
        </p>
      )}
      {showAgent && (
        <div className="mt-2.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {ready ? (
                <Badge variant="gray" dot title="Auto-start is off for this project: press ▶ to start the agent">
                  Ready to start
                </Badge>
              ) : (
                !isWaiting(feature) && (feature.status === 'build' || !!feature.agentStatus) && !settled && <AgentStatusBadge status={feature.agentStatus} />
              )}
              <PipelineChip feature={feature} />
            </div>
            {ready && (
              <Button
                size="icon-round"
                className="h-7 w-7 [&_svg]:size-3.5"
                onClick={start}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                disabled={starting}
                aria-label="Start build"
                title="Start the agent"
              >
                <Play className="translate-x-px fill-current" />
              </Button>
            )}
            {!ready && !settled && run && run.attempt > 1 && (
              <span className="text-[10px] text-muted-foreground" title={`Run #${run.attempt}, pipeline cycle ${run.cycle}`}>
                {runLabel(run)} · #{run.attempt}
              </span>
            )}
          </div>
          {feature.agentStatus && !settled && <RunProgress feature={feature} run={run} />}
          {feature.gate && run?.currentActivity && <p className="text-xs font-medium text-amber-700 dark:text-[hsl(var(--gold))]">{run.currentActivity}</p>}
          {run?.currentActivity && active && (
            <p className="truncate text-xs text-muted-foreground" title={run.currentActivity}>
              {run.currentActivity}
            </p>
          )}
          {run?.error && feature.agentStatus === 'failed' && (
            <p className="line-clamp-2 text-xs text-red-600 dark:text-red-400" title={run.error}>
              {run.error}
            </p>
          )}
          {run && (run.startedAt || totalTokens(run) > 0) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1" title="Elapsed execution time">
                <Timer className="h-3 w-3" /> {formatDuration(duration)}
              </span>
              {multi ? (
                <>
                  <span className="inline-flex items-center gap-1" title={`New tokens (input + cache write + output) across all ${feature.totals!.runs} runs of this feature`}>
                    <Zap className="h-3 w-3" /> {formatTokens(feature.totals!.newTokens)}
                    <span className="opacity-70">· {feature.totals!.runs} runs</span>
                  </span>
                  <span className="inline-flex items-center gap-1" title="Estimated cost of all runs (not an actual charge)">
                    <Coins className="h-3 w-3" /> ~{formatCost(feature.totals!.costUsd)}
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="inline-flex items-center gap-1"
                    title={`New tokens (input + cache write + output). Plus ${formatTokens(run.usage.cacheReadTokens)} cache re-reads over ${run.metrics?.turns ?? 0} turns.`}
                  >
                    <Zap className="h-3 w-3" /> {formatTokens(newTokens(run))}
                    {run.metrics?.turns ? <span className="opacity-70">· {run.metrics.turns} turns</span> : null}
                  </span>
                  <span className="inline-flex items-center gap-1" title="Estimated cost (not an actual charge)">
                    <Coins className="h-3 w-3" /> ~{formatCost(runCost(run))}
                  </span>
                </>
              )}
            </div>
          )}
          {feature.branch && (
            <p className="flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground" title={feature.baseRef ? `${feature.branch} (from ${feature.baseRef})` : feature.branch}>
              <GitBranch className="h-3 w-3 shrink-0" /> {feature.branch}
            </p>
          )}
          {feature.pr && feature.status !== 'done' && (feature.pr.checks || feature.pr.state === 'closed') && (
            <span className="mr-1.5 inline-flex align-middle">
              {feature.pr.state === 'closed' ? (
                <Badge variant="red">
                  <XCircle className="h-3 w-3" /> PR closed
                </Badge>
              ) : feature.pr.checks === 'failing' ? (
                <Badge variant="red">
                  <XCircle className="h-3 w-3" /> CI failing
                </Badge>
              ) : feature.pr.checks === 'pending' ? (
                <Badge variant="amber">
                  <CircleDot className="h-3 w-3" /> CI running
                </Badge>
              ) : (
                <Badge variant="green">
                  <CheckCircle2 className="h-3 w-3" /> CI passing
                </Badge>
              )}
            </span>
          )}
          {feature.prUrl && (
            <a
              href={feature.prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-full border border-emerald-300/70 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-500/15 dark:border-emerald-800 dark:text-emerald-300"
            >
              <GitPullRequest className="h-3 w-3" /> PR #{feature.prNumber}
              {feature.pr?.state === 'merged' ? ' merged' : feature.pr?.draft ? ' (draft)' : ''}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function SortableFeatureCard({ feature, onOpen }: { feature: Feature; onOpen: (f: Feature) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: feature.id, data: { feature } });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <FeatureCardView feature={feature} onClick={() => onOpen(feature)} />
    </div>
  );
}
